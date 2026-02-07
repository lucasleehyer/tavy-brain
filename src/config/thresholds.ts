// Default thresholds (will be overridden by database settings)
export interface TradingThresholds {
  minConfidence: number;
  minAtrPips: number;
  momentumThresholdPips: number;
  dailyLossLimitPct: number;
  weeklyLossLimitPct: number;
  maxConsecutiveLosses: number;
  consecutiveLossSizeReductionPct: number;
  // Confluence scoring
  minConfluenceScore: number;
}

// RELAXED for 1+ trade/day during active sessions
export const DEFAULT_THRESHOLDS: TradingThresholds = {
  minConfidence: 60,        // Reduced from 70 - allow more AI flexibility
  minAtrPips: 3,
  momentumThresholdPips: 6,
  dailyLossLimitPct: 10,
  weeklyLossLimitPct: 20,
  maxConsecutiveLosses: 5,
  consecutiveLossSizeReductionPct: 0,
  minConfluenceScore: 55    // Reduced from 60 - easier entry
};

// Pre-filter thresholds - RELAXED for 1+ trade/day
export const PREFILTER_THRESHOLDS = {
  // RSI thresholds - widened zones
  rsiOversold: 35,
  rsiOverbought: 65,

  // ADX threshold for trending market (reduced from 22 to catch earlier trends)
  adxTrending: 12,

  // Minimum candles for analysis
  minCandles: 50,

  // Max spread multiplier
  maxSpreadMultiplier: 2.0
};

// Session trading hours (UTC)
export const SESSION_CONFIG = {
  london: {
    start: 6,   // 6:00 UTC
    end: 16,    // 16:00 UTC
  },
  newYork: {
    start: 13,  // 13:00 UTC
    end: 22,    // 22:00 UTC
  },
  overlap: {
    start: 13,  // 13:00 UTC
    end: 16,    // 16:00 UTC (London-NY overlap)
  },
  asian: {
    start: 0,   // 00:00 UTC
    end: 8,     // 08:00 UTC
  },
  // First/last minutes to exclude from each session (reduced from 30)
  sessionBufferMinutes: 15
};

// Spread limits by pair type (in pips)
export const SPREAD_LIMITS = {
  majors: 2.0,      // EUR/USD, GBP/USD, USD/JPY, etc.
  crosses: 3.0,     // EUR/GBP, GBP/JPY, etc.
  exotics: 5.0,     // USD/ZAR, EUR/TRY, etc.
  metals: 3.5,      // XAU/USD, XAG/USD
};

// News filter timing (minutes)
export const NEWS_FILTER = {
  highImpact: {
    before: 15,     // 15 min before high-impact news
    after: 30,      // 30 min after high-impact news
  },
  mediumImpact: {
    before: 5,
    after: 10,
  }
};

// Extreme volatility thresholds
export const VOLATILITY_GATES = {
  // Pause if 15m range > this multiplier of average 15m range
  extremeRangeMultiplier: 4.0,
  // Minimum movement in pips in last 2 hours (reduced from 10)
  minActivityPips: 4,
  // Minimum distance from daily open (pips)
  minDistanceFromDailyOpen: 3
};

// Anti-scalping rules - AGGRESSIVE for paper trading
export const ANTI_SCALPING = {
  forex: {
    minTp1Pips: 20,         // Aggressive: allow smaller wins
    minRiskReward: 1.5      // More flexible
  },
  metals: {
    minTp1Pips: 40,         // Aggressive for metals
    minRiskReward: 1.5
  },
  stocks: {
    minTp1Percent: 0.4,     // Aggressive for stocks
    minRiskReward: 1.5
  },
  crypto: {
    minTp1Percent: 1.0,     // AGGRESSIVE: 1% minimum for crypto (was 1.5%)
    minRiskReward: 1.3,     // AGGRESSIVE: 1.3 R:R for more trades
    maxLeverage: 20         // Conservative leverage for crypto
  }
};

// Crypto-specific thresholds - AGGRESSIVE for paper trading
export const CRYPTO_THRESHOLDS = {
  minConfidence: 55,        // AGGRESSIVE: Lower threshold (was 65)
  minVolatilityPercent: 0.15, // AGGRESSIVE: Lower min volatility (was 0.3)
  maxVolatilityPercent: 15,  // AGGRESSIVE: Higher max volatility (was 10)
  minVolumeMultiplier: 0.6,  // AGGRESSIVE: Lower volume requirement (was 0.8)
  sessionBuffer: 0,          // No session buffer (24/7)
  maxSpreadPercent: 0.5      // AGGRESSIVE: Higher spread tolerance (was 0.3)
};

// Major pairs list for spread classification
export const MAJOR_PAIRS = [
  'EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 
  'AUDUSD', 'USDCAD', 'NZDUSD'
];

export const CROSS_PAIRS = [
  'EURGBP', 'EURJPY', 'GBPJPY', 'EURCHF',
  'AUDNZD', 'AUDJPY', 'CADJPY', 'CHFJPY'
];
