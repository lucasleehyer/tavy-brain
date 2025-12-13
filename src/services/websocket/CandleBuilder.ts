import { Tick, Candle } from '../../types/market';

export class CandleBuilder {
  private candles: Map<string, Candle[]> = new Map();
  private currentCandles: Map<string, Candle> = new Map();
  private readonly maxCandles = 200;
  private readonly timeframes = ['1m', '5m', '15m', '1h'];

  private getTimeframeMs(timeframe: string): number {
    const map: Record<string, number> = {
      '1m': 60000,
      '5m': 300000,
      '15m': 900000,
      '1h': 3600000,
      '4h': 14400000,
      '1d': 86400000
    };
    return map[timeframe] || 60000;
  }

  private getCandleKey(symbol: string, timeframe: string): string {
    return `${symbol}_${timeframe}`;
  }

  private getCandleStartTime(time: Date, timeframeMs: number): Date {
    const timestamp = time.getTime();
    return new Date(Math.floor(timestamp / timeframeMs) * timeframeMs);
  }

  addTick(tick: Tick): void {
    const price = (tick.bid + tick.ask) / 2;

    for (const tf of this.timeframes) {
      const key = this.getCandleKey(tick.symbol, tf);
      const tfMs = this.getTimeframeMs(tf);
      const candleStart = this.getCandleStartTime(tick.time, tfMs);

      let current = this.currentCandles.get(key);

      // New candle period?
      if (!current || current.time.getTime() !== candleStart.getTime()) {
        // Save old candle to history
        if (current) {
          const history = this.candles.get(key) || [];
          history.push(current);

          // Trim to max
          if (history.length > this.maxCandles) {
            history.shift();
          }

          this.candles.set(key, history);
        }

        // Start new candle
        current = {
          symbol: tick.symbol,
          timeframe: tf,
          open: price,
          high: price,
          low: price,
          close: price,
          volume: 1,
          time: candleStart
        };
      } else {
        // Update current candle
        current.high = Math.max(current.high, price);
        current.low = Math.min(current.low, price);
        current.close = price;
        current.volume++;
      }

      this.currentCandles.set(key, current);
    }
  }

  getCandles(symbol: string, timeframe: string, count: number): Candle[] {
    const key = this.getCandleKey(symbol, timeframe);
    const history = this.candles.get(key) || [];
    const current = this.currentCandles.get(key);

    const all = current ? [...history, current] : history;
    return all.slice(-count);
  }

  getCurrentCandle(symbol: string, timeframe: string): Candle | null {
    const key = this.getCandleKey(symbol, timeframe);
    return this.currentCandles.get(key) || null;
  }

  clear(): void {
    this.candles.clear();
    this.currentCandles.clear();
  }
}
