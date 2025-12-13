import { Tick } from '../../types/market';

interface CachedPrice extends Tick {
  lastUpdate: number;
}

export class PriceCache {
  private cache: Map<string, CachedPrice> = new Map();
  private readonly TTL_MS = 30000; // 30 second TTL

  update(tick: Tick): void {
    this.cache.set(tick.symbol, {
      ...tick,
      lastUpdate: Date.now()
    });
  }

  get(symbol: string): CachedPrice | null {
    const cached = this.cache.get(symbol);
    if (!cached) return null;

    // Check if stale
    if (Date.now() - cached.lastUpdate > this.TTL_MS) {
      return null;
    }

    return cached;
  }

  getAll(): Map<string, CachedPrice> {
    const fresh = new Map<string, CachedPrice>();
    const now = Date.now();

    for (const [symbol, data] of this.cache) {
      if (now - data.lastUpdate <= this.TTL_MS) {
        fresh.set(symbol, data);
      }
    }

    return fresh;
  }

  getAge(symbol: string): number | null {
    const cached = this.cache.get(symbol);
    if (!cached) return null;
    return Date.now() - cached.lastUpdate;
  }

  getLastTickTime(): number {
    let latest = 0;
    for (const data of this.cache.values()) {
      if (data.lastUpdate > latest) {
        latest = data.lastUpdate;
      }
    }
    return latest;
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}
