/**
 * Multi-Timeframe Trend Filter
 * 
 * Analyzes 4H, 1H, and 15m timeframes to determine allowed trade direction.
 * Key insight: Only trade in direction of higher timeframe trend.
 */

import { Candle, Indicators } from '../../types/market';
import { MTFTrendResult, TimeframeTrend, TrendDirection, AllowedDirection } from '../../types/quant';
import { logger } from '../../utils/logger';

interface MultiTimeframeCandles {
  '4h': Candle[];
  '1h': Candle[];
  '15m': Candle[];
  '5m'?: Candle[];
}

export class MTFTrendFilter {
  private readonly EMA_PERIOD_FAST = 20;
  private readonly EMA_PERIOD_SLOW = 50;
  private readonly MIN_CANDLES = 60; // Need at least 60 candles for EMA50

  /**
   * Analyze multiple timeframes and return allowed direction
   */
  analyze(candles: MultiTimeframeCandles): MTFTrendResult {
    const trends = {
      '4h': this.analyzeTrend(candles['4h'], '4h'),
      '1h': this.analyzeTrend(candles['1h'], '1h'),
      '15m': this.analyzeTrend(candles['15m'], '15m')
    };

    // Determine alignment
    const directions = [trends['4h'].direction, trends['1h'].direction, trends['15m'].direction];
    const bullishCount = directions.filter(d => d === 'bullish').length;
    const bearishCount = directions.filter(d => d === 'bearish').length;

    let alignment: 'full' | 'partial' | 'conflicting';
    let allowedDirection: AllowedDirection;
    let reason: string;

    // RULE: 4H is the boss. 1H must confirm. 15m just for timing.
    const htf = trends['4h'].direction; // Higher timeframe
    const mtf = trends['1h'].direction; // Middle timeframe

    if (htf === 'bullish' && mtf === 'bullish') {
      alignment = 'full';
      allowedDirection = 'long';
      reason = '4H + 1H both bullish - LONG only';
    } else if (htf === 'bearish' && mtf === 'bearish') {
      alignment = 'full';
      allowedDirection = 'short';
      reason = '4H + 1H both bearish - SHORT only';
    } else if (htf !== 'neutral' && mtf === 'neutral') {
      // 4H has direction but 1H is neutral - partial alignment
      alignment = 'partial';
      allowedDirection = htf === 'bullish' ? 'long' : 'short';
      reason = `4H ${htf} but 1H neutral - ${allowedDirection.toUpperCase()} with caution`;
    } else if (htf === 'neutral' && mtf !== 'neutral') {
      // 4H neutral but 1H has direction - wait for clarity
      alignment = 'partial';
      allowedDirection = 'none';
      reason = '4H neutral - wait for higher timeframe direction';
    } else if (htf !== 'neutral' && mtf !== 'neutral' && htf !== mtf) {
      // 4H and 1H conflict - DO NOT TRADE
      alignment = 'conflicting';
      allowedDirection = 'none';
      reason = `4H ${htf} vs 1H ${mtf} CONFLICT - NO TRADE`;
    } else {
      // Both neutral
      alignment = 'conflicting';
      allowedDirection = 'none';
      reason = 'No clear trend on higher timeframes';
    }

    // Calculate overall strength
    const overallStrength = (
      trends['4h'].strength * 0.5 +
      trends['1h'].strength * 0.35 +
      trends['15m'].strength * 0.15
    );

    const result: MTFTrendResult = {
      allowedDirection,
      trends,
      alignment,
      overallStrength,
      reason
    };

    logger.info(`[MTF] ${allowedDirection.toUpperCase()} allowed | ${alignment} alignment | 4H=${htf} 1H=${mtf} | Strength=${overallStrength.toFixed(0)}%`);

    return result;
  }

  /**
   * Analyze a single timeframe trend
   */
  private analyzeTrend(candles: Candle[], timeframe: string): TimeframeTrend {
    if (!candles || candles.length < this.MIN_CANDLES) {
      return this.getNeutralTrend(timeframe);
    }

    // Calculate EMAs
    const closes = candles.map(c => c.close);
    const ema20 = this.calculateEMA(closes, this.EMA_PERIOD_FAST);
    const ema50 = this.calculateEMA(closes, this.EMA_PERIOD_SLOW);
    const currentPrice = closes[closes.length - 1];

    // Determine direction
    let direction: TrendDirection;
    let strength: number;

    const emaGap = ((ema20 - ema50) / ema50) * 100;
    const priceAboveEma20 = currentPrice > ema20;
    const priceAboveEma50 = currentPrice > ema50;
    const ema20AboveEma50 = ema20 > ema50;

    if (ema20AboveEma50 && priceAboveEma20) {
      direction = 'bullish';
      strength = Math.min(100, Math.abs(emaGap) * 20 + 50);
    } else if (!ema20AboveEma50 && !priceAboveEma20) {
      direction = 'bearish';
      strength = Math.min(100, Math.abs(emaGap) * 20 + 50);
    } else {
      // Mixed signals
      direction = 'neutral';
      strength = Math.max(0, 50 - Math.abs(emaGap) * 10);
    }

    // Add recent price action confirmation
    const recentCandles = candles.slice(-5);
    const recentBullish = recentCandles.filter(c => c.close > c.open).length;
    const priceActionConfirms = (direction === 'bullish' && recentBullish >= 3) ||
                                (direction === 'bearish' && recentBullish <= 2);
    
    if (priceActionConfirms) {
      strength = Math.min(100, strength + 10);
    }

    const confidence = strength;

    return {
      timeframe: timeframe as '4h' | '1h' | '15m' | '5m',
      direction,
      strength,
      ema20,
      ema50,
      price: currentPrice,
      confidence
    };
  }

  /**
   * Calculate Exponential Moving Average
   */
  private calculateEMA(values: number[], period: number): number {
    if (values.length < period) return values[values.length - 1];
    
    const k = 2 / (period + 1);
    let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    
    for (let i = period; i < values.length; i++) {
      ema = values[i] * k + ema * (1 - k);
    }
    
    return ema;
  }

  /**
   * Return neutral trend for insufficient data
   */
  private getNeutralTrend(timeframe: string): TimeframeTrend {
    return {
      timeframe: timeframe as '4h' | '1h' | '15m' | '5m',
      direction: 'neutral',
      strength: 0,
      ema20: 0,
      ema50: 0,
      price: 0,
      confidence: 0
    };
  }

  /**
   * Quick check if signal direction matches MTF trend
   */
  matchesSignal(mtfResult: MTFTrendResult, signalDirection: 'BUY' | 'SELL'): boolean {
    if (mtfResult.allowedDirection === 'none') return false;
    if (signalDirection === 'BUY' && mtfResult.allowedDirection === 'long') return true;
    if (signalDirection === 'SELL' && mtfResult.allowedDirection === 'short') return true;
    return false;
  }
}
