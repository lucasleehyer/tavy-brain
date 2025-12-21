import { Candle } from '../../types/market';

export interface KeyLevel {
  price: number;
  type: 'support' | 'resistance' | 'pivot';
  source: string; // e.g., 'daily_high', 'weekly_open', 'swing_low'
  strength: number; // 1-3 (how many times tested)
  lastTested: Date;
}

export interface KeyLevelResult {
  levels: KeyLevel[];
  nearestSupport: number | null;
  nearestResistance: number | null;
  distanceToNearestLevel: number;
  atKeyLevel: boolean;
  levelType: 'support' | 'resistance' | 'none';
}

export class KeyLevelDetector {
  private atrMultiplier: number;

  constructor(atrMultiplier: number = 0.3) {
    this.atrMultiplier = atrMultiplier;
  }

  detect(candles: Candle[], currentPrice: number, atr: number): KeyLevelResult {
    if (candles.length < 20) {
      return this.getDefaultResult();
    }

    const levels: KeyLevel[] = [];

    // Detect swing highs and lows
    const swingLevels = this.detectSwingPoints(candles);
    levels.push(...swingLevels);

    // Add daily open/high/low levels from recent candles
    const dailyLevels = this.getDailyLevels(candles);
    levels.push(...dailyLevels);

    // Sort levels by price
    levels.sort((a, b) => a.price - b.price);

    // Find nearest support and resistance
    let nearestSupport: number | null = null;
    let nearestResistance: number | null = null;

    for (const level of levels) {
      if (level.price < currentPrice) {
        if (!nearestSupport || level.price > nearestSupport) {
          nearestSupport = level.price;
        }
      } else if (level.price > currentPrice) {
        if (!nearestResistance || level.price < nearestResistance) {
          nearestResistance = level.price;
        }
      }
    }

    // Check if at key level (within ATR threshold)
    const levelThreshold = atr * this.atrMultiplier;
    let atKeyLevel = false;
    let levelType: 'support' | 'resistance' | 'none' = 'none';
    let distanceToNearestLevel = Infinity;

    for (const level of levels) {
      const distance = Math.abs(currentPrice - level.price);
      if (distance < distanceToNearestLevel) {
        distanceToNearestLevel = distance;
      }
      if (distance <= levelThreshold) {
        atKeyLevel = true;
        levelType = level.type === 'pivot' 
          ? (currentPrice > level.price ? 'support' : 'resistance')
          : level.type;
      }
    }

    return {
      levels,
      nearestSupport,
      nearestResistance,
      distanceToNearestLevel,
      atKeyLevel,
      levelType
    };
  }

  private detectSwingPoints(candles: Candle[]): KeyLevel[] {
    const levels: KeyLevel[] = [];
    const lookback = 5; // Bars on each side to confirm swing

    for (let i = lookback; i < candles.length - lookback; i++) {
      const current = candles[i];
      let isSwingHigh = true;
      let isSwingLow = true;

      // Check if current high is higher than surrounding bars
      for (let j = i - lookback; j <= i + lookback; j++) {
        if (j === i) continue;
        if (candles[j].high >= current.high) isSwingHigh = false;
        if (candles[j].low <= current.low) isSwingLow = false;
      }

      if (isSwingHigh) {
        const existingLevel = levels.find(l => 
          Math.abs(l.price - current.high) / current.high < 0.001 // Within 0.1%
        );
        if (existingLevel) {
          existingLevel.strength++;
          existingLevel.lastTested = current.time;
        } else {
          levels.push({
            price: current.high,
            type: 'resistance',
            source: 'swing_high',
            strength: 1,
            lastTested: current.time
          });
        }
      }

      if (isSwingLow) {
        const existingLevel = levels.find(l => 
          Math.abs(l.price - current.low) / current.low < 0.001
        );
        if (existingLevel) {
          existingLevel.strength++;
          existingLevel.lastTested = current.time;
        } else {
          levels.push({
            price: current.low,
            type: 'support',
            source: 'swing_low',
            strength: 1,
            lastTested: current.time
          });
        }
      }
    }

    return levels;
  }

  private getDailyLevels(candles: Candle[]): KeyLevel[] {
    const levels: KeyLevel[] = [];
    
    if (candles.length < 10) return levels;

    // Get the daily open (first candle of the day)
    const recentCandles = candles.slice(-50);
    const dailyOpen = recentCandles[0]?.open;
    
    if (dailyOpen) {
      levels.push({
        price: dailyOpen,
        type: 'pivot',
        source: 'daily_open',
        strength: 2,
        lastTested: recentCandles[0].time
      });
    }

    // Get yesterday's high/low approximation (previous day candles)
    const prevDayCandles = candles.slice(-100, -50);
    if (prevDayCandles.length > 0) {
      const prevHigh = Math.max(...prevDayCandles.map(c => c.high));
      const prevLow = Math.min(...prevDayCandles.map(c => c.low));

      levels.push({
        price: prevHigh,
        type: 'resistance',
        source: 'prev_day_high',
        strength: 2,
        lastTested: prevDayCandles[prevDayCandles.length - 1].time
      });

      levels.push({
        price: prevLow,
        type: 'support',
        source: 'prev_day_low',
        strength: 2,
        lastTested: prevDayCandles[prevDayCandles.length - 1].time
      });
    }

    return levels;
  }

  private getDefaultResult(): KeyLevelResult {
    return {
      levels: [],
      nearestSupport: null,
      nearestResistance: null,
      distanceToNearestLevel: Infinity,
      atKeyLevel: false,
      levelType: 'none'
    };
  }
}
