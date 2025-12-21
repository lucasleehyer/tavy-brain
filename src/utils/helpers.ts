import { format, subDays, isWeekend, getDay, getHours } from 'date-fns';
import { isCryptoPair } from '../config/pairs';

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
 * Check if crypto market is open (24/7)
 */
export function isCryptoMarketOpen(): boolean {
  return true; // Crypto trades 24/7
}

/**
 * Check if market is open for a given symbol
 */
export function isMarketOpen(symbol: string): boolean {
  if (isCryptoPair(symbol)) {
    return isCryptoMarketOpen();
  }
  return isForexMarketOpen();
}

/**
 * Get current trading session
 */
export function getCurrentSession(symbol?: string): 'asian' | 'london' | 'newyork' | 'closed' | 'crypto_24h' {
  // Crypto is always open
  if (symbol && isCryptoPair(symbol)) {
    return 'crypto_24h';
  }

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
 * Calculate lot size based on risk (forex/metals)
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
 * Calculate lot size for crypto CFDs (percentage-based)
 */
export function calculateCryptoLotSize(
  accountBalance: number,
  riskPercent: number,
  stopLossPercent: number,
  entryPrice: number,
  maxLeverage: number = 20
): number {
  // Risk amount in dollars
  const riskAmount = accountBalance * (riskPercent / 100);
  
  // Position size based on stop loss percentage
  // If SL is 2% away, and we want to risk $100, position = $100 / 0.02 = $5000
  const positionValue = riskAmount / (stopLossPercent / 100);
  
  // Convert to lots (units of the crypto)
  // For BTCUSD at $60000, $5000 position = 0.083 BTC
  let lotSize = positionValue / entryPrice;
  
  // Apply leverage constraint
  const maxPositionValue = accountBalance * maxLeverage;
  if (positionValue > maxPositionValue) {
    lotSize = maxPositionValue / entryPrice;
  }
  
  // Round to appropriate precision based on price
  if (entryPrice > 10000) {
    // BTC: round to 0.001
    lotSize = Math.round(lotSize * 1000) / 1000;
  } else if (entryPrice > 100) {
    // ETH, SOL: round to 0.01
    lotSize = Math.round(lotSize * 100) / 100;
  } else {
    // Smaller cryptos: round to 1
    lotSize = Math.round(lotSize);
  }
  
  // Enforce minimums
  lotSize = Math.max(0.001, lotSize);
  
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
