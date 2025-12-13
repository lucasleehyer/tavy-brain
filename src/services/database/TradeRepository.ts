import { SupabaseManager } from './SupabaseClient';
import { logger } from '../../utils/logger';
import { Trade } from '../../types/trade';

export class TradeRepository {
  private supabase = SupabaseManager.getInstance().getClient();

  async saveTrade(trade: Trade): Promise<string | null> {
    try {
      const { data, error } = await this.supabase
        .from('trades')
        .insert({
          user_id: trade.userId,
          symbol: trade.symbol,
          direction: trade.direction,
          entry_price: trade.entryPrice,
          quantity: trade.quantity,
          stop_loss: trade.stopLoss,
          take_profit: trade.takeProfit,
          trading_account_id: trade.tradingAccountId,
          signal_id: trade.signalId,
          mt_position_id: trade.mtPositionId,
          execution_status: trade.executionStatus,
          execution_attempts: trade.executionAttempts,
          snapshot_settings: trade.snapshotSettings,
          status: 'open',
          opened_at: new Date().toISOString()
        })
        .select('id')
        .single();

      if (error) throw error;

      logger.info(`Trade saved: ${data.id}`);
      return data.id;

    } catch (error) {
      logger.error('Failed to save trade:', error);
      return null;
    }
  }

  async updateTradeExecution(
    tradeId: string,
    mtPositionId: string,
    entryPrice: number
  ): Promise<void> {
    const { error } = await this.supabase
      .from('trades')
      .update({
        mt_position_id: mtPositionId,
        entry_price: entryPrice,
        execution_status: 'executed',
        executed_at: new Date().toISOString()
      })
      .eq('id', tradeId);

    if (error) {
      logger.error('Failed to update trade execution:', error);
    }
  }

  async closeTrade(
    tradeId: string,
    exitPrice: number,
    pnl: number,
    pnlPercent: number
  ): Promise<void> {
    const { error } = await this.supabase
      .from('trades')
      .update({
        exit_price: exitPrice,
        pnl,
        pnl_percent: pnlPercent,
        status: 'closed',
        closed_at: new Date().toISOString()
      })
      .eq('id', tradeId);

    if (error) {
      logger.error('Failed to close trade:', error);
    } else {
      logger.info(`Trade ${tradeId} closed @ ${exitPrice} (P&L: ${pnl.toFixed(2)})`);
    }
  }

  async getOpenTrades(): Promise<any[]> {
    const { data, error } = await this.supabase
      .from('trades')
      .select('*')
      .eq('status', 'open')
      .order('opened_at', { ascending: false });

    if (error) {
      logger.error('Failed to get open trades:', error);
      return [];
    }

    return data || [];
  }

  async getTradeBySignalId(signalId: string): Promise<any | null> {
    const { data, error } = await this.supabase
      .from('trades')
      .select('*')
      .eq('signal_id', signalId)
      .single();

    if (error) {
      return null;
    }

    return data;
  }

  async getTradeByMtPositionId(mtPositionId: string): Promise<any | null> {
    const { data, error } = await this.supabase
      .from('trades')
      .select('*')
      .eq('mt_position_id', mtPositionId)
      .single();

    if (error) {
      return null;
    }

    return data;
  }
}
