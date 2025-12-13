import { Indicators, MarketRegime } from '../../types/market';
import { PREFILTER_THRESHOLDS } from '../../config/thresholds';

export class RegimeDetector {
  detect(indicators: Indicators): MarketRegime {
    const { adx, plusDi, minusDi, atr, rsi, ema20, ema50 } = indicators;

    // Determine regime type based on ADX
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
      // Transitional zone (20-25)
      type = 'volatile';
      strength = 50;
    }

    // Determine direction
    let direction: MarketRegime['direction'];

    if (plusDi > minusDi && ema20 > ema50) {
      direction = 'bullish';
    } else if (minusDi > plusDi && ema20 < ema50) {
      direction = 'bearish';
    } else {
      direction = 'neutral';
    }

    // Calculate confidence based on indicator agreement
    let confidence = 50;

    // ADX strength adds confidence
    if (adx > 30) confidence += 15;
    if (adx > 40) confidence += 10;

    // DI divergence adds confidence
    const diDiff = Math.abs(plusDi - minusDi);
    if (diDiff > 10) confidence += 10;
    if (diDiff > 20) confidence += 10;

    // EMA alignment adds confidence
    const emaAligned = (direction === 'bullish' && ema20 > ema50) ||
                       (direction === 'bearish' && ema20 < ema50);
    if (emaAligned) confidence += 10;

    // RSI confirmation
    if (direction === 'bullish' && rsi > 50 && rsi < 70) confidence += 5;
    if (direction === 'bearish' && rsi < 50 && rsi > 30) confidence += 5;

    confidence = Math.min(confidence, 95);

    return { type, direction, strength, confidence };
  }

  getPlaybook(regime: MarketRegime): string {
    if (regime.type === 'trending' && regime.strength > 60) {
      return 'TREND_FOLLOW';
    } else if (regime.type === 'ranging') {
      return 'FADE_EXTREMES';
    } else if (regime.type === 'volatile') {
      return 'BREAKOUT_CONFIRM';
    } else {
      return 'PULLBACK_ENTRY';
    }
  }

  getSizeMultiplier(regime: MarketRegime): number {
    switch (regime.type) {
      case 'trending':
        return 1.0;
      case 'ranging':
        return 0.7;
      case 'volatile':
        return 0.5;
      case 'breakout':
        return 0.8;
      default:
        return 1.0;
    }
  }
}
