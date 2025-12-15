import { MetaApiManager } from '../services/websocket/MetaApiManager';
import { AICouncil } from '../services/ai/AICouncil';
import { ExecutionRouter } from '../services/execution/ExecutionRouter';
import { SignalRepository } from '../services/database/SignalRepository';
import { PreFilter } from '../services/analysis/PreFilter';
import { IndicatorCalculator } from '../services/analysis/IndicatorCalculator';
import { RegimeDetector } from '../services/analysis/RegimeDetector';
import { AlertManager } from '../services/notifications/AlertManager';
import { logger } from '../utils/logger';
import { Tick, TradingThresholds } from '../types';

// Track processing stats for debugging
interface ProcessingStats {
  ticksReceived: number;
  ticksThrottled: number;
  candlesFailed: number;
  preFilterPassed: number;
  preFilterFailed: number;
  aiCouncilCalls: number;
  signalsGenerated: number;
  signalsSaved: number;
  tradesExecuted: number;
  errors: number;
  lastSymbolProcessed: string;
  lastProcessTime: number;
}

export class SignalProcessor {
  private metaApi: MetaApiManager;
  private aiCouncil: AICouncil;
  private executionRouter: ExecutionRouter;
  private signalRepo: SignalRepository;
  private preFilter: PreFilter;
  private indicatorCalc: IndicatorCalculator;
  private regimeDetector: RegimeDetector;
  private alertManager: AlertManager;
  private settings: TradingThresholds;
  private userId: string;
  
  private lastAnalysis: Map<string, number> = new Map();
  private analysisInterval = 60000; // 1 minute between analyses per symbol
  private pendingSignals: number = 0;
  private isRunning: boolean = true;
  private stats: ProcessingStats;
  private statsLogInterval: NodeJS.Timeout | null = null;

  constructor(metaApi: MetaApiManager, settings: TradingThresholds, userId: string) {
    this.metaApi = metaApi;
    this.settings = settings;
    this.userId = userId;
    
    this.aiCouncil = new AICouncil();
    this.executionRouter = new ExecutionRouter();
    this.signalRepo = new SignalRepository(userId);
    this.preFilter = new PreFilter(settings);
    this.indicatorCalc = new IndicatorCalculator();
    this.regimeDetector = new RegimeDetector();
    this.alertManager = new AlertManager();
    
    // Initialize stats
    this.stats = {
      ticksReceived: 0,
      ticksThrottled: 0,
      candlesFailed: 0,
      preFilterPassed: 0,
      preFilterFailed: 0,
      aiCouncilCalls: 0,
      signalsGenerated: 0,
      signalsSaved: 0,
      tradesExecuted: 0,
      errors: 0,
      lastSymbolProcessed: 'none',
      lastProcessTime: Date.now()
    };
    
    // Log stats every 30 seconds for visibility
    this.statsLogInterval = setInterval(() => {
      this.logStats();
    }, 30000);
    
    logger.info(`✅ SignalProcessor initialized with userId: ${userId}`);
    logger.info(`   Analysis interval: ${this.analysisInterval}ms`);
    logger.info(`   Min confidence: ${this.settings.minConfidence || 60}%`);
  }

  private logStats(): void {
    const elapsed = (Date.now() - this.stats.lastProcessTime) / 1000;
    logger.info(`📊 STATS | Ticks: ${this.stats.ticksReceived} | Throttled: ${this.stats.ticksThrottled} | PreFilter Pass/Fail: ${this.stats.preFilterPassed}/${this.stats.preFilterFailed} | AI Calls: ${this.stats.aiCouncilCalls} | Signals: ${this.stats.signalsGenerated} | Saved: ${this.stats.signalsSaved} | Trades: ${this.stats.tradesExecuted} | Errors: ${this.stats.errors} | Last: ${this.stats.lastSymbolProcessed}`);
  }

  async processTick(tick: Tick): Promise<void> {
    if (!this.isRunning) return;
    
    this.stats.ticksReceived++;
    this.stats.lastSymbolProcessed = tick.symbol;
    this.stats.lastProcessTime = Date.now();

    const symbol = tick.symbol;
    const now = Date.now();
    const lastTime = this.lastAnalysis.get(symbol) || 0;

    // Only analyze each symbol every analysisInterval
    if (now - lastTime < this.analysisInterval) {
      this.stats.ticksThrottled++;
      return;
    }

    this.lastAnalysis.set(symbol, now);
    logger.info(`🔍 Processing ${symbol} @ ${tick.bid}/${tick.ask} (spread: ${((tick.ask - tick.bid) * 10000).toFixed(1)} pips)`);

    try {
      // Get candles for analysis
      const candles = this.metaApi.getCandles(symbol, 'M15', 100);
      if (candles.length < 50) {
        this.stats.candlesFailed++;
        logger.warn(`⚠️ ${symbol}: Insufficient candles (${candles.length}/50 required)`);
        return;
      }
      
      logger.debug(`📊 ${symbol}: Got ${candles.length} candles, latest close: ${candles[candles.length - 1]?.close}`);

      // Calculate indicators
      const indicators = this.indicatorCalc.calculate(candles);
      logger.debug(`📈 ${symbol}: RSI=${indicators.rsi?.toFixed(1)}, ATR=${indicators.atr?.toFixed(5)}`);
      
      // Detect market regime
      const regime = this.regimeDetector.detect(candles, indicators);
      logger.debug(`🎯 ${symbol}: Regime=${regime.type}, Trend=${regime.trend}`);

      // Pre-filter check
      const preFilterResult = this.preFilter.check(symbol, candles, indicators, regime);
      if (!preFilterResult.passed) {
        this.stats.preFilterFailed++;
        logger.info(`❌ ${symbol}: Pre-filter FAILED - ${preFilterResult.reason}`);
        return;
      }

      this.stats.preFilterPassed++;
      logger.info(`✅ ${symbol}: Pre-filter PASSED, running AI Council...`);

      // Get account info for position sizing
      const accountInfo = await this.metaApi.getAccountInfo();
      logger.debug(`💰 Account: Balance=$${accountInfo.balance}, Equity=$${accountInfo.equity}`);

      // Run AI Council analysis
      this.stats.aiCouncilCalls++;
      logger.info(`🤖 ${symbol}: Calling AI Council with price ${tick.bid}...`);
      
      const decision = await this.aiCouncil.analyze({
        symbol,
        assetType: 'forex',
        currentPrice: tick.bid,
        candles,
        indicators,
        regime,
        accountBalance: accountInfo.balance,
        riskPercent: this.settings.riskPercent || 5
      });

      logger.info(`🤖 ${symbol}: AI Council returned: ${decision.action} @ ${decision.confidence}% confidence`);
      logger.debug(`   Entry: ${decision.entryPrice}, SL: ${decision.stopLoss}, TP1: ${decision.takeProfit1}`);

      // Check confidence threshold
      const minConfidence = this.settings.minConfidence || 60;
      if (decision.action === 'HOLD' || decision.confidence < minConfidence) {
        logger.info(`⏸️ ${symbol}: Signal REJECTED - ${decision.action} at ${decision.confidence}% (min: ${minConfidence}%)`);
        logger.info(`   Reason: ${decision.reasoning?.slice(0, 100)}...`);
        return;
      }

      this.stats.signalsGenerated++;
      logger.info(`🎉 ${symbol}: Signal APPROVED - ${decision.action} @ ${decision.confidence}%`);

      // Save signal to database with proper userId
      logger.info(`💾 ${symbol}: Saving signal to database with userId: ${this.userId}...`);
      
      const signal = await this.signalRepo.saveSignal({
        userId: this.userId,
        symbol,
        assetType: 'forex',
        action: decision.action,
        confidence: decision.confidence,
        entryPrice: decision.entryPrice,
        stopLoss: decision.stopLoss,
        takeProfit1: decision.takeProfit1,
        takeProfit2: decision.takeProfit2,
        takeProfit3: decision.takeProfit3,
        reasoning: decision.reasoning,
        source: 'forex_monitor',
        marketRegime: regime.type,
        agentOutputs: decision.agentOutputs,
        agentScores: decision.agentScores
      });

      if (signal) {
        this.stats.signalsSaved++;
        logger.info(`✅ ${symbol}: Signal SAVED to database with ID: ${signal.id}`);
      } else {
        logger.error(`❌ ${symbol}: Failed to save signal to database!`);
      }

      this.pendingSignals++;

      // Execute trades on all active accounts
      logger.info(`🚀 ${symbol}: Executing trades on active accounts...`);
      const execResults = await this.executionRouter.executeSignal(signal, decision, this.userId);
      
      if (execResults && execResults.length > 0) {
        this.stats.tradesExecuted += execResults.length;
        logger.info(`✅ ${symbol}: Executed ${execResults.length} trades`);
        for (const result of execResults) {
          logger.info(`   Account: ${result.accountName}, Position: ${result.positionId}, Price: ${result.price}`);
        }
      } else {
        logger.warn(`⚠️ ${symbol}: No trades executed (check account balances/status)`);
      }

      // Send alert notification
      await this.alertManager.alertSignalFired(
        symbol,
        decision.action,
        decision.confidence,
        `Entry: ${decision.entryPrice}, SL: ${decision.stopLoss}, TP1: ${decision.takeProfit1}`
      );

    } catch (error) {
      this.stats.errors++;
      logger.error(`💥 ERROR processing ${symbol}:`, error);
    }
  }

  updateSettings(newSettings: Partial<TradingThresholds>): void {
    this.settings = { ...this.settings, ...newSettings };
    this.preFilter.updateThresholds(this.settings);
    logger.info(`⚙️ SignalProcessor settings updated: minConfidence=${this.settings.minConfidence}`);
  }

  getPendingCount(): number {
    return this.pendingSignals;
  }

  getStats(): ProcessingStats {
    return { ...this.stats };
  }

  stop(): void {
    this.isRunning = false;
    if (this.statsLogInterval) {
      clearInterval(this.statsLogInterval);
    }
    this.logStats(); // Final stats log
    logger.info('🛑 SignalProcessor stopped');
  }
}