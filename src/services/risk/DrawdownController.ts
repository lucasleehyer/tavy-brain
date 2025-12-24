/**
 * Drawdown Controller
 * 
 * Manages trading based on equity curve and consecutive losses.
 * Key insight: Reduce size during drawdowns, stop during danger.
 */

import { DrawdownResult, DrawdownState } from '../../types/quant';
import { supabase } from '../database/SupabaseClient';
import { logger } from '../../utils/logger';

interface DrawdownConfig {
  cautionThreshold: number;    // Start reducing size
  dangerThreshold: number;     // Significant reduction
  stoppedThreshold: number;    // Stop trading
  consecutiveLossLimit: number; // Max consecutive losses
  cooldownMinutes: number;     // Cooldown after hitting stopped
}

const DEFAULT_CONFIG: DrawdownConfig = {
  cautionThreshold: 5,         // 5% drawdown = caution
  dangerThreshold: 10,         // 10% drawdown = danger
  stoppedThreshold: 15,        // 15% drawdown = stop trading
  consecutiveLossLimit: 5,     // 5 consecutive losses = stop
  cooldownMinutes: 60          // 1 hour cooldown after stopped
};

export class DrawdownController {
  private config: DrawdownConfig;
  private lastStoppedTime: Date | null = null;

  constructor(config?: Partial<DrawdownConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Get current drawdown state
   */
  async getState(tradingAccountId?: string): Promise<DrawdownResult> {
    try {
      // Get recent trade history
      const lookbackDate = new Date();
      lookbackDate.setDate(lookbackDate.getDate() - 7); // Last 7 days

      let query = supabase
        .from('trade_analytics')
        .select('pnl_percent, outcome, closed_at')
        .gte('closed_at', lookbackDate.toISOString())
        .order('closed_at', { ascending: true });

      if (tradingAccountId) {
        query = query.eq('trading_account_id', tradingAccountId);
      }

      const { data, error } = await query;

      if (error || !data || data.length === 0) {
        return this.getNormalState();
      }

      // Calculate drawdown and consecutive losses
      const { currentDrawdown, maxDrawdown, consecutiveLosses } = this.calculateMetrics(data);

      // Determine state
      let state: DrawdownState;
      let sizeMultiplier: number;
      let canTrade = true;
      let cooldownMinutes = 0;

      if (currentDrawdown >= this.config.stoppedThreshold || consecutiveLosses >= this.config.consecutiveLossLimit) {
        state = 'STOPPED';
        sizeMultiplier = 0;
        canTrade = false;
        cooldownMinutes = this.config.cooldownMinutes;
        
        // Check if we're in cooldown
        if (this.lastStoppedTime) {
          const elapsed = (Date.now() - this.lastStoppedTime.getTime()) / 60000;
          if (elapsed < this.config.cooldownMinutes) {
            cooldownMinutes = Math.ceil(this.config.cooldownMinutes - elapsed);
          } else {
            // Cooldown expired, allow trading with reduced size
            state = 'DANGER';
            sizeMultiplier = 0.25;
            canTrade = true;
            cooldownMinutes = 0;
            this.lastStoppedTime = null;
          }
        } else {
          this.lastStoppedTime = new Date();
        }
      } else if (currentDrawdown >= this.config.dangerThreshold || consecutiveLosses >= 4) {
        state = 'DANGER';
        sizeMultiplier = 0.25;
      } else if (currentDrawdown >= this.config.cautionThreshold || consecutiveLosses >= 2) {
        state = 'CAUTION';
        sizeMultiplier = 0.5;
      } else {
        state = 'NORMAL';
        sizeMultiplier = 1.0;
        this.lastStoppedTime = null;
      }

      const reason = this.buildReason(state, currentDrawdown, consecutiveLosses, cooldownMinutes);

      const result: DrawdownResult = {
        state,
        currentDrawdown,
        maxDrawdown,
        consecutiveLosses,
        sizeMultiplier,
        canTrade,
        cooldownMinutes,
        reason
      };

      logger.info(`[DRAWDOWN] ${state} | DD=${currentDrawdown.toFixed(1)}% | Losses=${consecutiveLosses} | Size=${(sizeMultiplier * 100).toFixed(0)}%`);

      return result;

    } catch (error) {
      logger.error('Drawdown controller error:', error);
      return this.getNormalState();
    }
  }

  /**
   * Calculate drawdown metrics from trade history
   */
  private calculateMetrics(trades: any[]): { currentDrawdown: number; maxDrawdown: number; consecutiveLosses: number } {
    // Calculate cumulative P&L and track drawdown
    let cumPnl = 0;
    let peak = 0;
    let maxDrawdown = 0;
    let currentDrawdown = 0;

    for (const trade of trades) {
      cumPnl += trade.pnl_percent || 0;
      peak = Math.max(peak, cumPnl);
      const dd = peak - cumPnl;
      maxDrawdown = Math.max(maxDrawdown, dd);
      currentDrawdown = dd;
    }

    // Count consecutive losses from the end
    let consecutiveLosses = 0;
    for (let i = trades.length - 1; i >= 0; i--) {
      if (trades[i].outcome === 'loss') {
        consecutiveLosses++;
      } else {
        break;
      }
    }

    return { currentDrawdown, maxDrawdown, consecutiveLosses };
  }

  /**
   * Build reason string
   */
  private buildReason(state: DrawdownState, drawdown: number, losses: number, cooldown: number): string {
    switch (state) {
      case 'STOPPED':
        if (cooldown > 0) {
          return `Trading stopped - ${cooldown} minutes cooldown remaining`;
        }
        return `Trading stopped - DD=${drawdown.toFixed(1)}%, ${losses} consecutive losses`;
      case 'DANGER':
        return `Danger zone - 25% position size (DD=${drawdown.toFixed(1)}%, ${losses} losses)`;
      case 'CAUTION':
        return `Caution - 50% position size (DD=${drawdown.toFixed(1)}%, ${losses} losses)`;
      default:
        return 'Normal trading conditions';
    }
  }

  /**
   * Get normal state
   */
  private getNormalState(): DrawdownResult {
    return {
      state: 'NORMAL',
      currentDrawdown: 0,
      maxDrawdown: 0,
      consecutiveLosses: 0,
      sizeMultiplier: 1.0,
      canTrade: true,
      cooldownMinutes: 0,
      reason: 'Normal trading conditions'
    };
  }

  /**
   * Check if can trade
   */
  async canTrade(tradingAccountId?: string): Promise<boolean> {
    const state = await this.getState(tradingAccountId);
    return state.canTrade;
  }

  /**
   * Get size multiplier
   */
  async getSizeMultiplier(tradingAccountId?: string): Promise<number> {
    const state = await this.getState(tradingAccountId);
    return state.sizeMultiplier;
  }

  /**
   * Update config
   */
  updateConfig(config: Partial<DrawdownConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Reset stopped state (manual override)
   */
  resetStoppedState(): void {
    this.lastStoppedTime = null;
    logger.info('[DRAWDOWN] Stopped state manually reset');
  }
}
