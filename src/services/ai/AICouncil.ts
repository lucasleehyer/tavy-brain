import { ResearchAgent } from './ResearchAgent';
import { TechnicalAgent } from './TechnicalAgent';
import { PredictorAgent } from './PredictorAgent';
import { MasterOrchestrator } from './MasterOrchestrator';
import { logger } from '../../utils/logger';
import { Candle, Indicators, MarketRegime } from '../../types/market';
import { SignalDecision } from '../../types/signal';

interface AICouncilInput {
  symbol: string;
  assetType: 'forex' | 'stock' | 'crypto';
  currentPrice: number;
  candles: Candle[];
  indicators: Indicators;
  regime: MarketRegime;
  accountBalance: number;
  riskPercent: number;
}

export class AICouncil {
  private researchAgent: ResearchAgent;
  private technicalAgent: TechnicalAgent;
  private predictorAgent: PredictorAgent;
  private masterOrchestrator: MasterOrchestrator;

  constructor() {
    this.researchAgent = new ResearchAgent();
    this.technicalAgent = new TechnicalAgent();
    this.predictorAgent = new PredictorAgent();
    this.masterOrchestrator = new MasterOrchestrator();
  }

  async analyze(input: AICouncilInput): Promise<SignalDecision> {
    const startTime = Date.now();
    logger.info(`AI Council analyzing ${input.symbol}...`);

    try {
      // Run all agents in parallel for speed
      const [research, technical, predictor] = await Promise.all([
        this.researchAgent.analyze(input.symbol, input.assetType),
        this.technicalAgent.analyze(input.candles, input.indicators, input.regime),
        this.predictorAgent.predict(input.symbol, input.candles, input.currentPrice)
      ]);

      logger.info(`Agents completed: Research=${research.sentimentScore}, Technical=${technical.confidence}%, Predictor=${predictor.confidence}%`);

      // Master Orchestrator synthesizes all inputs
      const decision = await this.masterOrchestrator.orchestrate({
        symbol: input.symbol,
        assetType: input.assetType,
        currentPrice: input.currentPrice,
        regime: input.regime,
        accountBalance: input.accountBalance,
        riskPercent: input.riskPercent,
        agentOutputs: { research, technical, predictor }
      });

      const duration = Date.now() - startTime;
      logger.info(`AI Council completed in ${duration}ms: ${decision.action} @ ${decision.confidence}%`);

      return decision;

    } catch (error) {
      logger.error('AI Council error:', error);

      return {
        action: 'HOLD',
        confidence: 0,
        entryPrice: input.currentPrice,
        stopLoss: 0,
        takeProfit1: 0,
        takeProfit2: 0,
        takeProfit3: 0,
        reasoning: `AI Council error: ${(error as Error).message}`,
        agentOutputs: { research: null, technical: null, predictor: null } as any,
        agentScores: { research: 0, technical: 0, predictor: 0 }
      };
    }
  }
}