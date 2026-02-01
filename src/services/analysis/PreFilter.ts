import { logger } from '../../utils/logger';
import { Candle, Indicators, TradingSession } from '../../types/market';
import { 
  PREFILTER_THRESHOLDS, 
  SESSION_CONFIG, 
  SPREAD_LIMITS, 
  NEWS_FILTER, 
  VOLATILITY_GATES,
  MAJOR_PAIRS,
  CROSS_PAIRS
} from '../../config/thresholds';
import { IndicatorCalculator } from './IndicatorCalculator';
import { TwinRangeFilter, TwinRangeResult } from './TwinRangeFilter';
import { priceToPips } from '../../config/pairs';

interface PreFilterResult {
  passed: boolean;
  reason?: string;
  indicators?: Indicators;
  twinRange?: TwinRangeResult;
  suggestedAction?: 'BUY' | 'SELL';
  session?: TradingSession;
  warnings?: string[];
}

interface HardGateResult {
  passed: boolean;
  reason?: string;
  warnings?: string[];
}

export class PreFilter {
  private calculator: IndicatorCalculator;
  private twinRangeFilter: TwinRangeFilter;
  private minAtrPips: number;
  private momentumThreshold: number;

  constructor(settings: { minAtrPips: number; momentumThresholdPips: number }) {
    this.calculator = new IndicatorCalculator();
    this.twinRangeFilter = new TwinRangeFilter();
    this.minAtrPips = settings.minAtrPips;
    this.momentumThreshold = settings.momentumThresholdPips;
  }

  updateThresholds(settings: { minAtrPips: number; momentumThresholdPips: number }): void {
    this.minAtrPips = settings.minAtrPips;
    this.momentumThreshold = settings.momentumThresholdPips;
  }

  analyze(symbol: string, candles: Candle[], currentSpread?: number, hasUpcomingNews?: boolean, assetType?: string): PreFilterResult {
    const warnings: string[] = [];

    // ============ STAGE 1: HARD RULES PRE-FILTER ============
    // Must pass ALL gates to proceed

    // Gate 1: Minimum candles check
    if (candles.length < PREFILTER_THRESHOLDS.minCandles) {
      return {
        passed: false,
        reason: `Insufficient data: ${candles.length}/${PREFILTER_THRESHOLDS.minCandles} candles`
      };
    }

    // Gate 2: Session & Liquidity check (skip for crypto - trades 24/7)
    const sessionGate = this.checkSessionGate(assetType);
    if (!sessionGate.passed) {
      return { passed: false, reason: sessionGate.reason, warnings: sessionGate.warnings };
    }
    if (sessionGate.warnings) warnings.push(...sessionGate.warnings);

    // Gate 3: Spread check
    const spreadGate = this.checkSpreadGate(symbol, currentSpread);
    if (!spreadGate.passed) {
      return { passed: false, reason: spreadGate.reason };
    }

    // Gate 4: News filter
    if (hasUpcomingNews) {
      return {
        passed: false,
        reason: 'High-impact news approaching - no trade zone'
      };
    }

    // Calculate indicators
    const indicators = this.calculator.calculate(candles);

    // Gate 5: Volatility sanity check
    const volatilityGate = this.checkVolatilityGate(symbol, candles, indicators.atr);
    if (!volatilityGate.passed) {
      return { passed: false, reason: volatilityGate.reason, indicators };
    }
    if (volatilityGate.warnings) warnings.push(...volatilityGate.warnings);

    // Gate 6: ATR filter - skip dead markets
    const atrPips = priceToPips(symbol, indicators.atr);
    if (atrPips < this.minAtrPips) {
      return {
        passed: false,
        reason: `Low volatility: ATR ${atrPips.toFixed(1)} pips < ${this.minAtrPips} min`,
        indicators
      };
    }

    // Gate 7: ADX gate - only trade trending markets
    if (indicators.adx < PREFILTER_THRESHOLDS.adxTrending) {
      return {
        passed: false,
        reason: `Weak trend: ADX ${indicators.adx.toFixed(1)} < ${PREFILTER_THRESHOLDS.adxTrending}`,
        indicators
      };
    }

    // Gate 8: Activity check - require minimum movement
    const activityGate = this.checkActivityGate(symbol, candles);
    if (!activityGate.passed) {
      return { passed: false, reason: activityGate.reason, indicators };
    }

    // ============ Calculate Twin Range Filter ============
    const twinRange = this.twinRangeFilter.calculate(candles);

    // ============ Determine Direction Bias (Twin Range Primary) ============
    let suggestedAction: 'BUY' | 'SELL' | undefined;

    // Twin Range signal takes priority (less lagging)
    if (twinRange.signal === 'BUY' || (twinRange.direction === 'bullish' && twinRange.strength >= 2)) {
      suggestedAction = 'BUY';
    } else if (twinRange.signal === 'SELL' || (twinRange.direction === 'bearish' && twinRange.strength >= 2)) {
      suggestedAction = 'SELL';
    } else {
      // Fallback to RSI extremes + DI for direction if Twin Range is neutral
      if (indicators.rsi <= PREFILTER_THRESHOLDS.rsiOversold) {
        if (indicators.plusDi > indicators.minusDi) {
          suggestedAction = 'BUY';
          warnings.push('Twin Range neutral - using RSI oversold for direction');
        }
      } else if (indicators.rsi >= PREFILTER_THRESHOLDS.rsiOverbought) {
        if (indicators.minusDi > indicators.plusDi) {
          suggestedAction = 'SELL';
          warnings.push('Twin Range neutral - using RSI overbought for direction');
        }
      } else {
        // Last resort: EMA + DI
        if (indicators.plusDi > indicators.minusDi && indicators.ema20 > indicators.ema50) {
          suggestedAction = 'BUY';
          warnings.push('Twin Range neutral - using EMA crossover for direction');
        } else if (indicators.minusDi > indicators.plusDi && indicators.ema20 < indicators.ema50) {
          suggestedAction = 'SELL';
          warnings.push('Twin Range neutral - using EMA crossover for direction');
        }
      }
    }

    if (!suggestedAction) {
      return {
        passed: false,
        reason: 'No clear directional bias from Twin Range or fallback indicators',
        indicators,
        twinRange,
        warnings
      };
    }

    const session = this.getCurrentSession();
    logger.info(`${symbol} passed pre-filter: ${suggestedAction} (TwinRange: ${twinRange.direction}, Strength: ${twinRange.strength}, RSI: ${indicators.rsi.toFixed(1)}, ADX: ${indicators.adx.toFixed(1)}, Session: ${session})`);

    return {
      passed: true,
      indicators,
      twinRange,
      suggestedAction,
      session,
      warnings: warnings.length > 0 ? warnings : undefined
    };
  }

  // ============ HARD GATE CHECKS ============

  private checkSessionGate(assetType?: string): HardGateResult {
    // Crypto trades 24/7 - skip all session checks
    if (assetType === 'crypto') {
      return { passed: true };
    }

    const now = new Date();
    const utcHour = now.getUTCHours();
    const utcMinutes = now.getUTCMinutes();
    const dayOfWeek = now.getUTCDay();
    const warnings: string[] = [];

    // No trading on weekends (forex/metals only)
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      return { passed: false, reason: 'Weekend - market closed' };
    }

    // Check if in London or NY session
    const inLondon = utcHour >= SESSION_CONFIG.london.start && utcHour < SESSION_CONFIG.london.end;
    const inNewYork = utcHour >= SESSION_CONFIG.newYork.start && utcHour < SESSION_CONFIG.newYork.end;
    const inAsian = utcHour >= SESSION_CONFIG.asian.start && utcHour < SESSION_CONFIG.asian.end;

    if (!inLondon && !inNewYork) {
      // Allow Asian session with a warning
      if (inAsian) {
        warnings.push('Asian session - lower liquidity expected');
        return { passed: true, warnings };
      }
      return { passed: false, reason: `Outside active sessions (Current: ${utcHour}:${utcMinutes.toString().padStart(2, '0')} UTC)` };
    }

    // Check for first/last 30 minutes of session
    const buffer = SESSION_CONFIG.sessionBufferMinutes;
    const minutesSinceHour = utcMinutes;

    // First 30 min of London
    if (utcHour === SESSION_CONFIG.london.start && minutesSinceHour < buffer) {
      return { passed: false, reason: 'First 30 minutes of London session - waiting for market to settle' };
    }
    // Last 30 min of London (if not in NY overlap)
    if (utcHour === SESSION_CONFIG.london.end - 1 && minutesSinceHour >= 30 && !inNewYork) {
      return { passed: false, reason: 'Last 30 minutes of London session' };
    }
    // First 30 min of NY
    if (utcHour === SESSION_CONFIG.newYork.start && minutesSinceHour < buffer) {
      warnings.push('Early NY session - market may be volatile');
    }
    // Last 30 min of NY
    if (utcHour === SESSION_CONFIG.newYork.end - 1 && minutesSinceHour >= 30) {
      return { passed: false, reason: 'Last 30 minutes of NY session' };
    }

    return { passed: true, warnings: warnings.length > 0 ? warnings : undefined };
  }

  private checkSpreadGate(symbol: string, currentSpread?: number): HardGateResult {
    if (!currentSpread) {
      return { passed: true }; // Can't check without spread data
    }

    const normalizedSymbol = symbol.replace(/[^A-Za-z]/g, '').toUpperCase();
    let maxSpread: number;

    if (MAJOR_PAIRS.includes(normalizedSymbol)) {
      maxSpread = SPREAD_LIMITS.majors;
    } else if (CROSS_PAIRS.includes(normalizedSymbol)) {
      maxSpread = SPREAD_LIMITS.crosses;
    } else if (normalizedSymbol.includes('XAU') || normalizedSymbol.includes('XAG')) {
      maxSpread = SPREAD_LIMITS.metals;
    } else {
      maxSpread = SPREAD_LIMITS.exotics;
    }

    // Convert spread to pips
    const spreadPips = priceToPips(symbol, currentSpread);

    if (spreadPips > maxSpread) {
      return {
        passed: false,
        reason: `Spread too high: ${spreadPips.toFixed(1)} pips > ${maxSpread} max`
      };
    }

    return { passed: true };
  }

  private checkVolatilityGate(symbol: string, candles: Candle[], atr: number): HardGateResult {
    if (candles.length < 20) return { passed: true };
    const warnings: string[] = [];

    // Check for extreme volatility (15m range > 3x average)
    const recentCandles = candles.slice(-12); // Last ~3 hours on 15m
    const ranges = recentCandles.map(c => c.high - c.low);
    const avgRange = ranges.slice(0, -1).reduce((a, b) => a + b) / (ranges.length - 1);
    const currentRange = ranges[ranges.length - 1];

    if (avgRange > 0 && currentRange > avgRange * VOLATILITY_GATES.extremeRangeMultiplier) {
      return {
        passed: false,
        reason: `Extreme volatility: current range ${(currentRange / avgRange).toFixed(1)}x average`
      };
    }

    // Check distance from daily open
    const dailyOpen = candles[Math.max(0, candles.length - 96)]?.open; // ~24h back on 15m
    if (dailyOpen) {
      const distanceFromOpen = Math.abs(candles[candles.length - 1].close - dailyOpen);
      const distancePips = priceToPips(symbol, distanceFromOpen);
      
      if (distancePips < VOLATILITY_GATES.minDistanceFromDailyOpen) {
        return {
          passed: false,
          reason: `Price too close to daily open: ${distancePips.toFixed(1)} pips (min: ${VOLATILITY_GATES.minDistanceFromDailyOpen})`
        };
      }
    }

    return { passed: true, warnings: warnings.length > 0 ? warnings : undefined };
  }

  private checkActivityGate(symbol: string, candles: Candle[]): HardGateResult {
    if (candles.length < 8) return { passed: true };

    // Check movement in last ~2 hours (8 x 15m candles)
    const recentCandles = candles.slice(-8);
    const high = Math.max(...recentCandles.map(c => c.high));
    const low = Math.min(...recentCandles.map(c => c.low));
    const movementPips = priceToPips(symbol, high - low);

    if (movementPips < VOLATILITY_GATES.minActivityPips) {
      return {
        passed: false,
        reason: `Low activity: only ${movementPips.toFixed(1)} pips movement in last 2 hours (min: ${VOLATILITY_GATES.minActivityPips})`
      };
    }

    return { passed: true };
  }

  getCurrentSession(): TradingSession {
    const now = new Date();
    const utcHour = now.getUTCHours();

    const inLondon = utcHour >= SESSION_CONFIG.london.start && utcHour < SESSION_CONFIG.london.end;
    const inNewYork = utcHour >= SESSION_CONFIG.newYork.start && utcHour < SESSION_CONFIG.newYork.end;
    const inAsian = utcHour >= SESSION_CONFIG.asian.start && utcHour < SESSION_CONFIG.asian.end;

    if (inLondon && inNewYork) return 'london_ny_overlap';
    if (inLondon) return 'london';
    if (inNewYork) return 'new_york';
    if (inAsian) return 'asian';
    return 'off_hours';
  }
}
