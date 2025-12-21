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
import { ALL_PAIRS } from './config/pairs';

// Track initialization state
let initializationState = {
  status: 'starting' as 'starting' | 'ready' | 'degraded' | 'failed',
  supabase: false,
  metaApi: false,
  error: null as string | null,
  subscribedPairs: 0,
  openPositions: 0,
  pendingSignals: 0
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
    memory: process.memoryUsage()
  });
});

app.get('/', (req, res) => {
  res.json({
    name: 'TAVY Brain',
    version: '1.0.0',
    status: initializationState.status
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
      logger.error(`Missing required environment variable: ${envVar}`);
      initializationState.status = 'failed';
      initializationState.error = `Missing env: ${envVar}`;
      return;
    }
  }

  // Initialize Supabase with service account authentication
  logger.info('Authenticating to Supabase...');
  try {
    await SupabaseManager.getInstance().initialize();
    initializationState.supabase = true;
    logger.info('Supabase authenticated');
  } catch (error) {
    logger.error('Supabase auth failed:', error);
    initializationState.error = 'Supabase auth failed';
    initializationState.status = 'degraded';
  }

  // Initialize settings repository first to get price source
  const settingsRepo = new SettingsRepository();
  const alertManager = new AlertManager();

  try {
    // Load settings from database
    const settings = await settingsRepo.loadSettings();
    logger.info('Settings loaded:', JSON.stringify(settings, null, 2));

    // Get price source account from database (with env var fallback)
    const priceSourceAccount = await settingsRepo.getPriceSourceAccount();
    const priceSourceAccountId = priceSourceAccount?.metaapi_account_id || process.env.METAAPI_ACCOUNT_ID;
    
    if (!priceSourceAccountId) {
      throw new Error('No price source account configured in database or environment');
    }

    logger.info(`Using price source: ${priceSourceAccount?.account_name || 'ENV fallback'} (${priceSourceAccountId.slice(0, 8)}...)`);

    // Initialize MetaAPI with price source account
    const metaApi = new MetaApiManager(priceSourceAccountId);

    // Connect to MetaAPI WebSocket
    logger.info('Connecting to MetaAPI...');
    await metaApi.connect();
    initializationState.metaApi = true;

    // Subscribe to forex pairs
    const pairs = process.env.TRADING_PAIRS?.split(',') || ALL_PAIRS;
    logger.info(`Subscribing to ${pairs.length} pairs...`);
    await metaApi.subscribeToSymbols(pairs);
    initializationState.subscribedPairs = pairs.length;

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
    logger.error('Error during initialization:', error);
    initializationState.error = (error as Error).message;
    initializationState.status = 'degraded';
    await alertManager.sendAlert('critical', 'Initialization Failed', (error as Error).message);
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
