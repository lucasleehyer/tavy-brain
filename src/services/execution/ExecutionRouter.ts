import { MetaApiManager } from '../websocket/MetaApiManager';
import { TradeRepository } from '../database/TradeRepository';
import { SettingsRepository } from '../database/SettingsRepository';
import { AlertManager } from '../notifications/AlertManager';
import { CircuitBreaker } from '../risk/CircuitBreaker';
import { activityLogger } from '../database/ActivityLogger';
import { logger } from '../../utils/logger';
import { Signal } from '../../types/signal';
import { ExecutionResult } from '../../types/trade';
import { calculateLotSize, calculateCryptoLotSize } from '../../utils/helpers';
import { pipsToPrice, getPipMultiplier, isCryptoPair } from '../../config/pairs';
import { ANTI_SCALPING } from '../../config/thresholds';

interface ExecutionConfig {
  userId: string;
  defaultRiskPercent: number;
}

interface TradingAccount {
  id: string;
  account_name: string;
  broker: string;
  metaapi_account_id: string;
  minimum_balance: number;
  leverage: number;
  is_active: boolean;
}

export interface DynamicPositionConfig {
  baseRiskPercent: number;
  confidence: number;
  confluenceScore: number;
}

// Confidence tiers for position sizing
const CONFIDENCE_TIERS = {
  FULL: { minConfidence: 85, multiplier: 1.5 },     // Full position
  STANDARD: { minConfidence: 70, multiplier: 1.0 }, // Standard position
  HALF: { minConfidence: 60, multiplier: 0.5 },     // Half position
  REJECT: { minConfidence: 0, multiplier: 0 }       // No trade
};

// Confluence score bonuses
const CONFLUENCE_BONUSES = {
  EXCEPTIONAL: { minScore: 90, bonusPercent: 1.0 },
  HIGH: { minScore: 80, bonusPercent: 0.5 },
  STANDARD: { minScore: 60, bonusPercent: 0 }
};

const MAX_TOTAL_RISK_PERCENT = 3; // Never exceed 3% risk per trade

export class ExecutionRouter {
  private tradeRepo: TradeRepository;
  private settingsRepo: SettingsRepository;
  private alertManager: AlertManager;
  private circuitBreaker: CircuitBreaker;
  private config: ExecutionConfig;
  private accountConnections: Map<string, MetaApiManager> = new Map();

  constructor(config: ExecutionConfig) {
    this.tradeRepo = new TradeRepository();
    this.settingsRepo = new SettingsRepository();
    this.alertManager = new AlertManager();
    this.circuitBreaker = new CircuitBreaker();
    this.config = config;
  }

  async initialize(): Promise<void> {
    await this.circuitBreaker.initialize();
    logger.info('ExecutionRouter initialized with CircuitBreaker');
  }

  updateRiskPercent(riskPercent: number): void {
    this.config.defaultRiskPercent = riskPercent;
    logger.info(`ExecutionRouter risk percent updated to ${riskPercent}%`);
  }

  /**
   * Calculate dynamic position size based on confidence and confluence
   */
  calculateDynamicRisk(config: DynamicPositionConfig): { 
    riskPercent: number; 
    tier: string;
    multiplier: number;
    confluenceBonus: number;
  } {
    // Determine confidence tier
    let tier = 'REJECT';
    let multiplier = 0;

    if (config.confidence >= CONFIDENCE_TIERS.FULL.minConfidence) {
      tier = 'FULL';
      multiplier = CONFIDENCE_TIERS.FULL.multiplier;
    } else if (config.confidence >= CONFIDENCE_TIERS.STANDARD.minConfidence) {
      tier = 'STANDARD';
      multiplier = CONFIDENCE_TIERS.STANDARD.multiplier;
    } else if (config.confidence >= CONFIDENCE_TIERS.HALF.minConfidence) {
      tier = 'HALF';
      multiplier = CONFIDENCE_TIERS.HALF.multiplier;
    }

    // Calculate confluence bonus
    let confluenceBonus = 0;
    if (config.confluenceScore >= CONFLUENCE_BONUSES.EXCEPTIONAL.minScore) {
      confluenceBonus = CONFLUENCE_BONUSES.EXCEPTIONAL.bonusPercent;
    } else if (config.confluenceScore >= CONFLUENCE_BONUSES.HIGH.minScore) {
      confluenceBonus = CONFLUENCE_BONUSES.HIGH.bonusPercent;
    }

    // Calculate final risk
    const baseRisk = config.baseRiskPercent * multiplier;
    const totalRisk = Math.min(baseRisk + confluenceBonus, MAX_TOTAL_RISK_PERCENT);

    logger.info(`Dynamic position sizing: Tier=${tier}, Multiplier=${multiplier}x, ConfluenceBonus=+${confluenceBonus}%, FinalRisk=${totalRisk}%`);

    return {
      riskPercent: totalRisk,
      tier,
      multiplier,
      confluenceBonus
    };
  }

  async executeTrade(signal: Signal): Promise<ExecutionResult[]> {
    logger.info(`Executing trade on all active accounts: ${signal.symbol} ${signal.action}`);

    // Get all active execution accounts from database
    const accounts = await this.settingsRepo.getActiveExecutionAccounts();
    
    if (accounts.length === 0) {
      logger.warn('No active execution accounts found');
      return [{ success: false, error: 'No active execution accounts' }];
    }

    logger.info(`Found ${accounts.length} active execution accounts`);

    // Calculate dynamic risk based on signal confidence and confluence
    const confluenceScore = signal.snapshotSettings?.confluenceScore || 60;
    const dynamicRisk = this.calculateDynamicRisk({
      baseRiskPercent: this.config.defaultRiskPercent,
      confidence: signal.confidence,
      confluenceScore
    });

    // Skip if confidence tier is REJECT
    if (dynamicRisk.tier === 'REJECT') {
      logger.warn(`Skipping execution: confidence ${signal.confidence}% below minimum threshold`);
      return [{ success: false, error: 'Confidence below minimum threshold' }];
    }

    const results: ExecutionResult[] = [];

    // Execute on each account
    for (const account of accounts) {
      const result = await this.executeOnAccount(signal, account, dynamicRisk.riskPercent);
      results.push(result);
    }

    // Send summary alert
    const successCount = results.filter(r => r.success).length;
    await this.alertManager.alertSignalFired(
      signal.symbol,
      signal.action,
      signal.confidence,
      `Executed on ${successCount}/${accounts.length} accounts (${dynamicRisk.tier} position, ${dynamicRisk.riskPercent.toFixed(2)}% risk)`
    );

    return results;
  }

  private async executeOnAccount(
    signal: Signal, 
    account: TradingAccount,
    riskPercent: number
  ): Promise<ExecutionResult> {
    logger.info(`Executing on ${account.account_name} (${account.broker})...`);

    // Check circuit breaker for this account
    const circuitStatus = await this.circuitBreaker.canTrade(account.id);
    if (!circuitStatus.canTrade) {
      logger.warn(`Circuit breaker BLOCKED trade on ${account.account_name}: ${circuitStatus.reason}`);
      return {
        success: false,
        error: `Circuit breaker: ${circuitStatus.reason}`,
        accountId: account.id,
        accountName: account.account_name
      };
    }

    try {
      // Get or create MetaAPI connection for this account
      let metaApi = this.accountConnections.get(account.metaapi_account_id);
      
      if (!metaApi || !metaApi.isReady()) {
        metaApi = new MetaApiManager(account.metaapi_account_id);
        await metaApi.connect();
        this.accountConnections.set(account.metaapi_account_id, metaApi);
      }

      // CHECK SYMBOL AVAILABILITY - Critical for multi-broker support
      const availableSymbols = metaApi.getAvailableSymbols();
      if (availableSymbols.length > 0 && !availableSymbols.includes(signal.symbol)) {
        // Try to find a similar symbol (e.g., XAUUSD vs GOLD, EURUSDm vs EURUSD)
        const normalizedSignal = signal.symbol.replace(/[.#_\-m]/gi, '').toUpperCase();
        const matchingSymbol = availableSymbols.find(s => {
          const normalized = s.replace(/[.#_\-m]/gi, '').toUpperCase();
          return normalized === normalizedSignal;
        });

        if (matchingSymbol) {
          logger.info(`Symbol mapping: ${signal.symbol} -> ${matchingSymbol} on ${account.broker}`);
          // Update signal symbol for this execution (don't modify original)
          signal = { ...signal, symbol: matchingSymbol };
        } else {
          const errorMsg = `Symbol ${signal.symbol} not available on ${account.broker}`;
          logger.error(`❌ ${account.account_name}: ${errorMsg}`);
          
          // Log to activity feed so it's visible in dashboard
          await activityLogger.logError(`Broker ${account.broker} does not have ${signal.symbol}`, {
            accountName: account.account_name,
            broker: account.broker,
            symbol: signal.symbol,
            availableCount: availableSymbols.length,
            searchedFor: normalizedSignal
          });

          // Save failed trade attempt to database for complete history
          await this.tradeRepo.saveTrade({
            userId: this.config.userId,
            symbol: signal.symbol,
            direction: signal.action.toLowerCase() as 'buy' | 'sell',
            entryPrice: signal.entryPrice,
            quantity: 0, // No lot size since we couldn't execute
            stopLoss: signal.stopLoss,
            takeProfit: signal.takeProfit1,
            tradingAccountId: account.id,
            signalId: signal.id,
            mtPositionId: undefined,
            executionStatus: 'failed',
            executionAttempts: 1,
            lastExecutionError: errorMsg,
            snapshotSettings: signal.snapshotSettings,
            status: 'cancelled',
            openedAt: new Date()
          });

          await this.alertManager.alertTradeFailure(signal.symbol, errorMsg);

          return {
            success: false,
            error: errorMsg,
            accountId: account.id,
            accountName: account.account_name
          };
        }
      }

      // Get account balance
      const accountInfo = await metaApi.getAccountInfo();
      const balance = accountInfo.balance;

      // Check minimum balance
      if (balance < account.minimum_balance) {
        const errorMsg = `Balance $${balance.toFixed(2)} below minimum $${account.minimum_balance}`;
        logger.warn(`Skipping ${account.account_name}: ${errorMsg}`);
        
        await activityLogger.logError(`Insufficient balance on ${account.account_name}`, {
          balance,
          minimumBalance: account.minimum_balance,
          symbol: signal.symbol
        });

        return {
          success: false,
          error: errorMsg,
          accountId: account.id,
          accountName: account.account_name
        };
      }

      // Calculate lot size based on asset type
      let lotSize: number;
      
      if (isCryptoPair(signal.symbol)) {
        // Crypto uses percentage-based position sizing
        const stopLossPercent = Math.abs((signal.entryPrice - signal.stopLoss) / signal.entryPrice) * 100;
        const maxLeverage = ANTI_SCALPING.crypto.maxLeverage || 20;
        lotSize = calculateCryptoLotSize(
          balance,
          riskPercent,
          stopLossPercent,
          signal.entryPrice,
          maxLeverage
        );
        logger.info(`${account.account_name} [CRYPTO]: Balance $${balance}, Risk ${riskPercent}%, SL ${stopLossPercent.toFixed(2)}%, Lot size: ${lotSize}`);
      } else {
        // Forex/metals uses pip-based position sizing
        const stopLossPips = Math.abs(signal.entryPrice - signal.stopLoss) * getPipMultiplier(signal.symbol);
        lotSize = calculateLotSize(
          balance,
          riskPercent,
          stopLossPips
        );
        logger.info(`${account.account_name} [FOREX]: Balance $${balance}, Risk ${riskPercent}%, Lot size: ${lotSize}`);
      }

      // Execute trade
      const result = await metaApi.openTrade({
        symbol: signal.symbol,
        direction: signal.action.toLowerCase() as 'buy' | 'sell',
        volume: lotSize,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit1,
        comment: `TAVY-${signal.id?.slice(0, 8) || 'SIGNAL'}`
      });

      // Enhance snapshot with position sizing info
      const enhancedSnapshot = {
        ...signal.snapshotSettings,
        riskPercent,
        positionTier: this.getPositionTier(signal.confidence),
        dynamicSizing: true,
        executedOnBroker: account.broker,
        executedSymbol: signal.symbol
      };

      // Save trade to database with full details
      await this.tradeRepo.saveTrade({
        userId: this.config.userId,
        symbol: signal.symbol,
        direction: signal.action.toLowerCase() as 'buy' | 'sell',
        entryPrice: result.price || signal.entryPrice,
        quantity: lotSize,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit1,
        tradingAccountId: account.id,
        signalId: signal.id,
        mtPositionId: result.positionId,
        executionStatus: 'executed',
        executionAttempts: 1,
        snapshotSettings: enhancedSnapshot,
        status: 'open',
        openedAt: new Date()
      });

      logger.info(`✅ ${account.account_name}: Trade executed - ${result.positionId} @ ${result.price}`);
      
      // Log success to activity feed
      await activityLogger.logTrade(signal.symbol, account.account_name, signal.action as 'BUY' | 'SELL');

      return {
        success: true,
        positionId: result.positionId,
        entryPrice: result.price,
        accountId: account.id,
        accountName: account.account_name
      };

    } catch (error) {
      const errorMessage = (error as Error).message;
      logger.error(`❌ ${account.account_name}: Execution failed - ${errorMessage}`);

      // Log execution failure
      await activityLogger.logError(`Trade execution failed on ${account.account_name}`, {
        symbol: signal.symbol,
        action: signal.action,
        error: errorMessage,
        broker: account.broker
      });

      // Save failed trade attempt to database
      await this.tradeRepo.saveTrade({
        userId: this.config.userId,
        symbol: signal.symbol,
        direction: signal.action.toLowerCase() as 'buy' | 'sell',
        entryPrice: signal.entryPrice,
        quantity: 0,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit1,
        tradingAccountId: account.id,
        signalId: signal.id,
        mtPositionId: undefined,
        executionStatus: 'failed',
        executionAttempts: 1,
        lastExecutionError: errorMessage,
        snapshotSettings: signal.snapshotSettings,
        status: 'cancelled',
        openedAt: new Date()
      });

      await this.alertManager.alertTradeFailure(
        signal.symbol,
        `${account.account_name}: ${errorMessage}`
      );

      return {
        success: false,
        error: errorMessage,
        accountId: account.id,
        accountName: account.account_name
      };
    }
  }

  private getPositionTier(confidence: number): string {
    if (confidence >= 85) return 'FULL';
    if (confidence >= 70) return 'STANDARD';
    if (confidence >= 60) return 'HALF';
    return 'REJECT';
  }

  async closeTrade(positionId: string, tradeId: string, exitPrice: number): Promise<boolean> {
    try {
      // Get trade details first to find the correct account
      const trade = await this.tradeRepo.getTradeByMtPositionId(positionId);
      if (!trade) {
        logger.error(`Trade not found for position ${positionId}`);
        return false;
      }

      // Get the MetaAPI connection for this account
      const metaApi = this.accountConnections.get(trade.metaapi_account_id);
      if (!metaApi) {
        logger.error(`No MetaAPI connection for account ${trade.metaapi_account_id}`);
        return false;
      }

      await metaApi.closeTrade(positionId);

      const pnl = this.calculatePnl(trade, exitPrice);
      await this.tradeRepo.closeTrade(tradeId, exitPrice, pnl.dollars, pnl.percent);

      // Record result for circuit breaker
      const isWin = pnl.dollars >= 0;
      await this.circuitBreaker.recordTradeResult(
        trade.trading_account_id,
        isWin,
        pnl.dollars
      );

      await this.alertManager.alertTradeClosed(
        trade.symbol,
        pnl.dollars,
        isWin ? 'win' : 'loss'
      );

      return true;

    } catch (error) {
      logger.error('Failed to close trade:', error);
      return false;
    }
  }

  private calculatePnl(
    trade: any,
    exitPrice: number
  ): { dollars: number; percent: number } {
    const direction = trade.direction === 'buy' ? 1 : -1;
    const priceDiff = (exitPrice - trade.entry_price) * direction;
    const pipMultiplier = getPipMultiplier(trade.symbol);

    // For forex: pips * $10 per standard lot * lot size
    const pips = priceDiff * pipMultiplier;
    const pipValue = trade.symbol.includes('JPY') ? 100 / exitPrice : 10;
    const dollars = pips * pipValue * trade.quantity;

    // Assume entry margin for percent calculation
    const entryMargin = trade.entry_price * trade.quantity * 100000 / 100; // Rough estimate
    const percent = entryMargin > 0 ? (dollars / entryMargin) * 100 : 0;

    return { dollars, percent };
  }

  getCircuitBreaker(): CircuitBreaker {
    return this.circuitBreaker;
  }
}
