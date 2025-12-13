import { format, subDays, isWeekend, getDay, getHours } from 'date-fns';

/**
 * Check if forex market is open
 * Forex is closed from Friday 10 PM UTC to Sunday 10 PM UTC
 */
export function isForexMarketOpen(): boolean {
  const now = new Date();
  const dayOfWeek = getDay(now);
  const hourUtc = getHours(now);

  // Sunday before 10 PM UTC
  if (dayOfWeek === 0 && hourUtc < 22) {
    return false;
  }

  // Saturday (any time)
  if (dayOfWeek === 6) {
    return false;
  }

  // Friday after 10 PM UTC
  if (dayOfWeek === 5 && hourUtc >= 22) {
    return false;
  }

  return true;
}

/**
 * Get current trading session
 */
export function getCurrentSession(): 'asian' | 'london' | 'newyork' | 'closed' {
  if (!isForexMarketOpen()) {
    return 'closed';
  }

  const now = new Date();
  const hourUtc = getHours(now);

  // Asian session: 00:00 - 09:00 UTC
  if (hourUtc >= 0 && hourUtc < 9) {
    return 'asian';
  }

  // London session: 08:00 - 16:00 UTC
  if (hourUtc >= 8 && hourUtc < 16) {
    return 'london';
  }

  // New York session: 13:00 - 22:00 UTC
  if (hourUtc >= 13 && hourUtc < 22) {
    return 'newyork';
  }

  return 'asian';
}

/**
 * Calculate lot size based on risk
 */
export function calculateLotSize(
  accountBalance: number,
  riskPercent: number,
  stopLossPips: number,
  pipValue: number = 10
): number {
  const riskAmount = accountBalance * (riskPercent / 100);
  let lotSize = riskAmount / (stopLossPips * pipValue);

  // Round to 2 decimal places
  lotSize = Math.round(lotSize * 100) / 100;

  // Enforce min/max
  lotSize = Math.max(0.01, Math.min(lotSize, 10.0));

  return lotSize;
}

/**
 * Delay execution
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry with exponential backoff
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  initialDelayMs: number = 1000
): Promise<T> {
  let lastError: Error | undefined;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      const delayMs = initialDelayMs * Math.pow(2, i);
      await delay(delayMs);
    }
  }

  throw lastError;
}

/**
 * Format price for display
 */
export function formatPrice(price: number, symbol: string): string {
  const decimals = symbol.includes('JPY') ? 3 : 5;
  return price.toFixed(decimals);
}

/**
 * Generate unique ID
 */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}
