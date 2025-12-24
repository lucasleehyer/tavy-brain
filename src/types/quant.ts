/**
 * Quant Brain Types - All type definitions for the Quant Brain system
 */

// ═══════════════════════════════════════════════════════════════
//                     MTF TREND FILTER TYPES
// ═══════════════════════════════════════════════════════════════

export type TrendDirection = 'bullish' | 'bearish' | 'neutral';
export type AllowedDirection = 'long' | 'short' | 'none';

export interface TimeframeTrend {
  timeframe: '4h' | '1h' | '15m' | '5m';
  direction: TrendDirection;
  strength: number; // 0-100
  ema20: number;
  ema50: number;
  price: number;
  confidence: number;
}

export interface MTFTrendResult {
  allowedDirection: AllowedDirection;
  trends: {
    '4h': TimeframeTrend;
    '1h': TimeframeTrend;
    '15m': TimeframeTrend;
  };
  alignment: 'full' | 'partial' | 'conflicting';
  overallStrength: number;
  reason: string;
}

// ═══════════════════════════════════════════════════════════════
//                     STRUCTURE VALIDATOR TYPES
// ═══════════════════════════════════════════════════════════════

export type EntryQuality = 'excellent' | 'good' | 'poor' | 'invalid';
export type StructureType = 'support' | 'resistance' | 'orderblock' | 'fvg' | 'none';

export interface StructureResult {
  entryQuality: EntryQuality;
  structureType: StructureType;
  nearestLevel: number;
  distanceToLevel: number;
  distanceInATR: number;
  withinRange: boolean;
  orderBlockDetected: boolean;
  fvgDetected: boolean;
  reason: string;
  recentCandles?: import('./market').Candle[]; // For Entry Optimizer
}

// ═══════════════════════════════════════════════════════════════
//                     CORRELATION GUARD TYPES
// ═══════════════════════════════════════════════════════════════

export interface CorrelationResult {
  canTrade: boolean;
  conflictingPositions: string[];
  netExposure: {
    USD: number;
    EUR: number;
    GBP: number;
    JPY: number;
    CHF: number;
    AUD: number;
    CAD: number;
    NZD: number;
  };
  correlationRisk: 'low' | 'medium' | 'high';
  reason: string;
}

// ═══════════════════════════════════════════════════════════════
//                     REGIME STRATEGY TYPES
// ═══════════════════════════════════════════════════════════════

export type RegimePlaybook = 'TREND_FOLLOW' | 'FADE_EXTREMES' | 'BREAKOUT_CONFIRM' | 'PULLBACK_ENTRY';

export interface RegimeStrategy {
  playbook: RegimePlaybook;
  entryRules: string[];
  exitRules: string[];
  positionSizeMultiplier: number;
  maxHoldingPeriod: string;
  preferredTimeframes: string[];
}

export interface RegimeStrategyResult {
  strategy: RegimeStrategy;
  isValidSetup: boolean;
  adjustments: string[];
  reason: string;
}

// ═══════════════════════════════════════════════════════════════
//                     SESSION FILTER TYPES
// ═══════════════════════════════════════════════════════════════

export type SessionName = 'asian' | 'london' | 'new_york' | 'london_ny_overlap' | 'off_hours';

export interface SessionInfo {
  name: SessionName;
  isActive: boolean;
  liquidity: 'low' | 'medium' | 'high';
  volatility: 'low' | 'medium' | 'high';
  hoursUntilNext: number;
  nextSession: SessionName;
}

export interface SessionFilterResult {
  canTrade: boolean;
  session: SessionInfo;
  positionSizeMultiplier: number;
  newsProximityMinutes: number | null;
  newsImpact: 'low' | 'medium' | 'high' | null;
  reason: string;
}

// Backward compatibility aliases
export type SessionResult = SessionFilterResult;

// Re-export for AICouncil
export interface OpenPosition {
  symbol: string;
  direction: 'long' | 'short';
  size: number;
}

// ═══════════════════════════════════════════════════════════════
//                     CONFIDENCE CALCULATOR TYPES
// ═══════════════════════════════════════════════════════════════

export interface ConfidenceAdjustment {
  source: string;
  adjustment: number;
  reason: string;
}

export interface ConfidenceResult {
  baseConfidence: number;
  adjustedConfidence: number;
  adjustments: ConfidenceAdjustment[];
  meetsThreshold: boolean;
  threshold: number;
  reason: string;
}

// ═══════════════════════════════════════════════════════════════
//                     BAYESIAN ENGINE TYPES
// ═══════════════════════════════════════════════════════════════

export interface BayesianResult {
  posteriorWinRate: number;
  credibleInterval: {
    lower: number;
    upper: number;
    confidence: number;
  };
  uncertainty: number;
  kellyAdjustment: number;
  recommendedSizeMultiplier: number;
  sampleSize: number;
  reason: string;
}

// ═══════════════════════════════════════════════════════════════
//                     MONTE CARLO TYPES
// ═══════════════════════════════════════════════════════════════

export interface MonteCarloResult {
  probHitTP: number;
  probHitSL: number;
  expectedPnL: number;
  medianTimeToHit: number;
  riskRewardValidated: boolean;
  simulationCount: number;
  paths: {
    winPaths: number;
    lossPaths: number;
    timeoutPaths: number;
  };
  reason: string;
}

// ═══════════════════════════════════════════════════════════════
//                     ENTRY OPTIMIZER TYPES
// ═══════════════════════════════════════════════════════════════

export interface EntryOptimizationResult {
  optimalEntry: number;
  entryZone: {
    min: number;
    max: number;
  };
  waitTimeMinutes: number;
  fillProbability: number;
  expectedImprovement: number; // pips
  useLimit: boolean;
  reason: string;
}

// ═══════════════════════════════════════════════════════════════
//                     DRAWDOWN CONTROLLER TYPES
// ═══════════════════════════════════════════════════════════════

export type DrawdownState = 'NORMAL' | 'CAUTION' | 'DANGER' | 'STOPPED';

export interface DrawdownResult {
  state: DrawdownState;
  currentDrawdown: number;
  maxDrawdown: number;
  consecutiveLosses: number;
  sizeMultiplier: number;
  canTrade: boolean;
  cooldownMinutes: number;
  reason: string;
}

// ═══════════════════════════════════════════════════════════════
//                     OPTIMAL TRANSPORT TYPES
// ═══════════════════════════════════════════════════════════════

export interface DistanceResult {
  distanceToWinners: number;
  distanceToLosers: number;
  distanceRatio: number;
  isStrongSignal: boolean;
  featureVector: {
    confluence: number;
    confidence: number;
    regime: string;
    structure: number;
    session: string;
    mtfAlignment: number;
  };
  reason: string;
}

// ═══════════════════════════════════════════════════════════════
//                     PERFORMANCE TRACKER TYPES
// ═══════════════════════════════════════════════════════════════

export interface PerformanceMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWinPips: number;
  avgLossPips: number;
  profitFactor: number;
  sharpeRatio: number;
  maxDrawdown: number;
  consecutiveWins: number;
  consecutiveLosses: number;
}

export interface PerformanceBreakdown {
  bySymbol: Record<string, PerformanceMetrics>;
  byRegime: Record<string, PerformanceMetrics>;
  bySession: Record<string, PerformanceMetrics>;
  byStructure: Record<string, PerformanceMetrics>;
  overall: PerformanceMetrics;
}

export interface PerformanceTrackerResult {
  lastUpdated: Date;
  lookbackDays: number;
  breakdown: PerformanceBreakdown;
  rollingWinRate: number;
  trend: 'improving' | 'stable' | 'declining';
}

// ═══════════════════════════════════════════════════════════════
//                     QUANT FILTER COMBINED RESULT
// ═══════════════════════════════════════════════════════════════

export interface QuantFilterResult {
  canTrade: boolean;
  mtf: MTFTrendResult;
  structure: StructureResult;
  correlation: CorrelationResult;
  session: SessionFilterResult;
  regime: RegimeStrategyResult;
  confidence: ConfidenceResult;
  drawdown: DrawdownResult;
  bayesian?: BayesianResult;
  monteCarlo?: MonteCarloResult;
  entryOptimizer?: EntryOptimizationResult;
  distance?: DistanceResult;
  finalSizeMultiplier: number;
  blockReasons: string[];
}
