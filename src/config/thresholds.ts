// Default thresholds (will be overridden by database settings)
export interface TradingThresholds {
  minConfidence: number;
  minAtrPips: number;
  momentumThresholdPips: number;
  dailyLossLimitPct: number;
  weeklyLossLimitPct: number;
  maxConsecutiveLosses: number;
  consecutiveLossSizeReductionPct: number;
}

export const DEFAULT_THRESHOLDS: TradingThresholds = {
  minConfidence: 60,
  minAtrPips: 5,
  momentumThresholdPips: 8,
  dailyLossLimitPct: 10,
  weeklyLossLimitPct: 20,
  maxConsecutiveLosses: 5,
  consecutiveLossSizeReductionPct: 0
};

// Pre-filter thresholds
export const PREFILTER_THRESHOLDS = {
  // RSI thresholds
  rsiOversold: 30,
  rsiOverbought: 70,

  // ADX threshold for trending market
  adxTrending: 25,

  // Minimum candles for analysis
  minCandles: 50,

  // Max spread multiplier
  maxSpreadMultiplier: 2.0
};

// Anti-scalping rules
export const ANTI_SCALPING = {
  forex: {
    minTp1Pips: 20,
    minRiskReward: 1.0
  },
  metals: {
    minTp1Pips: 50,
    minRiskReward: 1.0
  },
  stocks: {
    minTp1Percent: 0.5,
    minRiskReward: 1.0
  },
  crypto: {
    minTp1Percent: 1.0,
    minRiskReward: 1.0
  }
};
