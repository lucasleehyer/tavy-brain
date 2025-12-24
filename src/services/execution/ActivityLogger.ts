import { SupabaseManager } from './SupabaseClient';
import { logger } from '../../utils/logger';

// Symbol name translations for human-friendly display
const SYMBOL_NAMES: Record<string, string> = {
  'EURUSD': 'Euro/Dollar',
  'GBPUSD': 'Pound/Dollar',
  'USDJPY': 'Dollar/Yen',
  'USDCHF': 'Dollar/Franc',
  'AUDUSD': 'Aussie/Dollar',
  'NZDUSD': 'Kiwi/Dollar',
  'USDCAD': 'Dollar/Canadian',
  'EURGBP': 'Euro/Pound',
  'EURJPY': 'Euro/Yen',
  'GBPJPY': 'Pound/Yen',
  'EURAUD': 'Euro/Aussie',
  'EURNZD': 'Euro/Kiwi',
  'EURCAD': 'Euro/Canadian',
  'EURCHF': 'Euro/Franc',
  'GBPAUD': 'Pound/Aussie',
  'GBPNZD': 'Pound/Kiwi',
  'GBPCAD': 'Pound/Canadian',
  'GBPCHF': 'Pound/Franc',
  'AUDNZD': 'Aussie/Kiwi',
  'AUDJPY': 'Aussie/Yen',
  'NZDJPY': 'Kiwi/Yen',
  'CADJPY': 'Canadian/Yen',
  'XAUUSD': 'Gold',
  'XAGUSD': 'Silver',
};

// Message templates for natural variation
const MESSAGES = {
  scanning: [
    'Scanning the forex markets...',
    'Keeping an eye on the markets...',
    'Monitoring currency pairs...',
    'Watching for opportunities...',
  ],
  analyzing: [
    'Taking a closer look at {symbol}...',
    'Something caught our eye on {symbol}',
    'Analyzing {symbol} for opportunities',
    'Checking out {symbol} - interesting movement',
  ],
  research: [
    'Gathering latest news on {symbol}...',
    'Our research team is checking {symbol}',
    'Looking into market sentiment for {symbol}',
    'Reviewing fundamentals for {symbol}...',
  ],
  prefilterPass: [
    'Spotted something interesting in {symbol}',
    '{symbol} is showing potential',
    'Good setup forming on {symbol}',
    '{symbol} passed our initial screening',
  ],
  prefilterFail: [
    '{symbol} looks quiet - holding back',
    'Nothing compelling on {symbol} right now',
    '{symbol} not quite there yet',
    'Skipping {symbol} - conditions not ideal',
  ],
  decision_hold: [
    'Good setup, but waiting for confirmation',
    'Close, but not quite there on {symbol}',
    'Staying patient - {symbol} needs more time',
    'Holding back on {symbol} for now',
    '{symbol} almost ready - watching closely',
  ],
  decision_buy: [
    'Looking bullish on {symbol}!',
    '{symbol} showing strong buying signals',
    'Opportunity spotted - {symbol} is ready',
  ],
  decision_sell: [
    'Looking bearish on {symbol}!',
    '{symbol} showing selling signals',
    'Downside opportunity on {symbol}',
  ],
  signal: [
    '🎯 Opportunity found! Going {direction} on {symbol}',
    '🎯 Signal generated - {direction} on {symbol}',
    '🎯 Taking a position on {symbol}',
  ],
  trade: [
    '💰 Trade opened on {account}',
    '💰 Executing trade on {account}',
    '💰 Position opened via {account}',
  ],
  waiting: [
    "Markets are quiet - staying patient",
    'Waiting for the right moment...',
    'All pairs analyzed - watching for changes',
    'No strong setups right now - being selective',
  ],
  error: [
    '⚠️ Encountered an issue - investigating',
    '⚠️ Something went wrong - retrying',
  ],
};

export class ActivityLogger {
  private supabaseManager: SupabaseManager;
  private lastScanLog = 0;
  private scanLogInterval = 30000; // Log scan summary every 30 seconds max

  constructor() {
    this.supabaseManager = SupabaseManager.getInstance();
  }

  private getSymbolName(symbol: string): string {
    const clean = symbol.replace('/', '').replace('.', '').toUpperCase();
    return SYMBOL_NAMES[clean] || symbol;
  }

  private pickRandom(messages: string[]): string {
    return messages[Math.floor(Math.random() * messages.length)];
  }

  private formatMessage(template: string, vars: Record<string, string>): string {
    let result = template;
    for (const [key, value] of Object.entries(vars)) {
      result = result.replace(`{${key}}`, value);
    }
    return result;
  }

  async log(
    activityType: string,
    symbol: string | null,
    customMessage?: string,
    details?: Record<string, any>
  ): Promise<void> {
    try {
      const client = this.supabaseManager.getClient();
      
      let humanMessage = customMessage;
      
      if (!humanMessage) {
        const symbolName = symbol ? this.getSymbolName(symbol) : '';
        const templates = MESSAGES[activityType as keyof typeof MESSAGES] || MESSAGES.waiting;
        humanMessage = this.formatMessage(this.pickRandom(templates), { symbol: symbolName });
      }

      const { error } = await client.from('vps_activity_logs').insert({
        activity_type: activityType,
        symbol: symbol ? this.getSymbolName(symbol) : null,
        human_message: humanMessage,
        details,
        level: activityType === 'error' ? 'error' : 'info',
      });

      if (error) {
        logger.warn('Failed to log activity:', error.message);
      }
    } catch (err) {
      // Don't throw - activity logging should never break the main flow
      logger.warn('Activity logging error:', err);
    }
  }

  // Convenience methods
  async logScanning(pairsCount: number): Promise<void> {
    const now = Date.now();
    if (now - this.lastScanLog < this.scanLogInterval) {
      return; // Rate limit scan logs
    }
    this.lastScanLog = now;
    
    await this.log('scanning', null, `Scanning ${pairsCount} currency pairs...`);
  }

  async logAnalyzing(symbol: string): Promise<void> {
    await this.log('analyzing', symbol);
  }

  async logResearch(symbol: string): Promise<void> {
    await this.log('research', symbol);
  }

  async logPrefilterPass(symbol: string, indicators?: Record<string, any>): Promise<void> {
    await this.log('analyzing', symbol, undefined, indicators);
  }

  async logPrefilterFail(symbol: string): Promise<void> {
    // Don't log every fail - too noisy
  }

  async logDecision(symbol: string, decision: 'BUY' | 'SELL' | 'HOLD', confidence: number): Promise<void> {
    const decisionType = decision === 'HOLD' ? 'decision_hold' : 
                         decision === 'BUY' ? 'decision_buy' : 'decision_sell';
    
    const symbolName = this.getSymbolName(symbol);
    const templates = MESSAGES[decisionType as keyof typeof MESSAGES] || MESSAGES.decision_hold;
    const message = this.formatMessage(this.pickRandom(templates), { symbol: symbolName });
    
    await this.log('decision', symbol, message, { confidence });
  }

  async logSignal(symbol: string, direction: 'BUY' | 'SELL', confidence: number): Promise<void> {
    const symbolName = this.getSymbolName(symbol);
    const dirText = direction === 'BUY' ? 'LONG' : 'SHORT';
    const template = this.pickRandom(MESSAGES.signal);
    const message = this.formatMessage(template, { symbol: symbolName, direction: dirText });
    
    await this.log('signal', symbol, message, { direction, confidence });
  }

  async logTrade(symbol: string, accountName: string, direction: 'BUY' | 'SELL'): Promise<void> {
    const symbolName = this.getSymbolName(symbol);
    const template = this.pickRandom(MESSAGES.trade);
    const message = this.formatMessage(template, { account: accountName, symbol: symbolName });
    
    await this.log('trade', symbol, message, { account: accountName, direction });
  }

  async logWaiting(): Promise<void> {
    await this.log('waiting', null);
  }

  async logError(message: string, details?: Record<string, any>): Promise<void> {
    await this.log('error', null, `⚠️ ${message}`, details);
  }

  async logInfo(message: string, details?: Record<string, any>): Promise<void> {
    await this.log('info', null, `ℹ️ ${message}`, details);
  }
}

export const activityLogger = new ActivityLogger();
