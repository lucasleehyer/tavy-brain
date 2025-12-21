import { SupabaseClient } from '../database/SupabaseClient';
import { logger } from '../../utils/logger';

interface TradeAnalysis {
  id: string;
  symbol: string;
  direction: string;
  outcome: 'win' | 'loss' | 'breakeven';
  pnlPips: number;
  pnlPercent: number;
  confluenceScore: number;
  aiConfidence: number;
  trfAligned: boolean;
  entryRegime: string;
  entrySession: string;
  holdDurationMinutes: number;
}

interface PerformanceInsight {
  metric: string;
  value: number;
  bucket?: string;
  sampleSize: number;
}

interface OptimizationSuggestion {
  parameter: string;
  currentValue: number;
  suggestedValue: number;
  reason: string;
  confidenceLevel: 'high' | 'medium' | 'low';
}

interface WeeklyReport {
  startDate: string;
  endDate: string;
  totalTrades: number;
  winRate: number;
  avgPnlPips: number;
  avgPnlPercent: number;
  insightsByConfluence: PerformanceInsight[];
  insightsByConfidence: PerformanceInsight[];
  insightsByTRF: PerformanceInsight[];
  insightsBySession: PerformanceInsight[];
  insightsByRegime: PerformanceInsight[];
  suggestions: OptimizationSuggestion[];
}

export class PerformanceAnalyzer {
  private supabase: SupabaseClient;
  private minSampleSize: number = 10;

  constructor() {
    this.supabase = new SupabaseClient();
  }

  async runWeeklyAnalysis(): Promise<WeeklyReport> {
    logger.info('Running weekly performance analysis...');

    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);

    const trades = await this.fetchClosedTrades(startDate, endDate);
    
    if (trades.length === 0) {
      logger.info('No closed trades in the past week');
      return this.createEmptyReport(startDate, endDate);
    }

    const analyses = this.analyzeTradesData(trades);

    const report: WeeklyReport = {
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      totalTrades: trades.length,
      winRate: this.calculateWinRate(analyses),
      avgPnlPips: this.calculateAverage(analyses, 'pnlPips'),
      avgPnlPercent: this.calculateAverage(analyses, 'pnlPercent'),
      insightsByConfluence: this.analyzeByConfluenceBuckets(analyses),
      insightsByConfidence: this.analyzeByConfidenceBuckets(analyses),
      insightsByTRF: this.analyzeByTRFStatus(analyses),
      insightsBySession: this.analyzeBySession(analyses),
      insightsByRegime: this.analyzeByRegime(analyses),
      suggestions: this.generateSuggestions(analyses)
    };

    await this.saveReport(report);

    logger.info(`Weekly analysis complete: ${report.totalTrades} trades, ${(report.winRate * 100).toFixed(1)}% win rate`);
    
    return report;
  }

  private async fetchClosedTrades(startDate: Date, endDate: Date): Promise<any[]> {
    try {
      const { data, error } = await this.supabase.client
        .from('trade_analytics')
        .select('*')
        .gte('closed_at', startDate.toISOString())
        .lte('closed_at', endDate.toISOString())
        .not('outcome', 'is', null);

      if (error) throw error;
      return data || [];
    } catch (error) {
      logger.error('Failed to fetch trades for analysis:', error);
      return [];
    }
  }

  private analyzeTradesData(trades: any[]): TradeAnalysis[] {
    return trades.map(trade => ({
      id: trade.id,
      symbol: trade.symbol,
      direction: trade.direction,
      outcome: this.determineOutcome(trade.pnl_pips),
      pnlPips: trade.pnl_pips || 0,
      pnlPercent: trade.pnl_percent || 0,
      confluenceScore: trade.quant_score || 0, // Mapped from quant_score
      aiConfidence: trade.ai_confidence || 0,
      trfAligned: trade.entry_trend === 'aligned', // Derive from entry_trend
      entryRegime: trade.entry_regime || 'unknown',
      entrySession: trade.entry_session || 'unknown',
      holdDurationMinutes: trade.hold_duration_minutes || 0
    }));
  }

  private determineOutcome(pnlPips: number | null): 'win' | 'loss' | 'breakeven' {
    if (pnlPips === null || pnlPips === 0) return 'breakeven';
    return pnlPips > 0 ? 'win' : 'loss';
  }

  private calculateWinRate(analyses: TradeAnalysis[]): number {
    if (analyses.length === 0) return 0;
    const wins = analyses.filter(a => a.outcome === 'win').length;
    return wins / analyses.length;
  }

  private calculateAverage(analyses: TradeAnalysis[], field: keyof TradeAnalysis): number {
    if (analyses.length === 0) return 0;
    const sum = analyses.reduce((acc, a) => acc + (a[field] as number), 0);
    return sum / analyses.length;
  }

  private analyzeByConfluenceBuckets(analyses: TradeAnalysis[]): PerformanceInsight[] {
    const buckets = [
      { min: 0, max: 59, label: '0-59' },
      { min: 60, max: 69, label: '60-69' },
      { min: 70, max: 79, label: '70-79' },
      { min: 80, max: 89, label: '80-89' },
      { min: 90, max: 100, label: '90-100' }
    ];

    return buckets.map(bucket => {
      const trades = analyses.filter(a => a.confluenceScore >= bucket.min && a.confluenceScore <= bucket.max);
      return {
        metric: 'win_rate_by_confluence',
        bucket: bucket.label,
        value: trades.length > 0 ? this.calculateWinRate(trades) : 0,
        sampleSize: trades.length
      };
    }).filter(i => i.sampleSize > 0);
  }

  private analyzeByConfidenceBuckets(analyses: TradeAnalysis[]): PerformanceInsight[] {
    const buckets = [
      { min: 0, max: 59, label: '0-59%' },
      { min: 60, max: 69, label: '60-69%' },
      { min: 70, max: 84, label: '70-84%' },
      { min: 85, max: 100, label: '85-100%' }
    ];

    return buckets.map(bucket => {
      const trades = analyses.filter(a => a.aiConfidence >= bucket.min && a.aiConfidence <= bucket.max);
      return {
        metric: 'win_rate_by_confidence',
        bucket: bucket.label,
        value: trades.length > 0 ? this.calculateWinRate(trades) : 0,
        sampleSize: trades.length
      };
    }).filter(i => i.sampleSize > 0);
  }

  private analyzeByTRFStatus(analyses: TradeAnalysis[]): PerformanceInsight[] {
    const aligned = analyses.filter(a => a.trfAligned);
    const notAligned = analyses.filter(a => !a.trfAligned);

    return [
      {
        metric: 'win_rate_by_trf',
        bucket: 'aligned',
        value: aligned.length > 0 ? this.calculateWinRate(aligned) : 0,
        sampleSize: aligned.length
      },
      {
        metric: 'win_rate_by_trf',
        bucket: 'not_aligned',
        value: notAligned.length > 0 ? this.calculateWinRate(notAligned) : 0,
        sampleSize: notAligned.length
      }
    ].filter(i => i.sampleSize > 0);
  }

  private analyzeBySession(analyses: TradeAnalysis[]): PerformanceInsight[] {
    const sessions = ['london', 'new_york', 'asian', 'london_ny_overlap'];
    
    return sessions.map(session => {
      const trades = analyses.filter(a => a.entrySession.toLowerCase().includes(session.replace('_', '')));
      return {
        metric: 'win_rate_by_session',
        bucket: session,
        value: trades.length > 0 ? this.calculateWinRate(trades) : 0,
        sampleSize: trades.length
      };
    }).filter(i => i.sampleSize > 0);
  }

  private analyzeByRegime(analyses: TradeAnalysis[]): PerformanceInsight[] {
    const regimes = ['trending', 'ranging', 'volatile', 'quiet'];
    
    return regimes.map(regime => {
      const trades = analyses.filter(a => a.entryRegime.toLowerCase() === regime);
      return {
        metric: 'win_rate_by_regime',
        bucket: regime,
        value: trades.length > 0 ? this.calculateWinRate(trades) : 0,
        sampleSize: trades.length
      };
    }).filter(i => i.sampleSize > 0);
  }

  private generateSuggestions(analyses: TradeAnalysis[]): OptimizationSuggestion[] {
    const suggestions: OptimizationSuggestion[] = [];

    if (analyses.length < this.minSampleSize) {
      return suggestions; // Not enough data
    }

    // Check confluence score effectiveness
    const highConfluence = analyses.filter(a => a.confluenceScore >= 80);
    const lowConfluence = analyses.filter(a => a.confluenceScore >= 60 && a.confluenceScore < 70);

    if (highConfluence.length >= 5 && lowConfluence.length >= 5) {
      const highWinRate = this.calculateWinRate(highConfluence);
      const lowWinRate = this.calculateWinRate(lowConfluence);

      if (highWinRate - lowWinRate > 0.15) {
        suggestions.push({
          parameter: 'min_confluence_score',
          currentValue: 60,
          suggestedValue: 70,
          reason: `High confluence (80+) win rate: ${(highWinRate * 100).toFixed(1)}% vs low (60-69): ${(lowWinRate * 100).toFixed(1)}%`,
          confidenceLevel: 'high'
        });
      }
    }

    // Check TRF alignment impact
    const trfAligned = analyses.filter(a => a.trfAligned);
    const trfNotAligned = analyses.filter(a => !a.trfAligned);

    if (trfAligned.length >= 5 && trfNotAligned.length >= 5) {
      const alignedWinRate = this.calculateWinRate(trfAligned);
      const notAlignedWinRate = this.calculateWinRate(trfNotAligned);

      if (alignedWinRate - notAlignedWinRate > 0.1) {
        suggestions.push({
          parameter: 'require_trf_alignment',
          currentValue: 0,
          suggestedValue: 1,
          reason: `TRF aligned win rate: ${(alignedWinRate * 100).toFixed(1)}% vs not aligned: ${(notAlignedWinRate * 100).toFixed(1)}%`,
          confidenceLevel: 'medium'
        });
      }
    }

    // Check AI confidence tiers
    const highConfidence = analyses.filter(a => a.aiConfidence >= 85);
    const midConfidence = analyses.filter(a => a.aiConfidence >= 70 && a.aiConfidence < 85);

    if (highConfidence.length >= 5 && midConfidence.length >= 5) {
      const highWinRate = this.calculateWinRate(highConfidence);
      const midWinRate = this.calculateWinRate(midConfidence);

      if (highWinRate - midWinRate > 0.1) {
        suggestions.push({
          parameter: 'min_ai_confidence',
          currentValue: 60,
          suggestedValue: 70,
          reason: `85%+ confidence win rate: ${(highWinRate * 100).toFixed(1)}% vs 70-84%: ${(midWinRate * 100).toFixed(1)}%`,
          confidenceLevel: 'medium'
        });
      }
    }

    return suggestions;
  }

  private async saveReport(report: WeeklyReport): Promise<void> {
    try {
      await this.supabase.client
        .from('ai_optimization_runs')
        .insert({
          run_date: report.startDate,
          status: 'completed',
          trades_analyzed: report.totalTrades,
          win_rate: report.winRate,
          avg_pnl_pips: report.avgPnlPips,
          performance_data: {
            insightsByConfluence: report.insightsByConfluence,
            insightsByConfidence: report.insightsByConfidence,
            insightsByTRF: report.insightsByTRF,
            insightsBySession: report.insightsBySession,
            insightsByRegime: report.insightsByRegime
          },
          suggested_changes: report.suggestions,
          current_thresholds: {},
          reasoning: `Weekly analysis of ${report.totalTrades} trades. Win rate: ${(report.winRate * 100).toFixed(1)}%`
        });

      // Also log to VPS activity
      await this.supabase.client
        .from('vps_activity_logs')
        .insert({
          activity_type: 'performance_analysis',
          human_message: `Weekly analysis complete: ${report.totalTrades} trades, ${(report.winRate * 100).toFixed(1)}% win rate`,
          level: 'info',
          details: {
            suggestions: report.suggestions.length,
            topInsight: report.suggestions[0]?.reason || 'No suggestions'
          }
        });
    } catch (error) {
      logger.error('Failed to save weekly report:', error);
    }
  }

  private createEmptyReport(startDate: Date, endDate: Date): WeeklyReport {
    return {
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      totalTrades: 0,
      winRate: 0,
      avgPnlPips: 0,
      avgPnlPercent: 0,
      insightsByConfluence: [],
      insightsByConfidence: [],
      insightsByTRF: [],
      insightsBySession: [],
      insightsByRegime: [],
      suggestions: []
    };
  }

  async getHistoricalReports(count: number = 4): Promise<any[]> {
    try {
      const { data, error } = await this.supabase.client
        .from('ai_optimization_runs')
        .select('*')
        .order('run_date', { ascending: false })
        .limit(count);

      if (error) throw error;
      return data || [];
    } catch (error) {
      logger.error('Failed to fetch historical reports:', error);
      return [];
    }
  }
}
