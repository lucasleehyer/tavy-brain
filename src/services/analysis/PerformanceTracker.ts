/**
 * Performance Tracker
 * 
 * Tracks outcomes by symbol, regime, session, and structure type.
 * Feeds data to Bayesian engine and optimizer.
 */

import { supabase } from '../database/SupabaseClient';
import { logger } from '../../utils/logger';
import { PerformanceMetrics, PerformanceBreakdown, PerformanceTrackerResult } from '../../types/quant';

export class PerformanceTracker {
  private cache: PerformanceTrackerResult | null = null;
  private cacheExpiry: Date | null = null;
  private readonly CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutes

  /**
   * Get comprehensive performance breakdown
   */
  async getPerformance(lookbackDays: number = 30): Promise<PerformanceTrackerResult> {
    // Check cache
    if (this.cache && this.cacheExpiry && new Date() < this.cacheExpiry) {
      return this.cache;
    }

    const lookbackDate = new Date();
    lookbackDate.setDate(lookbackDate.getDate() - lookbackDays);

    try {
      const { data, error } = await supabase
        .from('trade_analytics')
        .select('*')
        .gte('created_at', lookbackDate.toISOString())
        .in('outcome', ['win', 'loss']);

      if (error || !data) {
        logger.error('Failed to fetch trade analytics:', error);
        return this.getEmptyResult(lookbackDays);
      }

      const breakdown = this.calculateBreakdown(data);
      const rollingWinRate = breakdown.overall.winRate;
      
      // Determine trend
      const recentTrades = data.slice(-10);
      const recentWinRate = recentTrades.filter((t: any) => t.outcome === 'win').length / recentTrades.length;
      let trend: 'improving' | 'stable' | 'declining';
      
      if (recentWinRate > rollingWinRate + 0.05) {
        trend = 'improving';
      } else if (recentWinRate < rollingWinRate - 0.05) {
        trend = 'declining';
      } else {
        trend = 'stable';
      }

      const result: PerformanceTrackerResult = {
        lastUpdated: new Date(),
        lookbackDays,
        breakdown,
        rollingWinRate,
        trend
      };

      // Cache result
      this.cache = result;
      this.cacheExpiry = new Date(Date.now() + this.CACHE_DURATION_MS);

      logger.info(`[PERF] Win rate: ${(rollingWinRate * 100).toFixed(1)}% | Trend: ${trend} | Trades: ${data.length}`);

      return result;

    } catch (error) {
      logger.error('Performance tracker error:', error);
      return this.getEmptyResult(lookbackDays);
    }
  }

  /**
   * Calculate performance breakdown by various dimensions
   */
  private calculateBreakdown(trades: any[]): PerformanceBreakdown {
    const bySymbol: Record<string, any[]> = {};
    const byRegime: Record<string, any[]> = {};
    const bySession: Record<string, any[]> = {};
    const byStructure: Record<string, any[]> = {};

    // Group trades
    for (const trade of trades) {
      // By symbol
      const symbol = trade.symbol || 'unknown';
      if (!bySymbol[symbol]) bySymbol[symbol] = [];
      bySymbol[symbol].push(trade);

      // By regime
      const regime = trade.entry_regime || 'unknown';
      if (!byRegime[regime]) byRegime[regime] = [];
      byRegime[regime].push(trade);

      // By session
      const session = trade.entry_session || 'unknown';
      if (!bySession[session]) bySession[session] = [];
      bySession[session].push(trade);

      // By structure (we'll add this field later, for now use 'unknown')
      const structure = 'unknown';
      if (!byStructure[structure]) byStructure[structure] = [];
      byStructure[structure].push(trade);
    }

    return {
      bySymbol: this.mapToMetrics(bySymbol),
      byRegime: this.mapToMetrics(byRegime),
      bySession: this.mapToMetrics(bySession),
      byStructure: this.mapToMetrics(byStructure),
      overall: this.calculateMetrics(trades)
    };
  }

  /**
   * Map grouped trades to metrics
   */
  private mapToMetrics(grouped: Record<string, any[]>): Record<string, PerformanceMetrics> {
    const result: Record<string, PerformanceMetrics> = {};
    for (const [key, trades] of Object.entries(grouped)) {
      result[key] = this.calculateMetrics(trades);
    }
    return result;
  }

  /**
   * Calculate metrics from a set of trades
   */
  private calculateMetrics(trades: any[]): PerformanceMetrics {
    if (trades.length === 0) {
      return this.getEmptyMetrics();
    }

    const wins = trades.filter((t: any) => t.outcome === 'win');
    const losses = trades.filter((t: any) => t.outcome === 'loss');

    const avgWinPips = wins.length > 0
      ? wins.reduce((sum: number, t: any) => sum + (t.pnl_pips || 0), 0) / wins.length
      : 0;

    const avgLossPips = losses.length > 0
      ? Math.abs(losses.reduce((sum: number, t: any) => sum + (t.pnl_pips || 0), 0) / losses.length)
      : 0;

    const totalWinPips = wins.reduce((sum: number, t: any) => sum + (t.pnl_pips || 0), 0);
    const totalLossPips = Math.abs(losses.reduce((sum: number, t: any) => sum + (t.pnl_pips || 0), 0));

    const profitFactor = totalLossPips > 0 ? totalWinPips / totalLossPips : totalWinPips > 0 ? 999 : 1;

    // Calculate consecutive wins/losses
    let maxConsecutiveWins = 0;
    let maxConsecutiveLosses = 0;
    let currentWins = 0;
    let currentLosses = 0;

    for (const trade of trades) {
      if (trade.outcome === 'win') {
        currentWins++;
        currentLosses = 0;
        maxConsecutiveWins = Math.max(maxConsecutiveWins, currentWins);
      } else {
        currentLosses++;
        currentWins = 0;
        maxConsecutiveLosses = Math.max(maxConsecutiveLosses, currentLosses);
      }
    }

    // Calculate max drawdown
    let peak = 0;
    let maxDrawdown = 0;
    let cumPnl = 0;

    for (const trade of trades) {
      cumPnl += trade.pnl_percent || 0;
      peak = Math.max(peak, cumPnl);
      const drawdown = peak - cumPnl;
      maxDrawdown = Math.max(maxDrawdown, drawdown);
    }

    // Calculate Sharpe ratio (simplified)
    const returns = trades.map((t: any) => t.pnl_percent || 0);
    const avgReturn = returns.reduce((a: number, b: number) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum: number, r: number) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
    const stdDev = Math.sqrt(variance);
    const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0; // Annualized

    return {
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: wins.length / trades.length,
      avgWinPips,
      avgLossPips,
      profitFactor,
      sharpeRatio,
      maxDrawdown,
      consecutiveWins: maxConsecutiveWins,
      consecutiveLosses: maxConsecutiveLosses
    };
  }

  /**
   * Get win rate for specific conditions
   */
  async getWinRateFor(
    conditions: {
      symbol?: string;
      regime?: string;
      session?: string;
      structure?: string;
    },
    lookbackDays: number = 30
  ): Promise<{ winRate: number; sampleSize: number }> {
    const performance = await this.getPerformance(lookbackDays);
    
    let metrics: PerformanceMetrics | undefined;

    if (conditions.symbol) {
      metrics = performance.breakdown.bySymbol[conditions.symbol];
    } else if (conditions.regime) {
      metrics = performance.breakdown.byRegime[conditions.regime];
    } else if (conditions.session) {
      metrics = performance.breakdown.bySession[conditions.session];
    } else if (conditions.structure) {
      metrics = performance.breakdown.byStructure[conditions.structure];
    }

    if (!metrics) {
      return { winRate: performance.rollingWinRate, sampleSize: performance.breakdown.overall.totalTrades };
    }

    return { winRate: metrics.winRate, sampleSize: metrics.totalTrades };
  }

  /**
   * Get empty result
   */
  private getEmptyResult(lookbackDays: number): PerformanceTrackerResult {
    return {
      lastUpdated: new Date(),
      lookbackDays,
      breakdown: {
        bySymbol: {},
        byRegime: {},
        bySession: {},
        byStructure: {},
        overall: this.getEmptyMetrics()
      },
      rollingWinRate: 0.5,
      trend: 'stable'
    };
  }

  /**
   * Get empty metrics
   */
  private getEmptyMetrics(): PerformanceMetrics {
    return {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0.5,
      avgWinPips: 0,
      avgLossPips: 0,
      profitFactor: 1,
      sharpeRatio: 0,
      maxDrawdown: 0,
      consecutiveWins: 0,
      consecutiveLosses: 0
    };
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.cache = null;
    this.cacheExpiry = null;
  }
}
