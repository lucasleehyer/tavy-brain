import { MetaApiManager } from '../websocket/MetaApiManager';
import { TradeRepository } from '../database/TradeRepository';
import { SettingsRepository } from '../database/SettingsRepository';
import { AlertManager } from '../notifications/AlertManager';
import { CircuitBreaker } from '../risk/CircuitBreaker';
import { KellyCalculator } from '../risk/KellyCalculator';
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
  private kellyCalculator: KellyCalculator;
  private config: ExecutionConfig;
  private accountConnections: Map<string, MetaApiManager> = new Map();

  constructor(config: ExecutionConfig) {
    this.tradeRepo = new TradeRepository();
    this.settingsRepo = new SettingsRepository();
    this.alertManager = new AlertManager();
    this.circuitBreaker = new CircuitBreaker();
    this.kellyCalculator = new KellyCalculator();
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

    // ========== KELLY CALCULATOR INTEGRATION ==========
    // Get Kelly-optimal risk first, then apply confidence tier adjustments
    const assetType = isCryptoPair(signal.symbol) ? 'crypto' : 'forex';
    let baseRiskPercent = this.config.defaultRiskPercent;
    
    try {
      const kellyResult = await this.kellyCalculator.calculate(assetType);
      if (kellyResult.recommendedPercent > 0) {
        baseRiskPercent = kellyResult.recommendedPercent;
        logger.info(`[KELLY] Using Kelly-optimal risk: ${baseRiskPercent.toFixed(2)}% (${kellyResult.reason})`);
      } else {
        logger.info(`[KELLY] No edge detected, using default risk: ${baseRiskPercent}%`);
      }
    } catch (error) {
      logger.warn('[KELLY] Failed to calculate Kelly, using default risk:', error);
    }

    // Calculate dynamic risk based on signal confidence and confluence
    const confluenceScore = signal.snapshotSettings?.confluenceScore || 60;
    const dynamicRisk = this.calculateDynamicRisk({
      baseRiskPercent,
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
      signal.entryPrice,
      signal.stopLoss,
      signal.takeProfit1,
      signal.takeProfit2,
      signal.takeProfit3,
      'forex',
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

      // Get max lot size settings from database (cached in settings)
      const settings = await this.settingsRepo.getSettings();
      const maxLotSize = settings?.max_lot_size || 0.5;
      const maxLotSizeGold = settings?.max_lot_size_gold || 0.1;
      const maxConcurrentPositions = settings?.max_concurrent_positions || 3;

      // Check concurrent position limit
      const openTrades = await this.tradeRepo.getOpenTrades();
      const accountOpenTrades = openTrades.filter(t => t.trading_account_id === account.id);
      
      if (accountOpenTrades.length >= maxConcurrentPositions) {
        const errorMsg = `Max concurrent positions reached (${accountOpenTrades.length}/${maxConcurrentPositions})`;
        logger.warn(`Skipping ${account.account_name}: ${errorMsg}`);
        
        await activityLogger.logInfo(`Position limit reached on ${account.account_name}`, {
          openPositions: accountOpenTrades.length,
          maxPositions: maxConcurrentPositions,
          symbol: signal.symbol
        });

        return {
          success: false,
          error: errorMsg,
          accountId: account.id,
          accountName: account.account_name
        };
      }

      // DUPLICATE TRADE PREVENTION: Check if symbol already has open position on broker
      try {
        const brokerPositions = await metaApi.getPositions();
        const normalizedSignalSymbol = signal.symbol.replace(/[.#_\-m]/gi, '').toUpperCase();
        
        const existingPosition = brokerPositions.find((p: any) => {
          const normalizedPosSymbol = (p.symbol || '').replace(/[.#_\-m]/gi, '').toUpperCase();
          return normalizedPosSymbol === normalizedSignalSymbol;
        });

        if (existingPosition) {
          const errorMsg = `Already has open position for ${signal.symbol} (position ${existingPosition.id})`;
          logger.warn(`⚠️ ${account.account_name}: ${errorMsg}`);
          
          await activityLogger.logInfo(`Skipped duplicate trade on ${account.account_name}`, {
            symbol: signal.symbol,
            existingPositionId: existingPosition.id,
            existingDirection: existingPosition.type,
            existingVolume: existingPosition.volume
          });

          return {
            success: false,
            error: errorMsg,
            accountId: account.id,
            accountName: account.account_name
          };
        }
      } catch (posCheckError) {
        logger.warn(`Could not check existing positions on ${account.account_name}:`, posCheckError);
        // Continue with trade - we'll rely on broker rejection if duplicate exists
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

      // CRITICAL: Apply maximum lot size cap
      const isGold = signal.symbol.includes('XAU') || signal.symbol.includes('GOLD');
      const isSilver = signal.symbol.includes('XAG') || signal.symbol.includes('SILVER');
      const effectiveMaxLot = (isGold || isSilver) ? maxLotSizeGold : maxLotSize;
      
      if (lotSize > effectiveMaxLot) {
        logger.warn(`${account.account_name}: Lot size ${lotSize} capped to max ${effectiveMaxLot}`);
        await activityLogger.logInfo(`Lot size capped on ${account.account_name}`, {
          calculatedLot: lotSize,
          maxLot: effectiveMaxLot,
          symbol: signal.symbol,
          isGold: isGold || isSilver
        });
        lotSize = effectiveMaxLot;
      }

      logger.info(`${account.account_name}: Final lot size = ${lotSize} (max: ${effectiveMaxLot})`);

      // Calculate dollar risk for logging
      const dollarRisk = balance * (riskPercent / 100);
      await activityLogger.logInfo(`Trade sizing: ${signal.symbol} ${signal.action}`, {
        accountName: account.account_name,
        balance: balance.toFixed(2),
        riskPercent: riskPercent.toFixed(2),
        dollarRisk: dollarRisk.toFixed(2),
        lotSize: lotSize,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit1
      });

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

      // Send email notification for trade execution
      await this.alertManager.alertTradeExecuted(
        signal.symbol,
        signal.action as 'BUY' | 'SELL',
        signal.confidence,
        result.price || signal.entryPrice,
        lotSize,
        account.account_name,
        account.broker,
        result.positionId,
        signal.stopLoss,
        signal.takeProfit1,
        signal.assetType
      );

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
