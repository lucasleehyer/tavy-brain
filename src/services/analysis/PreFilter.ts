import { logger } from '../../utils/logger';
import { Candle, Indicators } from '../../types/market';
import { PREFILTER_THRESHOLDS, ANTI_SCALPING } from '../../config/thresholds';
import { IndicatorCalculator } from './IndicatorCalculator';
import { priceToPips } from '../../config/pairs';

interface PreFilterResult {
  passed: boolean;
  reason?: string;
  indicators?: Indicators;
  suggestedAction?: 'BUY' | 'SELL';
}

export class PreFilter {
  private calculator: IndicatorCalculator;
  private minAtrPips: number;
  private momentumThreshold: number;

  constructor(settings: { minAtrPips: number; momentumThresholdPips: number }) {
    this.calculator = new IndicatorCalculator();
    this.minAtrPips = settings.minAtrPips;
    this.momentumThreshold = settings.momentumThresholdPips;
  }

  updateThresholds(settings: { minAtrPips: number; momentumThresholdPips: number }): void {
    this.minAtrPips = settings.minAtrPips;
    this.momentumThreshold = settings.momentumThresholdPips;
  }

  analyze(symbol: string, candles: Candle[]): PreFilterResult {
    // Check minimum candles
    if (candles.length < PREFILTER_THRESHOLDS.minCandles) {
      return {
        passed: false,
        reason: `Insufficient data: ${candles.length}/${PREFILTER_THRESHOLDS.minCandles} candles`
      };
    }

    // Calculate indicators
    const indicators = this.calculator.calculate(candles);

    // ATR filter - skip dead markets
    const atrPips = priceToPips(symbol, indicators.atr);
    if (atrPips < this.minAtrPips) {
      return {
        passed: false,
        reason: `Low volatility: ATR ${atrPips.toFixed(1)} pips < ${this.minAtrPips} min`,
        indicators
      };
    }

    // ADX gate - only trade trending markets
    if (indicators.adx < PREFILTER_THRESHOLDS.adxTrending) {
      return {
        passed: false,
        reason: `Weak trend: ADX ${indicators.adx.toFixed(1)} < ${PREFILTER_THRESHOLDS.adxTrending}`,
        indicators
      };
    }

    // Momentum filter
    const momentumPips = priceToPips(symbol, Math.abs(indicators.momentum));
    if (momentumPips < this.momentumThreshold) {
      return {
        passed: false,
        reason: `Weak momentum: ${momentumPips.toFixed(1)} pips < ${this.momentumThreshold} threshold`,
        indicators
      };
    }

    // RSI extremes for potential reversals or continuations
    let suggestedAction: 'BUY' | 'SELL' | undefined;

    if (indicators.rsi <= PREFILTER_THRESHOLDS.rsiOversold) {
      // Oversold - potential buy
      if (indicators.plusDi > indicators.minusDi) {
        suggestedAction = 'BUY';
      }
    } else if (indicators.rsi >= PREFILTER_THRESHOLDS.rsiOverbought) {
      // Overbought - potential sell
      if (indicators.minusDi > indicators.plusDi) {
        suggestedAction = 'SELL';
      }
    } else {
      // Trend following
      if (indicators.plusDi > indicators.minusDi && indicators.ema20 > indicators.ema50) {
        suggestedAction = 'BUY';
      } else if (indicators.minusDi > indicators.plusDi && indicators.ema20 < indicators.ema50) {
        suggestedAction = 'SELL';
      }
    }

    if (!suggestedAction) {
      return {
        passed: false,
        reason: 'No clear directional bias',
        indicators
      };
    }

    logger.info(`${symbol} passed pre-filter: ${suggestedAction} (RSI: ${indicators.rsi.toFixed(1)}, ADX: ${indicators.adx.toFixed(1)}, ATR: ${atrPips.toFixed(1)} pips)`);

    return {
      passed: true,
      indicators,
      suggestedAction
    };
  }
}
