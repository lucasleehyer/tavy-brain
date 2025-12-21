import { supabase } from '../database/SupabaseClient';
import { logger } from '../../utils/logger';

interface MomentumState {
  consecutiveWins: number;
  consecutiveLosses: number;
  lastTradeResult: 'win' | 'loss' | null;
  hotStreak: boolean;
  coldStreak: boolean;
  dailyPnlPercent: number;
  weeklyPnlPercent: number;
}

interface MomentumMultipliers {
  positionSizeMultiplier: number;
  confidenceBonus: number;
  reentryDelayMs: number;
  reason: string;
}

interface MomentumConfig {
  hotStreakThreshold: number;  // Consecutive wins to trigger hot streak
  coldStreakThreshold: number; // Consecutive losses to trigger cold streak
  maxPositionMultiplier: number;
  minPositionMultiplier: number;
  hotStreakMultiplier: number;
  coldStreakMultiplier: number;
  fastReentryDelayMs: number;
  normalReentryDelayMs: number;
  slowReentryDelayMs: number;
}

const DEFAULT_CONFIG: MomentumConfig = {
  hotStreakThreshold: 2,        // 2 wins = hot streak
  coldStreakThreshold: 2,       // 2 losses = cold streak
  maxPositionMultiplier: 2.0,   // Max 2x position on hot streak
  minPositionMultiplier: 0.5,   // Min 0.5x on cold streak
  hotStreakMultiplier: 1.5,     // 1.5x on hot streak
  coldStreakMultiplier: 0.75,   // 0.75x on cold streak
  fastReentryDelayMs: 30000,    // 30s re-entry on hot streak
  normalReentryDelayMs: 300000, // 5 min normal
  slowReentryDelayMs: 900000    // 15 min on cold streak
};

/**
 * Momentum Tracker - Ride winning streaks, protect during losing streaks
 * Inspired by DeepSeek's competition performance
 */
export class MomentumTracker {
  private config: MomentumConfig;
  private state: MomentumState;
  private lastUpdate: Date;

  constructor(config?: Partial<MomentumConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = this.getDefaultState();
    this.lastUpdate = new Date();
  }

  /**
   * Initialize from database
   */
  async initialize(): Promise<void> {
    try {
      await this.syncWithDatabase();
      logger.info('[MOMENTUM] Initialized:', this.getStateDescription());
    } catch (error) {
      logger.error('Failed to initialize momentum tracker:', error);
    }
  }

  /**
   * Record a trade result and update momentum
   */
  async recordResult(isWin: boolean, pnlPercent: number): Promise<void> {
    if (isWin) {
      this.state.consecutiveWins++;
      this.state.consecutiveLosses = 0;
      this.state.lastTradeResult = 'win';
    } else {
      this.state.consecutiveLosses++;
      this.state.consecutiveWins = 0;
      this.state.lastTradeResult = 'loss';
    }

    // Update streaks
    this.state.hotStreak = this.state.consecutiveWins >= this.config.hotStreakThreshold;
    this.state.coldStreak = this.state.consecutiveLosses >= this.config.coldStreakThreshold;

    // Update daily PnL
    this.state.dailyPnlPercent += pnlPercent;

    this.lastUpdate = new Date();

    logger.info(`[MOMENTUM] Recorded ${isWin ? 'WIN' : 'LOSS'}: ${this.getStateDescription()}`);
  }

  /**
   * Get position sizing and timing multipliers based on momentum
   */
  getMultipliers(): MomentumMultipliers {
    let positionSizeMultiplier = 1.0;
    let confidenceBonus = 0;
    let reentryDelayMs = this.config.normalReentryDelayMs;
    let reason = 'Normal momentum';

    // Hot streak: Increase aggression
    if (this.state.hotStreak) {
      positionSizeMultiplier = this.config.hotStreakMultiplier;
      
      // Additional multiplier for extended hot streaks
      if (this.state.consecutiveWins >= 4) {
        positionSizeMultiplier = this.config.maxPositionMultiplier;
        confidenceBonus = 10;
        reason = `🔥 Extended hot streak (${this.state.consecutiveWins} wins)`;
      } else {
        confidenceBonus = 5;
        reason = `🔥 Hot streak (${this.state.consecutiveWins} wins)`;
      }
      
      reentryDelayMs = this.config.fastReentryDelayMs;
    }
    
    // Cold streak: Reduce aggression
    else if (this.state.coldStreak) {
      positionSizeMultiplier = this.config.coldStreakMultiplier;
      
      // Further reduction for extended cold streaks
      if (this.state.consecutiveLosses >= 4) {
        positionSizeMultiplier = this.config.minPositionMultiplier;
        confidenceBonus = -10;
        reason = `❄️ Extended cold streak (${this.state.consecutiveLosses} losses)`;
      } else {
        confidenceBonus = -5;
        reason = `❄️ Cold streak (${this.state.consecutiveLosses} losses)`;
      }
      
      reentryDelayMs = this.config.slowReentryDelayMs;
    }

    // Daily performance adjustment
    if (this.state.dailyPnlPercent > 5) {
      // Great day: can be more aggressive
      positionSizeMultiplier *= 1.1;
      reason += `, Daily +${this.state.dailyPnlPercent.toFixed(1)}%`;
    } else if (this.state.dailyPnlPercent < -3) {
      // Bad day: reduce risk
      positionSizeMultiplier *= 0.8;
      reason += `, Daily ${this.state.dailyPnlPercent.toFixed(1)}%`;
    }

    // Cap multipliers
    positionSizeMultiplier = Math.max(
      this.config.minPositionMultiplier,
      Math.min(positionSizeMultiplier, this.config.maxPositionMultiplier)
    );

    return {
      positionSizeMultiplier,
      confidenceBonus,
      reentryDelayMs,
      reason
    };
  }

  /**
   * Check if we should take a trade based on momentum
   */
  shouldTrade(baseConfidence: number): { 
    shouldTrade: boolean; 
    adjustedConfidence: number;
    reason: string 
  } {
    const multipliers = this.getMultipliers();
    const adjustedConfidence = Math.min(100, baseConfidence + multipliers.confidenceBonus);

    // Extended cold streak: require higher confidence
    if (this.state.consecutiveLosses >= 4 && baseConfidence < 75) {
      return {
        shouldTrade: false,
        adjustedConfidence,
        reason: `Cold streak requires 75%+ confidence (got ${baseConfidence}%)`
      };
    }

    // On hot streak: lower confidence acceptable
    if (this.state.hotStreak && baseConfidence >= 55) {
      return {
        shouldTrade: true,
        adjustedConfidence,
        reason: `Hot streak allows lower threshold (${baseConfidence}% -> ${adjustedConfidence}%)`
      };
    }

    return {
      shouldTrade: true,
      adjustedConfidence,
      reason: multipliers.reason
    };
  }

  /**
   * Sync with database for recent trade results
   */
  private async syncWithDatabase(): Promise<void> {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // Get today's trades
      const { data: todayTrades } = await supabase
        .from('trades')
        .select('pnl_percent, status')
        .gte('closed_at', today.toISOString())
        .eq('status', 'closed')
        .order('closed_at', { ascending: false });

      if (todayTrades && todayTrades.length > 0) {
        // Calculate daily PnL
        this.state.dailyPnlPercent = todayTrades.reduce(
          (sum, t) => sum + (t.pnl_percent || 0), 
          0
        );

        // Count consecutive results from most recent
        let consecutiveWins = 0;
        let consecutiveLosses = 0;
        
        for (const trade of todayTrades) {
          const isWin = (trade.pnl_percent || 0) >= 0;
          if (isWin) {
            if (consecutiveLosses === 0) consecutiveWins++;
            else break;
          } else {
            if (consecutiveWins === 0) consecutiveLosses++;
            else break;
          }
        }

        this.state.consecutiveWins = consecutiveWins;
        this.state.consecutiveLosses = consecutiveLosses;
        this.state.hotStreak = consecutiveWins >= this.config.hotStreakThreshold;
        this.state.coldStreak = consecutiveLosses >= this.config.coldStreakThreshold;
        
        if (todayTrades.length > 0) {
          this.state.lastTradeResult = (todayTrades[0].pnl_percent || 0) >= 0 ? 'win' : 'loss';
        }
      }
    } catch (error) {
      logger.error('Failed to sync momentum with database:', error);
    }
  }

  /**
   * Reset daily stats (call at midnight UTC)
   */
  resetDaily(): void {
    this.state.dailyPnlPercent = 0;
    logger.info('[MOMENTUM] Daily stats reset');
  }

  /**
   * Get current momentum state
   */
  getState(): MomentumState {
    return { ...this.state };
  }

  private getStateDescription(): string {
    const parts = [];
    if (this.state.hotStreak) parts.push(`🔥 HOT (${this.state.consecutiveWins}W)`);
    if (this.state.coldStreak) parts.push(`❄️ COLD (${this.state.consecutiveLosses}L)`);
    parts.push(`Daily: ${this.state.dailyPnlPercent >= 0 ? '+' : ''}${this.state.dailyPnlPercent.toFixed(2)}%`);
    return parts.join(', ') || 'Neutral';
  }

  private getDefaultState(): MomentumState {
    return {
      consecutiveWins: 0,
      consecutiveLosses: 0,
      lastTradeResult: null,
      hotStreak: false,
      coldStreak: false,
      dailyPnlPercent: 0,
      weeklyPnlPercent: 0
    };
  }

  updateConfig(config: Partial<MomentumConfig>): void {
    this.config = { ...this.config, ...config };
  }
}
