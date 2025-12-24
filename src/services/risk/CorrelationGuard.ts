/**
 * Correlation Guard
 * 
 * Prevents conflicting positions on correlated pairs.
 * Key insight: LONG EURUSD + SHORT GBPUSD = double USD exposure (bad)
 */

import { CorrelationResult } from '../../types/quant';
import { logger } from '../../utils/logger';

interface OpenPosition {
  symbol: string;
  direction: 'long' | 'short';
  size: number;
}

// Static correlation matrix for major pairs
// Positive = move together, Negative = move opposite
const CORRELATION_MATRIX: Record<string, Record<string, number>> = {
  'EURUSD': { 'GBPUSD': 0.85, 'AUDUSD': 0.75, 'NZDUSD': 0.70, 'USDCHF': -0.90, 'USDJPY': -0.30 },
  'GBPUSD': { 'EURUSD': 0.85, 'AUDUSD': 0.70, 'NZDUSD': 0.65, 'USDCHF': -0.80, 'USDJPY': -0.25 },
  'AUDUSD': { 'EURUSD': 0.75, 'GBPUSD': 0.70, 'NZDUSD': 0.90, 'USDCHF': -0.70, 'USDJPY': 0.10 },
  'NZDUSD': { 'EURUSD': 0.70, 'GBPUSD': 0.65, 'AUDUSD': 0.90, 'USDCHF': -0.65, 'USDJPY': 0.15 },
  'USDCHF': { 'EURUSD': -0.90, 'GBPUSD': -0.80, 'AUDUSD': -0.70, 'NZDUSD': -0.65, 'USDJPY': 0.55 },
  'USDJPY': { 'EURUSD': -0.30, 'GBPUSD': -0.25, 'AUDUSD': 0.10, 'NZDUSD': 0.15, 'USDCHF': 0.55 },
  'EURGBP': { 'EURJPY': 0.60, 'GBPJPY': 0.40 },
  'EURJPY': { 'USDJPY': 0.80, 'GBPJPY': 0.85, 'EURGBP': 0.60 },
  'GBPJPY': { 'USDJPY': 0.75, 'EURJPY': 0.85, 'EURGBP': 0.40 },
};

// Currency exposure mapping
const CURRENCY_EXPOSURE: Record<string, { base: string; quote: string }> = {
  'EURUSD': { base: 'EUR', quote: 'USD' },
  'GBPUSD': { base: 'GBP', quote: 'USD' },
  'AUDUSD': { base: 'AUD', quote: 'USD' },
  'NZDUSD': { base: 'NZD', quote: 'USD' },
  'USDCHF': { base: 'USD', quote: 'CHF' },
  'USDJPY': { base: 'USD', quote: 'JPY' },
  'USDCAD': { base: 'USD', quote: 'CAD' },
  'EURGBP': { base: 'EUR', quote: 'GBP' },
  'EURJPY': { base: 'EUR', quote: 'JPY' },
  'GBPJPY': { base: 'GBP', quote: 'JPY' },
  'AUDJPY': { base: 'AUD', quote: 'JPY' },
  'CADJPY': { base: 'CAD', quote: 'JPY' },
  'CHFJPY': { base: 'CHF', quote: 'JPY' },
  'EURAUD': { base: 'EUR', quote: 'AUD' },
  'EURCHF': { base: 'EUR', quote: 'CHF' },
  'GBPAUD': { base: 'GBP', quote: 'AUD' },
  'GBPCHF': { base: 'GBP', quote: 'CHF' },
  'AUDCHF': { base: 'AUD', quote: 'CHF' },
  'AUDNZD': { base: 'AUD', quote: 'NZD' },
  'NZDJPY': { base: 'NZD', quote: 'JPY' },
};

export class CorrelationGuard {
  private readonly HIGH_CORRELATION_THRESHOLD = 0.70;
  private readonly MAX_SINGLE_CURRENCY_EXPOSURE = 2; // Max 2 positions in same direction per currency

  /**
   * Check if a new trade conflicts with open positions
   */
  check(
    symbol: string,
    direction: 'long' | 'short',
    openPositions: OpenPosition[]
  ): CorrelationResult {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    
    // Calculate net currency exposure
    const netExposure = this.calculateNetExposure(openPositions);
    
    // Check for conflicting positions
    const conflictingPositions: string[] = [];
    
    for (const pos of openPositions) {
      const normalizedPosSymbol = this.normalizeSymbol(pos.symbol);
      const correlation = this.getCorrelation(normalizedSymbol, normalizedPosSymbol);
      
      // High positive correlation + same direction = concentration risk
      if (correlation > this.HIGH_CORRELATION_THRESHOLD && pos.direction === direction) {
        // Not a conflict per se, but increases risk
        logger.debug(`[CORR] Same direction on correlated pair: ${symbol} & ${pos.symbol}`);
      }
      
      // High positive correlation + opposite direction = conflicting bet
      if (correlation > this.HIGH_CORRELATION_THRESHOLD && pos.direction !== direction) {
        conflictingPositions.push(`${pos.symbol} (${pos.direction})`);
      }
      
      // High negative correlation + same direction = conflicting bet
      if (correlation < -this.HIGH_CORRELATION_THRESHOLD && pos.direction === direction) {
        conflictingPositions.push(`${pos.symbol} (${pos.direction})`);
      }
    }

    // Add exposure from proposed trade
    const proposedExposure = this.getCurrencyExposure(normalizedSymbol, direction);
    const updatedExposure = { ...netExposure };
    
    for (const [currency, exposure] of Object.entries(proposedExposure)) {
      const key = currency as keyof typeof updatedExposure;
      if (key in updatedExposure) {
        updatedExposure[key] += exposure;
      }
    }

    // Check for excessive single currency exposure
    let correlationRisk: 'low' | 'medium' | 'high' = 'low';
    const maxExposure = Math.max(...Object.values(updatedExposure).map(Math.abs));
    
    if (maxExposure >= 3) {
      correlationRisk = 'high';
    } else if (maxExposure >= 2) {
      correlationRisk = 'medium';
    }

    // Determine if can trade
    const canTrade = conflictingPositions.length === 0 && 
                     correlationRisk !== 'high';

    let reason: string;
    if (!canTrade) {
      if (conflictingPositions.length > 0) {
        reason = `Conflicting positions: ${conflictingPositions.join(', ')}`;
      } else {
        reason = `Excessive currency exposure (${maxExposure}x)`;
      }
    } else if (correlationRisk === 'medium') {
      reason = 'Moderate correlation risk - proceed with smaller size';
    } else {
      reason = 'No correlation conflicts';
    }

    const result: CorrelationResult = {
      canTrade,
      conflictingPositions,
      netExposure: updatedExposure,
      correlationRisk,
      reason
    };

    logger.info(`[CORR] ${canTrade ? 'OK' : 'BLOCKED'} | ${reason}`);

    return result;
  }

  /**
   * Calculate net currency exposure from open positions
   */
  private calculateNetExposure(positions: OpenPosition[]): CorrelationResult['netExposure'] {
    const exposure: CorrelationResult['netExposure'] = {
      USD: 0, EUR: 0, GBP: 0, JPY: 0, CHF: 0, AUD: 0, CAD: 0, NZD: 0
    };

    for (const pos of positions) {
      const normalizedSymbol = this.normalizeSymbol(pos.symbol);
      const currencyExp = this.getCurrencyExposure(normalizedSymbol, pos.direction);
      
      for (const [currency, exp] of Object.entries(currencyExp)) {
        const key = currency as keyof typeof exposure;
        if (key in exposure) {
          exposure[key] += exp;
        }
      }
    }

    return exposure;
  }

  /**
   * Get currency exposure for a symbol and direction
   */
  private getCurrencyExposure(
    symbol: string, 
    direction: 'long' | 'short'
  ): Record<string, number> {
    const exposure: Record<string, number> = {};
    const pair = CURRENCY_EXPOSURE[symbol];
    
    if (!pair) return exposure;

    // LONG = buy base, sell quote
    // SHORT = sell base, buy quote
    const multiplier = direction === 'long' ? 1 : -1;
    
    exposure[pair.base] = multiplier;
    exposure[pair.quote] = -multiplier;
    
    return exposure;
  }

  /**
   * Get correlation between two symbols
   */
  private getCorrelation(symbol1: string, symbol2: string): number {
    if (symbol1 === symbol2) return 1;
    
    const correlations = CORRELATION_MATRIX[symbol1];
    if (correlations && symbol2 in correlations) {
      return correlations[symbol2];
    }
    
    // Check reverse
    const reverseCorrelations = CORRELATION_MATRIX[symbol2];
    if (reverseCorrelations && symbol1 in reverseCorrelations) {
      return reverseCorrelations[symbol1];
    }
    
    return 0; // Unknown correlation
  }

  /**
   * Normalize symbol (remove suffixes like .a, .b, etc.)
   */
  private normalizeSymbol(symbol: string): string {
    return symbol.replace(/\.[a-z]$/i, '').toUpperCase();
  }

  /**
   * Quick check if trade is allowed
   */
  isAllowed(result: CorrelationResult): boolean {
    return result.canTrade;
  }

  /**
   * Get position size multiplier based on correlation risk
   */
  getSizeMultiplier(result: CorrelationResult): number {
    switch (result.correlationRisk) {
      case 'high': return 0.5;
      case 'medium': return 0.75;
      case 'low': return 1.0;
      default: return 1.0;
    }
  }
}
