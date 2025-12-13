export type SignalAction = 'BUY' | 'SELL' | 'HOLD';
export type AssetType = 'forex' | 'stock' | 'crypto';
export type SignalSource = 'forex_monitor' | 'daily_scan' | 'manual';
export type SignalOutcome = 'pending' | 'win' | 'loss' | 'cancelled';

export interface Signal {
  id?: string;
  userId: string;
  symbol: string;
  assetType: AssetType;
  action: SignalAction;
  confidence: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2?: number;
  takeProfit3?: number;
  reasoning: string;
  source: SignalSource;
  marketRegime?: string;
  sentimentScore?: number;
  agentOutputs?: AgentOutputs;
  agentScores?: AgentScores;
  snapshotSettings?: any;
  createdAt?: Date;
}

export interface AgentOutputs {
  research?: ResearchOutput;
  technical?: TechnicalOutput;
  predictor?: PredictorOutput;
}

export interface AgentScores {
  research: number;
  technical: number;
  predictor: number;
}

export interface ResearchOutput {
  sentimentScore: number;
  reliability: number;
  newsSummary: string;
  upcomingEvents: string[];
  recommendation: string;
}

export interface TechnicalOutput {
  trendDirection: 'bullish' | 'bearish' | 'neutral';
  trendStrength: number;
  keyLevels: {
    support: number[];
    resistance: number[];
  };
  patternDetected: string;
  entryZone: {
    min: number;
    max: number;
  };
  confidence: number;
  reasoning: string;
}

export interface PredictorOutput {
  predictedDirection: 'up' | 'down' | 'sideways';
  predictedMove: number;
  confidence: number;
  timeframe: string;
  supportLevels: number[];
  resistanceLevels: number[];
}

export interface SignalDecision {
  action: SignalAction;
  confidence: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  takeProfit3: number;
  reasoning: string;
  agentOutputs: AgentOutputs;
  agentScores: AgentScores;
  systemRecommendation?: SystemRecommendation;
}

export interface SystemRecommendation {
  urgency: 'low' | 'medium' | 'high' | 'critical';
  type: string;
  recommendation: string;
  canAutoImplement: boolean;
  suggestedValues?: Record<string, any>;
}
