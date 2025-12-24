/**
 * Regime Strategy Router
 * 
 * Routes signals to regime-specific strategies.
 * Key insight: Different market conditions require different approaches.
 */

import { MarketRegime } from '../../types/market';
import { RegimeStrategy, RegimeStrategyResult, RegimePlaybook } from '../../types/quant';
import { logger } from '../../utils/logger';

const REGIME_STRATEGIES: Record<RegimePlaybook, RegimeStrategy> = {
  'TREND_FOLLOW': {
    playbook: 'TREND_FOLLOW',
    entryRules: [
      'Wait for pullback to EMA20/50',
      'Enter on bullish/bearish engulfing at EMA',
      'Confirm with momentum indicator',
      'Higher timeframe must confirm direction'
    ],
    exitRules: [
      'Trail stop below swing lows (bullish) or above swing highs (bearish)',
      'Take partial at 1:1 R:R',
      'Let runner ride with trailing stop'
    ],
    positionSizeMultiplier: 1.0,
    maxHoldingPeriod: '48h',
    preferredTimeframes: ['1h', '4h']
  },
  
  'FADE_EXTREMES': {
    playbook: 'FADE_EXTREMES',
    entryRules: [
      'Only trade at range extremes (support/resistance)',
      'Wait for rejection candle (pin bar, engulfing)',
      'RSI must be oversold (<30) for long, overbought (>70) for short',
      'Do NOT trade the middle of the range'
    ],
    exitRules: [
      'Target opposite range extreme',
      'Take full profit at target (no trailing)',
      'Stop just outside range extreme'
    ],
    positionSizeMultiplier: 0.7,
    maxHoldingPeriod: '24h',
    preferredTimeframes: ['15m', '1h']
  },
  
  'BREAKOUT_CONFIRM': {
    playbook: 'BREAKOUT_CONFIRM',
    entryRules: [
      'Wait for candle close beyond range/level',
      'Require retest of broken level',
      'Volume/momentum must confirm breakout',
      'Avoid false breakouts - patience!'
    ],
    exitRules: [
      'Target next major structure level',
      'Tight stop below breakout level',
      'Move to breakeven quickly'
    ],
    positionSizeMultiplier: 0.8,
    maxHoldingPeriod: '12h',
    preferredTimeframes: ['15m', '1h']
  },
  
  'PULLBACK_ENTRY': {
    playbook: 'PULLBACK_ENTRY',
    entryRules: [
      'Trend must be established (ADX > 25)',
      'Wait for pullback to key level (EMA, Fib, S/R)',
      'Enter on reversal candle pattern',
      'Stop beyond the pullback extreme'
    ],
    exitRules: [
      'Target recent swing high/low or beyond',
      'Trail stop as trend continues',
      'Take partial at 1:1.5'
    ],
    positionSizeMultiplier: 1.0,
    maxHoldingPeriod: '36h',
    preferredTimeframes: ['1h', '4h']
  }
};

export class RegimeStrategyRouter {
  /**
   * Route to appropriate strategy based on regime
   */
  route(
    regime: MarketRegime,
    signalDirection: 'BUY' | 'SELL',
    rsi: number,
    atKeyLevel: boolean
  ): RegimeStrategyResult {
    // Determine playbook based on regime
    let playbook: RegimePlaybook;
    let isValidSetup = true;
    const adjustments: string[] = [];

    switch (regime.type) {
      case 'trending':
        if (regime.strength > 60) {
          playbook = 'TREND_FOLLOW';
          // Validate direction matches trend
          const trendDirection = regime.direction;
          if ((signalDirection === 'BUY' && trendDirection === 'bearish') ||
              (signalDirection === 'SELL' && trendDirection === 'bullish')) {
            isValidSetup = false;
            adjustments.push('Signal conflicts with trend direction');
          }
        } else {
          playbook = 'PULLBACK_ENTRY';
          // For pullback, we need a slight counter-trend move
          if (rsi > 30 && rsi < 70) {
            adjustments.push('Good RSI range for pullback entry');
          }
        }
        break;

      case 'ranging':
        playbook = 'FADE_EXTREMES';
        // Validate we're at an extreme
        if (!atKeyLevel) {
          isValidSetup = false;
          adjustments.push('Ranging market requires entry at key level');
        }
        // Validate RSI confirms extreme
        if (signalDirection === 'BUY' && rsi > 40) {
          adjustments.push('For range long, prefer RSI < 40');
        }
        if (signalDirection === 'SELL' && rsi < 60) {
          adjustments.push('For range short, prefer RSI > 60');
        }
        break;

      case 'breakout':
        playbook = 'BREAKOUT_CONFIRM';
        adjustments.push('Breakout detected - require retest confirmation');
        break;

      case 'volatile':
        // In volatile conditions, use breakout with confirmation
        playbook = 'BREAKOUT_CONFIRM';
        adjustments.push('Volatile market - reduced position size');
        break;

      default:
        playbook = 'PULLBACK_ENTRY';
    }

    const strategy = REGIME_STRATEGIES[playbook];
    
    let reason: string;
    if (isValidSetup) {
      reason = `${playbook}: ${strategy.entryRules[0]}`;
    } else {
      reason = `Setup invalid for ${regime.type} regime: ${adjustments.join('; ')}`;
    }

    const result: RegimeStrategyResult = {
      strategy,
      isValidSetup,
      adjustments,
      reason
    };

    logger.info(`[REGIME] ${playbook} | Valid=${isValidSetup} | ${regime.type} ${regime.direction} (${regime.strength}%)`);

    return result;
  }

  /**
   * Get position size multiplier for regime
   */
  getSizeMultiplier(regime: MarketRegime): number {
    switch (regime.type) {
      case 'trending':
        return regime.strength > 70 ? 1.0 : 0.9;
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

  /**
   * Get all strategies
   */
  getAllStrategies(): Record<RegimePlaybook, RegimeStrategy> {
    return REGIME_STRATEGIES;
  }
}
