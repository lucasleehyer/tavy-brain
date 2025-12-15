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
    
    logger.info(`SignalProcessor initialized with userId: ${userId}`);
  }

  async processTick(tick: Tick): Promise<void> {
    if (!this.isRunning) return;

    const symbol = tick.symbol;
    const now = Date.now();
    const lastTime = this.lastAnalysis.get(symbol) || 0;

    // Only analyze each symbol every analysisInterval
    if (now - lastTime < this.analysisInterval) {
      return;
    }

    this.lastAnalysis.set(symbol, now);

    try {
      // Get candles for analysis
      const candles = this.metaApi.getCandles(symbol, 'M15', 100);
      if (candles.length < 50) {
        logger.debug(`Not enough candles for ${symbol}: ${candles.length}`);
        return;
      }

      // Calculate indicators
      const indicators = this.indicatorCalc.calculate(candles);
      
      // Detect market regime
      const regime = this.regimeDetector.detect(candles, indicators);

      // Pre-filter check
      const preFilterResult = this.preFilter.check(symbol, candles, indicators, regime);
      if (!preFilterResult.passed) {
        logger.debug(`Pre-filter failed for ${symbol}: ${preFilterResult.reason}`);
        return;
      }

      logger.info(`Pre-filter passed for ${symbol}, running AI Council analysis...`);

      // Get account info for position sizing
      const accountInfo = await this.metaApi.getAccountInfo();

      // Run AI Council analysis
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

      // Check confidence threshold
      if (decision.action === 'HOLD' || decision.confidence < (this.settings.minConfidence || 60)) {
        logger.info(`Signal rejected for ${symbol}: ${decision.action} @ ${decision.confidence}% confidence`);
        return;
      }

      logger.info(`Signal approved for ${symbol}: ${decision.action} @ ${decision.confidence}%`);

      // Save signal to database with proper userId
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

      this.pendingSignals++;

      // Execute trades on all active accounts
      await this.executionRouter.executeSignal(signal, decision, this.userId);

      // Send alert notification
      await this.alertManager.alertSignalFired(
        symbol,
        decision.action,
        decision.confidence,
        `Entry: ${decision.entryPrice}, SL: ${decision.stopLoss}, TP1: ${decision.takeProfit1}`
      );

    } catch (error) {
      logger.error(`Error processing tick for ${symbol}:`, error);
    }
  }

  updateSettings(newSettings: Partial<TradingThresholds>): void {
    this.settings = { ...this.settings, ...newSettings };
    this.preFilter.updateThresholds(this.settings);
    logger.info('SignalProcessor settings updated');
  }

  getPendingCount(): number {
    return this.pendingSignals;
  }

  stop(): void {
    this.isRunning = false;
    logger.info('SignalProcessor stopped');
  }
}