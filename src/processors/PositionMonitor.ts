import { MetaApiManager } from '../services/websocket/MetaApiManager';
import { TradeRepository } from '../services/database/TradeRepository';
import { SignalRepository } from '../services/database/SignalRepository';
import { AlertManager } from '../services/notifications/AlertManager';
import { logger } from '../utils/logger';
import { Position } from '../types/trade';

export class PositionMonitor {
  private metaApi: MetaApiManager;
  private tradeRepo: TradeRepository;
  private signalRepo: SignalRepository;
  private alertManager: AlertManager;
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;

  private readonly CHECK_INTERVAL = 10000; // 10 seconds

  constructor(metaApi: MetaApiManager) {
    this.metaApi = metaApi;
    this.tradeRepo = new TradeRepository();
    this.signalRepo = new SignalRepository();
    this.alertManager = new AlertManager();
  }

  start(): void {
    if (this.isRunning) return;

    this.isRunning = true;
    this.intervalId = setInterval(() => this.checkPositions(), this.CHECK_INTERVAL);
    logger.info('Position monitor started');
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    logger.info('Position monitor stopped');
  }

  private async checkPositions(): Promise<void> {
    if (!this.metaApi.isReady()) {
      logger.warn('MetaAPI not ready, skipping position check');
      return;
    }

    try {
      // Get open positions from MetaAPI
      const positions = await this.metaApi.getPositions();

      // Get open trades from database
      const dbTrades = await this.tradeRepo.getOpenTrades();

      // Check for closed positions (in DB but not in MetaAPI)
      for (const trade of dbTrades) {
        if (!trade.mt_position_id) continue;

        const mtPosition = positions.find(
          (p: Position) => p.id === trade.mt_position_id
        );

        if (!mtPosition) {
          // Position was closed on MT5
          logger.info(`Position ${trade.mt_position_id} closed on MT5`);

          // Get the current price for this symbol to estimate exit
          const price = this.metaApi.getPrice(trade.symbol);
          const exitPrice = price
            ? (trade.direction === 'buy' ? price.bid : price.ask)
            : trade.entry_price;

          // Calculate P&L
          const pnl = this.calculatePnl(trade, exitPrice);

          // Update database
          await this.tradeRepo.closeTrade(
            trade.id,
            exitPrice,
            pnl.dollars,
            pnl.percent
          );

          // Resolve signal
          if (trade.signal_id) {
            await this.signalRepo.resolveSignal(
              trade.signal_id,
              pnl.dollars >= 0 ? 'win' : 'loss',
              pnl.percent
            );
          }

          // Calculate hold duration
          const openedAt = new Date(trade.opened_at);
          const holdDurationMinutes = (Date.now() - openedAt.getTime()) / (1000 * 60);

          // Calculate pips
          const pipMultiplier = trade.symbol.includes('JPY') ? 100 : 10000;
          const direction = trade.direction === 'buy' ? 1 : -1;
          const pnlPips = (exitPrice - trade.entry_price) * direction * pipMultiplier;

          // Alert with full details
          await this.alertManager.alertTradeClosed(
            trade.symbol,
            pnl.dollars,
            pnl.dollars >= 0 ? 'win' : 'loss',
            trade.direction?.toUpperCase() as 'BUY' | 'SELL',
            trade.entry_price,
            exitPrice,
            trade.quantity,
            trade.account_name || undefined,
            holdDurationMinutes,
            pnlPips,
            trade.asset_type || 'forex'
          );
        }
      }

      // Check SL/TP for open positions
      for (const position of positions) {
        await this.checkSlTp(position);
      }

    } catch (error) {
      logger.error('Error checking positions:', error);
    }
  }

  private async checkSlTp(position: Position): Promise<void> {
    const trade = await this.tradeRepo.getTradeByMtPositionId(position.id);
    if (!trade) return;

    const price = this.metaApi.getPrice(position.symbol);
    if (!price) return;

    const currentPrice = position.type === 'POSITION_TYPE_BUY' ? price.bid : price.ask;

    // Check stop loss
    if (trade.stop_loss) {
      const slHit = position.type === 'POSITION_TYPE_BUY'
        ? currentPrice <= trade.stop_loss
        : currentPrice >= trade.stop_loss;

      if (slHit) {
        logger.info(`SL hit for ${position.symbol} @ ${currentPrice}`);
        await this.closePosition(position, trade, trade.stop_loss);
        return;
      }
    }

    // Check take profit
    if (trade.take_profit) {
      const tpHit = position.type === 'POSITION_TYPE_BUY'
        ? currentPrice >= trade.take_profit
        : currentPrice <= trade.take_profit;

      if (tpHit) {
        logger.info(`TP hit for ${position.symbol} @ ${currentPrice}`);
        await this.closePosition(position, trade, trade.take_profit);
        return;
      }
    }
  }

  private async closePosition(
    position: Position,
    trade: any,
    exitPrice: number
  ): Promise<void> {
    try {
      await this.metaApi.closeTrade(position.id);

      const pnl = this.calculatePnl(trade, exitPrice);

      await this.tradeRepo.closeTrade(trade.id, exitPrice, pnl.dollars, pnl.percent);

      if (trade.signal_id) {
        await this.signalRepo.resolveSignal(
          trade.signal_id,
          pnl.dollars >= 0 ? 'win' : 'loss',
          pnl.percent
        );
      }

      // Calculate hold duration
      const openedAt = new Date(trade.opened_at);
      const holdDurationMinutes = (Date.now() - openedAt.getTime()) / (1000 * 60);

      // Calculate pips
      const pipMultiplier = trade.symbol.includes('JPY') ? 100 : 10000;
      const direction = trade.direction === 'buy' ? 1 : -1;
      const pnlPips = (exitPrice - trade.entry_price) * direction * pipMultiplier;

      await this.alertManager.alertTradeClosed(
        trade.symbol,
        pnl.dollars,
        pnl.dollars >= 0 ? 'win' : 'loss',
        trade.direction?.toUpperCase() as 'BUY' | 'SELL',
        trade.entry_price,
        exitPrice,
        trade.quantity,
        trade.account_name || undefined,
        holdDurationMinutes,
        pnlPips,
        trade.asset_type || 'forex'
      );

    } catch (error) {
      logger.error(`Failed to close position ${position.id}:`, error);
    }
  }

  private calculatePnl(
    trade: any,
    exitPrice: number
  ): { dollars: number; percent: number } {
    const direction = trade.direction === 'buy' ? 1 : -1;
    const priceDiff = (exitPrice - trade.entry_price) * direction;

    // Simplified P&L calculation
    const pipMultiplier = trade.symbol.includes('JPY') ? 100 : 10000;
    const pips = priceDiff * pipMultiplier;
    const pipValue = trade.symbol.includes('JPY') ? 100 / exitPrice : 10;
    const dollars = pips * pipValue * trade.quantity;

    const entryValue = trade.entry_price * trade.quantity * 100000;
    const percent = entryValue > 0 ? (dollars / entryValue) * 100 * 100 : 0;

    return { dollars, percent };
  }

  getPositionCount(): number {
    return this.metaApi.isReady() ? 0 : -1; // Would need to track this properly
  }
}
