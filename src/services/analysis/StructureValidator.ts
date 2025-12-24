/**
 * Structure Validator
 * 
 * Validates that entries occur at key support/resistance levels.
 * Key insight: Best entries happen at structure, not in no-man's land.
 */

import { Candle } from '../../types/market';
import { StructureResult, EntryQuality, StructureType } from '../../types/quant';
import { logger } from '../../utils/logger';

interface KeyLevel {
  price: number;
  type: 'support' | 'resistance';
  touches: number;
  strength: number;
}

export class StructureValidator {
  private readonly ATR_THRESHOLD_EXCELLENT = 0.3; // Within 0.3 ATR = excellent
  private readonly ATR_THRESHOLD_GOOD = 0.5;      // Within 0.5 ATR = good
  private readonly ATR_THRESHOLD_POOR = 1.0;      // Within 1.0 ATR = poor
  private readonly MIN_CANDLES_FOR_OB = 3;

  /**
   * Validate entry against market structure
   */
  validate(
    candles: Candle[],
    entryPrice: number,
    direction: 'BUY' | 'SELL',
    atr: number
  ): StructureResult {
    if (!candles || candles.length < 20 || !atr || atr <= 0) {
      return this.getInvalidResult('Insufficient data for structure analysis');
    }

    // Detect key levels
    const keyLevels = this.detectKeyLevels(candles);
    
    // Find nearest relevant level (support for BUY, resistance for SELL)
    const relevantLevels = keyLevels.filter(l => 
      direction === 'BUY' ? l.type === 'support' : l.type === 'resistance'
    );

    // Also check for order blocks and FVGs
    const orderBlock = this.detectOrderBlock(candles, direction);
    const fvg = this.detectFVG(candles, direction);

    // Find nearest level to entry
    let nearestLevel: KeyLevel | null = null;
    let minDistance = Infinity;

    for (const level of relevantLevels) {
      const distance = Math.abs(entryPrice - level.price);
      if (distance < minDistance) {
        minDistance = distance;
        nearestLevel = level;
      }
    }

    // Calculate distance in ATR terms
    const distanceInATR = nearestLevel ? minDistance / atr : Infinity;
    
    // Determine entry quality
    let entryQuality: EntryQuality;
    let structureType: StructureType = 'none';
    let reason: string;

    // Check order block first (highest priority)
    if (orderBlock.detected && orderBlock.distance !== null && orderBlock.distance / atr < this.ATR_THRESHOLD_GOOD) {
      entryQuality = 'excellent';
      structureType = 'orderblock';
      reason = `At order block (${(orderBlock.distance / atr).toFixed(2)} ATR away)`;
    }
    // Check FVG second
    else if (fvg.detected && fvg.distance !== null && fvg.distance / atr < this.ATR_THRESHOLD_GOOD) {
      entryQuality = 'good';
      structureType = 'fvg';
      reason = `Near FVG (${(fvg.distance / atr).toFixed(2)} ATR away)`;
    }
    // Check key levels
    else if (distanceInATR <= this.ATR_THRESHOLD_EXCELLENT) {
      entryQuality = 'excellent';
      structureType = nearestLevel?.type || 'support';
      reason = `Excellent: At key ${structureType} (${distanceInATR.toFixed(2)} ATR)`;
    } else if (distanceInATR <= this.ATR_THRESHOLD_GOOD) {
      entryQuality = 'good';
      structureType = nearestLevel?.type || 'support';
      reason = `Good: Near key ${structureType} (${distanceInATR.toFixed(2)} ATR)`;
    } else if (distanceInATR <= this.ATR_THRESHOLD_POOR) {
      entryQuality = 'poor';
      structureType = nearestLevel?.type || 'none';
      reason = `Poor: Far from structure (${distanceInATR.toFixed(2)} ATR)`;
    } else {
      entryQuality = 'invalid';
      structureType = 'none';
      reason = `Invalid: No structure nearby (${distanceInATR.toFixed(2)} ATR)`;
    }

    const withinRange = distanceInATR <= this.ATR_THRESHOLD_POOR;

    const result: StructureResult = {
      entryQuality,
      structureType,
      nearestLevel: nearestLevel?.price || 0,
      distanceToLevel: minDistance,
      distanceInATR,
      withinRange,
      orderBlockDetected: orderBlock.detected,
      fvgDetected: fvg.detected,
      reason
    };

    logger.info(`[STRUCTURE] ${entryQuality.toUpperCase()} | ${structureType} | ${reason}`);

    return result;
  }

  /**
   * Detect key support and resistance levels
   */
  private detectKeyLevels(candles: Candle[]): KeyLevel[] {
    const levels: KeyLevel[] = [];
    const tolerance = 0.0005; // 5 pips tolerance for forex

    // Find swing highs and lows
    for (let i = 2; i < candles.length - 2; i++) {
      const prev2 = candles[i - 2];
      const prev1 = candles[i - 1];
      const curr = candles[i];
      const next1 = candles[i + 1];
      const next2 = candles[i + 2];

      // Swing high (resistance)
      if (curr.high > prev1.high && curr.high > prev2.high && 
          curr.high > next1.high && curr.high > next2.high) {
        this.addOrMergeLevel(levels, curr.high, 'resistance', tolerance);
      }

      // Swing low (support)
      if (curr.low < prev1.low && curr.low < prev2.low &&
          curr.low < next1.low && curr.low < next2.low) {
        this.addOrMergeLevel(levels, curr.low, 'support', tolerance);
      }
    }

    // Calculate strength based on touches
    return levels
      .filter(l => l.touches >= 2)
      .sort((a, b) => b.strength - a.strength)
      .slice(0, 10); // Top 10 levels
  }

  /**
   * Add level or merge with existing if close
   */
  private addOrMergeLevel(
    levels: KeyLevel[],
    price: number,
    type: 'support' | 'resistance',
    tolerance: number
  ): void {
    const existing = levels.find(l => 
      Math.abs(l.price - price) / price < tolerance && l.type === type
    );

    if (existing) {
      existing.touches++;
      existing.strength = existing.touches * 10 + 50;
      existing.price = (existing.price + price) / 2; // Average
    } else {
      levels.push({
        price,
        type,
        touches: 1,
        strength: 50
      });
    }
  }

  /**
   * Detect order blocks (significant institutional candles)
   */
  private detectOrderBlock(
    candles: Candle[],
    direction: 'BUY' | 'SELL'
  ): { detected: boolean; price: number | null; distance: number | null } {
    if (candles.length < this.MIN_CANDLES_FOR_OB + 5) {
      return { detected: false, price: null, distance: null };
    }

    const recentCandles = candles.slice(-20);
    const currentPrice = candles[candles.length - 1].close;

    for (let i = recentCandles.length - 3; i >= 0; i--) {
      const candle = recentCandles[i];
      const body = Math.abs(candle.close - candle.open);
      const range = candle.high - candle.low;
      
      // Order block = large body candle (>70% body to range)
      if (body / range > 0.7) {
        const isBullishOB = candle.close > candle.open;
        const obPrice = isBullishOB ? candle.low : candle.high;
        
        // For BUY, we want bullish OB below current price
        // For SELL, we want bearish OB above current price
        if (direction === 'BUY' && isBullishOB && obPrice < currentPrice) {
          return {
            detected: true,
            price: obPrice,
            distance: currentPrice - obPrice
          };
        }
        if (direction === 'SELL' && !isBullishOB && obPrice > currentPrice) {
          return {
            detected: true,
            price: obPrice,
            distance: obPrice - currentPrice
          };
        }
      }
    }

    return { detected: false, price: null, distance: null };
  }

  /**
   * Detect Fair Value Gaps (imbalances)
   */
  private detectFVG(
    candles: Candle[],
    direction: 'BUY' | 'SELL'
  ): { detected: boolean; high: number | null; low: number | null; distance: number | null } {
    if (candles.length < 5) {
      return { detected: false, high: null, low: null, distance: null };
    }

    const recentCandles = candles.slice(-15);
    const currentPrice = candles[candles.length - 1].close;

    for (let i = 1; i < recentCandles.length - 1; i++) {
      const candle1 = recentCandles[i - 1];
      const candle3 = recentCandles[i + 1];

      // Bullish FVG: candle3.low > candle1.high
      if (direction === 'BUY' && candle3.low > candle1.high) {
        const fvgHigh = candle3.low;
        const fvgLow = candle1.high;
        const fvgMid = (fvgHigh + fvgLow) / 2;
        
        if (currentPrice > fvgHigh) {
          return {
            detected: true,
            high: fvgHigh,
            low: fvgLow,
            distance: currentPrice - fvgMid
          };
        }
      }

      // Bearish FVG: candle1.low > candle3.high
      if (direction === 'SELL' && candle1.low > candle3.high) {
        const fvgHigh = candle1.low;
        const fvgLow = candle3.high;
        const fvgMid = (fvgHigh + fvgLow) / 2;
        
        if (currentPrice < fvgLow) {
          return {
            detected: true,
            high: fvgHigh,
            low: fvgLow,
            distance: fvgMid - currentPrice
          };
        }
      }
    }

    return { detected: false, high: null, low: null, distance: null };
  }

  /**
   * Return invalid result
   */
  private getInvalidResult(reason: string): StructureResult {
    return {
      entryQuality: 'invalid',
      structureType: 'none',
      nearestLevel: 0,
      distanceToLevel: Infinity,
      distanceInATR: Infinity,
      withinRange: false,
      orderBlockDetected: false,
      fvgDetected: false,
      reason
    };
  }

  /**
   * Check if structure quality is tradeable
   */
  isTradeable(result: StructureResult): boolean {
    return result.entryQuality !== 'invalid' && result.entryQuality !== 'poor';
  }
}
