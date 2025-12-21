import { Candle } from '../../types/market';

export interface CandlePattern {
  name: string;
  type: 'bullish' | 'bearish' | 'neutral';
  strength: number; // 1-3
  description: string;
}

export interface CandlePatternResult {
  patterns: CandlePattern[];
  primaryPattern: CandlePattern | null;
  last3CandlesDirection: 'bullish' | 'bearish' | 'mixed';
  rangeExpansion: number; // ratio vs average
  volumeRatio: number; // ratio vs average
}

export class CandlePatterns {
  private avgRangePeriod: number;

  constructor(avgRangePeriod: number = 5) {
    this.avgRangePeriod = avgRangePeriod;
  }

  analyze(candles: Candle[]): CandlePatternResult {
    if (candles.length < 10) {
      return this.getDefaultResult();
    }

    const patterns: CandlePattern[] = [];
    const recentCandles = candles.slice(-5);
    const current = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const prevPrev = candles[candles.length - 3];

    // Engulfing patterns
    const engulfing = this.detectEngulfing(prev, current);
    if (engulfing) patterns.push(engulfing);

    // Pin bar / hammer / shooting star
    const pinBar = this.detectPinBar(current);
    if (pinBar) patterns.push(pinBar);

    // Inside bar
    const insideBar = this.detectInsideBar(prev, current);
    if (insideBar) patterns.push(insideBar);

    // Doji
    const doji = this.detectDoji(current);
    if (doji) patterns.push(doji);

    // Three soldiers / crows
    const threeSeries = this.detectThreeSeries(prevPrev, prev, current);
    if (threeSeries) patterns.push(threeSeries);

    // Calculate last 3 candles direction
    const last3Direction = this.calculateLast3Direction(recentCandles);

    // Calculate range expansion
    const rangeExpansion = this.calculateRangeExpansion(candles);

    // Calculate volume ratio
    const volumeRatio = this.calculateVolumeRatio(candles);

    // Primary pattern is the highest strength one
    const primaryPattern = patterns.length > 0
      ? patterns.reduce((max, p) => p.strength > max.strength ? p : max, patterns[0])
      : null;

    return {
      patterns,
      primaryPattern,
      last3CandlesDirection: last3Direction,
      rangeExpansion,
      volumeRatio
    };
  }

  private detectEngulfing(prev: Candle, current: Candle): CandlePattern | null {
    const prevBody = Math.abs(prev.close - prev.open);
    const currBody = Math.abs(current.close - current.open);
    const prevBullish = prev.close > prev.open;
    const currBullish = current.close > current.open;

    // Bullish engulfing
    if (!prevBullish && currBullish && 
        current.open <= prev.close && current.close >= prev.open &&
        currBody > prevBody) {
      return {
        name: 'bullish_engulfing',
        type: 'bullish',
        strength: currBody > prevBody * 1.5 ? 3 : 2,
        description: 'Bullish engulfing pattern - strong reversal signal'
      };
    }

    // Bearish engulfing
    if (prevBullish && !currBullish &&
        current.open >= prev.close && current.close <= prev.open &&
        currBody > prevBody) {
      return {
        name: 'bearish_engulfing',
        type: 'bearish',
        strength: currBody > prevBody * 1.5 ? 3 : 2,
        description: 'Bearish engulfing pattern - strong reversal signal'
      };
    }

    return null;
  }

  private detectPinBar(candle: Candle): CandlePattern | null {
    const body = Math.abs(candle.close - candle.open);
    const fullRange = candle.high - candle.low;
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;

    if (fullRange === 0) return null;

    const bodyRatio = body / fullRange;
    const upperWickRatio = upperWick / fullRange;
    const lowerWickRatio = lowerWick / fullRange;

    // Hammer / bullish pin bar (long lower wick)
    if (lowerWickRatio >= 0.6 && bodyRatio <= 0.3 && upperWickRatio <= 0.15) {
      return {
        name: 'hammer',
        type: 'bullish',
        strength: lowerWickRatio >= 0.7 ? 3 : 2,
        description: 'Hammer pattern - bullish reversal at support'
      };
    }

    // Shooting star / bearish pin bar (long upper wick)
    if (upperWickRatio >= 0.6 && bodyRatio <= 0.3 && lowerWickRatio <= 0.15) {
      return {
        name: 'shooting_star',
        type: 'bearish',
        strength: upperWickRatio >= 0.7 ? 3 : 2,
        description: 'Shooting star pattern - bearish reversal at resistance'
      };
    }

    return null;
  }

  private detectInsideBar(prev: Candle, current: Candle): CandlePattern | null {
    if (current.high <= prev.high && current.low >= prev.low) {
      return {
        name: 'inside_bar',
        type: 'neutral',
        strength: 1,
        description: 'Inside bar - consolidation, watch for breakout'
      };
    }
    return null;
  }

  private detectDoji(candle: Candle): CandlePattern | null {
    const body = Math.abs(candle.close - candle.open);
    const fullRange = candle.high - candle.low;

    if (fullRange === 0) return null;

    if (body / fullRange < 0.1) {
      return {
        name: 'doji',
        type: 'neutral',
        strength: 1,
        description: 'Doji - indecision, potential reversal'
      };
    }
    return null;
  }

  private detectThreeSeries(c1: Candle, c2: Candle, c3: Candle): CandlePattern | null {
    const bullish1 = c1.close > c1.open;
    const bullish2 = c2.close > c2.open;
    const bullish3 = c3.close > c3.open;

    // Three white soldiers
    if (bullish1 && bullish2 && bullish3 &&
        c2.close > c1.close && c3.close > c2.close &&
        c2.open > c1.open && c3.open > c2.open) {
      return {
        name: 'three_white_soldiers',
        type: 'bullish',
        strength: 3,
        description: 'Three white soldiers - strong bullish continuation'
      };
    }

    // Three black crows
    if (!bullish1 && !bullish2 && !bullish3 &&
        c2.close < c1.close && c3.close < c2.close &&
        c2.open < c1.open && c3.open < c2.open) {
      return {
        name: 'three_black_crows',
        type: 'bearish',
        strength: 3,
        description: 'Three black crows - strong bearish continuation'
      };
    }

    return null;
  }

  private calculateLast3Direction(candles: Candle[]): 'bullish' | 'bearish' | 'mixed' {
    const last3 = candles.slice(-3);
    let bullishCount = 0;
    let bearishCount = 0;

    for (const c of last3) {
      if (c.close > c.open) bullishCount++;
      else if (c.close < c.open) bearishCount++;
    }

    if (bullishCount >= 2) return 'bullish';
    if (bearishCount >= 2) return 'bearish';
    return 'mixed';
  }

  private calculateRangeExpansion(candles: Candle[]): number {
    if (candles.length < this.avgRangePeriod + 1) return 1.0;

    const recentRanges = candles.slice(-this.avgRangePeriod - 1, -1).map(c => c.high - c.low);
    const avgRange = recentRanges.reduce((a, b) => a + b) / recentRanges.length;
    const currentRange = candles[candles.length - 1].high - candles[candles.length - 1].low;

    return avgRange > 0 ? currentRange / avgRange : 1.0;
  }

  private calculateVolumeRatio(candles: Candle[]): number {
    if (candles.length < 21) return 1.0;

    const recentVolumes = candles.slice(-21, -1).map(c => c.volume);
    const avgVolume = recentVolumes.reduce((a, b) => a + b) / recentVolumes.length;
    const currentVolume = candles[candles.length - 1].volume;

    return avgVolume > 0 ? currentVolume / avgVolume : 1.0;
  }

  private getDefaultResult(): CandlePatternResult {
    return {
      patterns: [],
      primaryPattern: null,
      last3CandlesDirection: 'mixed',
      rangeExpansion: 1.0,
      volumeRatio: 1.0
    };
  }
}
