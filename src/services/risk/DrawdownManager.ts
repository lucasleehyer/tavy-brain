import { supabase } from '../database/SupabaseClient';
import { logger } from '../../utils/logger';

interface DrawdownState {
  peakBalance: number;
  currentBalance: number;
  drawdownPercent: number;
  dailyDrawdownPercent: number;
  weeklyDrawdownPercent: number;
  monthlyDrawdownPercent: number;
  isInDrawdown: boolean;
  protectionLevel: 'none' | 'light' | 'moderate' | 'heavy' | 'lockout';
}

interface DrawdownAdjustments {
  riskMultiplier: number;
  maxTradesPerDay: number;
  requireHighConfidence: boolean;
  minimumConfidence: number;
  reason: string;
}

interface DrawdownConfig {
  lightDrawdownPercent: number;    // 3% - start light protection
  moderateDrawdownPercent: number; // 5% - moderate protection
  heavyDrawdownPercent: number;    // 8% - heavy protection
  lockoutDrawdownPercent: number;  // 10% - stop trading
  dailyLossLimit: number;          // 5% daily loss limit
  profitLockPercent: number;       // Lock 50% of daily profits
}

const DEFAULT_CONFIG: DrawdownConfig = {
  lightDrawdownPercent: 3,
  moderateDrawdownPercent: 5,
  heavyDrawdownPercent: 8,
  lockoutDrawdownPercent: 10,
  dailyLossLimit: 5,
  profitLockPercent: 0.5
};

/**
 * Drawdown Manager - Protect capital during losing periods
 * Scale position size inversely with drawdown
 */
export class DrawdownManager {
  private config: DrawdownConfig;
  private state: DrawdownState;
  private dailyStartBalance: number = 0;
  private dailyPeakBalance: number = 0;

  constructor(config?: Partial<DrawdownConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = this.getDefaultState();
  }

  /**
   * Initialize from database with account balances
   */
  async initialize(): Promise<void> {
    try {
      await this.syncWithDatabase();
      logger.info('[DRAWDOWN] Initialized:', this.getStateDescription());
    } catch (error) {
      logger.error('Failed to initialize drawdown manager:', error);
    }
  }

  /**
   * Update with current balance
   */
  updateBalance(currentBalance: number): void {
    this.state.currentBalance = currentBalance;
    
    // Update peak if new high
    if (currentBalance > this.state.peakBalance) {
      this.state.peakBalance = currentBalance;
      this.state.isInDrawdown = false;
      this.state.drawdownPercent = 0;
    } else {
      // Calculate drawdown from peak
      this.state.drawdownPercent = ((this.state.peakBalance - currentBalance) / this.state.peakBalance) * 100;
      this.state.isInDrawdown = this.state.drawdownPercent > 0;
    }

    // Update daily peak
    if (currentBalance > this.dailyPeakBalance) {
      this.dailyPeakBalance = currentBalance;
    }

    // Calculate daily drawdown
    if (this.dailyStartBalance > 0) {
      this.state.dailyDrawdownPercent = ((this.dailyStartBalance - currentBalance) / this.dailyStartBalance) * 100;
    }

    // Determine protection level
    this.state.protectionLevel = this.calculateProtectionLevel();

    logger.debug(`[DRAWDOWN] Balance: $${currentBalance.toFixed(2)}, Peak: $${this.state.peakBalance.toFixed(2)}, DD: ${this.state.drawdownPercent.toFixed(2)}%, Protection: ${this.state.protectionLevel}`);
  }

  /**
   * Get trading adjustments based on drawdown
   */
  getAdjustments(): DrawdownAdjustments {
    const level = this.state.protectionLevel;

    switch (level) {
      case 'lockout':
        return {
          riskMultiplier: 0,
          maxTradesPerDay: 0,
          requireHighConfidence: true,
          minimumConfidence: 100, // Impossible
          reason: `🚫 LOCKOUT: ${this.state.drawdownPercent.toFixed(1)}% drawdown - trading suspended`
        };

      case 'heavy':
        return {
          riskMultiplier: 0.25, // 25% of normal risk
          maxTradesPerDay: 2,
          requireHighConfidence: true,
          minimumConfidence: 85,
          reason: `⚠️ Heavy protection: ${this.state.drawdownPercent.toFixed(1)}% drawdown - 25% position size`
        };

      case 'moderate':
        return {
          riskMultiplier: 0.5, // 50% of normal risk
          maxTradesPerDay: 3,
          requireHighConfidence: true,
          minimumConfidence: 75,
          reason: `⚠️ Moderate protection: ${this.state.drawdownPercent.toFixed(1)}% drawdown - 50% position size`
        };

      case 'light':
        return {
          riskMultiplier: 0.75, // 75% of normal risk
          maxTradesPerDay: 5,
          requireHighConfidence: false,
          minimumConfidence: 65,
          reason: `📉 Light protection: ${this.state.drawdownPercent.toFixed(1)}% drawdown - 75% position size`
        };

      default:
        return {
          riskMultiplier: 1.0,
          maxTradesPerDay: 10,
          requireHighConfidence: false,
          minimumConfidence: 55,
          reason: `✅ No drawdown protection active`
        };
    }
  }

  /**
   * Check if we should take a trade based on drawdown
   */
  canTrade(confidence: number): { canTrade: boolean; reason: string } {
    const adjustments = this.getAdjustments();

    // Lockout
    if (adjustments.riskMultiplier === 0) {
      return { canTrade: false, reason: adjustments.reason };
    }

    // Daily loss limit check
    if (this.state.dailyDrawdownPercent >= this.config.dailyLossLimit) {
      return { 
        canTrade: false, 
        reason: `Daily loss limit reached: ${this.state.dailyDrawdownPercent.toFixed(1)}% (max ${this.config.dailyLossLimit}%)`
      };
    }

    // Confidence check
    if (confidence < adjustments.minimumConfidence) {
      return { 
        canTrade: false, 
        reason: `Confidence ${confidence}% below required ${adjustments.minimumConfidence}% (${this.state.protectionLevel} protection)`
      };
    }

    return { canTrade: true, reason: adjustments.reason };
  }

  /**
   * Get adjusted risk percentage
   */
  getAdjustedRisk(baseRiskPercent: number): number {
    const adjustments = this.getAdjustments();
    const adjustedRisk = baseRiskPercent * adjustments.riskMultiplier;
    
    logger.info(`[DRAWDOWN] Risk adjustment: ${baseRiskPercent}% * ${adjustments.riskMultiplier} = ${adjustedRisk.toFixed(2)}%`);
    
    return adjustedRisk;
  }

  /**
   * Calculate profit lock amount
   * When we're up X% on the day, protect 50% of it
   */
  calculateProfitLock(): number {
    if (this.dailyStartBalance <= 0) return 0;
    
    const dailyPnl = this.state.currentBalance - this.dailyStartBalance;
    
    if (dailyPnl > 0) {
      const dailyPnlPercent = (dailyPnl / this.dailyStartBalance) * 100;
      
      // If up more than 2%, lock 50% of profits
      if (dailyPnlPercent > 2) {
        const lockedProfit = dailyPnl * this.config.profitLockPercent;
        const lockedBalance = this.dailyStartBalance + lockedProfit;
        
        logger.info(`[DRAWDOWN] Profit lock: Up ${dailyPnlPercent.toFixed(1)}%, locked $${lockedProfit.toFixed(2)}, floor at $${lockedBalance.toFixed(2)}`);
        
        return lockedBalance;
      }
    }
    
    return 0;
  }

  /**
   * Reset daily stats (call at start of trading day)
   */
  resetDaily(currentBalance: number): void {
    this.dailyStartBalance = currentBalance;
    this.dailyPeakBalance = currentBalance;
    this.state.dailyDrawdownPercent = 0;
    logger.info(`[DRAWDOWN] Daily reset: Starting balance $${currentBalance.toFixed(2)}`);
  }

  private calculateProtectionLevel(): 'none' | 'light' | 'moderate' | 'heavy' | 'lockout' {
    const dd = this.state.drawdownPercent;
    const dailyDd = this.state.dailyDrawdownPercent;

    // Check both overall and daily drawdown
    const effectiveDd = Math.max(dd, dailyDd);

    if (effectiveDd >= this.config.lockoutDrawdownPercent) return 'lockout';
    if (effectiveDd >= this.config.heavyDrawdownPercent) return 'heavy';
    if (effectiveDd >= this.config.moderateDrawdownPercent) return 'moderate';
    if (effectiveDd >= this.config.lightDrawdownPercent) return 'light';
    return 'none';
  }

  private async syncWithDatabase(): Promise<void> {
    try {
      // Get total balance across all active accounts
      const { data: accounts } = await supabase
        .from('trading_accounts')
        .select('id, metaapi_account_id')
        .eq('is_active', true);

      // Get peak balance from trades (highest ending balance)
      const { data: pnlData } = await supabase
        .from('daily_account_pnl')
        .select('ending_balance')
        .order('ending_balance', { ascending: false })
        .limit(1);

      if (pnlData && pnlData.length > 0 && pnlData[0].ending_balance) {
        this.state.peakBalance = pnlData[0].ending_balance;
      }

      // Get today's starting balance
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const { data: todayPnl } = await supabase
        .from('daily_account_pnl')
        .select('starting_balance')
        .gte('trade_date', today.toISOString().split('T')[0])
        .limit(1);

      if (todayPnl && todayPnl.length > 0) {
        this.dailyStartBalance = todayPnl[0].starting_balance;
        this.dailyPeakBalance = this.dailyStartBalance;
      }

    } catch (error) {
      logger.error('Failed to sync drawdown with database:', error);
    }
  }

  getState(): DrawdownState {
    return { ...this.state };
  }

  private getStateDescription(): string {
    return `DD: ${this.state.drawdownPercent.toFixed(2)}%, Daily: ${this.state.dailyDrawdownPercent.toFixed(2)}%, Protection: ${this.state.protectionLevel}`;
  }

  private getDefaultState(): DrawdownState {
    return {
      peakBalance: 0,
      currentBalance: 0,
      drawdownPercent: 0,
      dailyDrawdownPercent: 0,
      weeklyDrawdownPercent: 0,
      monthlyDrawdownPercent: 0,
      isInDrawdown: false,
      protectionLevel: 'none'
    };
  }

  updateConfig(config: Partial<DrawdownConfig>): void {
    this.config = { ...this.config, ...config };
  }
}
