import 'dotenv/config';
import express from 'express';
import { MetaApiManager } from './services/websocket/MetaApiManager';
import { SignalProcessor } from './processors/SignalProcessor';
import { PositionMonitor } from './processors/PositionMonitor';
import { SupabaseManager } from './services/database/SupabaseClient';
import { SettingsRepository } from './services/database/SettingsRepository';
import { AlertManager } from './services/notifications/AlertManager';
import { ThresholdOptimizer } from './services/ai/ThresholdOptimizer';
import { logger } from './utils/logger';
import { ALL_PAIRS, FOREX_PAIRS, CRYPTO_PAIRS } from './config/pairs';

// Track initialization state
let initializationState = {
  status: 'starting' as 'starting' | 'ready' | 'degraded' | 'failed',
  supabase: false,
  metaApi: false,
  error: null as string | null,
  lastError: null as string | null,
  initializationStep: 'pending' as string,
  subscribedPairs: 0,
  openPositions: 0,
  pendingSignals: 0,
  startedAt: new Date().toISOString()
};

// START EXPRESS SERVER IMMEDIATELY (before any async work)
const app = express();
const PORT = process.env.PORT || 3000;

// Railway healthcheck - always return 200 immediately
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Detailed status endpoint for debugging
app.get('/status', (req, res) => {
  res.status(200).json({
    ...initializationState,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    uptimeFormatted: `${Math.floor(process.uptime() / 60)}m ${Math.floor(process.uptime() % 60)}s`,
    memory: process.memoryUsage(),
    metaApiConnected: metaApiInstance?.isConnected() || false
  });
});

app.get('/', (req, res) => {
  res.json({
    name: 'TAVY Brain',
    version: '1.0.0',
    status: initializationState.status
  });
});

// Store metaApi reference for /symbols endpoint
let metaApiInstance: MetaApiManager | null = null;

// Debug endpoint to see all available symbols from broker
app.get('/symbols', (req, res) => {
  if (!metaApiInstance) {
    return res.status(503).json({
      error: 'MetaAPI not initialized yet',
      status: initializationState.status
    });
  }

  const available = metaApiInstance.getAvailableSymbols();
  const subscribed = metaApiInstance.getSubscribedSymbols();
  const byType = metaApiInstance.getSymbolsByType();

  res.json({
    summary: {
      available: available.length,
      subscribed: subscribed.length,
      byType: {
        forex: byType.forex.length,
        crypto: byType.crypto.length,
        indices: byType.indices.length,
        commodities: byType.commodities.length,
        stocks: byType.stocks.length,
        other: byType.other.length
      }
    },
    subscribed,
    available: {
      forex: byType.forex,
      crypto: byType.crypto,
      indices: byType.indices,
      commodities: byType.commodities,
      stocks: byType.stocks,
      other: byType.other
    },
    allSymbols: available
  });
});

// Start server immediately
app.listen(PORT, () => {
  logger.info(`Health check server running on port ${PORT}`);
});

logger.info('🚀 Starting TAVY Brain v1.0...');
logger.info(`Environment: ${process.env.NODE_ENV}`);
logger.info(`Timezone: ${process.env.TZ || 'UTC'}`);

// Now do async initialization in background
async function initialize() {
  const updateStep = (step: string) => {
    initializationState.initializationStep = step;
    logger.info(`📍 INIT STEP: ${step}`);
  };

  const setError = (error: string) => {
    initializationState.lastError = error;
    logger.error(`❌ INIT ERROR: ${error}`);
  };

  try {
    updateStep('1/10: Validating environment variables');
    
    // Validate required environment variables (METAAPI_ACCOUNT_ID now optional - read from DB)
    const requiredEnvVars = [
      'METAAPI_TOKEN',
      'SUPABASE_URL',
      'SUPABASE_ANON_KEY',
      'TAVY_SERVICE_EMAIL',
      'TAVY_SERVICE_PASSWORD'
    ];

    for (const envVar of requiredEnvVars) {
      if (!process.env[envVar]) {
        setError(`Missing required environment variable: ${envVar}`);
        initializationState.status = 'failed';
        initializationState.error = `Missing env: ${envVar}`;
        return;
      }
    }
    logger.info('✅ All required env vars present');

    // Initialize Supabase with service account authentication
    updateStep('2/10: Authenticating to Supabase');
    try {
      await SupabaseManager.getInstance().initialize();
      initializationState.supabase = true;
      logger.info('✅ Supabase authenticated');
    } catch (error) {
      setError(`Supabase auth failed: ${(error as Error).message}`);
      initializationState.error = 'Supabase auth failed';
      initializationState.status = 'degraded';
      // Continue anyway - some features may still work
    }

    // Initialize settings repository first to get price source
    const settingsRepo = new SettingsRepository();
    const alertManager = new AlertManager();

    updateStep('3/10: Loading settings from database');
    const settings = await settingsRepo.loadSettings();
    logger.info('✅ Settings loaded');

    updateStep('4/10: Getting price source account');
    const priceSourceAccount = await settingsRepo.getPriceSourceAccount();
    const priceSourceAccountId = priceSourceAccount?.metaapi_account_id || process.env.METAAPI_ACCOUNT_ID;
    
    if (!priceSourceAccountId) {
      throw new Error('No price source account configured in database or environment');
    }
    logger.info(`✅ Using price source: ${priceSourceAccount?.account_name || 'ENV fallback'} (${priceSourceAccountId.slice(0, 8)}...)`);

    updateStep('5/10: Initializing MetaAPI manager');
    const metaApi = new MetaApiManager(priceSourceAccountId);
    metaApiInstance = metaApi; // Store reference for /symbols endpoint
    logger.info('✅ MetaAPI manager created');

    updateStep('6/10: Connecting to MetaAPI WebSocket');
    await metaApi.connect();
    initializationState.metaApi = true;
    logger.info('✅ MetaAPI WebSocket connected');

    // Wait for broker to send symbol specifications (up to 30 seconds)
    updateStep('7/10: Waiting for broker symbol specifications');
    let specsCount = 0;
    try {
      specsCount = await metaApi.waitForSpecifications(30000);
      logger.info(`✅ Received ${specsCount} symbol specifications from broker`);
    } catch (specError) {
      setError(`waitForSpecifications failed: ${(specError as Error).message}`);
      logger.warn('⚠️ Spec wait failed, continuing with hardcoded pairs...');
      // Continue anyway - we'll use hardcoded pairs
    }

    updateStep('8/10: Discovering available symbols');
    // Auto-discover available symbols from broker
    const availableSymbols = metaApi.getAvailableSymbols();
    const symbolsByType = metaApi.getSymbolsByType();
    
    logger.info(`📊 Broker offers ${availableSymbols.length} symbols:`);
    logger.info(`   Forex: ${symbolsByType.forex.length}, Crypto: ${symbolsByType.crypto.length}`);
    logger.info(`   Indices: ${symbolsByType.indices.length}, Commodities: ${symbolsByType.commodities.length}`);
    logger.info(`   Stocks: ${symbolsByType.stocks.length}, Other: ${symbolsByType.other.length}`);

    // Determine which symbols to subscribe to:
    // 1. If TRADING_PAIRS env is set, use that (manual override)
    // 2. Otherwise use auto-discovery with smart filtering
    let pairs: string[];
    
    if (process.env.TRADING_PAIRS) {
      // Manual override via environment variable
      pairs = process.env.TRADING_PAIRS.split(',');
      logger.info(`Using manual TRADING_PAIRS override: ${pairs.length} symbols`);
    } else if (process.env.AUTO_DISCOVER_SYMBOLS === 'true') {
      // Full auto-discovery - subscribe to ALL available symbols
      pairs = availableSymbols;
      logger.info(`Auto-discovery enabled: subscribing to ALL ${pairs.length} symbols`);
    } else {
      // Default: Combine auto-discovered forex with hardcoded crypto from pairs.ts
      // (FBS crypto CFDs aren't classified correctly by auto-discovery)
      const autoDiscoveredForex = symbolsByType.forex;
      const autoDiscoveredCommodities = symbolsByType.commodities;
      
      // Use auto-discovered forex if available, otherwise use hardcoded
      const forexToUse = autoDiscoveredForex.length > 0 ? autoDiscoveredForex : FOREX_PAIRS;
      
      // Always use hardcoded crypto (auto-discovery unreliable for crypto CFDs)
      const cryptoToUse = CRYPTO_PAIRS;
      
      // Combine all: forex + crypto + commodities (dedupe)
      pairs = [...new Set([...forexToUse, ...cryptoToUse, ...autoDiscoveredCommodities])];
      
      logger.info(`Using ${forexToUse.length} forex + ${cryptoToUse.length} crypto + ${autoDiscoveredCommodities.length} commodities = ${pairs.length} total pairs`);
    }

    // Fallback if no pairs discovered
    if (pairs.length === 0) {
      logger.warn('⚠️ No pairs discovered, falling back to ALL_PAIRS from config');
      pairs = ALL_PAIRS;
    }

    updateStep('9/10: Subscribing to symbol feeds');
    logger.info(`Subscribing to ${pairs.length} pairs...`);
    await metaApi.subscribeToSymbols(pairs);
    initializationState.subscribedPairs = pairs.length;
    logger.info(`✅ Subscribed to ${pairs.length} pairs`);

    updateStep('10/10: Setting up processors and event handlers');
    
    // Log active execution accounts
    const executionAccounts = await settingsRepo.getActiveExecutionAccounts();
    logger.info(`Found ${executionAccounts.length} active execution accounts:`);
    for (const acc of executionAccounts) {
      logger.info(`  - ${acc.account_name} (${acc.broker}) - Min balance: $${acc.minimum_balance}`);
    }

    // Initialize processors
    const signalProcessor = new SignalProcessor(metaApi, settings);
    const positionMonitor = new PositionMonitor(metaApi);

    // Set up tick handler
    metaApi.on('tick', (tick) => {
      signalProcessor.processTick(tick);
    });

    // Handle disconnection
    metaApi.on('disconnected', async () => {
      logger.warn('MetaAPI disconnected');
      initializationState.metaApi = false;
      initializationState.status = 'degraded';
      await alertManager.alertDisconnection();
    });

    // Handle reconnection
    metaApi.on('connected', () => {
      logger.info('MetaAPI reconnected');
      initializationState.metaApi = true;
      if (initializationState.supabase) {
        initializationState.status = 'ready';
      }
    });

    // Subscribe to real-time settings updates
    SupabaseManager.getInstance().subscribeToSettings((newSettings) => {
      logger.info('Settings updated from database');
      signalProcessor.updateSettings(newSettings);
    });

    // Start position monitor (checks SL/TP every 10 seconds)
    positionMonitor.start();

    // Schedule weekly threshold optimization (Sunday 23:00 UTC)
    scheduleWeeklyOptimization();

    // Update initialization state
    initializationState.status = 'ready';
    initializationState.initializationStep = 'complete';
    initializationState.openPositions = positionMonitor.getPositionCount();
    initializationState.pendingSignals = signalProcessor.getPendingCount();

    // Graceful shutdown handlers
    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down gracefully...`);

      try {
        // Stop processors
        positionMonitor.stop();
        signalProcessor.stop();

        // Disconnect from MetaAPI
        await metaApi.disconnect();

        logger.info('Shutdown complete');
        process.exit(0);
      } catch (error) {
        logger.error('Error during shutdown:', error);
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Handle uncaught exceptions
    process.on('uncaughtException', async (error) => {
      logger.error('Uncaught exception:', error);
      await alertManager.sendAlert('critical', 'Uncaught Exception', error.message);
      await shutdown('UNCAUGHT_EXCEPTION');
    });

    process.on('unhandledRejection', async (reason) => {
      logger.error('Unhandled rejection:', reason);
      await alertManager.sendAlert('critical', 'Unhandled Rejection', String(reason));
    });

    logger.info('✅ TAVY Brain is running and ready');

  } catch (error) {
    const errorMsg = (error as Error).message;
    const errorStack = (error as Error).stack;
    logger.error('❌ FATAL: Error during initialization:', error);
    logger.error('Stack trace:', errorStack);
    initializationState.error = errorMsg;
    initializationState.lastError = `${initializationState.initializationStep}: ${errorMsg}`;
    initializationState.status = 'degraded';
    
    try {
      const alertManager = new AlertManager();
      await alertManager.sendAlert('critical', 'Initialization Failed', `Step: ${initializationState.initializationStep}\nError: ${errorMsg}`);
    } catch (alertError) {
      logger.error('Failed to send alert:', alertError);
    }
  }
}

// Weekly threshold optimization scheduler
function scheduleWeeklyOptimization() {
  let lastRunDate: string | null = null; // Prevent duplicate runs on same day

  const checkAndRunOptimization = async () => {
    const now = new Date();
    const dayOfWeek = now.getUTCDay(); // 0 = Sunday
    const hour = now.getUTCHours();
    const todayKey = now.toISOString().split('T')[0]; // YYYY-MM-DD

    // Run on Sunday at 23:00 UTC, but only once per day
    if (dayOfWeek === 0 && hour === 23 && lastRunDate !== todayKey) {
      lastRunDate = todayKey; // Mark as run for today
      logger.info('🧠 Running scheduled weekly threshold optimization...');
      try {
        const optimizer = new ThresholdOptimizer();
        const result = await optimizer.runOptimization();
        logger.info(`Optimization complete: ${result.status}, ${result.appliedChanges.length} changes applied`);
      } catch (error) {
        logger.error('Weekly optimization failed:', error);
      }
    }
  };

  // Check every 15 minutes (reduces unnecessary checks)
  setInterval(checkAndRunOptimization, 15 * 60 * 1000);
  logger.info('📅 Weekly threshold optimization scheduled for Sundays 23:00 UTC');
}

// Start initialization in background (don't await - let Express run)
initialize().catch((error) => {
  logger.error('Fatal initialization error:', error);
  initializationState.status = 'failed';
  initializationState.error = error.message;
});
