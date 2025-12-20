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
  minConfidence: 70,        // Increased from 60 - higher quality signals
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

// Anti-scalping rules - UPGRADED for 30% monthly target
export const ANTI_SCALPING = {
  forex: {
    minTp1Pips: 40,         // Increased from 20 - no scalping
    minRiskReward: 2.0      // Increased from 1.0 - 2:1 minimum
  },
  metals: {
    minTp1Pips: 80,         // Increased from 50
    minRiskReward: 2.0
  },
  stocks: {
    minTp1Percent: 0.8,     // Increased from 0.5
    minRiskReward: 2.0
  },
  crypto: {
    minTp1Percent: 1.5,     // Increased from 1.0
    minRiskReward: 2.0
  }
};
