import { supabase } from '../database/SupabaseClient';
import { logger } from '../../utils/logger';

interface CircuitBreakerConfig {
  maxConsecutiveLosses: number;
  maxDailyDrawdownPercent: number;
  maxWeeklyDrawdownPercent: number;
  maxLatencyMs: number;
  cooldownMinutes: number;
}

interface AccountRiskState {
  consecutiveLosses: number;
  dailyStartBalance: number;
  dailyPnl: number;
  weeklyStartBalance: number;
  weeklyPnl: number;
  lastTradeTime: Date | null;
  tripReason: string | null;
  trippedAt: Date | null;
}

interface CircuitBreakerStatus {
  canTrade: boolean;
  reason: string | null;
  accountStates: Map<string, AccountRiskState>;
  systemLatency: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  maxConsecutiveLosses: 3,
  maxDailyDrawdownPercent: 3,
  maxWeeklyDrawdownPercent: 6,
  maxLatencyMs: 100,
  cooldownMinutes: 60
};

export class CircuitBreaker {
  private config: CircuitBreakerConfig;
  private accountStates: Map<string, AccountRiskState> = new Map();
  private lastLatencyCheck: number = 0;
  private systemLatency: number = 0;
  private globalTripped: boolean = false;
  private globalTripReason: string | null = null;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    // Uses imported supabase singleton
  }

  async initialize(): Promise<void> {
    logger.info('Initializing Circuit Breaker...');
    await this.loadAccountStates();
    await this.syncWithDatabase();
  }

  private async loadAccountStates(): Promise<void> {
    try {
      const { data: accounts, error } = await supabase
        .from('trading_accounts')
        .select('id, consecutive_losses, is_frozen, freeze_reason, frozen_at')
        .eq('is_active', true);

      if (error) throw error;

      for (const account of accounts || []) {
        const state: AccountRiskState = {
          consecutiveLosses: account.consecutive_losses || 0,
          dailyStartBalance: 0,
          dailyPnl: 0,
          weeklyStartBalance: 0,
          weeklyPnl: 0,
          lastTradeTime: null,
          tripReason: account.is_frozen ? account.freeze_reason : null,
          trippedAt: account.is_frozen ? new Date(account.frozen_at) : null
        };
        this.accountStates.set(account.id, state);
      }

      logger.info(`Loaded circuit breaker state for ${accounts?.length || 0} accounts`);
    } catch (error) {
      logger.error('Failed to load account states:', error);
    }
  }

  private async syncWithDatabase(): Promise<void> {
    try {
      const today = new Date().toISOString().split('T')[0];
      
      const { data: dailyPnl, error } = await supabase
        .from('daily_account_pnl')
        .select('trading_account_id, starting_balance, realized_pnl')
        .eq('trade_date', today);

      if (error) throw error;

      for (const pnl of dailyPnl || []) {
        const state = this.accountStates.get(pnl.trading_account_id);
        if (state) {
          state.dailyStartBalance = pnl.starting_balance;
          state.dailyPnl = pnl.realized_pnl;
        }
      }
    } catch (error) {
      logger.error('Failed to sync with database:', error);
    }
  }

  async canTrade(accountId?: string): Promise<CircuitBreakerStatus> {
    // Check system-level breakers first
    if (this.globalTripped) {
      return {
        canTrade: false,
        reason: this.globalTripReason,
        accountStates: this.accountStates,
        systemLatency: this.systemLatency
      };
    }

    // Check latency
    if (this.systemLatency > this.config.maxLatencyMs) {
      return {
        canTrade: false,
        reason: `System latency too high: ${this.systemLatency}ms > ${this.config.maxLatencyMs}ms`,
        accountStates: this.accountStates,
        systemLatency: this.systemLatency
      };
    }

    // If checking specific account
    if (accountId) {
      const state = this.accountStates.get(accountId);
      if (!state) {
        return {
          canTrade: true,
          reason: null,
          accountStates: this.accountStates,
          systemLatency: this.systemLatency
        };
      }

      // Check if in cooldown
      if (state.trippedAt) {
        const cooldownEnd = new Date(state.trippedAt.getTime() + this.config.cooldownMinutes * 60 * 1000);
        if (new Date() < cooldownEnd) {
          return {
            canTrade: false,
            reason: `Account in cooldown until ${cooldownEnd.toISOString()}: ${state.tripReason}`,
            accountStates: this.accountStates,
            systemLatency: this.systemLatency
          };
        } else {
          // Cooldown expired, reset
          await this.resetAccountBreaker(accountId);
        }
      }

      // Check consecutive losses
      if (state.consecutiveLosses >= this.config.maxConsecutiveLosses) {
        return {
          canTrade: false,
          reason: `Max consecutive losses reached: ${state.consecutiveLosses}`,
          accountStates: this.accountStates,
          systemLatency: this.systemLatency
        };
      }

      // Check daily drawdown
      if (state.dailyStartBalance > 0) {
        const dailyDrawdown = (Math.abs(state.dailyPnl) / state.dailyStartBalance) * 100;
        if (state.dailyPnl < 0 && dailyDrawdown >= this.config.maxDailyDrawdownPercent) {
          return {
            canTrade: false,
            reason: `Daily drawdown limit hit: ${dailyDrawdown.toFixed(2)}%`,
            accountStates: this.accountStates,
            systemLatency: this.systemLatency
          };
        }
      }

      // Check weekly drawdown
      if (state.weeklyStartBalance > 0) {
        const weeklyDrawdown = (Math.abs(state.weeklyPnl) / state.weeklyStartBalance) * 100;
        if (state.weeklyPnl < 0 && weeklyDrawdown >= this.config.maxWeeklyDrawdownPercent) {
          return {
            canTrade: false,
            reason: `Weekly drawdown limit hit: ${weeklyDrawdown.toFixed(2)}%`,
            accountStates: this.accountStates,
            systemLatency: this.systemLatency
          };
        }
      }
    }

    return {
      canTrade: true,
      reason: null,
      accountStates: this.accountStates,
      systemLatency: this.systemLatency
    };
  }

  async recordTradeResult(accountId: string, isWin: boolean, pnl: number): Promise<void> {
    let state = this.accountStates.get(accountId);
    
    if (!state) {
      state = {
        consecutiveLosses: 0,
        dailyStartBalance: 0,
        dailyPnl: 0,
        weeklyStartBalance: 0,
        weeklyPnl: 0,
        lastTradeTime: null,
        tripReason: null,
        trippedAt: null
      };
      this.accountStates.set(accountId, state);
    }

    // Update consecutive losses
    if (isWin) {
      state.consecutiveLosses = 0;
    } else {
      state.consecutiveLosses++;
    }

    // Update PnL tracking
    state.dailyPnl += pnl;
    state.weeklyPnl += pnl;
    state.lastTradeTime = new Date();

    // Check if we need to trip the breaker
    if (state.consecutiveLosses >= this.config.maxConsecutiveLosses) {
      await this.tripAccountBreaker(accountId, `${this.config.maxConsecutiveLosses} consecutive losses`);
    }

    // Update database
    await this.updateAccountInDatabase(accountId, state);
  }

  async tripAccountBreaker(accountId: string, reason: string): Promise<void> {
    const state = this.accountStates.get(accountId);
    if (state) {
      state.tripReason = reason;
      state.trippedAt = new Date();
    }

    logger.warn(`Circuit breaker TRIPPED for account ${accountId}: ${reason}`);

    try {
      await supabase
        .from('trading_accounts')
        .update({
          is_frozen: true,
          freeze_reason: reason,
          frozen_at: new Date().toISOString()
        })
        .eq('id', accountId);

      // Log to VPS activity
      await supabase
        .from('vps_activity_logs')
        .insert({
          activity_type: 'circuit_breaker_trip',
          human_message: `Circuit breaker tripped for account: ${reason}`,
          level: 'error',
          details: { accountId, reason }
        });
    } catch (error) {
      logger.error('Failed to update database for circuit breaker trip:', error);
    }
  }

  async resetAccountBreaker(accountId: string): Promise<void> {
    const state = this.accountStates.get(accountId);
    if (state) {
      state.consecutiveLosses = 0;
      state.tripReason = null;
      state.trippedAt = null;
    }

    logger.info(`Circuit breaker RESET for account ${accountId}`);

    try {
      await supabase
        .from('trading_accounts')
        .update({
          is_frozen: false,
          freeze_reason: null,
          frozen_at: null,
          consecutive_losses: 0
        })
        .eq('id', accountId);
    } catch (error) {
      logger.error('Failed to reset circuit breaker in database:', error);
    }
  }

  private async updateAccountInDatabase(accountId: string, state: AccountRiskState): Promise<void> {
    try {
      await supabase
        .from('trading_accounts')
        .update({
          consecutive_losses: state.consecutiveLosses
        })
        .eq('id', accountId);
    } catch (error) {
      logger.error('Failed to update account state:', error);
    }
  }

  updateLatency(latencyMs: number): void {
    this.systemLatency = latencyMs;
    this.lastLatencyCheck = Date.now();

    if (latencyMs > this.config.maxLatencyMs) {
      logger.warn(`High system latency detected: ${latencyMs}ms`);
    }
  }

  tripGlobal(reason: string): void {
    this.globalTripped = true;
    this.globalTripReason = reason;
    logger.error(`GLOBAL circuit breaker TRIPPED: ${reason}`);
  }

  resetGlobal(): void {
    this.globalTripped = false;
    this.globalTripReason = null;
    logger.info('Global circuit breaker RESET');
  }

  getAccountState(accountId: string): AccountRiskState | undefined {
    return this.accountStates.get(accountId);
  }

  getConfig(): CircuitBreakerConfig {
    return { ...this.config };
  }

  updateConfig(newConfig: Partial<CircuitBreakerConfig>): void {
    this.config = { ...this.config, ...newConfig };
    logger.info('Circuit breaker config updated:', this.config);
  }
}
