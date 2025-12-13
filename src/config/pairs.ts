// Forex pairs to monitor
export const FOREX_PAIRS = [
  // Major pairs
  'EURUSD',
  'GBPUSD',
  'USDJPY',
  'USDCHF',
  'AUDUSD',
  'NZDUSD',
  'USDCAD',

  // Cross pairs
  'EURGBP',
  'EURJPY',
  'GBPJPY',
  'EURAUD',
  'EURNZD',
  'EURCAD',
  'EURCHF',
  'GBPAUD',
  'GBPNZD',
  'GBPCAD',
  'GBPCHF',
  'AUDNZD',
  'AUDJPY',
  'NZDJPY',
  'CADJPY',

  // Metals
  'XAUUSD',
  'XAGUSD'
];

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

  // Default for standard pairs
  'default': 10000
};

// Minimum TP in pips by symbol type
export const MIN_TP_PIPS: Record<string, number> = {
  'XAUUSD': 50,
  'XAGUSD': 50,
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
