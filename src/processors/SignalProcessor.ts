import { MetaApiManager } from '../services/websocket/MetaApiManager';
import { PreFilter } from '../services/analysis/PreFilter';
import { CryptoPreFilter } from '../services/analysis/CryptoPreFilter';
import { RegimeDetector } from '../services/analysis/RegimeDetector';
import { AICouncil } from '../services/ai/AICouncil';
import { ExecutionRouter } from '../services/execution/ExecutionRouter';
import { SignalRepository } from '../services/database/SignalRepository';
import { SettingsRepository } from '../services/database/SettingsRepository';
import { SupabaseManager } from '../services/database/SupabaseClient';
import { KellyCalculator } from '../services/risk/KellyCalculator';
import { MomentumTracker } from '../services/risk/MomentumTracker';
import { DrawdownManager } from '../services/risk/DrawdownManager';
import { activityLogger } from '../services/database/ActivityLogger';
import { logger } from '../utils/logger';
import { Tick, Candle } from '../types/market';
import { TradingThresholds, CRYPTO_THRESHOLDS } from '../config/thresholds';
import { isMarketOpen, getCurrentSession } from '../utils/helpers';
import { getAssetType, isCryptoPair } from '../config/pairs';

interface ProcessingState {
  lastProcessed: Map<string, number>;
  pendingAnalysis: Set<string>;
  pendingCount: number;
  dailyApiCalls: number;
  lastApiCallReset: Date;
  dailyTradeCount: number;
}

interface MultiTimeframeCandles {
  '5m': Candle[];
  '15m': Candle[];
  '1h': Candle[];
  '4h': Candle[];
}

export class SignalProcessor {
  private metaApi: MetaApiManager;
  private preFilter: PreFilter;
  private cryptoPreFilter: CryptoPreFilter;
  private regimeDetector: RegimeDetector;
  private aiCouncil: AICouncil;
  private executionRouter: ExecutionRouter;
  private signalRepo: SignalRepository;
  private settingsRepo: SettingsRepository;
  private kellyCalculator: KellyCalculator;
  private momentumTracker: MomentumTracker;
  private drawdownManager: DrawdownManager;
  private settings: TradingThresholds;
  private state: ProcessingState;
  private isRunning: boolean = true;

  // Processing intervals by asset type
  private readonly CRYPTO_PROCESS_INTERVAL = 300000;  // 5 minutes for crypto
  private readonly FOREX_PROCESS_INTERVAL = 900000;   // 15 minutes for forex
  private readonly STOCK_PROCESS_INTERVAL = 1800000;  // 30 minutes for stocks (API protection)
  private readonly INDEX_PROCESS_INTERVAL = 1200000;  // 20 minutes for indices
  private readonly MAX_DAILY_API_CALLS = 200; // Conservative limit for full auto-discovery

  constructor(metaApi: MetaApiManager, settings: TradingThresholds) {
    this.metaApi = metaApi;
    this.settings = settings;
    this.preFilter = new PreFilter({
      minAtrPips: settings.minAtrPips,
      momentumThresholdPips: settings.momentumThresholdPips
    });
    this.cryptoPreFilter = new CryptoPreFilter();
    this.regimeDetector = new RegimeDetector();
    this.aiCouncil = new AICouncil();
    this.signalRepo = new SignalRepository();
    this.settingsRepo = new SettingsRepository();
    this.kellyCalculator = new KellyCalculator({ kellyFraction: 0.5, maxRiskPercent: 5 });
    this.momentumTracker = new MomentumTracker();
    this.drawdownManager = new DrawdownManager();

    // Initialize execution router with authenticated user ID and default risk
    const userId = SupabaseManager.getInstance().getUserId();
    this.executionRouter = new ExecutionRouter({
      userId,
      defaultRiskPercent: 10 // Default, will be read from DB
    });

    this.state = {
      lastProcessed: new Map(),
      pendingAnalysis: new Set(),
      pendingCount: 0,
      dailyApiCalls: 0,
      lastApiCallReset: new Date(),
      dailyTradeCount: 0
    };

    // Initialize risk managers
    this.initializeRiskManagers();
  }

  private async initializeRiskManagers(): Promise<void> {
    try {
      await Promise.all([
        this.momentumTracker.initialize(),
        this.drawdownManager.initialize()
      ]);
      logger.info('[SIGNAL-PROCESSOR] Risk managers initialized');
    } catch (error) {
      logger.error('Failed to initialize risk managers:', error);
    }
  }

  private getProcessInterval(assetType: string, isCrypto: boolean): number {
    if (isCrypto) return this.CRYPTO_PROCESS_INTERVAL;
    if (assetType === 'stock') return this.STOCK_PROCESS_INTERVAL;
    if (assetType === 'index') return this.INDEX_PROCESS_INTERVAL;
    return this.FOREX_PROCESS_INTERVAL; // Default for forex, commodities, etc.
  }

  async processTick(tick: Tick): Promise<void> {
    if (!this.isRunning) return;

    const isCrypto = isCryptoPair(tick.symbol);
    const assetType = getAssetType(tick.symbol);
    
    // Get appropriate processing interval based on asset type
    const processInterval = this.getProcessInterval(assetType, isCrypto);

    // Check if market is open for this symbol (forex has schedule, crypto is 24/7)
    if (!isMarketOpen(tick.symbol)) {
      return;
    }

    // Reset daily API call counter at midnight UTC
    this.checkAndResetDailyCounter();

    // Check daily API call limit
    if (this.state.dailyApiCalls >= this.MAX_DAILY_API_CALLS) {
      logger.warn(`Daily API call limit reached (${this.MAX_DAILY_API_CALLS}), skipping analysis`);
      return;
    }

    // Check if AI is enabled (kill switch)
    const aiEnabled = await this.settingsRepo.isAIEnabled();
    if (!aiEnabled) {
      return;
    }

    // Check if we recently processed this symbol (faster for crypto)
    const lastProcessed = this.state.lastProcessed.get(tick.symbol) || 0;
    if (Date.now() - lastProcessed < processInterval) {
      return;
    }

    // Check if already being analyzed
    if (this.state.pendingAnalysis.has(tick.symbol)) {
      return;
    }

    // Mark as being processed
    this.state.lastProcessed.set(tick.symbol, Date.now());
    this.state.pendingAnalysis.add(tick.symbol);

    try {
      await this.analyzeSymbol(tick.symbol, tick);
    } finally {
      this.state.pendingAnalysis.delete(tick.symbol);
    }
  }

  private checkAndResetDailyCounter(): void {
    const now = new Date();
    const lastReset = this.state.lastApiCallReset;
    
    // Check if it's a new day (UTC)
    if (now.getUTCDate() !== lastReset.getUTCDate() || 
        now.getUTCMonth() !== lastReset.getUTCMonth() ||
        now.getUTCFullYear() !== lastReset.getUTCFullYear()) {
      this.state.dailyApiCalls = 0;
      this.state.lastApiCallReset = now;
      logger.info('Daily API call counter reset');
    }
  }

  private async analyzeSymbol(symbol: string, tick: Tick): Promise<void> {
    const assetType = getAssetType(symbol);
    
    try {
      // Log that we're analyzing
      await activityLogger.logAnalyzing(symbol);

      // Get multi-timeframe candles
      const mtfCandles = await this.getMultiTimeframeCandles(symbol);
      
      // Use 15m candles for pre-filter
      const candles15m = mtfCandles['15m'];
      if (candles15m.length < 50) {
        return; // Not enough data
      }

      // Run pre-filter on 15m candles
      const preFilterResult = this.preFilter.analyze(symbol, candles15m);

      if (!preFilterResult.passed) {
        await this.signalRepo.logDecision({
          symbol,
          assetType,
          decision: 'REJECTED',
          decisionType: 'pre_filter',
          confidence: 0,
          narrative: preFilterResult.reason || 'Pre-filter rejected',
          rejectionReason: preFilterResult.reason
        });
        return;
      }

      // Check for duplicate pending signal
      const hasDuplicate = await this.signalRepo.checkDuplicateSignal(symbol);
      if (hasDuplicate) {
        logger.info(`${symbol}: Skipping - pending signal already exists`);
        return;
      }

      // Detect market regime
      const regime = this.regimeDetector.detect(preFilterResult.indicators!);

      // Get account info
      const accountInfo = await this.metaApi.getAccountInfo();

      // Get risk percent from database
      const riskPercent = await this.settingsRepo.getRiskPercent();

      // Increment API call counter (we're about to call AI)
      this.state.dailyApiCalls++;
      logger.info(`[API-USAGE] ${symbol} (${assetType}) | Calls: ${this.state.dailyApiCalls}/${this.MAX_DAILY_API_CALLS} | Remaining: ${this.MAX_DAILY_API_CALLS - this.state.dailyApiCalls}`);

      // Run AI Council with multi-timeframe data
      const decision = await this.aiCouncil.analyze({
        symbol,
        assetType,
        currentPrice: (tick.bid + tick.ask) / 2,
        candles: mtfCandles,
        indicators: preFilterResult.indicators!,
        regime,
        accountBalance: accountInfo.balance,
        riskPercent
      });

      // Log the decision
      await this.signalRepo.logDecision({
        symbol,
        assetType,
        decision: decision.action,
        decisionType: 'ai_council',
        confidence: decision.confidence,
        narrative: decision.reasoning,
        engineConsensus: decision.agentScores,
        rejectionReason: decision.action === 'HOLD' ? decision.reasoning : undefined
      });

      // Log decision to activity feed
      await activityLogger.logDecision(symbol, decision.action, decision.confidence);

      // Execute if not HOLD and meets confidence threshold (now 70%)
      if (decision.action !== 'HOLD' && decision.confidence >= this.settings.minConfidence) {
        await activityLogger.logSignal(symbol, decision.action, decision.confidence);
        await this.executeSignal(symbol, decision, accountInfo.balance, riskPercent);
      }

    } catch (error) {
      logger.error(`Error analyzing ${symbol}:`, error);
      await activityLogger.logError(`Error analyzing ${symbol}`, { error: (error as Error).message });
    }
  }

  private async getMultiTimeframeCandles(symbol: string): Promise<MultiTimeframeCandles> {
    // Fetch candles for all timeframes
    const [candles5m, candles15m, candles1h, candles4h] = await Promise.all([
      Promise.resolve(this.metaApi.getCandles(symbol, '5m', 50)),
      Promise.resolve(this.metaApi.getCandles(symbol, '15m', 100)),
      Promise.resolve(this.metaApi.getCandles(symbol, '1h', 50)),
      Promise.resolve(this.metaApi.getCandles(symbol, '4h', 30))
    ]);

    return {
      '5m': candles5m,
      '15m': candles15m,
      '1h': candles1h,
      '4h': candles4h
    };
  }

  private async executeSignal(
    symbol: string,
    decision: any,
    accountBalance: number,
    riskPercent: number
  ): Promise<void> {
    const assetType = getAssetType(symbol);
    
    // Save signal first (user ID handled internally by SignalRepository)
    const signalId = await this.signalRepo.saveSignal({
      userId: SupabaseManager.getInstance().getUserId(),
      symbol,
      assetType,
      action: decision.action,
      confidence: decision.confidence,
      entryPrice: decision.entryPrice,
      stopLoss: decision.stopLoss,
      takeProfit1: decision.takeProfit1,
      takeProfit2: decision.takeProfit2,
      takeProfit3: decision.takeProfit3,
      reasoning: decision.reasoning,
      source: 'forex_monitor',
      marketRegime: decision.regime?.type,
      agentOutputs: decision.agentOutputs,
      snapshotSettings: { ...this.settings, riskPercent }
    });

    if (!signalId) {
      logger.error('Failed to save signal, aborting execution');
      return;
    }

    // Update execution router with current risk percent
    this.executionRouter.updateRiskPercent(riskPercent);

    // Execute trade (returns array of results for all accounts)
    const userId = SupabaseManager.getInstance().getUserId();
    const results = await this.executionRouter.executeTrade({
      id: signalId,
      userId,
      symbol,
      assetType,
      action: decision.action,
      confidence: decision.confidence,
      entryPrice: decision.entryPrice,
      stopLoss: decision.stopLoss,
      takeProfit1: decision.takeProfit1,
      reasoning: decision.reasoning,
      source: 'forex_monitor',
      snapshotSettings: { ...this.settings, riskPercent }
    });

    const successCount = results.filter(r => r.success).length;
    const failedResults = results.filter(r => !r.success);

    if (successCount > 0) {
      await activityLogger.logTrade(symbol, `${successCount} account(s)`, decision.action);
    }
    
    if (failedResults.length > 0) {
      const errors = failedResults.map(r => `${r.accountName || 'Unknown'}: ${r.error}`).join('; ');
      logger.error(`Trade execution failed on ${failedResults.length} account(s) for ${symbol}: ${errors}`);
      await activityLogger.logError(`Trade execution failed for ${symbol}`, { error: errors });
    }
  }

  updateSettings(newSettings: Partial<TradingThresholds>): void {
    this.settings = { ...this.settings, ...newSettings };
    this.preFilter.updateThresholds({
      minAtrPips: this.settings.minAtrPips,
      momentumThresholdPips: this.settings.momentumThresholdPips
    });
    logger.info('Signal processor settings updated');
  }

  getPendingCount(): number {
    return this.state.pendingAnalysis.size;
  }

  getDailyApiCalls(): number {
    return this.state.dailyApiCalls;
  }

  stop(): void {
    this.isRunning = false;
    logger.info('Signal processor stopped');
  }
}
