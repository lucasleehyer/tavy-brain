import { supabase } from '../database/SupabaseClient';
import { logger } from '../../utils/logger';

interface TradeStats {
  totalTrades: number;
  wins: number;
  losses: number;
  avgWinPercent: number;
  avgLossPercent: number;
  winRate: number;
  profitFactor: number;
}

interface KellyResult {
  kellyPercent: number;
  halfKellyPercent: number;
  quarterKellyPercent: number;
  recommendedPercent: number;
  reason: string;
  stats: TradeStats;
}

interface KellyConfig {
  lookbackDays: number;
  minTrades: number;
  maxRiskPercent: number;
  defaultRiskPercent: number;
  kellyFraction: number; // 0.25 = quarter Kelly, 0.5 = half Kelly
}

const DEFAULT_CONFIG: KellyConfig = {
  lookbackDays: 30,
  minTrades: 10,
  maxRiskPercent: 5, // Aggressive but capped
  defaultRiskPercent: 2,
  kellyFraction: 0.5 // Half Kelly for safety
};

/**
 * Kelly Criterion Calculator for Optimal Position Sizing
 * Based on: f* = W - (1-W)/R
 * Where: W = win rate, R = average win/average loss ratio
 */
export class KellyCalculator {
  private config: KellyConfig;
  private cachedStats: TradeStats | null = null;
  private lastStatsUpdate: Date | null = null;

  constructor(config?: Partial<KellyConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Calculate optimal Kelly position size
   */
  async calculate(assetType?: 'forex' | 'crypto'): Promise<KellyResult> {
    const stats = await this.getTradeStats(assetType);

    // If not enough trades, use default
    if (stats.totalTrades < this.config.minTrades) {
      return {
        kellyPercent: 0,
        halfKellyPercent: 0,
        quarterKellyPercent: 0,
        recommendedPercent: this.config.defaultRiskPercent,
        reason: `Insufficient trade history (${stats.totalTrades}/${this.config.minTrades} required)`,
        stats
      };
    }

    // Kelly formula: f* = W - (1-W)/R
    // W = win rate, R = avg win / avg loss
    const W = stats.winRate;
    const R = stats.avgWinPercent / Math.abs(stats.avgLossPercent || 1);

    // Raw Kelly percentage
    const kellyPercent = (W - ((1 - W) / R)) * 100;

    // If Kelly is negative, we shouldn't trade at all
    if (kellyPercent <= 0) {
      return {
        kellyPercent: 0,
        halfKellyPercent: 0,
        quarterKellyPercent: 0,
        recommendedPercent: 0,
        reason: `Negative Kelly (${kellyPercent.toFixed(2)}%) - edge is negative, should not trade`,
        stats
      };
    }

    const halfKelly = kellyPercent * 0.5;
    const quarterKelly = kellyPercent * 0.25;
    
    // Apply configured fraction
    let recommended = kellyPercent * this.config.kellyFraction;
    
    // Cap at maximum
    recommended = Math.min(recommended, this.config.maxRiskPercent);
    
    // Ensure minimum
    recommended = Math.max(recommended, 0.5);

    const reason = this.generateReason(stats, kellyPercent, recommended);

    logger.info(`[KELLY] WinRate=${(W * 100).toFixed(1)}%, R:R=${R.toFixed(2)}, Kelly=${kellyPercent.toFixed(2)}%, Recommended=${recommended.toFixed(2)}%`);

    return {
      kellyPercent,
      halfKellyPercent: halfKelly,
      quarterKellyPercent: quarterKelly,
      recommendedPercent: recommended,
      reason,
      stats
    };
  }

  /**
   * Get optimal risk for a specific confidence level
   * Higher confidence = closer to full Kelly
   */
  async getOptimalRisk(confidence: number, assetType?: 'forex' | 'crypto'): Promise<number> {
    const kellyResult = await this.calculate(assetType);

    // If no edge, return minimum
    if (kellyResult.recommendedPercent <= 0) {
      return 0.5;
    }

    // Scale by confidence (60-100%)
    // 60% confidence = 50% of recommended
    // 100% confidence = 100% of recommended
    const confidenceScale = (confidence - 50) / 50; // 0.2 to 1.0
    const scaledRisk = kellyResult.recommendedPercent * Math.max(0.5, confidenceScale);

    // Apply aggressive mode for crypto
    const multiplier = assetType === 'crypto' ? 1.5 : 1.0;
    
    let finalRisk = scaledRisk * multiplier;
    
    // Cap at max
    finalRisk = Math.min(finalRisk, this.config.maxRiskPercent);

    logger.info(`[KELLY-OPTIMAL] Confidence=${confidence}%, Base=${kellyResult.recommendedPercent.toFixed(2)}%, Final=${finalRisk.toFixed(2)}%`);

    return finalRisk;
  }

  /**
   * Get trade statistics from database
   */
  private async getTradeStats(assetType?: 'forex' | 'crypto'): Promise<TradeStats> {
    // Use cache if recent (5 minutes)
    if (this.cachedStats && this.lastStatsUpdate) {
      const cacheAge = Date.now() - this.lastStatsUpdate.getTime();
      if (cacheAge < 5 * 60 * 1000) {
        return this.cachedStats;
      }
    }

    try {
      const lookbackDate = new Date();
      lookbackDate.setDate(lookbackDate.getDate() - this.config.lookbackDays);

      let query = supabase
        .from('trade_analytics')
        .select('outcome, pnl_percent')
        .gte('created_at', lookbackDate.toISOString())
        .in('outcome', ['win', 'loss']);

      if (assetType) {
        query = query.eq('asset_type', assetType);
      }

      const { data, error } = await query;

      if (error || !data || data.length === 0) {
        return this.getDefaultStats();
      }

      const wins = data.filter(t => t.outcome === 'win');
      const losses = data.filter(t => t.outcome === 'loss');

      const avgWinPercent = wins.length > 0
        ? wins.reduce((sum, t) => sum + (t.pnl_percent || 0), 0) / wins.length
        : 2; // Default 2% win

      const avgLossPercent = losses.length > 0
        ? losses.reduce((sum, t) => sum + (t.pnl_percent || 0), 0) / losses.length
        : -1; // Default 1% loss

      const stats: TradeStats = {
        totalTrades: data.length,
        wins: wins.length,
        losses: losses.length,
        avgWinPercent,
        avgLossPercent,
        winRate: wins.length / data.length,
        profitFactor: Math.abs(avgWinPercent * wins.length) / Math.abs(avgLossPercent * losses.length || 1)
      };

      // Cache the stats
      this.cachedStats = stats;
      this.lastStatsUpdate = new Date();

      return stats;

    } catch (error) {
      logger.error('Failed to get trade stats for Kelly:', error);
      return this.getDefaultStats();
    }
  }

  private getDefaultStats(): TradeStats {
    return {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      avgWinPercent: 2,
      avgLossPercent: -1,
      winRate: 0.55, // Assume 55% for aggressive trading
      profitFactor: 1.5
    };
  }

  private generateReason(stats: TradeStats, kelly: number, recommended: number): string {
    const parts = [];
    
    parts.push(`${stats.totalTrades} trades analyzed`);
    parts.push(`${(stats.winRate * 100).toFixed(0)}% win rate`);
    parts.push(`${stats.profitFactor.toFixed(2)} profit factor`);
    
    if (kelly > 20) {
      parts.push('Strong edge detected');
    } else if (kelly > 10) {
      parts.push('Moderate edge detected');
    } else if (kelly > 0) {
      parts.push('Slight edge detected');
    }

    return parts.join(', ');
  }

  updateConfig(config: Partial<KellyConfig>): void {
    this.config = { ...this.config, ...config };
    this.cachedStats = null; // Clear cache on config change
  }
}
