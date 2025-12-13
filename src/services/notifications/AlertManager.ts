import { EmailService } from './EmailService';
import { logger } from '../../utils/logger';

type AlertLevel = 'info' | 'warning' | 'critical';

export class AlertManager {
  private emailService: EmailService;

  constructor() {
    this.emailService = new EmailService();
  }

  async sendAlert(
    level: AlertLevel,
    title: string,
    message: string
  ): Promise<void> {
    const logLevel = level === 'critical' ? 'error' : level;
    logger.log(logLevel, `[ALERT] ${title}: ${message}`);

    if (level === 'critical' || level === 'warning') {
      try {
        await this.emailService.send({
          subject: `[TAVY ${level.toUpperCase()}] ${title}`,
          html: `
            <div style="font-family: Arial, sans-serif; padding: 20px;">
              <h2 style="color: ${level === 'critical' ? '#dc2626' : '#f59e0b'};">${title}</h2>
              <p style="color: #374151; font-size: 16px;">${message}</p>
              <hr style="border: 1px solid #e5e7eb; margin: 20px 0;" />
              <p style="color: #6b7280; font-size: 12px;">
                Time: ${new Date().toISOString()}<br/>
                Environment: ${process.env.NODE_ENV || 'development'}
              </p>
            </div>
          `
        });
      } catch (error) {
        logger.error('Failed to send alert email:', error);
      }
    }
  }

  async alertDisconnection(): Promise<void> {
    await this.sendAlert(
      'critical',
      'MetaAPI Disconnected',
      'WebSocket connection to MetaAPI has been lost. Attempting to reconnect automatically. Check the VPS status if this persists.'
    );
  }

  async alertReconnected(): Promise<void> {
    await this.sendAlert(
      'info',
      'MetaAPI Reconnected',
      'WebSocket connection to MetaAPI has been restored. Trading operations resuming.'
    );
  }

  async alertTradeFailure(symbol: string, error: string): Promise<void> {
    await this.sendAlert(
      'critical',
      'Trade Execution Failed',
      `Failed to execute trade for ${symbol}: ${error}`
    );
  }

  async alertEquityLimit(limitType: string, currentPct: number): Promise<void> {
    await this.sendAlert(
      'critical',
      'Equity Protection Triggered',
      `${limitType} limit reached. Current: ${currentPct.toFixed(2)}%. Trading has been paused for safety.`
    );
  }

  async alertSignalFired(symbol: string, action: string, confidence: number): Promise<void> {
    await this.sendAlert(
      'info',
      'Signal Fired',
      `${action} signal for ${symbol} at ${confidence}% confidence. Trade execution attempted.`
    );
  }

  async alertTradeClosed(
    symbol: string,
    pnl: number,
    outcome: 'win' | 'loss'
  ): Promise<void> {
    const emoji = outcome === 'win' ? '✅' : '❌';
    await this.sendAlert(
      'info',
      `Trade Closed ${emoji}`,
      `${symbol} closed with ${outcome.toUpperCase()}. P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`
    );
  }
}
