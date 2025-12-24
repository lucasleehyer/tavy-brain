/**
 * Entry Optimizer
 * 
 * Finds optimal limit order price within entry zone.
 * Key insight: Better entries = better R:R = higher win rate.
 */

import { EntryOptimizationResult } from '../../types/quant';
import { Candle } from '../../types/market';
import { DeepSeekClient } from '../ai/DeepSeekClient';
import { config } from '../../config';
import { logger } from '../../utils/logger';

interface OptimizationParams {
  currentPrice: number;
  direction: 'BUY' | 'SELL';
  atr: number;
  recentCandles: Candle[];
  nearestSupport?: number;
  nearestResistance?: number;
}

export class EntryOptimizer {
  private client: DeepSeekClient | null = null;
  
  // Entry zone configuration
  private readonly ZONE_ATR_MULTIPLIER = 0.5; // Entry zone = ±0.5 ATR
  private readonly MAX_WAIT_MINUTES = 60; // Max wait for limit order
  private readonly MIN_IMPROVEMENT_PIPS = 3; // Minimum improvement to wait

  private getClient(): DeepSeekClient | null {
    if (!this.client && config.ai.deepseek?.apiKey) {
      this.client = new DeepSeekClient(config.ai.deepseek.apiKey);
    }
    return this.client;
  }

  /**
   * Optimize entry price
   */
  async optimize(params: OptimizationParams): Promise<EntryOptimizationResult> {
    const { currentPrice, direction, atr, recentCandles, nearestSupport, nearestResistance } = params;

    // Calculate entry zone
    const zoneWidth = atr * this.ZONE_ATR_MULTIPLIER;
    let entryZone: { min: number; max: number };
    
    if (direction === 'BUY') {
      // For BUY, we want to enter lower (better price)
      entryZone = {
        min: Math.max(nearestSupport || 0, currentPrice - zoneWidth),
        max: currentPrice
      };
    } else {
      // For SELL, we want to enter higher (better price)
      entryZone = {
        min: currentPrice,
        max: Math.min(nearestResistance || Infinity, currentPrice + zoneWidth)
      };
    }

    // Analyze recent price action for entry optimization
    const analysis = this.analyzePriceAction(recentCandles, direction);
    
    // Use DeepSeek for sophisticated optimization if available
    const client = this.getClient();
    if (client) {
      try {
        return await this.optimizeWithDeepSeek(client, params, entryZone, analysis);
      } catch (error) {
        logger.warn('Entry optimization via DeepSeek failed, using local optimization');
      }
    }

    // Local optimization
    return this.optimizeLocally(params, entryZone, analysis);
  }

  /**
   * Optimize using DeepSeek
   */
  private async optimizeWithDeepSeek(
    client: DeepSeekClient,
    params: OptimizationParams,
    entryZone: { min: number; max: number },
    analysis: { recentRange: number; pullbackProbability: number }
  ): Promise<EntryOptimizationResult> {
    const { currentPrice, direction, atr } = params;
    
    const prompt = `You are a trade execution optimizer. Find optimal limit order price.

Current Setup:
- Current price: ${currentPrice}
- Direction: ${direction}
- ATR: ${atr.toFixed(5)}
- Entry zone: ${entryZone.min.toFixed(5)} to ${entryZone.max.toFixed(5)}
- Recent range: ${analysis.recentRange.toFixed(5)}
- Pullback probability: ${(analysis.pullbackProbability * 100).toFixed(0)}%

For a ${direction} trade:
1. Calculate optimal limit order price within the zone
2. Estimate probability of fill within 60 minutes
3. Estimate improvement in pips vs market order

Consider:
- Higher improvement = lower fill probability
- Balance between waiting for better price and getting filled
- If pullback probability is low, accept current price

Return ONLY a JSON object:
{
  "optimal_entry": number,
  "fill_probability": number (0-1),
  "wait_minutes": number,
  "improvement_pips": number,
  "use_limit": boolean
}`;

    const response = await client.chat(
      [{ role: 'user', content: prompt }],
      { model: 'deepseek-chat', temperature: 0.2, maxTokens: 500 }
    );

    try {
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        
        return {
          optimalEntry: parsed.optimal_entry || currentPrice,
          entryZone,
          waitTimeMinutes: parsed.wait_minutes || 0,
          fillProbability: parsed.fill_probability || 0.9,
          expectedImprovement: parsed.improvement_pips || 0,
          useLimit: parsed.use_limit || false,
          reason: `Optimal entry at ${parsed.optimal_entry?.toFixed(5)} (${parsed.improvement_pips?.toFixed(1)} pips better, ${(parsed.fill_probability * 100)?.toFixed(0)}% fill prob)`
        };
      }
    } catch (error) {
      logger.error('Failed to parse DeepSeek entry optimization response');
    }

    return this.optimizeLocally(params, entryZone, analysis);
  }

  /**
   * Local entry optimization
   */
  private optimizeLocally(
    params: OptimizationParams,
    entryZone: { min: number; max: number },
    analysis: { recentRange: number; pullbackProbability: number }
  ): EntryOptimizationResult {
    const { currentPrice, direction, atr } = params;
    
    // Calculate optimal entry based on pullback probability
    let optimalEntry = currentPrice;
    let improvement = 0;
    let useLimit = false;
    let waitTime = 0;
    let fillProbability = 1.0;

    if (analysis.pullbackProbability > 0.4) {
      // High pullback probability - use limit order
      const pullbackAmount = analysis.recentRange * 0.382; // Fib retracement
      
      if (direction === 'BUY') {
        optimalEntry = Math.max(entryZone.min, currentPrice - pullbackAmount);
        improvement = currentPrice - optimalEntry;
      } else {
        optimalEntry = Math.min(entryZone.max, currentPrice + pullbackAmount);
        improvement = optimalEntry - currentPrice;
      }

      // Estimate fill probability based on distance from current price
      const distanceRatio = Math.abs(optimalEntry - currentPrice) / atr;
      fillProbability = Math.max(0.3, 1 - distanceRatio);
      
      // Only use limit if improvement is significant
      useLimit = improvement * 10000 >= this.MIN_IMPROVEMENT_PIPS; // Convert to pips
      waitTime = useLimit ? 30 : 0;
    }

    // If not using limit, or improvement is minimal, use market price
    if (!useLimit) {
      optimalEntry = currentPrice;
      improvement = 0;
      waitTime = 0;
      fillProbability = 1.0;
    }

    const result: EntryOptimizationResult = {
      optimalEntry,
      entryZone,
      waitTimeMinutes: waitTime,
      fillProbability,
      expectedImprovement: improvement * 10000, // Convert to pips
      useLimit,
      reason: useLimit 
        ? `Limit order at ${optimalEntry.toFixed(5)} (${(improvement * 10000).toFixed(1)} pips better)`
        : 'Market order recommended - low pullback probability'
    };

    logger.info(`[ENTRY OPT] ${useLimit ? 'LIMIT' : 'MARKET'} @ ${optimalEntry.toFixed(5)} | Fill=${(fillProbability * 100).toFixed(0)}%`);

    return result;
  }

  /**
   * Analyze recent price action
   */
  private analyzePriceAction(candles: Candle[], direction: 'BUY' | 'SELL'): { recentRange: number; pullbackProbability: number } {
    if (!candles || candles.length < 10) {
      return { recentRange: 0, pullbackProbability: 0.3 };
    }

    const recent = candles.slice(-10);
    const high = Math.max(...recent.map(c => c.high));
    const low = Math.min(...recent.map(c => c.low));
    const recentRange = high - low;

    // Count pullbacks in recent candles
    let pullbacks = 0;
    for (let i = 1; i < recent.length; i++) {
      const prev = recent[i - 1];
      const curr = recent[i];
      
      if (direction === 'BUY') {
        // Pullback for BUY = lower low
        if (curr.low < prev.low) pullbacks++;
      } else {
        // Pullback for SELL = higher high
        if (curr.high > prev.high) pullbacks++;
      }
    }

    const pullbackProbability = pullbacks / (recent.length - 1);

    return { recentRange, pullbackProbability };
  }

  /**
   * Should use limit order?
   */
  shouldUseLimit(result: EntryOptimizationResult): boolean {
    return result.useLimit && result.fillProbability > 0.5;
  }
}
