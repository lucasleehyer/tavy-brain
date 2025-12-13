import { MetaApiManager } from '../websocket/MetaApiManager';
import { TradeRepository } from '../database/TradeRepository';
import { AlertManager } from '../notifications/AlertManager';
import { logger } from '../../utils/logger';
import { Signal } from '../../types/signal';
import { ExecutionResult } from '../../types/trade';
import { calculateLotSize } from '../../utils/helpers';
import { pipsToPrice, getPipMultiplier } from '../../config/pairs';

interface ExecutionConfig {
  masterAccountId: string;
  userId: string;
  defaultRiskPercent: number;
}

export class ExecutionRouter {
  private metaApi: MetaApiManager;
  private tradeRepo: TradeRepository;
  private alertManager: AlertManager;
  private config: ExecutionConfig;

  constructor(metaApi: MetaApiManager, config: ExecutionConfig) {
    this.metaApi = metaApi;
    this.tradeRepo = new TradeRepository();
    this.alertManager = new AlertManager();
    this.config = config;
  }

  async executeTrade(signal: Signal, accountBalance: number): Promise<ExecutionResult> {
    logger.info(`Executing trade: ${signal.symbol} ${signal.action}`);

    try {
      // Calculate lot size
      const stopLossPips = Math.abs(signal.entryPrice - signal.stopLoss) * getPipMultiplier(signal.symbol);
      const lotSize = calculateLotSize(
        accountBalance,
        this.config.defaultRiskPercent,
        stopLossPips
      );

      logger.info(`Calculated lot size: ${lotSize} (SL: ${stopLossPips.toFixed(1)} pips)`);

      // Execute on MetaAPI
      const result = await this.metaApi.openTrade({
        symbol: signal.symbol,
        direction: signal.action.toLowerCase() as 'buy' | 'sell',
        volume: lotSize,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit1,
        comment: `TAVY-${signal.id?.slice(0, 8) || 'SIGNAL'}`
      });

      // Save trade to database
      const tradeId = await this.tradeRepo.saveTrade({
        userId: this.config.userId,
        symbol: signal.symbol,
        direction: signal.action.toLowerCase() as 'buy' | 'sell',
        entryPrice: result.price || signal.entryPrice,
        quantity: lotSize,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit1,
        tradingAccountId: this.config.masterAccountId,
        signalId: signal.id,
        mtPositionId: result.positionId,
        executionStatus: 'executed',
        executionAttempts: 1,
        snapshotSettings: signal.snapshotSettings,
        status: 'open',
        openedAt: new Date()
      });

      logger.info(`Trade executed successfully: ${result.positionId}`);

      // Send alert
      await this.alertManager.alertSignalFired(
        signal.symbol,
        signal.action,
        signal.confidence
      );

      return {
        success: true,
        positionId: result.positionId,
        entryPrice: result.price,
        accountId: this.config.masterAccountId
      };

    } catch (error) {
      const errorMessage = (error as Error).message;
      logger.error('Trade execution failed:', errorMessage);

      await this.alertManager.alertTradeFailure(signal.symbol, errorMessage);

      return {
        success: false,
        error: errorMessage
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
