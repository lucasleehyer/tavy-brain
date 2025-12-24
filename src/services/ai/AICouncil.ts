import { ResearchAgent } from './ResearchAgent';
import { TechnicalAgent } from './TechnicalAgent';
import { PredictorAgent } from './PredictorAgent';
import { MasterOrchestrator } from './MasterOrchestrator';
import { KeyLevelDetector, KeyLevelResult } from '../analysis/KeyLevelDetector';
import { MTFTrendFilter } from '../analysis/MTFTrendFilter';
import { StructureValidator } from '../analysis/StructureValidator';
import { CorrelationGuard } from '../risk/CorrelationGuard';
import { SessionFilter } from '../analysis/SessionFilter';
import { PerformanceTracker } from '../analysis/PerformanceTracker';
import { logger } from '../../utils/logger';
import { Candle, Indicators, MarketRegime } from '../../types/market';
import { SignalDecision } from '../../types/signal';
import { MTFTrendResult, StructureResult, CorrelationResult, SessionResult } from '../../types/quant';

interface MultiTimeframeCandles {
  '5m': Candle[];
  '15m': Candle[];
  '1h': Candle[];
  '4h': Candle[];
}

interface AICouncilInput {
  symbol: string;
  assetType: 'forex' | 'stock' | 'crypto';
  currentPrice: number;
  candles: Candle[] | MultiTimeframeCandles;
  indicators: Indicators;
  regime: MarketRegime;
  accountBalance: number;
  riskPercent: number;
  openPositions?: { symbol: string; direction: 'long' | 'short' }[];
}

export class AICouncil {
  private researchAgent: ResearchAgent;
  private technicalAgent: TechnicalAgent;
  private predictorAgent: PredictorAgent;
  private masterOrchestrator: MasterOrchestrator;
  private keyLevelDetector: KeyLevelDetector;
  // Phase 1 filters
  private mtfTrendFilter: MTFTrendFilter;
  private structureValidator: StructureValidator;
  private correlationGuard: CorrelationGuard;
  private sessionFilter: SessionFilter;
  private performanceTracker: PerformanceTracker;

  constructor() {
    this.researchAgent = new ResearchAgent();
    this.technicalAgent = new TechnicalAgent();
    this.predictorAgent = new PredictorAgent();
    this.masterOrchestrator = new MasterOrchestrator();
    this.keyLevelDetector = new KeyLevelDetector();
    // Initialize Phase 1 filters
    this.mtfTrendFilter = new MTFTrendFilter();
    this.structureValidator = new StructureValidator();
    this.correlationGuard = new CorrelationGuard();
    this.sessionFilter = new SessionFilter();
    this.performanceTracker = new PerformanceTracker();
  }

  async analyze(input: AICouncilInput): Promise<SignalDecision> {
    const startTime = Date.now();
    logger.info(`AI Council analyzing ${input.symbol}...`);

    try {
      // Get candles for different timeframes
      const technicalCandles = this.getTechnicalCandles(input.candles);
      const mtfCandles = this.getMTFCandles(input.candles);
      const atr = input.indicators.atr || 0;

      // ========== PHASE 1: Pre-filters (run in parallel) ==========
      const [mtfTrend, session, correlation] = await Promise.all([
        this.mtfTrendFilter.analyze(mtfCandles),
        Promise.resolve(this.sessionFilter.check(input.symbol)),
        Promise.resolve(this.correlationGuard.check(input.symbol, 'long', input.openPositions || []))
      ]);

      logger.info(`[Phase 1] MTF=${mtfTrend.allowedDirection}, Session=${session.canTrade ? 'OK' : session.reason}, Correlation=${correlation.canTrade ? 'OK' : correlation.reason}`);

      // Early exit if MTF conflicts
      if (mtfTrend.allowedDirection === 'none') {
        logger.info(`[AI Council] ${input.symbol}: Blocked by MTF - conflicting timeframe trends`);
        return this.createHoldDecision(input.currentPrice, 'MTF trend conflict - timeframes not aligned');
      }

      // Early exit if session is bad
      if (!session.canTrade) {
        logger.info(`[AI Council] ${input.symbol}: Blocked by session filter - ${session.reason}`);
        return this.createHoldDecision(input.currentPrice, `Session: ${session.reason}`);
      }

      // ========== PHASE 1b: Structure Validation ==========
      let structure: StructureResult | undefined;
      if (atr > 0 && technicalCandles.length >= 20) {
        structure = this.structureValidator.validate(technicalCandles, input.currentPrice, atr);
        logger.info(`[Phase 1] Structure: ${structure.structureType} (${structure.entryQuality})`);
        
        if (structure.entryQuality === 'invalid') {
          logger.info(`[AI Council] ${input.symbol}: Blocked by structure - no valid entry point`);
          return this.createHoldDecision(input.currentPrice, 'No valid market structure for entry');
        }
      }

      // ========== PHASE 2: Run AI Agents in parallel ==========
      const [research, technical, predictor] = await Promise.all([
        this.researchAgent.analyze(input.symbol, input.assetType),
        this.technicalAgent.analyze(technicalCandles, input.indicators, input.regime),
        this.predictorAgent.predict(input.symbol, input.candles, input.currentPrice)
      ]);

      logger.info(`[Phase 2] Agents: Research=${research.sentimentScore.toFixed(2)}, Technical=${technical.confidence}%, Predictor=${predictor.confidence}%`);

      // ========== PHASE 3: Detect key levels ==========
      let keyLevels: KeyLevelResult | null = null;
      if (atr > 0 && technicalCandles.length >= 20) {
        keyLevels = this.keyLevelDetector.detect(technicalCandles, input.currentPrice, atr);
        logger.info(`[Phase 3] Key levels: Support=${keyLevels.nearestSupport?.toFixed(5) || 'N/A'}, Resistance=${keyLevels.nearestResistance?.toFixed(5) || 'N/A'}`);
      }

      // ========== PHASE 4: Master Orchestrator (includes Phase 2+3 quant validation) ==========
      const decision = await this.masterOrchestrator.orchestrate({
        symbol: input.symbol,
        assetType: input.assetType,
        currentPrice: input.currentPrice,
        regime: input.regime,
        accountBalance: input.accountBalance,
        riskPercent: input.riskPercent,
        agentOutputs: { research, technical, predictor },
        atr,
        keyLevels: keyLevels ? {
          nearestSupport: keyLevels.nearestSupport,
          nearestResistance: keyLevels.nearestResistance,
          atKeyLevel: keyLevels.atKeyLevel,
          levelType: keyLevels.levelType
        } : undefined,
        // Pass Phase 1 filter results
        mtfTrend,
        structure,
        correlation,
        session
      });

      const duration = Date.now() - startTime;
      logger.info(`AI Council completed in ${duration}ms: ${decision.action} @ ${decision.confidence}%`);
      
      // Log SL/TP distances for verification
      if (decision.action !== 'HOLD' && atr > 0) {
        const slDistance = Math.abs(decision.entryPrice - decision.stopLoss);
        const tp1Distance = Math.abs(decision.takeProfit1 - decision.entryPrice);
        const slAtrRatio = slDistance / atr;
        const tp1AtrRatio = tp1Distance / atr;
        logger.info(`[AI Council] SL=${slDistance.toFixed(5)} (${slAtrRatio.toFixed(1)}x ATR), TP1=${tp1Distance.toFixed(5)} (${tp1AtrRatio.toFixed(1)}x ATR)`);
        
        if (slAtrRatio < 1.5) {
          logger.warn(`[AI Council] ⚠️ SL is only ${slAtrRatio.toFixed(1)}x ATR - should be at least 1.5x!`);
        }
      }

      return decision;

    } catch (error) {
      logger.error('AI Council error:', error);
      return this.createHoldDecision(input.currentPrice, `AI Council error: ${(error as Error).message}`);
    }
  }

  private createHoldDecision(currentPrice: number, reason: string): SignalDecision {
    return {
      action: 'HOLD',
      confidence: 0,
      entryPrice: currentPrice,
      stopLoss: 0,
      takeProfit1: 0,
      takeProfit2: 0,
      takeProfit3: 0,
      reasoning: reason,
      agentOutputs: { research: null, technical: null, predictor: null } as any,
      agentScores: { research: 0, technical: 0, predictor: 0 }
    };
  }

  private getMTFCandles(candles: Candle[] | MultiTimeframeCandles): MultiTimeframeCandles {
    if (Array.isArray(candles)) {
      // If only single timeframe provided, use it for all
      return {
        '5m': candles,
        '15m': candles,
        '1h': candles,
        '4h': candles
      };
    }
    return candles;
  }

  private getTechnicalCandles(candles: Candle[] | MultiTimeframeCandles): Candle[] {
    if (Array.isArray(candles)) {
      return candles;
    }
    // For multi-timeframe, use 15m for technical analysis
    const mtf = candles as MultiTimeframeCandles;
    return mtf['15m'] || mtf['1h'] || mtf['5m'] || [];
  }
}