import { SupabaseManager } from '../database/SupabaseClient';
import { DeepSeekClient } from './DeepSeekClient';
import { AlertManager } from '../notifications/AlertManager';
import { logger } from '../../utils/logger';

// Hard guardrails - AI CANNOT suggest changes outside these bounds
const HARD_GUARDRAILS = {
  risk_percent_per_trade: { min: 1, max: 2 },
  daily_loss_limit_pct: { min: 5, max: 10 },
  weekly_loss_limit_pct: { min: 10, max: 20 },
  forex_min_tp1_pips: { min: 30, max: 60 },
  min_risk_reward: { min: 1.5, max: 3.0 }
};

// Soft parameters - AI can optimize within these ranges
const SOFT_PARAMETERS = {
  min_confidence: { min: 60, max: 80, default: 70 },
  momentum_threshold_pips: { min: 4, max: 10, default: 6 },
  adx_trending: { min: 18, max: 28, default: 22 },
  rsi_oversold: { min: 25, max: 40, default: 30 },
  rsi_overbought: { min: 60, max: 75, default: 70 },
  min_atr_pips: { min: 3, max: 8, default: 5 }
};

interface PerformanceData {
  tradesAnalyzed: number;
  winRate: number;
  avgPnlPips: number;
  totalPnlPips: number;
  maxDrawdownPct: number;
  avgHoldTimeMinutes: number;
  rejectionReasons: Record<string, number>;
  regimeDistribution: Record<string, number>;
  symbolPerformance: Record<string, { wins: number; losses: number; pnlPips: number }>;
}

interface SuggestedChange {
  key: string;
  currentValue: number;
  suggestedValue: number;
  reason: string;
}

interface OptimizationResult {
  status: 'applied' | 'no_changes' | 'insufficient_data' | 'error';
  suggestedChanges: SuggestedChange[];
  appliedChanges: SuggestedChange[];
  reasoning: string;
  performanceData: PerformanceData;
}

export class ThresholdOptimizer {
  private supabase = SupabaseManager.getInstance().getClient();
  private deepSeek: DeepSeekClient;
  private alertManager: AlertManager;

  constructor() {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new Error('DEEPSEEK_API_KEY is required for ThresholdOptimizer');
    }
    this.deepSeek = new DeepSeekClient(apiKey);
    this.alertManager = new AlertManager();
  }

  async runOptimization(): Promise<OptimizationResult> {
    logger.info('🧠 Starting AI Threshold Optimization...');
    
    const runId = crypto.randomUUID();
    
    try {
      // 1. Collect performance data from last 7 days
      const performance = await this.collectPerformanceData();
      
      // Check if we have enough data
      if (performance.tradesAnalyzed < 5) {
        logger.info(`Insufficient data for optimization: ${performance.tradesAnalyzed} trades (need 5+)`);
        await this.logOptimizationRun(runId, performance, [], [], 'Insufficient trade data for optimization', 'insufficient_data');
        return {
          status: 'insufficient_data',
          suggestedChanges: [],
          appliedChanges: [],
          reasoning: `Only ${performance.tradesAnalyzed} trades in last 7 days. Need at least 5 for optimization.`,
          performanceData: performance
        };
      }

      // 2. Get current thresholds
      const currentThresholds = await this.getCurrentThresholds();

      // 3. Send to DeepSeek Reasoner for analysis
      const suggestions = await this.getAISuggestions(performance, currentThresholds);

      // 4. Validate suggestions against guardrails
      const validatedChanges = this.validateSuggestions(suggestions.suggestedChanges);

      // 5. Apply valid changes
      if (validatedChanges.length > 0) {
        await this.applyChanges(validatedChanges);
        logger.info(`Applied ${validatedChanges.length} threshold changes`);
      } else {
        logger.info('No valid threshold changes to apply');
      }

      // 6. Log the optimization run
      await this.logOptimizationRun(
        runId,
        performance,
        suggestions.suggestedChanges,
        validatedChanges,
        suggestions.reasoning,
        validatedChanges.length > 0 ? 'applied' : 'no_changes'
      );

      // 7. Send alert about changes
      if (validatedChanges.length > 0) {
        await this.alertManager.sendAlert(
          'info',
          '🧠 AI Threshold Optimization Complete',
          `Applied ${validatedChanges.length} changes:\n${validatedChanges.map(c => `• ${c.key}: ${c.currentValue} → ${c.suggestedValue}`).join('\n')}`
        );
      }

      return {
        status: validatedChanges.length > 0 ? 'applied' : 'no_changes',
        suggestedChanges: suggestions.suggestedChanges,
        appliedChanges: validatedChanges,
        reasoning: suggestions.reasoning,
        performanceData: performance
      };

    } catch (error) {
      logger.error('Threshold optimization failed:', error);
      await this.logOptimizationRun(runId, { tradesAnalyzed: 0 } as PerformanceData, [], [], (error as Error).message, 'error');
      
      return {
        status: 'error',
        suggestedChanges: [],
        appliedChanges: [],
        reasoning: (error as Error).message,
        performanceData: { tradesAnalyzed: 0 } as PerformanceData
      };
    }
  }

  private async collectPerformanceData(): Promise<PerformanceData> {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    // Get closed trades from last 7 days
    const { data: trades, error: tradesError } = await this.supabase
      .from('trade_analytics')
      .select('*')
      .gte('closed_at', sevenDaysAgo.toISOString())
      .not('outcome', 'is', null);

    if (tradesError) {
      logger.error('Failed to fetch trades for optimization:', tradesError);
      throw tradesError;
    }

    // Get rejection logs from VPS activity
    const { data: rejections, error: rejectError } = await this.supabase
      .from('vps_activity_logs')
      .select('details')
      .eq('activity_type', 'signal_rejected')
      .gte('created_at', sevenDaysAgo.toISOString());

    // Calculate metrics
    const wins = trades?.filter(t => t.outcome === 'win') || [];
    const losses = trades?.filter(t => t.outcome === 'loss') || [];
    const tradesAnalyzed = trades?.length || 0;
    const winRate = tradesAnalyzed > 0 ? (wins.length / tradesAnalyzed) * 100 : 0;
    const avgPnlPips = tradesAnalyzed > 0 
      ? (trades?.reduce((sum, t) => sum + (t.pnl_pips || 0), 0) || 0) / tradesAnalyzed 
      : 0;
    const totalPnlPips = trades?.reduce((sum, t) => sum + (t.pnl_pips || 0), 0) || 0;

    // Calculate max drawdown
    let maxDrawdown = 0;
    let peak = 0;
    let cumPnl = 0;
    for (const trade of trades?.sort((a, b) => 
      new Date(a.closed_at).getTime() - new Date(b.closed_at).getTime()
    ) || []) {
      cumPnl += trade.pnl_percent || 0;
      peak = Math.max(peak, cumPnl);
      const drawdown = peak - cumPnl;
      maxDrawdown = Math.max(maxDrawdown, drawdown);
    }

    // Count rejection reasons
    const rejectionReasons: Record<string, number> = {};
    for (const rej of rejections || []) {
      const reason = (rej.details as any)?.reason || 'unknown';
      rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1;
    }

    // Regime distribution
    const regimeDistribution: Record<string, number> = {};
    for (const trade of trades || []) {
      const regime = trade.entry_regime || 'unknown';
      regimeDistribution[regime] = (regimeDistribution[regime] || 0) + 1;
    }

    // Symbol performance
    const symbolPerformance: Record<string, { wins: number; losses: number; pnlPips: number }> = {};
    for (const trade of trades || []) {
      if (!symbolPerformance[trade.symbol]) {
        symbolPerformance[trade.symbol] = { wins: 0, losses: 0, pnlPips: 0 };
      }
      if (trade.outcome === 'win') symbolPerformance[trade.symbol].wins++;
      if (trade.outcome === 'loss') symbolPerformance[trade.symbol].losses++;
      symbolPerformance[trade.symbol].pnlPips += trade.pnl_pips || 0;
    }

    // Average hold time
    const avgHoldTimeMinutes = tradesAnalyzed > 0
      ? (trades?.reduce((sum, t) => sum + (t.hold_duration_minutes || 0), 0) || 0) / tradesAnalyzed
      : 0;

    return {
      tradesAnalyzed,
      winRate,
      avgPnlPips,
      totalPnlPips,
      maxDrawdownPct: maxDrawdown,
      avgHoldTimeMinutes,
      rejectionReasons,
      regimeDistribution,
      symbolPerformance
    };
  }

  private async getCurrentThresholds(): Promise<Record<string, { value: number; min: number; max: number; isOptimizable: boolean }>> {
    const { data, error } = await this.supabase
      .from('system_settings')
      .select('key, value, min_value, max_value, is_ai_optimizable');

    if (error) throw error;

    const thresholds: Record<string, { value: number; min: number; max: number; isOptimizable: boolean }> = {};
    for (const row of data || []) {
      thresholds[row.key] = {
        value: row.value,
        min: row.min_value,
        max: row.max_value,
        isOptimizable: row.is_ai_optimizable || false
      };
    }

    return thresholds;
  }

  private async getAISuggestions(
    performance: PerformanceData,
    currentThresholds: Record<string, { value: number; min: number; max: number; isOptimizable: boolean }>
  ): Promise<{ suggestedChanges: SuggestedChange[]; reasoning: string }> {
    
    const prompt = `You are an AI trading system optimizer. Analyze the following performance data and current thresholds, then suggest improvements.

## PERFORMANCE DATA (Last 7 Days)
- Trades Analyzed: ${performance.tradesAnalyzed}
- Win Rate: ${performance.winRate.toFixed(1)}%
- Avg PnL per Trade: ${performance.avgPnlPips.toFixed(1)} pips
- Total PnL: ${performance.totalPnlPips.toFixed(1)} pips
- Max Drawdown: ${performance.maxDrawdownPct.toFixed(1)}%
- Avg Hold Time: ${performance.avgHoldTimeMinutes.toFixed(0)} minutes

## REJECTION REASONS (Why signals were filtered out)
${Object.entries(performance.rejectionReasons).map(([reason, count]) => `- ${reason}: ${count} times`).join('\n') || 'None recorded'}

## REGIME DISTRIBUTION
${Object.entries(performance.regimeDistribution).map(([regime, count]) => `- ${regime}: ${count} trades`).join('\n') || 'None recorded'}

## CURRENT THRESHOLDS (AI-Optimizable Only)
${Object.entries(currentThresholds)
  .filter(([_, v]) => v.isOptimizable)
  .map(([key, v]) => `- ${key}: ${v.value} (range: ${v.min}-${v.max})`)
  .join('\n')}

## SOFT PARAMETER BOUNDS (MUST stay within these)
${Object.entries(SOFT_PARAMETERS).map(([key, v]) => `- ${key}: min=${v.min}, max=${v.max}`).join('\n')}

## YOUR TASK
1. Analyze if current thresholds are too strict (rejecting good signals) or too loose (taking bad trades)
2. Suggest adjustments ONLY for AI-optimizable parameters
3. Stay STRICTLY within the soft parameter bounds
4. Explain your reasoning for each change

## RESPONSE FORMAT (JSON only, no markdown)
{
  "suggestedChanges": [
    {
      "key": "parameter_name",
      "currentValue": 70,
      "suggestedValue": 65,
      "reason": "Brief explanation"
    }
  ],
  "reasoning": "Overall analysis of performance and rationale for changes"
}

If no changes are needed, return empty suggestedChanges array with explanation in reasoning.`;

    try {
      const response = await this.deepSeek.chat(
        [{ role: 'user', content: prompt }],
        { model: 'deepseek-reasoner', temperature: 0.2, maxTokens: 1500 }
      );

      logger.info('DeepSeek optimization response received');
      logger.debug('Reasoning:', response.reasoningContent?.slice(0, 500));

      // Parse JSON response
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Failed to parse AI response as JSON');
      }

      const parsed = JSON.parse(jsonMatch[0]);
      
      return {
        suggestedChanges: parsed.suggestedChanges || [],
        reasoning: `${parsed.reasoning || 'No reasoning provided'}\n\n[DeepSeek Analysis: ${response.reasoningContent?.slice(0, 500) || 'N/A'}]`
      };

    } catch (error) {
      logger.error('Failed to get AI suggestions:', error);
      throw error;
    }
  }

  private validateSuggestions(suggestions: SuggestedChange[]): SuggestedChange[] {
    const validated: SuggestedChange[] = [];

    for (const suggestion of suggestions) {
      const bounds = SOFT_PARAMETERS[suggestion.key as keyof typeof SOFT_PARAMETERS];
      
      if (!bounds) {
        logger.warn(`Rejected suggestion for ${suggestion.key}: Not an AI-optimizable parameter`);
        continue;
      }

      // Check if hard guardrail
      if (HARD_GUARDRAILS[suggestion.key as keyof typeof HARD_GUARDRAILS]) {
        logger.warn(`Rejected suggestion for ${suggestion.key}: This is a hard guardrail`);
        continue;
      }

      // Validate within bounds
      if (suggestion.suggestedValue < bounds.min || suggestion.suggestedValue > bounds.max) {
        logger.warn(`Rejected suggestion for ${suggestion.key}: Value ${suggestion.suggestedValue} outside bounds [${bounds.min}, ${bounds.max}]`);
        continue;
      }

      // Only apply if there's a meaningful change (>1% difference)
      const changePct = Math.abs(suggestion.suggestedValue - suggestion.currentValue) / suggestion.currentValue * 100;
      if (changePct < 1) {
        logger.debug(`Skipping ${suggestion.key}: Change too small (${changePct.toFixed(1)}%)`);
        continue;
      }

      validated.push(suggestion);
    }

    return validated;
  }

  private async applyChanges(changes: SuggestedChange[]): Promise<void> {
    for (const change of changes) {
      // Update the setting
      const { error: updateError } = await this.supabase
        .from('system_settings')
        .update({
          value: change.suggestedValue,
          adjustment_reason: `AI Optimization: ${change.reason}`,
          last_adjusted_at: new Date().toISOString()
        })
        .eq('key', change.key);

      if (updateError) {
        logger.error(`Failed to update ${change.key}:`, updateError);
        continue;
      }

      // Log the change
      await this.supabase.from('system_settings_log').insert({
        setting_key: change.key,
        old_value: change.currentValue,
        new_value: change.suggestedValue,
        reason: `AI Optimization: ${change.reason}`
      });

      logger.info(`✅ Updated ${change.key}: ${change.currentValue} → ${change.suggestedValue}`);
    }
  }

  private async logOptimizationRun(
    runId: string,
    performance: PerformanceData,
    suggested: SuggestedChange[],
    applied: SuggestedChange[],
    reasoning: string,
    status: string
  ): Promise<void> {
    const currentThresholds = await this.getCurrentThresholds();

    await this.supabase.from('ai_optimization_runs').insert({
      id: runId,
      performance_data: performance,
      current_thresholds: currentThresholds,
      suggested_changes: suggested,
      applied_changes: applied,
      reasoning,
      trades_analyzed: performance.tradesAnalyzed,
      win_rate: performance.winRate,
      avg_pnl_pips: performance.avgPnlPips,
      max_drawdown_pct: performance.maxDrawdownPct,
      status
    });
  }
}
