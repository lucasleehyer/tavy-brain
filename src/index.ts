import 'dotenv/config';
import express from 'express';
import { MetaApiManager } from './services/websocket/MetaApiManager';
import { SignalProcessor } from './processors/SignalProcessor';
import { PositionMonitor } from './processors/PositionMonitor';
import { SupabaseManager } from './services/database/SupabaseClient';
import { SettingsRepository } from './services/database/SettingsRepository';
import { AlertManager } from './services/notifications/AlertManager';
import { logger } from './utils/logger';
import { FOREX_PAIRS } from './config/pairs';

async function main() {
  logger.info('🚀 Starting TAVY Brain v1.0...');
  logger.info(`Environment: ${process.env.NODE_ENV}`);
  logger.info(`Timezone: ${process.env.TZ || 'UTC'}`);

  // Validate required environment variables
  const requiredEnvVars = [
    'METAAPI_TOKEN',
    'METAAPI_ACCOUNT_ID',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY'
  ];

  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      logger.error(`Missing required environment variable: ${envVar}`);
      process.exit(1);
    }
  }

  // Initialize services
  const metaApi = new MetaApiManager();
  const settingsRepo = new SettingsRepository();
  const alertManager = new AlertManager();

  try {
    // Load settings from database
    const settings = await settingsRepo.loadSettings();
    logger.info('Settings loaded:', JSON.stringify(settings, null, 2));

    // Connect to MetaAPI WebSocket
    logger.info('Connecting to MetaAPI...');
    await metaApi.connect();

    // Subscribe to forex pairs
    const pairs = process.env.FOREX_PAIRS?.split(',') || FOREX_PAIRS;
    logger.info(`Subscribing to ${pairs.length} pairs...`);
    await metaApi.subscribeToSymbols(pairs);

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
      await alertManager.alertDisconnection();
    });

    // Handle reconnection
    metaApi.on('connected', () => {
      logger.info('MetaAPI reconnected');
    });

    // Subscribe to real-time settings updates
    SupabaseManager.getInstance().subscribeToSettings((newSettings) => {
      logger.info('Settings updated from database');
      signalProcessor.updateSettings(newSettings);
    });

    // Start position monitor (checks SL/TP every 10 seconds)
    positionMonitor.start();

    // Health check server
    const app = express();
    const PORT = process.env.PORT || 3000;

    app.get('/health', (req, res) => {
      const health = {
        status: metaApi.isReady() ? 'ok' : 'degraded',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        websocket: metaApi.isReady(),
        subscribedPairs: pairs.length,
        openPositions: positionMonitor.getPositionCount(),
        pendingSignals: signalProcessor.getPendingCount(),
        memory: process.memoryUsage()
      };

      const statusCode = health.status === 'ok' ? 200 : 503;
      res.status(statusCode).json(health);
    });

    app.get('/', (req, res) => {
      res.json({
        name: 'TAVY Brain',
        version: '1.0.0',
        status: 'running'
      });
    });

    app.listen(PORT, () => {
      logger.info(`Health check server running on port ${PORT}`);
    });

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
    logger.error('Fatal error during startup:', error);
    await alertManager.sendAlert('critical', 'Startup Failed', (error as Error).message);
    process.exit(1);
  }
}

// Start the application
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
