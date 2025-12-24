/**
 * Optimal Transport Distance
 * 
 * Calculates statistical distance between current setup and historical winners/losers.
 * Key insight: Similar setups to past winners = higher probability of success.
 */

import { DistanceResult } from '../../types/quant';
import { supabase } from '../database/SupabaseClient';
import { logger } from '../../utils/logger';

interface FeatureVector {
  confluence: number;      // 0-100
  confidence: number;      // 0-100
  regime: string;          // trending/ranging/volatile
  structure: number;       // 0-100 (entry quality score)
  session: string;         // asian/london/new_york
  mtfAlignment: number;    // 0-100
}

interface HistoricalStats {
  winners: FeatureVector[];
  losers: FeatureVector[];
  winnersMean: Record<string, number>;
  losersMean: Record<string, number>;
  winnersStdDev: Record<string, number>;
  losersStdDev: Record<string, number>;
}

export class OptimalTransportDistance {
  private cachedStats: HistoricalStats | null = null;
  private cacheExpiry: Date | null = null;
  private readonly CACHE_DURATION_MS = 30 * 60 * 1000; // 30 minutes
  private readonly MIN_SAMPLES = 20;

  /**
   * Calculate distance from current setup to historical patterns
   */
  async calculate(currentFeatures: FeatureVector): Promise<DistanceResult> {
    try {
      // Get historical statistics
      const stats = await this.getHistoricalStats();
      
      if (!stats || stats.winners.length < this.MIN_SAMPLES) {
        return this.getDefaultResult(currentFeatures);
      }

      // Calculate Mahalanobis distance to winners and losers
      const distanceToWinners = this.calculateMahalanobisDistance(
        currentFeatures,
        stats.winnersMean,
        stats.winnersStdDev
      );

      const distanceToLosers = this.calculateMahalanobisDistance(
        currentFeatures,
        stats.losersMean,
        stats.losersStdDev
      );

      // Distance ratio: < 1 means closer to winners
      const distanceRatio = distanceToWinners / Math.max(0.01, distanceToLosers);
      
      // Signal strength
      const isStrongSignal = distanceRatio < 0.7;
      const isWeakSignal = distanceRatio > 1.3;

      let reason: string;
      if (isStrongSignal) {
        reason = `Strong signal: Setup similar to winners (ratio: ${distanceRatio.toFixed(2)})`;
      } else if (isWeakSignal) {
        reason = `Weak signal: Setup similar to losers (ratio: ${distanceRatio.toFixed(2)})`;
      } else {
        reason = `Neutral signal: Mixed similarity (ratio: ${distanceRatio.toFixed(2)})`;
      }

      const result: DistanceResult = {
        distanceToWinners,
        distanceToLosers,
        distanceRatio,
        isStrongSignal,
        featureVector: currentFeatures,
        reason
      };

      logger.info(`[OT DISTANCE] D(W)=${distanceToWinners.toFixed(2)} D(L)=${distanceToLosers.toFixed(2)} Ratio=${distanceRatio.toFixed(2)} Strong=${isStrongSignal}`);

      return result;

    } catch (error) {
      logger.error('Optimal Transport calculation error:', error);
      return this.getDefaultResult(currentFeatures);
    }
  }

  /**
   * Get historical statistics from database
   */
  private async getHistoricalStats(): Promise<HistoricalStats | null> {
    // Check cache
    if (this.cachedStats && this.cacheExpiry && new Date() < this.cacheExpiry) {
      return this.cachedStats;
    }

    const lookbackDate = new Date();
    lookbackDate.setDate(lookbackDate.getDate() - 60); // Last 60 days

    const { data, error } = await supabase
      .from('trade_analytics')
      .select('outcome, ai_confidence, entry_regime, entry_session, final_confidence')
      .gte('created_at', lookbackDate.toISOString())
      .in('outcome', ['win', 'loss']);

    if (error || !data || data.length < this.MIN_SAMPLES * 2) {
      return null;
    }

    // Convert to feature vectors
    const winners: FeatureVector[] = [];
    const losers: FeatureVector[] = [];

    for (const trade of data) {
      const features: FeatureVector = {
        confluence: trade.final_confidence || trade.ai_confidence || 50,
        confidence: trade.ai_confidence || 50,
        regime: trade.entry_regime || 'unknown',
        structure: 50, // Default - would need structure data
        session: trade.entry_session || 'unknown',
        mtfAlignment: 50 // Default - would need MTF data
      };

      if (trade.outcome === 'win') {
        winners.push(features);
      } else {
        losers.push(features);
      }
    }

    // Calculate means and standard deviations
    const winnersMean = this.calculateMean(winners);
    const losersMean = this.calculateMean(losers);
    const winnersStdDev = this.calculateStdDev(winners, winnersMean);
    const losersStdDev = this.calculateStdDev(losers, losersMean);

    const stats: HistoricalStats = {
      winners,
      losers,
      winnersMean,
      losersMean,
      winnersStdDev,
      losersStdDev
    };

    // Cache
    this.cachedStats = stats;
    this.cacheExpiry = new Date(Date.now() + this.CACHE_DURATION_MS);

    return stats;
  }

  /**
   * Calculate mean of numerical features
   */
  private calculateMean(vectors: FeatureVector[]): Record<string, number> {
    if (vectors.length === 0) return {};

    const sum: Record<string, number> = {
      confluence: 0,
      confidence: 0,
      structure: 0,
      mtfAlignment: 0
    };

    for (const v of vectors) {
      sum.confluence += v.confluence;
      sum.confidence += v.confidence;
      sum.structure += v.structure;
      sum.mtfAlignment += v.mtfAlignment;
    }

    return {
      confluence: sum.confluence / vectors.length,
      confidence: sum.confidence / vectors.length,
      structure: sum.structure / vectors.length,
      mtfAlignment: sum.mtfAlignment / vectors.length
    };
  }

  /**
   * Calculate standard deviation
   */
  private calculateStdDev(vectors: FeatureVector[], mean: Record<string, number>): Record<string, number> {
    if (vectors.length < 2) {
      return { confluence: 10, confidence: 10, structure: 10, mtfAlignment: 10 };
    }

    const keys = ['confluence', 'confidence', 'structure', 'mtfAlignment'];
    const variance: Record<string, number> = {};

    for (const key of keys) {
      let sumSq = 0;
      for (const v of vectors) {
        const value = v[key as keyof FeatureVector] as number;
        sumSq += Math.pow(value - mean[key], 2);
      }
      variance[key] = sumSq / (vectors.length - 1);
    }

    return {
      confluence: Math.sqrt(variance.confluence) || 10,
      confidence: Math.sqrt(variance.confidence) || 10,
      structure: Math.sqrt(variance.structure) || 10,
      mtfAlignment: Math.sqrt(variance.mtfAlignment) || 10
    };
  }

  /**
   * Calculate Mahalanobis-like distance
   */
  private calculateMahalanobisDistance(
    current: FeatureVector,
    mean: Record<string, number>,
    stdDev: Record<string, number>
  ): number {
    const keys = ['confluence', 'confidence', 'structure', 'mtfAlignment'];
    let sumSq = 0;

    for (const key of keys) {
      const value = current[key as keyof FeatureVector] as number;
      const z = (value - (mean[key] || 50)) / (stdDev[key] || 10);
      sumSq += z * z;
    }

    return Math.sqrt(sumSq / keys.length);
  }

  /**
   * Get default result when insufficient data
   */
  private getDefaultResult(currentFeatures: FeatureVector): DistanceResult {
    return {
      distanceToWinners: 1,
      distanceToLosers: 1,
      distanceRatio: 1,
      isStrongSignal: false,
      featureVector: currentFeatures,
      reason: 'Insufficient historical data for comparison'
    };
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.cachedStats = null;
    this.cacheExpiry = null;
  }

  /**
   * Check if signal is strong based on distance
   */
  isStrong(result: DistanceResult): boolean {
    return result.isStrongSignal;
  }
}
