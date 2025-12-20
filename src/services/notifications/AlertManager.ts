import { logger } from '../../utils/logger';
import { config } from '../../config';

type AlertLevel = 'info' | 'warning' | 'critical';

export class AlertManager {
  private supabaseUrl: string;
  private supabaseAnonKey: string;

  constructor() {
    this.supabaseUrl = config.supabase.url;
    this.supabaseAnonKey = config.supabase.anonKey;
  }

  /**
   * Send alert to Supabase edge function for email delivery
   * All emails now go through Supabase for centralized configuration
   */
  private async sendToSupabase(payload: Record<string, any>): Promise<boolean> {
    try {
      const response = await fetch(
        `${this.supabaseUrl}/functions/v1/send-alert-notification`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.supabaseAnonKey}`,
          },
          body: JSON.stringify(payload),
        }
      );

      if (!response.ok) {
        const error = await response.text();
        logger.error('Supabase alert function error:', error);
        return false;
      }

      const result = await response.json();
      logger.info(`Alert sent via Supabase: ${result.emailsSent} emails delivered`);
      return true;
    } catch (error) {
      logger.error('Failed to send alert to Supabase:', error);
      return false;
    }
  }

  async sendAlert(
    level: AlertLevel,
    title: string,
    message: string
  ): Promise<void> {
    const logLevel = level === 'critical' ? 'error' : level;
    logger.log(logLevel, `[ALERT] ${title}: ${message}`);

    if (level === 'critical' || level === 'warning') {
      await this.sendToSupabase({
        type: 'generic_alert',
        level,
        title,
        message,
      });
    }
  }

  async alertDisconnection(): Promise<void> {
    logger.error('[ALERT] MetaAPI Disconnected');
    await this.sendToSupabase({
      type: 'metaapi_disconnection',
    });
  }

  async alertReconnected(): Promise<void> {
    logger.info('[ALERT] MetaAPI Reconnected');
    await this.sendToSupabase({
      type: 'metaapi_reconnected',
    });
  }

  async alertTradeFailure(symbol: string, error: string): Promise<void> {
    logger.error(`[ALERT] Trade execution failed for ${symbol}: ${error}`);
    await this.sendToSupabase({
      type: 'trade_failure',
      symbol,
      error,
    });
  }

  async alertEquityLimit(limitType: string, currentPct: number): Promise<void> {
    logger.error(`[ALERT] Equity protection triggered: ${limitType} at ${currentPct.toFixed(2)}%`);
    await this.sendToSupabase({
      type: 'equity_limit',
      limitType,
      currentPct,
    });
  }

  async alertSignalFired(symbol: string, action: string, confidence: number): Promise<void> {
    logger.info(`[ALERT] Signal fired: ${action} ${symbol} at ${confidence}% confidence`);
    await this.sendToSupabase({
      type: 'signal_fired',
      symbol,
      action,
      confidence,
    });
  }

  async alertTradeClosed(
    symbol: string,
    pnl: number,
    outcome: 'win' | 'loss'
  ): Promise<void> {
    const emoji = outcome === 'win' ? '✅' : '❌';
    logger.info(`[ALERT] Trade closed ${emoji}: ${symbol} with ${outcome.toUpperCase()}, P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`);
    await this.sendToSupabase({
      type: 'trade_closed',
      symbol,
      pnl,
      outcome,
    });
  }
}
