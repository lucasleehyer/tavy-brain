import { MetaApiManager } from '../websocket/MetaApiManager';
import { TradeRepository } from '../database/TradeRepository';
import { SettingsRepository } from '../database/SettingsRepository';
import { AlertManager } from '../notifications/AlertManager';
import { logger } from '../../utils/logger';
import { Signal } from '../../types/signal';
import { ExecutionResult } from '../../types/trade';
import { calculateLotSize } from '../../utils/helpers';
import { pipsToPrice, getPipMultiplier } from '../../config/pairs';

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

export class ExecutionRouter {
  private tradeRepo: TradeRepository;
  private settingsRepo: SettingsRepository;
  private alertManager: AlertManager;
  private config: ExecutionConfig;
  private accountConnections: Map<string, MetaApiManager> = new Map();

  constructor(config: ExecutionConfig) {
    this.tradeRepo = new TradeRepository();
    this.settingsRepo = new SettingsRepository();
    this.alertManager = new AlertManager();
    this.config = config;
  }

  updateRiskPercent(riskPercent: number): void {
    this.config.defaultRiskPercent = riskPercent;
    logger.info(`ExecutionRouter risk percent updated to ${riskPercent}%`);
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

    const results: ExecutionResult[] = [];

    // Execute on each account
    for (const account of accounts) {
      const result = await this.executeOnAccount(signal, account);
      results.push(result);
    }

    // Send summary alert
    const successCount = results.filter(r => r.success).length;
    await this.alertManager.alertSignalFired(
      signal.symbol,
      signal.action,
      signal.confidence,
      `Executed on ${successCount}/${accounts.length} accounts`
    );

    return results;
  }

  private async executeOnAccount(signal: Signal, account: TradingAccount): Promise<ExecutionResult> {
    logger.info(`Executing on ${account.account_name} (${account.broker})...`);

    try {
      // Get or create MetaAPI connection for this account
      let metaApi = this.accountConnections.get(account.metaapi_account_id);
      
      if (!metaApi || !metaApi.isReady()) {
        metaApi = new MetaApiManager(account.metaapi_account_id);
        await metaApi.connect();
        this.accountConnections.set(account.metaapi_account_id, metaApi);
      }

      // Get account balance
      const accountInfo = await metaApi.getAccountInfo();
      const balance = accountInfo.balance;

      // Check minimum balance
      if (balance < account.minimum_balance) {
        logger.warn(`Skipping ${account.account_name}: balance $${balance} below minimum $${account.minimum_balance}`);
        return {
          success: false,
          error: `Balance $${balance} below minimum $${account.minimum_balance}`,
          accountId: account.id,
          accountName: account.account_name
        };
      }

      // Calculate lot size for this account
      const stopLossPips = Math.abs(signal.entryPrice - signal.stopLoss) * getPipMultiplier(signal.symbol);
      const lotSize = calculateLotSize(
        balance,
        this.config.defaultRiskPercent,
        stopLossPips
      );

      logger.info(`${account.account_name}: Balance $${balance}, Lot size: ${lotSize}`);

      // Execute trade
      const result = await metaApi.openTrade({
        symbol: signal.symbol,
        direction: signal.action.toLowerCase() as 'buy' | 'sell',
        volume: lotSize,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit1,
        comment: `TAVY-${signal.id?.slice(0, 8) || 'SIGNAL'}`
      });

      // Save trade to database
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
        snapshotSettings: signal.snapshotSettings,
        status: 'open',
        openedAt: new Date()
      });

      logger.info(`✅ ${account.account_name}: Trade executed - ${result.positionId}`);

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

  async closeTrade(positionId: string, tradeId: string, exitPrice: number): Promise<boolean> {
    try {
      await this.metaApi.closeTrade(positionId);

      // Get trade details for P&L calculation
      const trade = await this.tradeRepo.getTradeByMtPositionId(positionId);
      if (trade) {
        const pnl = this.calculatePnl(trade, exitPrice);
        await this.tradeRepo.closeTrade(tradeId, exitPrice, pnl.dollars, pnl.percent);

        await this.alertManager.alertTradeClosed(
          trade.symbol,
          pnl.dollars,
          pnl.dollars >= 0 ? 'win' : 'loss'
        );
      }

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
}
