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
