import { SupabaseManager } from './SupabaseClient';
import { logger } from '../../utils/logger';
import { Signal, SignalOutcome } from '../../types/signal';

export class SignalRepository {
  private supabase = SupabaseManager.getInstance().getClient();

  async saveSignal(signal: Signal): Promise<string | null> {
    try {
      const { data, error } = await this.supabase
        .from('signal_history')
        .insert({
          user_id: signal.userId,
          symbol: signal.symbol,
          asset_type: signal.assetType,
          action: signal.action,
          confidence: signal.confidence,
          entry_price: signal.entryPrice,
          stop_loss: signal.stopLoss,
          take_profit: signal.takeProfit1,
          source: signal.source,
          market_regime: signal.marketRegime,
          sentiment_score: signal.sentimentScore,
          agent_outputs: signal.agentOutputs,
          snapshot_settings: signal.snapshotSettings,
          actual_outcome: 'pending'
        })
        .select('id')
        .single();

      if (error) throw error;

      logger.info(`Signal saved: ${data.id} - ${signal.symbol} ${signal.action}`);
      return data.id;

    } catch (error) {
      logger.error('Failed to save signal:', error);
      return null;
    }
  }

  async getPendingSignals(): Promise<any[]> {
    const { data, error } = await this.supabase
      .from('signal_history')
      .select('*')
      .eq('actual_outcome', 'pending')
      .order('created_at', { ascending: false });

    if (error) {
      logger.error('Failed to get pending signals:', error);
      return [];
    }

    return data || [];
  }

  async resolveSignal(
    signalId: string,
    outcome: 'win' | 'loss',
    pnlPercent: number,
    exitPrice?: number
  ): Promise<void> {
    const { error } = await this.supabase
      .from('signal_history')
      .update({
        actual_outcome: outcome,
        actual_pnl_percent: pnlPercent,
        resolved_at: new Date().toISOString()
      })
      .eq('id', signalId);

    if (error) {
      logger.error('Failed to resolve signal:', error);
    } else {
      logger.info(`Signal ${signalId} resolved: ${outcome} (${pnlPercent.toFixed(2)}%)`);
    }
  }

  async checkDuplicateSignal(symbol: string): Promise<boolean> {
    const { data, error } = await this.supabase
      .from('signal_history')
      .select('id')
      .eq('symbol', symbol)
      .eq('actual_outcome', 'pending')
      .limit(1);

    if (error) {
      logger.error('Failed to check duplicate signal:', error);
      return false;
    }

    return (data?.length || 0) > 0;
  }

  async logDecision(decision: {
    userId: string;
    symbol: string;
    assetType: string;
    decision: string;
    decisionType: string;
    confidence: number;
    narrative: string;
    engineConsensus?: any;
    rejectionReason?: string;
  }): Promise<void> {
    try {
      await this.supabase.from('ai_decision_log').insert({
        user_id: decision.userId,
        symbol: decision.symbol,
        asset_type: decision.assetType,
        decision: decision.decision,
        decision_type: decision.decisionType,
        confidence: decision.confidence,
        narrative: decision.narrative,
        engine_consensus: decision.engineConsensus,
        rejection_reason: decision.rejectionReason
      });
    } catch (error) {
      logger.error('Failed to log decision:', error);
    }
  }
}
