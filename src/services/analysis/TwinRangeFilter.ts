import { Candle } from '../../types/market';

export interface TwinRangeResult {
  filterLine: number;
  upperBand: number;
  lowerBand: number;
  direction: 'bullish' | 'bearish' | 'neutral';
  strength: number; // consecutive bars in same direction
  signal: 'BUY' | 'SELL' | 'NONE';
  // Enhanced properties for confluence scoring
  fastSlowAligned: boolean;
  gapExpanding: boolean;
  priceNearFastFilter: boolean;
  fastFilterLine: number;
  slowFilterLine: number;
  gapSize: number;
  previousGapSize: number;
}

export class TwinRangeFilter {
  private fastPeriod: number;
  private fastMultiplier: number;
  private slowPeriod: number;
  private slowMultiplier: number;

  constructor(
    fastPeriod: number = 27,
    fastMultiplier: number = 1.6,
    slowPeriod: number = 55,
    slowMultiplier: number = 2.0
  ) {
    this.fastPeriod = fastPeriod;
    this.fastMultiplier = fastMultiplier;
    this.slowPeriod = slowPeriod;
    this.slowMultiplier = slowMultiplier;
  }

  calculate(candles: Candle[]): TwinRangeResult {
    if (candles.length < this.slowPeriod + 10) {
      return this.getDefaultResult(candles[candles.length - 1]?.close || 0);
    }

    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);

    // Calculate smoothed average range for fast period
    const fastSmoothedRange = this.calculateSmoothedRange(highs, lows, this.fastPeriod);
    const fastRangeFilter = fastSmoothedRange * this.fastMultiplier;

    // Calculate smoothed average range for slow period  
    const slowSmoothedRange = this.calculateSmoothedRange(highs, lows, this.slowPeriod);
    const slowRangeFilter = slowSmoothedRange * this.slowMultiplier;

    // Calculate SEPARATE filter lines for fast and slow
    const fastResult = this.calculateFilterLine(closes, fastRangeFilter);
    const slowResult = this.calculateFilterLine(closes, slowRangeFilter);
    
    const fastFilterLine = fastResult.filterLine;
    const slowFilterLine = slowResult.filterLine;

    // Combined range filter (average of fast and slow)
    const combinedFilter = (fastRangeFilter + slowRangeFilter) / 2;

    // Calculate the main filter line using combined
    const { filterLine, upwardCount, downwardCount } = this.calculateFilterLine(
      closes,
      combinedFilter
    );

    const currentClose = closes[closes.length - 1];
    const upperBand = filterLine + combinedFilter;
    const lowerBand = filterLine - combinedFilter;

    // Enhanced: Check if fast and slow filters are aligned (both bullish or both bearish)
    const fastDirection = currentClose > fastFilterLine ? 'bullish' : currentClose < fastFilterLine ? 'bearish' : 'neutral';
    const slowDirection = currentClose > slowFilterLine ? 'bullish' : currentClose < slowFilterLine ? 'bearish' : 'neutral';
    const fastSlowAligned = fastDirection === slowDirection && fastDirection !== 'neutral';

    // Enhanced: Calculate gap between fast and slow filters
    const gapSize = Math.abs(fastFilterLine - slowFilterLine);
    
    // Calculate previous gap (using one candle back)
    const prevCloses = closes.slice(0, -1);
    let previousGapSize = gapSize;
    if (prevCloses.length >= this.slowPeriod) {
      const prevFastResult = this.calculateFilterLine(prevCloses, fastRangeFilter);
      const prevSlowResult = this.calculateFilterLine(prevCloses, slowRangeFilter);
      previousGapSize = Math.abs(prevFastResult.filterLine - prevSlowResult.filterLine);
    }
    
    // Gap is expanding when current gap > previous gap (strong trend)
    const gapExpanding = gapSize > previousGapSize * 1.02; // 2% threshold

    // Enhanced: Check if price is near fast filter (pullback zone for entries)
    const atr = fastSmoothedRange; // Use as proxy for volatility
    const distanceToFast = Math.abs(currentClose - fastFilterLine);
    const priceNearFastFilter = distanceToFast <= atr * 0.5; // Within 0.5 ATR

    // Determine direction based on filter line position relative to price
    let direction: 'bullish' | 'bearish' | 'neutral' = 'neutral';
    let signal: 'BUY' | 'SELL' | 'NONE' = 'NONE';

    if (upwardCount >= 2) {
      direction = 'bullish';
      // Buy signal: price crosses above filter + upward movement
      if (currentClose > filterLine && closes[closes.length - 2] <= filterLine) {
        signal = 'BUY';
      }
    } else if (downwardCount >= 2) {
      direction = 'bearish';
      // Sell signal: price crosses below filter + downward movement
      if (currentClose < filterLine && closes[closes.length - 2] >= filterLine) {
        signal = 'SELL';
      }
    }

    const strength = Math.max(upwardCount, downwardCount);

    return {
      filterLine,
      upperBand,
      lowerBand,
      direction,
      strength,
      signal,
      // Enhanced properties
      fastSlowAligned,
      gapExpanding,
      priceNearFastFilter,
      fastFilterLine,
      slowFilterLine,
      gapSize,
      previousGapSize
    };
  }

  private calculateSmoothedRange(highs: number[], lows: number[], period: number): number {
    if (highs.length < period) return 0;

    const ranges: number[] = [];
    for (let i = 0; i < highs.length; i++) {
      ranges.push(highs[i] - lows[i]);
    }

    // Use EMA smoothing for the range
    const multiplier = 2 / (period + 1);
    let ema = ranges.slice(0, period).reduce((a, b) => a + b) / period;

    for (let i = period; i < ranges.length; i++) {
      ema = (ranges[i] - ema) * multiplier + ema;
    }

    return ema;
  }

  private calculateFilterLine(
    closes: number[],
    rangeFilter: number
  ): { filterLine: number; upwardCount: number; downwardCount: number } {
    if (closes.length < 2) {
      return { filterLine: closes[closes.length - 1] || 0, upwardCount: 0, downwardCount: 0 };
    }

    // Initialize filter line
    let filterLine = closes[0];
    let upwardCount = 0;
    let downwardCount = 0;

    // Track consecutive directional bars
    let consecutiveUp = 0;
    let consecutiveDown = 0;

    for (let i = 1; i < closes.length; i++) {
      const price = closes[i];
      const prevFilter = filterLine;

      // Update filter line based on price movement relative to filter bands
      if (price > prevFilter + rangeFilter) {
        // Price broke above upper band - filter follows upward
        filterLine = price - rangeFilter;
        consecutiveUp++;
        consecutiveDown = 0;
      } else if (price < prevFilter - rangeFilter) {
        // Price broke below lower band - filter follows downward
        filterLine = price + rangeFilter;
        consecutiveDown++;
        consecutiveUp = 0;
      } else {
        // Price within bands - keep filter stable
        if (price > prevFilter) {
          filterLine = Math.max(filterLine, price - rangeFilter);
          consecutiveUp++;
          consecutiveDown = 0;
        } else if (price < prevFilter) {
          filterLine = Math.min(filterLine, price + rangeFilter);
          consecutiveDown++;
          consecutiveUp = 0;
        }
      }
    }

    upwardCount = consecutiveUp;
    downwardCount = consecutiveDown;

    return { filterLine, upwardCount, downwardCount };
  }

  private getDefaultResult(currentPrice: number): TwinRangeResult {
    return {
      filterLine: currentPrice,
      upperBand: currentPrice,
      lowerBand: currentPrice,
      direction: 'neutral',
      strength: 0,
      signal: 'NONE',
      fastSlowAligned: false,
      gapExpanding: false,
      priceNearFastFilter: false,
      fastFilterLine: currentPrice,
      slowFilterLine: currentPrice,
      gapSize: 0,
      previousGapSize: 0
    };
  }
}
