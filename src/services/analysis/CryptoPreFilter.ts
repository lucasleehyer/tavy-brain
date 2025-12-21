import { Candle } from '../../types/market';
import { IndicatorCalculator, IndicatorResult } from './IndicatorCalculator';
import { CRYPTO_THRESHOLDS } from '../../config/thresholds';
import { logger } from '../../utils/logger';

interface CryptoPreFilterResult {
  passed: boolean;
  reason?: string;
  indicators?: IndicatorResult;
  volumeSpike?: boolean;
  momentumStrength?: number;
  volatilityPercent?: number;
}

interface CryptoPreFilterConfig {
  minVolatilityPercent: number;
  maxVolatilityPercent: number;
  minVolumeMultiplier: number;
  minMomentumStrength: number;
}

const DEFAULT_CONFIG: CryptoPreFilterConfig = {
  minVolatilityPercent: CRYPTO_THRESHOLDS.minVolatilityPercent,
  maxVolatilityPercent: CRYPTO_THRESHOLDS.maxVolatilityPercent,
  minVolumeMultiplier: CRYPTO_THRESHOLDS.minVolumeMultiplier,
  minMomentumStrength: 0.3 // Minimum momentum score (0-1)
};

export class CryptoPreFilter {
  private calculator: IndicatorCalculator;
  private config: CryptoPreFilterConfig;

  constructor(config?: Partial<CryptoPreFilterConfig>) {
    this.calculator = new IndicatorCalculator();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Analyze crypto pair for trading opportunities
   * More aggressive than forex - optimized for 24/7 volatile markets
   */
  analyze(symbol: string, candles: Candle[]): CryptoPreFilterResult {
    if (candles.length < 30) {
      return { passed: false, reason: 'Insufficient data (need 30+ candles)' };
    }

    const indicators = this.calculator.calculate(candles);

    // Calculate volatility (% move in last N candles)
    const volatilityPercent = this.calculateVolatility(candles);
    
    // Check volatility is in acceptable range
    if (volatilityPercent < this.config.minVolatilityPercent) {
      return { 
        passed: false, 
        reason: `Low volatility: ${volatilityPercent.toFixed(2)}% (min ${this.config.minVolatilityPercent}%)`,
        indicators,
        volatilityPercent
      };
    }

    if (volatilityPercent > this.config.maxVolatilityPercent) {
      return { 
        passed: false, 
        reason: `Extreme volatility: ${volatilityPercent.toFixed(2)}% (max ${this.config.maxVolatilityPercent}%)`,
        indicators,
        volatilityPercent
      };
    }

    // Check for volume spike (crypto loves volume)
    const volumeSpike = this.detectVolumeSpike(candles);
    
    // Calculate momentum strength
    const momentumStrength = this.calculateMomentumStrength(indicators);

    // AGGRESSIVE MODE: Lower thresholds for crypto
    // Only reject if momentum is completely flat
    if (momentumStrength < this.config.minMomentumStrength && !volumeSpike) {
      return { 
        passed: false, 
        reason: `Weak momentum: ${(momentumStrength * 100).toFixed(0)}% and no volume spike`,
        indicators,
        volumeSpike,
        momentumStrength,
        volatilityPercent
      };
    }

    // Check ADX for trend strength (but more lenient for crypto)
    if (indicators.adx < 15) {
      return { 
        passed: false, 
        reason: `Very weak trend: ADX ${indicators.adx.toFixed(1)} (need 15+)`,
        indicators,
        volumeSpike,
        momentumStrength,
        volatilityPercent
      };
    }

    logger.info(`[CRYPTO-PREFILTER] ${symbol} PASSED: Vol=${volatilityPercent.toFixed(2)}%, Mom=${(momentumStrength * 100).toFixed(0)}%, VolSpike=${volumeSpike}, ADX=${indicators.adx.toFixed(1)}`);

    return {
      passed: true,
      indicators,
      volumeSpike,
      momentumStrength,
      volatilityPercent
    };
  }

  /**
   * Calculate recent volatility as percentage
   */
  private calculateVolatility(candles: Candle[]): number {
    const recentCandles = candles.slice(-15); // Last 15 candles
    
    let totalRange = 0;
    for (const candle of recentCandles) {
      const range = Math.abs(candle.high - candle.low);
      const rangePercent = (range / candle.close) * 100;
      totalRange += rangePercent;
    }

    return totalRange / recentCandles.length;
  }

  /**
   * Detect volume spike (volume > 1.5x average)
   */
  private detectVolumeSpike(candles: Candle[]): boolean {
    if (!candles[0]?.volume) return false; // No volume data

    const recent = candles.slice(-5);
    const older = candles.slice(-25, -5);

    const recentAvgVolume = recent.reduce((sum, c) => sum + (c.volume || 0), 0) / recent.length;
    const olderAvgVolume = older.reduce((sum, c) => sum + (c.volume || 0), 0) / older.length;

    if (olderAvgVolume === 0) return false;

    const volumeRatio = recentAvgVolume / olderAvgVolume;
    return volumeRatio >= this.config.minVolumeMultiplier * 1.5; // 1.5x threshold for spike
  }

  /**
   * Calculate momentum strength (0-1)
   */
  private calculateMomentumStrength(indicators: IndicatorResult): number {
    let score = 0;

    // RSI momentum (not at extremes = trending)
    if (indicators.rsi > 40 && indicators.rsi < 60) {
      score += 0.2; // Neutral = less momentum
    } else if ((indicators.rsi > 60 && indicators.rsi < 80) || (indicators.rsi > 20 && indicators.rsi < 40)) {
      score += 0.4; // Trending
    } else {
      score += 0.3; // Extreme = potential reversal
    }

    // MACD momentum
    if (Math.abs(indicators.macd.histogram) > 0) {
      const histStrength = Math.min(Math.abs(indicators.macd.histogram) * 1000, 0.3);
      score += histStrength;
    }

    // ADX trend strength
    if (indicators.adx > 25) {
      score += 0.3;
    } else if (indicators.adx > 20) {
      score += 0.2;
    } else if (indicators.adx > 15) {
      score += 0.1;
    }

    return Math.min(score, 1.0);
  }

  updateConfig(config: Partial<CryptoPreFilterConfig>): void {
    this.config = { ...this.config, ...config };
  }
}
