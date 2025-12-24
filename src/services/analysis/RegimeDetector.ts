import { Candle, Indicators, MarketRegime } from '../../types/market';
import { PREFILTER_THRESHOLDS } from '../../config/thresholds';

interface RangeInfo {
  isRanging: boolean;
  rangeHigh: number;
  rangeLow: number;
  rangeMid: number;
  positionInRange: number; // 0 = at low, 1 = at high
  rangeWidth: number;
}

export class RegimeDetector {
  detect(indicators: Indicators): MarketRegime {
    const { adx, plusDi, minusDi, atr, rsi, ema20, ema50 } = indicators;

    let type: MarketRegime['type'];
    let strength: number;

    if (adx >= 40) {
      type = 'trending';
      strength = Math.min((adx - 25) / 25 * 100, 100);
    } else if (adx >= PREFILTER_THRESHOLDS.adxTrending) {
      type = 'trending';
      strength = (adx - 20) / 20 * 100;
    } else if (adx < 20) {
      type = 'ranging';
      strength = (20 - adx) / 20 * 100;
    } else {
      type = 'volatile';
      strength = 50;
    }

    let direction: MarketRegime['direction'];
    if (plusDi > minusDi && ema20 > ema50) {
      direction = 'bullish';
    } else if (minusDi > plusDi && ema20 < ema50) {
      direction = 'bearish';
    } else {
      direction = 'neutral';
    }

    let confidence = 50;
    if (adx > 30) confidence += 15;
    if (adx > 40) confidence += 10;
    const diDiff = Math.abs(plusDi - minusDi);
    if (diDiff > 10) confidence += 10;
    if (diDiff > 20) confidence += 10;
    const emaAligned = (direction === 'bullish' && ema20 > ema50) ||
                       (direction === 'bearish' && ema20 < ema50);
    if (emaAligned) confidence += 10;
    if (direction === 'bullish' && rsi > 50 && rsi < 70) confidence += 5;
    if (direction === 'bearish' && rsi < 50 && rsi > 30) confidence += 5;
    confidence = Math.min(confidence, 95);

    return { type, direction, strength, confidence };
  }

  /**
   * Detect range from candles
   */
  detectRange(candles: Candle[], lookback: number = 50): RangeInfo {
    if (!candles || candles.length < lookback) {
      return { isRanging: false, rangeHigh: 0, rangeLow: 0, rangeMid: 0, positionInRange: 0.5, rangeWidth: 0 };
    }

    const recent = candles.slice(-lookback);
    const highs = recent.map(c => c.high);
    const lows = recent.map(c => c.low);
    
    const rangeHigh = Math.max(...highs);
    const rangeLow = Math.min(...lows);
    const rangeMid = (rangeHigh + rangeLow) / 2;
    const rangeWidth = rangeHigh - rangeLow;
    
    const currentPrice = candles[candles.length - 1].close;
    const positionInRange = rangeWidth > 0 ? (currentPrice - rangeLow) / rangeWidth : 0.5;

    // Check if ranging: multiple touches of high/low zones
    const highZone = rangeHigh - rangeWidth * 0.1;
    const lowZone = rangeLow + rangeWidth * 0.1;
    
    let highTouches = 0;
    let lowTouches = 0;
    for (const c of recent) {
      if (c.high >= highZone) highTouches++;
      if (c.low <= lowZone) lowTouches++;
    }

    const isRanging = highTouches >= 2 && lowTouches >= 2;

    return { isRanging, rangeHigh, rangeLow, rangeMid, positionInRange, rangeWidth };
  }

  /**
   * Detect if trend is changing
   */
  detectTrendChange(candles: Candle[], indicators: Indicators): { changing: boolean; newDirection: 'bullish' | 'bearish' | 'neutral' } {
    if (!candles || candles.length < 20) {
      return { changing: false, newDirection: 'neutral' };
    }

    const { ema20, ema50 } = indicators;
    const emaGap = Math.abs(ema20 - ema50) / ema50;
    
    // Trend change = EMAs converging rapidly
    const isConverging = emaGap < 0.002; // Within 0.2%
    
    if (!isConverging) {
      return { changing: false, newDirection: 'neutral' };
    }

    // Determine new direction from recent price action
    const recent = candles.slice(-5);
    const bullishCandles = recent.filter(c => c.close > c.open).length;
    
    return {
      changing: true,
      newDirection: bullishCandles >= 3 ? 'bullish' : bullishCandles <= 2 ? 'bearish' : 'neutral'
    };
  }

  getPlaybook(regime: MarketRegime): string {
    if (regime.type === 'trending' && regime.strength > 60) return 'TREND_FOLLOW';
    if (regime.type === 'ranging') return 'FADE_EXTREMES';
    if (regime.type === 'volatile') return 'BREAKOUT_CONFIRM';
    return 'PULLBACK_ENTRY';
  }

  getSizeMultiplier(regime: MarketRegime): number {
    switch (regime.type) {
      case 'trending': return 1.0;
      case 'ranging': return 0.7;
      case 'volatile': return 0.5;
      case 'breakout': return 0.8;
      default: return 1.0;
    }
  }
}
