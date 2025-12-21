export interface Tick {
  symbol: string;
  bid: number;
  ask: number;
  time: Date;
  spread: number;
}

export interface Candle {
  symbol: string;
  timeframe: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  time: Date;
}

export interface Indicators {
  rsi: number;
  adx: number;
  plusDi: number;
  minusDi: number;
  ema20: number;
  ema50: number;
  atr: number;
  momentum: number;
  stochK: number;
  stochD: number;
  pivotPoint: number;
  support1: number;
  support2: number;
  resistance1: number;
  resistance2: number;
  // Twin Range additions
  twinRangeFilter?: number;
  twinRangeDirection?: 'bullish' | 'bearish' | 'neutral';
  twinRangeStrength?: number;
  // Market structure
  marketStructure?: 'HH_HL' | 'LH_LL' | 'ranging';
}

export interface MarketRegime {
  type: 'trending' | 'ranging' | 'volatile' | 'breakout';
  direction: 'bullish' | 'bearish' | 'neutral';
  strength: number;
  confidence: number;
}

export interface PriceData {
  symbol: string;
  bid: number;
  ask: number;
  spread: number;
  timestamp: Date;
  ageMs: number;
}

// Session types for trading hours
export type TradingSession = 'london' | 'new_york' | 'london_ny_overlap' | 'asian' | 'off_hours';

// Enhanced data package for AI
export interface AIDataPackage {
  setupId: string;
  pair: string;
  timeframe: string;
  currentPrice: number;
  confluenceScore: number;
  
  priceAction: {
    keyLevelsNear: string[];
    distanceToLevel: number;
    candlePattern: string | null;
    marketStructure: string;
  };
  
  momentum: {
    twinRangeDirection: string;
    twinRangeStrength: number;
    last3CandlesDir: string;
    rangeExpansion: number;
  };
  
  context: {
    session: TradingSession;
    newsRisk: 'low' | 'medium' | 'high';
    weeklyTrend: string;
  };
  
  calculatedFeatures: {
    atr14: number;
    spread: number;
    rsi: number;
    adx: number;
  };
  
  potentialTrade: {
    direction: 'long' | 'short';
    nearestSupport: number | null;
    nearestResistance: number | null;
    naturalSlDistance: number;
    naturalTpDistance: number;
    potentialRR: number;
  };
}
