import { MetaApiManager } from '../services/websocket/MetaApiManager';
import { PreFilter } from '../services/analysis/PreFilter';
import { RegimeDetector } from '../services/analysis/RegimeDetector';
import { AICouncil } from '../services/ai/AICouncil';
import { ExecutionRouter } from '../services/execution/ExecutionRouter';
import { SignalRepository } from '../services/database/SignalRepository';
import { SettingsRepository } from '../services/database/SettingsRepository';
import { logger } from '../utils/logger';
import { Tick } from '../types/market';
import { TradingThresholds } from '../config/thresholds';
import { isForexMarketOpen, getCurrentSession } from '../utils/helpers';

interface ProcessingState {
  lastProcessed: Map<string, number>;
  pendingAnalysis: Set<string>;
  pendingCount: number;
}

export class SignalProcessor {
  private metaApi: MetaApiManager;
  private preFilter: PreFilter;
  private regimeDetector: RegimeDetector;
  private aiCouncil: AICouncil;
  private executionRouter: ExecutionRouter;
  private signalRepo: SignalRepository;
  private settingsRepo: SettingsRepository;
  private settings: TradingThresholds;
  private state: ProcessingState;
  private isRunning: boolean = true;

  // Minimum interval between processing same symbol (ms)
  private readonly PROCESS_INTERVAL = 30000; // 30 seconds

  constructor(metaApi: MetaApiManager, settings: TradingThresholds) {
    this.metaApi = metaApi;
    this.settings = settings;
    this.preFilter = new PreFilter({
      minAtrPips: settings.minAtrPips,
      momentumThresholdPips: settings.momentumThresholdPips
    });
    this.regimeDetector = new RegimeDetector();
    this.aiCouncil = new AICouncil();
    this.signalRepo = new SignalRepository();
    this.settingsRepo = new SettingsRepository();

    // Initialize execution router
    this.executionRouter = new ExecutionRouter(metaApi, {
      masterAccountId: process.env.METAAPI_ACCOUNT_ID!,
      userId: 'system', // Will be replaced with actual user ID
      defaultRiskPercent: 5
    });

    this.state = {
      lastProcessed: new Map(),
      pendingAnalysis: new Set(),
      pendingCount: 0
    };
  }

  async processTick(tick: Tick): Promise<void> {
    if (!this.isRunning) return;

    // Check if forex market is open
    if (!isForexMarketOpen()) {
      return;
    }

    // Check if we recently processed this symbol
    const lastProcessed = this.state.lastProcessed.get(tick.symbol) || 0;
    if (Date.now() - lastProcessed < this.PROCESS_INTERVAL) {
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

  private async analyzeSymbol(symbol: string, tick: Tick): Promise<void> {
    try {
      // Get candles
      const candles = this.metaApi.getCandles(symbol, '15m', 100);
      if (candles.length < 50) {
        return; // Not enough data
      }

      // Run pre-filter
      const preFilterResult = this.preFilter.analyze(symbol, candles);

      if (!preFilterResult.passed) {
        // Log the rejection
        await this.signalRepo.logDecision({
          userId: 'system',
          symbol,
          assetType: 'forex',
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

      // Run AI Council
      const decision = await this.aiCouncil.analyze({
        symbol,
        assetType: 'forex',
        currentPrice: (tick.bid + tick.ask) / 2,
        candles,
        indicators: preFilterResult.indicators!,
        regime,
        accountBalance: accountInfo.balance,
        riskPercent: 5
      });

      // Log the decision
      await this.signalRepo.logDecision({
        userId: 'system',
        symbol,
        assetType: 'forex',
        decision: decision.action,
        decisionType: 'ai_council',
        confidence: decision.confidence,
        narrative: decision.reasoning,
        engineConsensus: decision.agentScores,
        rejectionReason: decision.action === 'HOLD' ? decision.reasoning : undefined
      });

      // Execute if not HOLD and meets confidence threshold
      if (decision.action !== 'HOLD' && decision.confidence >= this.settings.minConfidence) {
        await this.executeSignal(symbol, decision, accountInfo.balance);
      }

    } catch (error) {
      logger.error(`Error analyzing ${symbol}:`, error);
    }
  }

  private async executeSignal(
    symbol: string,
    decision: any,
    accountBalance: number
  ): Promise<void> {
    // Save signal first
    const signalId = await this.signalRepo.saveSignal({
      userId: 'system',
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
      marketRegime: decision.regime?.type,
      agentOutputs: decision.agentOutputs,
      snapshotSettings: this.settings
    });

    if (!signalId) {
      logger.error('Failed to save signal, aborting execution');
      return;
    }

    // Execute trade
    const result = await this.executionRouter.executeTrade(
      {
        id: signalId,
        userId: 'system',
        symbol,
        assetType: 'forex',
        action: decision.action,
        confidence: decision.confidence,
        entryPrice: decision.entryPrice,
        stopLoss: decision.stopLoss,
        takeProfit1: decision.takeProfit1,
        reasoning: decision.reasoning,
        source: 'forex_monitor',
        snapshotSettings: this.settings
      },
      accountBalance
    );

    if (!result.success) {
      logger.error(`Trade execution failed for ${symbol}: ${result.error}`);
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

  stop(): void {
    this.isRunning = false;
    logger.info('Signal processor stopped');
  }
}
