import { Candle, Indicators } from '../../types/market';
import { TwinRangeFilter } from './TwinRangeFilter';

export class IndicatorCalculator {
  private twinRangeFilter: TwinRangeFilter;

  constructor() {
    this.twinRangeFilter = new TwinRangeFilter();
  }

  calculate(candles: Candle[]): Indicators {
    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);

    // Calculate Twin Range
    const twinRange = this.twinRangeFilter.calculate(candles);

    // Detect market structure
    const marketStructure = this.detectMarketStructure(candles);

    return {
      rsi: this.calculateRSI(closes, 14),
      adx: this.calculateADX(highs, lows, closes, 14).adx,
      plusDi: this.calculateADX(highs, lows, closes, 14).plusDi,
      minusDi: this.calculateADX(highs, lows, closes, 14).minusDi,
      ema20: this.calculateEMA(closes, 20),
      ema50: this.calculateEMA(closes, 50),
      atr: this.calculateATR(highs, lows, closes, 14),
      momentum: this.calculateMomentum(closes, 10),
      stochK: this.calculateStochastic(highs, lows, closes, 14).k,
      stochD: this.calculateStochastic(highs, lows, closes, 14).d,
      pivotPoint: this.calculatePivotPoints(highs, lows, closes).pivot,
      support1: this.calculatePivotPoints(highs, lows, closes).s1,
      support2: this.calculatePivotPoints(highs, lows, closes).s2,
      resistance1: this.calculatePivotPoints(highs, lows, closes).r1,
      resistance2: this.calculatePivotPoints(highs, lows, closes).r2,
      // Twin Range additions
      twinRangeFilter: twinRange.filterLine,
      twinRangeDirection: twinRange.direction,
      twinRangeStrength: twinRange.strength,
      // Market structure
      marketStructure
    };
  }

  private detectMarketStructure(candles: Candle[]): 'HH_HL' | 'LH_LL' | 'ranging' {
    if (candles.length < 20) return 'ranging';

    // Find swing highs and lows
    const swingHighs: number[] = [];
    const swingLows: number[] = [];
    const lookback = 3;

    for (let i = lookback; i < candles.length - lookback; i++) {
      let isHigh = true;
      let isLow = true;

      for (let j = i - lookback; j <= i + lookback; j++) {
        if (j === i) continue;
        if (candles[j].high >= candles[i].high) isHigh = false;
        if (candles[j].low <= candles[i].low) isLow = false;
      }

      if (isHigh) swingHighs.push(candles[i].high);
      if (isLow) swingLows.push(candles[i].low);
    }

    if (swingHighs.length < 2 || swingLows.length < 2) return 'ranging';

    // Check last two swing highs and lows
    const lastHighs = swingHighs.slice(-2);
    const lastLows = swingLows.slice(-2);

    const higherHighs = lastHighs[1] > lastHighs[0];
    const higherLows = lastLows[1] > lastLows[0];
    const lowerHighs = lastHighs[1] < lastHighs[0];
    const lowerLows = lastLows[1] < lastLows[0];

    if (higherHighs && higherLows) return 'HH_HL';
    if (lowerHighs && lowerLows) return 'LH_LL';
    return 'ranging';
  }

  private calculateRSI(closes: number[], period: number): number {
    if (closes.length < period + 1) return 50;

    let gains = 0;
    let losses = 0;

    for (let i = closes.length - period; i < closes.length; i++) {
      const change = closes[i] - closes[i - 1];
      if (change > 0) gains += change;
      else losses += Math.abs(change);
    }

    const avgGain = gains / period;
    const avgLoss = losses / period;

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  private calculateEMA(data: number[], period: number): number {
    if (data.length < period) return data[data.length - 1];

    const multiplier = 2 / (period + 1);
    let ema = data.slice(0, period).reduce((a, b) => a + b) / period;

    for (let i = period; i < data.length; i++) {
      ema = (data[i] - ema) * multiplier + ema;
    }

    return ema;
  }

  private calculateATR(highs: number[], lows: number[], closes: number[], period: number): number {
    if (highs.length < period + 1) return 0;

    const trueRanges: number[] = [];

    for (let i = 1; i < highs.length; i++) {
      const tr = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      );
      trueRanges.push(tr);
    }

    const recentTRs = trueRanges.slice(-period);
    return recentTRs.reduce((a, b) => a + b) / period;
  }

  private calculateADX(
    highs: number[],
    lows: number[],
    closes: number[],
    period: number
  ): { adx: number; plusDi: number; minusDi: number } {
    if (highs.length < period * 2) {
      return { adx: 20, plusDi: 25, minusDi: 25 };
    }

    const plusDMs: number[] = [];
    const minusDMs: number[] = [];
    const trs: number[] = [];

    for (let i = 1; i < highs.length; i++) {
      const plusDM = highs[i] - highs[i - 1];
      const minusDM = lows[i - 1] - lows[i];

      plusDMs.push(plusDM > 0 && plusDM > minusDM ? plusDM : 0);
      minusDMs.push(minusDM > 0 && minusDM > plusDM ? minusDM : 0);

      const tr = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      );
      trs.push(tr);
    }

    const smoothedPlusDM = this.wilderSmooth(plusDMs, period);
    const smoothedMinusDM = this.wilderSmooth(minusDMs, period);
    const smoothedTR = this.wilderSmooth(trs, period);

    const plusDi = (smoothedPlusDM / smoothedTR) * 100;
    const minusDi = (smoothedMinusDM / smoothedTR) * 100;

    const dx = Math.abs(plusDi - minusDi) / (plusDi + minusDi) * 100;

    return { adx: dx, plusDi, minusDi };
  }

  private wilderSmooth(data: number[], period: number): number {
    if (data.length < period) return data[data.length - 1] || 0;

    let smooth = data.slice(0, period).reduce((a, b) => a + b);

    for (let i = period; i < data.length; i++) {
      smooth = smooth - (smooth / period) + data[i];
    }

    return smooth / period;
  }

  private calculateMomentum(closes: number[], period: number): number {
    if (closes.length < period + 1) return 0;
    return closes[closes.length - 1] - closes[closes.length - 1 - period];
  }

  private calculateStochastic(
    highs: number[],
    lows: number[],
    closes: number[],
    period: number
  ): { k: number; d: number } {
    if (closes.length < period) {
      return { k: 50, d: 50 };
    }

    const recentHighs = highs.slice(-period);
    const recentLows = lows.slice(-period);
    const highest = Math.max(...recentHighs);
    const lowest = Math.min(...recentLows);
    const current = closes[closes.length - 1];

    const k = ((current - lowest) / (highest - lowest)) * 100;

    // Simple %D (3-period SMA of %K)
    const d = k; // Simplified

    return { k: isNaN(k) ? 50 : k, d: isNaN(d) ? 50 : d };
  }

  private calculatePivotPoints(
    highs: number[],
    lows: number[],
    closes: number[]
  ): { pivot: number; s1: number; s2: number; r1: number; r2: number } {
    const high = highs[highs.length - 2] || highs[highs.length - 1];
    const low = lows[lows.length - 2] || lows[lows.length - 1];
    const close = closes[closes.length - 2] || closes[closes.length - 1];

    const pivot = (high + low + close) / 3;
    const r1 = 2 * pivot - low;
    const s1 = 2 * pivot - high;
    const r2 = pivot + (high - low);
    const s2 = pivot - (high - low);

    return { pivot, s1, s2, r1, r2 };
  }
}
