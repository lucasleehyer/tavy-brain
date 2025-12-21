import { Candle, Indicators, MarketRegime } from '../../types/market';
import { TwinRangeResult } from './TwinRangeFilter';
import { KeyLevelResult } from './KeyLevelDetector';
import { CandlePatternResult } from './CandlePatterns';

export interface ConfluenceInput {
  indicators: Indicators;
  twinRange: TwinRangeResult;
  keyLevels: KeyLevelResult;
  candlePatterns: CandlePatternResult;
  regime: MarketRegime;
  session: 'london' | 'new_york' | 'london_ny_overlap' | 'asian' | 'off_hours';
  weeklyTrendAligned: boolean;
  // For adaptive threshold
  currentATR?: number;
  averageATR?: number;
  currentADX?: number;
}

export interface ConfluenceBreakdown {
  priceAction: {
    atKeyLevel: number;         // 0-15
    candlePattern: number;      // 0-10
    marketStructure: number;    // 0-15
    subtotal: number;           // 0-40
  };
  momentum: {
    twinRangeAligned: number;   // 0-15
    rangeExpansion: number;     // 0-10
    last3Candles: number;       // 0-5
    subtotal: number;           // 0-30
  };
  trf: {
    fastSlowAligned: number;    // 0-10
    gapExpanding: number;       // 0-5
    priceNearFast: number;      // 0-5
    subtotal: number;           // 0-20 (bonus points)
  };
  context: {
    sessionStrength: number;    // 0-15
    weeklyTrend: number;        // 0-10
    regimeClarity: number;      // 0-5
    subtotal: number;           // 0-30
  };
  total: number;                // 0-100+
  adjustedMinimum: number;      // Dynamic threshold
  details: string[];
}

export interface ConfluenceResult {
  score: number;
  passed: boolean;
  suggestedDirection: 'BUY' | 'SELL' | 'NONE';
  breakdown: ConfluenceBreakdown;
  adaptiveThreshold: number;
}

export class ConfluenceScorer {
  private baseMinimumScore: number;
  private currentMinimumScore: number;

  constructor(minimumScore: number = 60) {
    this.baseMinimumScore = minimumScore;
    this.currentMinimumScore = minimumScore;
  }

  updateMinimumScore(score: number): void {
    this.baseMinimumScore = score;
    this.currentMinimumScore = score;
  }

  /**
   * Calculate adaptive threshold based on market conditions
   * Higher thresholds in volatile or trendless conditions
   */
  calculateAdaptiveThreshold(
    currentATR: number,
    averageATR: number,
    adx: number,
    session: string
  ): number {
    let threshold = this.baseMinimumScore;

    // High volatility: ATR > 1.5× average → be stricter
    if (averageATR > 0 && currentATR > averageATR * 1.5) {
      threshold += 10;
    } else if (averageATR > 0 && currentATR > averageATR * 1.2) {
      threshold += 5;
    }

    // Low trend strength: ADX < 20 → require better setups
    if (adx < 20) {
      threshold += 5;
    } else if (adx < 15) {
      threshold += 10;
    }

    // Asian session: historically lower success rate
    if (session === 'asian') {
      threshold += 5;
    }

    // Off-hours: highest threshold
    if (session === 'off_hours') {
      threshold += 15;
    }

    this.currentMinimumScore = Math.min(70, threshold); // Cap at 70 (reduced from 85)
    return this.currentMinimumScore;
  }

  score(input: ConfluenceInput): ConfluenceResult {
    // Calculate adaptive threshold if data provided
    let adaptiveThreshold = this.currentMinimumScore;
    if (input.currentATR && input.averageATR) {
      adaptiveThreshold = this.calculateAdaptiveThreshold(
        input.currentATR,
        input.averageATR,
        input.currentADX || 25,
        input.session
      );
    }

    const breakdown = this.calculateBreakdown(input, adaptiveThreshold);
    const suggestedDirection = this.determineDirection(input);

    return {
      score: breakdown.total,
      passed: breakdown.total >= adaptiveThreshold,
      suggestedDirection,
      breakdown,
      adaptiveThreshold
    };
  }

  private calculateBreakdown(input: ConfluenceInput, adaptiveThreshold: number): ConfluenceBreakdown {
    const details: string[] = [];

    // ============ PRICE ACTION & STRUCTURE (40 pts max) ============
    
    // At Key Level: 0-15 pts
    let atKeyLevel = 0;
    if (input.keyLevels.atKeyLevel) {
      atKeyLevel = 15;
      details.push(`At key ${input.keyLevels.levelType} level (+15)`);
    } else if (input.keyLevels.distanceToNearestLevel < input.indicators.atr * 0.5) {
      atKeyLevel = 8;
      details.push('Near key level (+8)');
    }

    // Candlestick Pattern: 0-10 pts
    let candlePattern = 0;
    if (input.candlePatterns.primaryPattern) {
      candlePattern = input.candlePatterns.primaryPattern.strength * 3 + 1;
      details.push(`${input.candlePatterns.primaryPattern.name} pattern (+${candlePattern})`);
    }

    // Market Structure Alignment: 0-15 pts
    let marketStructure = 0;
    if (input.regime.direction !== 'neutral' && input.regime.strength >= 0.6) {
      marketStructure = 15;
      details.push(`Strong ${input.regime.direction} structure (+15)`);
    } else if (input.regime.direction !== 'neutral') {
      marketStructure = 8;
      details.push(`${input.regime.direction} structure (+8)`);
    }

    const priceActionSubtotal = Math.min(40, atKeyLevel + candlePattern + marketStructure);

    // ============ MOMENTUM (30 pts max) ============

    // Twin Range Aligned: 0-15 pts
    let twinRangeAligned = 0;
    if (input.twinRange.direction !== 'neutral' && input.twinRange.strength >= 3) {
      twinRangeAligned = 15;
      details.push(`Strong Twin Range ${input.twinRange.direction} (${input.twinRange.strength} bars) (+15)`);
    } else if (input.twinRange.direction !== 'neutral' && input.twinRange.strength >= 2) {
      twinRangeAligned = 10;
      details.push(`Twin Range ${input.twinRange.direction} (+10)`);
    } else if (input.twinRange.direction !== 'neutral') {
      twinRangeAligned = 5;
      details.push(`Weak Twin Range signal (+5)`);
    }

    // Range Expansion: 0-10 pts
    let rangeExpansion = 0;
    if (input.candlePatterns.rangeExpansion >= 1.5) {
      rangeExpansion = 10;
      details.push(`Range expansion ${input.candlePatterns.rangeExpansion.toFixed(1)}x (+10)`);
    } else if (input.candlePatterns.rangeExpansion >= 1.3) {
      rangeExpansion = 6;
      details.push(`Range expansion ${input.candlePatterns.rangeExpansion.toFixed(1)}x (+6)`);
    }

    // Last 3 Candles Direction: 0-5 pts
    let last3Candles = 0;
    if (input.candlePatterns.last3CandlesDirection !== 'mixed') {
      last3Candles = 5;
      details.push(`Last 3 candles ${input.candlePatterns.last3CandlesDirection} (+5)`);
    }

    const momentumSubtotal = Math.min(30, twinRangeAligned + rangeExpansion + last3Candles);

    // ============ TRF-SPECIFIC SCORING (20 pts bonus) ============

    // Fast & Slow Filters Aligned: 0-10 pts
    let fastSlowAligned = 0;
    if (input.twinRange.fastSlowAligned) {
      fastSlowAligned = 10;
      details.push('TRF Fast & Slow aligned (+10)');
    }

    // Gap Expanding (filters diverging = strong trend): 0-5 pts
    let gapExpanding = 0;
    if (input.twinRange.gapExpanding) {
      gapExpanding = 5;
      details.push('TRF gap expanding (+5)');
    }

    // Price Near Fast Filter (ideal pullback entry): 0-5 pts
    let priceNearFast = 0;
    if (input.twinRange.priceNearFastFilter) {
      priceNearFast = 5;
      details.push('Price near fast filter (+5)');
    }

    const trfSubtotal = fastSlowAligned + gapExpanding + priceNearFast;

    // ============ CONTEXT (30 pts max) ============

    // Session Strength: 0-15 pts
    let sessionStrength = 0;
    if (input.session === 'london_ny_overlap') {
      sessionStrength = 15;
      details.push('London-NY overlap session (+15)');
    } else if (input.session === 'london' || input.session === 'new_york') {
      sessionStrength = 10;
      details.push(`${input.session} session (+10)`);
    } else if (input.session === 'asian') {
      sessionStrength = 3;
      details.push('Asian session (+3)');
    }

    // Weekly Trend Alignment: 0-10 pts
    let weeklyTrend = 0;
    if (input.weeklyTrendAligned) {
      weeklyTrend = 10;
      details.push('Aligned with weekly trend (+10)');
    }

    // Regime Clarity: 0-5 pts
    let regimeClarity = 0;
    if (input.regime.confidence >= 0.8) {
      regimeClarity = 5;
      details.push('High regime confidence (+5)');
    } else if (input.regime.confidence >= 0.6) {
      regimeClarity = 2;
    }

    const contextSubtotal = Math.min(30, sessionStrength + weeklyTrend + regimeClarity);

    // ============ TOTAL ============
    // Base 100 + up to 20 TRF bonus
    const total = priceActionSubtotal + momentumSubtotal + contextSubtotal + trfSubtotal;

    return {
      priceAction: {
        atKeyLevel,
        candlePattern,
        marketStructure,
        subtotal: priceActionSubtotal
      },
      momentum: {
        twinRangeAligned,
        rangeExpansion,
        last3Candles,
        subtotal: momentumSubtotal
      },
      trf: {
        fastSlowAligned,
        gapExpanding,
        priceNearFast,
        subtotal: trfSubtotal
      },
      context: {
        sessionStrength,
        weeklyTrend,
        regimeClarity,
        subtotal: contextSubtotal
      },
      total,
      adjustedMinimum: adaptiveThreshold,
      details
    };
  }

  private determineDirection(input: ConfluenceInput): 'BUY' | 'SELL' | 'NONE' {
    let bullishScore = 0;
    let bearishScore = 0;

    // Twin Range direction is primary (weight: 3)
    if (input.twinRange.direction === 'bullish') bullishScore += 3;
    if (input.twinRange.direction === 'bearish') bearishScore += 3;

    // Twin Range signal (weight: 2)
    if (input.twinRange.signal === 'BUY') bullishScore += 2;
    if (input.twinRange.signal === 'SELL') bearishScore += 2;

    // TRF Fast/Slow alignment adds confidence (weight: 1)
    if (input.twinRange.fastSlowAligned) {
      if (input.twinRange.direction === 'bullish') bullishScore += 1;
      if (input.twinRange.direction === 'bearish') bearishScore += 1;
    }

    // Candle pattern (weight: 2)
    if (input.candlePatterns.primaryPattern?.type === 'bullish') bullishScore += 2;
    if (input.candlePatterns.primaryPattern?.type === 'bearish') bearishScore += 2;

    // Last 3 candles (weight: 1)
    if (input.candlePatterns.last3CandlesDirection === 'bullish') bullishScore += 1;
    if (input.candlePatterns.last3CandlesDirection === 'bearish') bearishScore += 1;

    // Regime direction (weight: 2)
    if (input.regime.direction === 'bullish') bullishScore += 2;
    if (input.regime.direction === 'bearish') bearishScore += 2;

    // Key level type (weight: 1)
    if (input.keyLevels.atKeyLevel && input.keyLevels.levelType === 'support') bullishScore += 1;
    if (input.keyLevels.atKeyLevel && input.keyLevels.levelType === 'resistance') bearishScore += 1;

    if (bullishScore >= 5 && bullishScore > bearishScore) return 'BUY';
    if (bearishScore >= 5 && bearishScore > bullishScore) return 'SELL';
    return 'NONE';
  }

  getAdaptiveThreshold(): number {
    return this.currentMinimumScore;
  }

  getBaseThreshold(): number {
    return this.baseMinimumScore;
  }
}
