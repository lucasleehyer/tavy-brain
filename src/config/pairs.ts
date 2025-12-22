// Forex pairs to monitor - OPTIMIZED with high-volatility pairs prioritized
export const FOREX_PAIRS = [
  // Major pairs
  'EURUSD',
  'GBPUSD',
  'USDJPY',
  'USDCHF',
  'AUDUSD',
  'NZDUSD',
  'USDCAD',

  // HIGH VOLATILITY Cross pairs (prioritized for 30% target)
  'GBPNZD',   // Very high volatility
  'GBPAUD',   // Very high volatility
  'EURNZD',   // High volatility
  'GBPJPY',   // High volatility
  'EURJPY',
  'EURAUD',
  'GBPCAD',
  'GBPCHF',
  'AUDJPY',
  'NZDJPY',
  'CADJPY',
  
  // Lower volatility crosses (still monitored)
  'EURGBP',
  'EURCAD',
  'EURCHF',
  'AUDNZD',

  // Metals (high volatility)
  'XAUUSD',
  'XAGUSD'
];

// Crypto CFD pairs - 24/7 trading (FBS exact symbol names)
export const CRYPTO_PAIRS = [
  'BTCUSD',
  'BCHUSD',
  'ETHUSD',
  'LTCUSD',
  'XRPUSD',
  'TONUSD',
  'SOLUSD',
  'TRXUSD',
  'DOGUSD',
  'BTCETH',
  'BTCXAU'
];

// All tradeable pairs
export const ALL_PAIRS = [...FOREX_PAIRS, ...CRYPTO_PAIRS];

// Pip multipliers by symbol
export const PIP_MULTIPLIERS: Record<string, number> = {
  // JPY pairs
  'USDJPY': 100,
  'EURJPY': 100,
  'GBPJPY': 100,
  'AUDJPY': 100,
  'NZDJPY': 100,
  'CADJPY': 100,

  // Metals (different pip definition)
  'XAUUSD': 10,
  'XAGUSD': 1000,

  // Crypto CFDs (price-based, use 1 for percentage calculations)
  'BTCUSD': 1,
  'ETHUSD': 1,
  'SOLUSD': 100,
  'XRPUSD': 10000,
  'LTCUSD': 100,
  'ADAUSD': 10000,
  'DOTUSD': 1000,
  'LINKUSD': 1000,

  // Default for standard pairs
  'default': 10000
};

// Minimum TP in pips by symbol type
export const MIN_TP_PIPS: Record<string, number> = {
  'XAUUSD': 50,
  'XAGUSD': 50,
  // Crypto uses percentage-based TP, not pips
  'BTCUSD': 100,   // $100 minimum move
  'ETHUSD': 10,    // $10 minimum move
  'SOLUSD': 1,     // $1 minimum move
  'default': 20
};

export function getPipMultiplier(symbol: string): number {
  return PIP_MULTIPLIERS[symbol] || PIP_MULTIPLIERS['default'];
}

export function getMinTpPips(symbol: string): number {
  return MIN_TP_PIPS[symbol] || MIN_TP_PIPS['default'];
}

export function priceToPips(symbol: string, priceMove: number): number {
  return priceMove * getPipMultiplier(symbol);
}

export function pipsToPrice(symbol: string, pips: number): number {
  return pips / getPipMultiplier(symbol);
}

export function isCryptoPair(symbol: string): boolean {
  return CRYPTO_PAIRS.includes(symbol);
}

export function isForexPair(symbol: string): boolean {
  return FOREX_PAIRS.includes(symbol);
}

export function getAssetType(symbol: string): 'forex' | 'crypto' {
  return isCryptoPair(symbol) ? 'crypto' : 'forex';
}
