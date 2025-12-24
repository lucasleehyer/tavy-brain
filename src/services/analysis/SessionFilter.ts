/**
 * Session Filter
 * 
 * Filters trades based on market session and liquidity.
 * Key insight: Trade EUR pairs during London, not Asian session.
 */

import { SessionFilterResult, SessionInfo, SessionName } from '../../types/quant';
import { logger } from '../../utils/logger';

// Session definitions (UTC hours)
const SESSIONS: Record<SessionName, { start: number; end: number; liquidity: 'low' | 'medium' | 'high'; volatility: 'low' | 'medium' | 'high' }> = {
  'asian': { start: 0, end: 8, liquidity: 'medium', volatility: 'low' },
  'london': { start: 7, end: 16, liquidity: 'high', volatility: 'high' },
  'new_york': { start: 12, end: 21, liquidity: 'high', volatility: 'high' },
  'london_ny_overlap': { start: 12, end: 16, liquidity: 'high', volatility: 'high' },
  'off_hours': { start: 21, end: 24, liquidity: 'low', volatility: 'low' }
};

// Optimal sessions for each currency pair
const OPTIMAL_SESSIONS: Record<string, SessionName[]> = {
  // EUR pairs - best in London + NY
  'EURUSD': ['london', 'new_york', 'london_ny_overlap'],
  'EURGBP': ['london'],
  'EURJPY': ['london', 'new_york', 'asian'],
  'EURAUD': ['london', 'asian'],
  'EURCHF': ['london'],
  
  // GBP pairs - best in London
  'GBPUSD': ['london', 'new_york', 'london_ny_overlap'],
  'GBPJPY': ['london', 'new_york'],
  'GBPCHF': ['london'],
  'GBPAUD': ['london', 'asian'],
  
  // USD pairs
  'USDCHF': ['london', 'new_york'],
  'USDJPY': ['london', 'new_york', 'asian'],
  'USDCAD': ['new_york'],
  
  // AUD/NZD pairs - best in Asian + London overlap
  'AUDUSD': ['asian', 'london'],
  'NZDUSD': ['asian', 'london'],
  'AUDJPY': ['asian', 'london'],
  'AUDNZD': ['asian'],
  
  // JPY pairs
  'CHFJPY': ['asian', 'london'],
  'CADJPY': ['asian', 'new_york']
};

// Position size multipliers per session quality
const SESSION_MULTIPLIERS: Record<'optimal' | 'acceptable' | 'suboptimal' | 'lunch', number> = {
  'optimal': 1.0,
  'acceptable': 0.8,
  'suboptimal': 0.5,
  'lunch': 0.6
};

export class SessionFilter {
  /**
   * Filter trade based on session
   */
  filter(
    symbol: string,
    assetType: 'forex' | 'stock' | 'crypto',
    newsProximityMinutes: number | null = null,
    newsImpact: 'low' | 'medium' | 'high' | null = null
  ): SessionFilterResult {
    // Crypto trades 24/7 - no session restrictions
    if (assetType === 'crypto') {
      return {
        canTrade: true,
        session: this.getCurrentSession(),
        positionSizeMultiplier: 1.0,
        newsProximityMinutes,
        newsImpact,
        reason: 'Crypto trades 24/7 - no session restrictions'
      };
    }

    const currentSession = this.getCurrentSession();
    const normalizedSymbol = this.normalizeSymbol(symbol);
    
    // Check if current session is optimal for this pair
    const optimalSessions = OPTIMAL_SESSIONS[normalizedSymbol] || ['london', 'new_york'];
    const isOptimal = optimalSessions.includes(currentSession.name);
    
    // Check for lunch hour (12:00-13:00 UTC)
    const now = new Date();
    const hour = now.getUTCHours();
    const isLunchHour = hour === 12;
    
    // Determine if we can trade
    let canTrade = true;
    let positionSizeMultiplier = 1.0;
    let reason = '';

    // Check news proximity
    if (newsProximityMinutes !== null && newsProximityMinutes < 60 && newsImpact === 'high') {
      canTrade = false;
      reason = `High-impact news in ${newsProximityMinutes} minutes - avoid trading`;
    } else if (newsProximityMinutes !== null && newsProximityMinutes < 30 && newsImpact === 'medium') {
      positionSizeMultiplier *= 0.7;
      reason = `Medium-impact news in ${newsProximityMinutes} minutes - reduced size`;
    }

    // Apply session rules
    if (canTrade) {
      if (isOptimal) {
        positionSizeMultiplier *= SESSION_MULTIPLIERS['optimal'];
        reason = `Optimal session for ${normalizedSymbol}`;
      } else if (currentSession.name === 'asian' && !optimalSessions.includes('asian')) {
        // Non-Asian pairs in Asian session - suboptimal
        positionSizeMultiplier *= SESSION_MULTIPLIERS['suboptimal'];
        reason = `${normalizedSymbol} not ideal for Asian session - reduced size`;
      } else if (currentSession.name === 'off_hours') {
        canTrade = false;
        reason = 'Off-hours - low liquidity, avoid trading';
      } else {
        positionSizeMultiplier *= SESSION_MULTIPLIERS['acceptable'];
        reason = `Acceptable session for ${normalizedSymbol}`;
      }
    }

    // Lunch hour reduction
    if (canTrade && isLunchHour) {
      positionSizeMultiplier *= SESSION_MULTIPLIERS['lunch'];
      reason += ' (lunch hour - reduced size)';
    }

    const result: SessionFilterResult = {
      canTrade,
      session: currentSession,
      positionSizeMultiplier,
      newsProximityMinutes,
      newsImpact,
      reason
    };

    logger.info(`[SESSION] ${currentSession.name} | ${canTrade ? 'OK' : 'BLOCKED'} | ${reason}`);

    return result;
  }

  /**
   * Get current trading session
   */
  getCurrentSession(): SessionInfo {
    const now = new Date();
    const hour = now.getUTCHours();
    
    let name: SessionName;
    let sessionData;

    // Check overlap first (highest priority)
    if (hour >= 12 && hour < 16) {
      name = 'london_ny_overlap';
      sessionData = SESSIONS['london_ny_overlap'];
    } else if (hour >= 7 && hour < 16) {
      name = 'london';
      sessionData = SESSIONS['london'];
    } else if (hour >= 12 && hour < 21) {
      name = 'new_york';
      sessionData = SESSIONS['new_york'];
    } else if (hour >= 0 && hour < 8) {
      name = 'asian';
      sessionData = SESSIONS['asian'];
    } else {
      name = 'off_hours';
      sessionData = SESSIONS['off_hours'];
    }

    // Calculate hours until next session
    let hoursUntilNext = 0;
    let nextSession: SessionName = 'london';
    
    if (name === 'asian') {
      hoursUntilNext = 7 - hour;
      if (hoursUntilNext < 0) hoursUntilNext += 24;
      nextSession = 'london';
    } else if (name === 'london' || name === 'london_ny_overlap') {
      hoursUntilNext = 12 - hour;
      if (hoursUntilNext < 0) hoursUntilNext = 21 - hour;
      nextSession = hour < 12 ? 'london_ny_overlap' : 'new_york';
    } else if (name === 'new_york') {
      hoursUntilNext = 24 - hour; // Until Asian opens
      nextSession = 'asian';
    } else {
      hoursUntilNext = 24 - hour; // Until Asian
      nextSession = 'asian';
    }

    return {
      name,
      isActive: true,
      liquidity: sessionData.liquidity,
      volatility: sessionData.volatility,
      hoursUntilNext,
      nextSession
    };
  }

  /**
   * Normalize symbol
   */
  private normalizeSymbol(symbol: string): string {
    return symbol.replace(/\.[a-z]$/i, '').toUpperCase();
  }

  /**
   * Check if symbol is tradeable in current session
   */
  isTradeable(symbol: string): boolean {
    const result = this.filter(symbol, 'forex');
    return result.canTrade;
  }
}
