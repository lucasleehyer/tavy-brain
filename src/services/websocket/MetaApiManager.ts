import MetaApi from 'metaapi.cloud-sdk';
import { EventEmitter } from 'events';
import { logger } from '../../utils/logger';
import { PriceCache } from './PriceCache';
import { CandleBuilder } from './CandleBuilder';
import { Tick, Candle, AccountInfo, Position } from '../../types';
import { config } from '../../config';
import { delay } from '../../utils/helpers';

export class MetaApiManager extends EventEmitter {
  private api: MetaApi;
  private connection: any;
  private account: any;
  private accountId: string;
  private isConnected: boolean = false;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private priceCache: PriceCache;
  private candleBuilder: CandleBuilder;
  private subscribedSymbols: string[] = [];

  constructor(accountId?: string) {
    super();
    this.accountId = accountId || config.metaapi.accountId;
    this.api = new MetaApi(config.metaapi.token);
    this.priceCache = new PriceCache();
    this.candleBuilder = new CandleBuilder();
  }

  async connect(): Promise<void> {
    try {
      logger.info(`Connecting to MetaAPI account ${this.accountId.slice(0, 8)}...`);

      this.account = await this.api.metatraderAccountApi
        .getAccount(this.accountId);

      // Wait for account to be deployed
      logger.info('Waiting for account to be deployed...');
      await this.account.waitDeployed();

      // Create streaming connection
      this.connection = this.account.getStreamingConnection();

      // Set up event handlers before connecting
      this.setupEventHandlers();

      // Connect
      await this.connection.connect();

      // Wait for synchronization
      logger.info('Waiting for synchronization...');
      await this.connection.waitSynchronized();

      this.isConnected = true;
      this.reconnectAttempts = 0;

      logger.info('✅ MetaAPI connected and synchronized');
      this.emit('connected');

    } catch (error) {
      logger.error('MetaAPI connection error:', error);
      await this.handleReconnect();
    }
  }

  private setupEventHandlers(): void {
    let tickCount = 0;
    const logInterval = 100; // Log every 100 ticks to reduce verbosity

    this.connection.addSynchronizationListener({
      // Handle batch price updates (plural - primary method used by MetaAPI SDK)
      onSymbolPricesUpdated: (instanceIndex: string, prices: any[]) => {
        for (const price of prices) {
          const tick: Tick = {
            symbol: price.symbol,
            bid: price.bid,
            ask: price.ask,
            time: new Date(price.time),
            spread: price.ask - price.bid
          };

          this.priceCache.update(tick);
          this.candleBuilder.addTick(tick);
          this.emit('tick', tick);
          
          tickCount++;
          if (tickCount % logInterval === 0) {
            logger.debug(`Processed ${tickCount} ticks, latest: ${price.symbol} ${price.bid}/${price.ask}`);
          }
        }
      },

      // Handle single price updates (singular - fallback)
      onSymbolPriceUpdated: (instanceIndex: string, price: any) => {
        const tick: Tick = {
          symbol: price.symbol,
          bid: price.bid,
          ask: price.ask,
          time: new Date(price.time),
          spread: price.ask - price.bid
        };

        this.priceCache.update(tick);
        this.candleBuilder.addTick(tick);
        this.emit('tick', tick);
      },

      onConnected: (instanceIndex: string) => {
        logger.info(`MetaAPI instance ${instanceIndex} connected`);
        this.isConnected = true;
        this.emit('connected');
      },

      onDisconnected: (instanceIndex: string) => {
        logger.warn(`MetaAPI instance ${instanceIndex} disconnected`);
        this.isConnected = false;
        this.emit('disconnected');
        this.handleReconnect();
      },

      onError: (instanceIndex: string, error: any) => {
        logger.error(`MetaAPI error on instance ${instanceIndex}:`, error);
        this.emit('error', error);
      },

      onPositionUpdated: (instanceIndex: string, position: any) => {
        this.emit('positionUpdated', position);
      },

      onPositionRemoved: (instanceIndex: string, positionId: string) => {
        this.emit('positionClosed', positionId);
      },

      // Required MetaAPI SDK callbacks
      onBrokerConnectionStatusChanged: (instanceIndex: string, connected: boolean) => {
        logger.info(`Broker connection status changed: ${connected ? 'connected' : 'disconnected'}`);
      },

      onHealthStatus: (instanceIndex: string, status: any) => {
        logger.debug(`Health status update received`);
      },

      // Stub handlers to prevent TypeError for SDK-expected callbacks
      onSynchronizationStarted: () => {},
      onAccountInformationUpdated: () => {},
      onSymbolSpecificationUpdated: () => {},
      onSymbolSpecificationsUpdated: (instanceIndex: string, specifications: any[]) => {
        logger.info(`📋 Received ${specifications?.length || 0} symbol specifications from broker`);
      },
      onDealAdded: () => {},
      onDealSynchronizationFinished: () => {},
      onOrderAdded: () => {},
      onOrderUpdated: () => {},
      onOrderRemoved: () => {},
      onOrderSynchronizationFinished: () => {},
      onPositionsSynchronized: () => {},
      onPendingOrdersSynchronized: () => {},
    });
  }

  /**
   * Wait for broker to send symbol specifications (up to maxWaitMs)
   * Returns the number of specifications received
   */
  async waitForSpecifications(maxWaitMs: number = 30000): Promise<number> {
    const startTime = Date.now();
    logger.info(`⏳ Waiting for symbol specifications (max ${maxWaitMs / 1000}s)...`);
    
    while (Date.now() - startTime < maxWaitMs) {
      const specs = this.getAvailableSymbols();
      if (specs.length > 0) {
        const elapsed = Date.now() - startTime;
        logger.info(`✅ Received ${specs.length} symbol specifications after ${elapsed}ms`);
        return specs.length;
      }
      await delay(1000);
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      if (elapsed % 5 === 0 && elapsed > 0) {
        logger.info(`Still waiting for specifications... ${elapsed}s`);
      }
    }
    
    logger.warn(`⚠️ Timed out waiting for specifications after ${maxWaitMs}ms`);
    return 0;
  }

  async subscribeToSymbols(symbols: string[]): Promise<void> {
    this.subscribedSymbols = symbols;

    for (const symbol of symbols) {
      try {
        await this.connection.subscribeToMarketData(symbol, [
          { type: 'quotes' }
        ]);
        logger.info(`Subscribed to ${symbol}`);
        await delay(100); // Small delay to avoid rate limiting
      } catch (error) {
        logger.error(`Failed to subscribe to ${symbol}:`, error);
      }
    }

    logger.info(`Subscribed to ${symbols.length} symbols`);
  }

  private async handleReconnect(): Promise<void> {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Max reconnection attempts reached');
      this.emit('maxReconnectAttemptsReached');
      return;
    }

    this.reconnectAttempts++;
    const delayMs = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);

    logger.info(`Reconnecting in ${delayMs}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    await delay(delayMs);
    await this.connect();
  }

  async openTrade(params: {
    symbol: string;
    direction: 'buy' | 'sell';
    volume: number;
    stopLoss?: number;
    takeProfit?: number;
    comment?: string;
  }): Promise<{ positionId: string; price: number }> {
    try {
      const method = params.direction === 'buy'
        ? 'createMarketBuyOrder'
        : 'createMarketSellOrder';

      const result = await this.connection[method](
        params.symbol,
        params.volume,
        params.stopLoss,
        params.takeProfit,
        {
          comment: params.comment || 'TAVY Signal'
        }
      );

      logger.info(`Trade opened: ${params.symbol} ${params.direction} ${params.volume} lots @ ${result.price || 'market'}`);

      return {
        positionId: result.positionId,
        price: result.price || 0
      };

    } catch (error) {
      logger.error('Failed to open trade:', error);
      throw error;
    }
  }

  async closeTrade(positionId: string): Promise<void> {
    try {
      await this.connection.closePosition(positionId);
      logger.info(`Trade closed: ${positionId}`);
    } catch (error) {
      logger.error('Failed to close trade:', error);
      throw error;
    }
  }

  async getPositions(): Promise<Position[]> {
    return this.connection.terminalState.positions || [];
  }

  async getAccountInfo(): Promise<AccountInfo> {
    const info = this.connection.terminalState.accountInformation;
    return {
      balance: info.balance,
      equity: info.equity,
      margin: info.margin,
      freeMargin: info.freeMargin,
      leverage: info.leverage,
      currency: info.currency
    };
  }

  getPrice(symbol: string): Tick | null {
    return this.priceCache.get(symbol);
  }

  getAllPrices(): Map<string, Tick> {
    return this.priceCache.getAll();
  }

  getCandles(symbol: string, timeframe: string, count: number): Candle[] {
    return this.candleBuilder.getCandles(symbol, timeframe, count);
  }

  isReady(): boolean {
    return this.isConnected;
  }

  getSubscribedSymbols(): string[] {
    return this.subscribedSymbols;
  }

  /**
   * Get all available symbols from the broker's terminal state
   * This reads from terminalState.specifications after synchronization
   */
  getAvailableSymbols(): string[] {
    const specifications = this.connection?.terminalState?.specifications || [];
    return specifications.map((spec: any) => spec.symbol);
  }

  /**
   * Get full symbol specifications with details like pip size, trade mode, etc.
   */
  getSymbolSpecifications(): any[] {
    return this.connection?.terminalState?.specifications || [];
  }

  /**
   * Get symbols filtered by type using symbol naming patterns
   * Enhanced to work with brokers like FBS that may not populate spec.path
   */
  getSymbolsByType(): {
    forex: string[];
    crypto: string[];
    indices: string[];
    commodities: string[];
    stocks: string[];
    other: string[];
  } {
    const specs = this.getSymbolSpecifications();
    
    const result = {
      forex: [] as string[],
      crypto: [] as string[],
      indices: [] as string[],
      commodities: [] as string[],
      stocks: [] as string[],
      other: [] as string[]
    };

    // Common currency codes for forex detection
    const forexCurrencies = ['EUR', 'USD', 'GBP', 'JPY', 'CHF', 'AUD', 'NZD', 'CAD', 'SEK', 'NOK', 'DKK', 'SGD', 'HKD', 'ZAR', 'MXN', 'TRY', 'PLN', 'HUF', 'CZK'];
    
    // Crypto symbols
    const cryptoSymbols = ['BTC', 'ETH', 'LTC', 'XRP', 'BCH', 'EOS', 'XLM', 'ADA', 'DOT', 'LINK', 'UNI', 'DOGE', 'SOL', 'AVAX', 'MATIC', 'SHIB', 'ATOM', 'FTM', 'NEAR', 'APE'];
    
    // Index symbols
    const indexPatterns = ['US30', 'US500', 'US100', 'NAS100', 'SPX', 'NDX', 'DJI', 'DAX', 'FTSE', 'CAC', 'STOXX', 'NIKKEI', 'N225', 'HSI', 'ASX', 'UK100', 'DE30', 'DE40', 'FR40', 'JP225', 'AU200', 'ES35', 'EU50'];
    
    // Commodity symbols
    const commodityPatterns = ['XAU', 'XAG', 'GOLD', 'SILVER', 'OIL', 'WTI', 'BRENT', 'USOIL', 'UKOIL', 'NGAS', 'COPPER', 'PLAT', 'PALL'];

    for (const spec of specs) {
      const symbol = spec.symbol.toUpperCase();
      const path = (spec.path || '').toLowerCase();
      
      // 1. First check path if available (most reliable)
      if (path.includes('forex') || path.includes('currencies') || path.includes('majors') || path.includes('minors') || path.includes('exotics')) {
        result.forex.push(spec.symbol);
        continue;
      }
      
      if (path.includes('crypto') || path.includes('coin')) {
        result.crypto.push(spec.symbol);
        continue;
      }
      
      if (path.includes('indices') || path.includes('index')) {
        result.indices.push(spec.symbol);
        continue;
      }
      
      if (path.includes('commodities') || path.includes('metals') || path.includes('energies') || path.includes('energy')) {
        result.commodities.push(spec.symbol);
        continue;
      }
      
      if (path.includes('stocks') || path.includes('shares') || path.includes('equities')) {
        result.stocks.push(spec.symbol);
        continue;
      }
      
      // 2. Fallback to symbol name pattern matching
      // Check for forex pairs (6 chars like EURUSD, or with suffix like EURUSDm)
      const baseSymbol = symbol.replace(/[.#_\-m]/gi, ''); // Remove common suffixes
      const isForex = forexCurrencies.some(c1 => 
        forexCurrencies.some(c2 => 
          c1 !== c2 && (baseSymbol.startsWith(c1 + c2) || baseSymbol === c1 + c2)
        )
      );
      
      if (isForex) {
        result.forex.push(spec.symbol);
        continue;
      }
      
      // Check for crypto
      const isCrypto = cryptoSymbols.some(c => symbol.includes(c));
      if (isCrypto) {
        result.crypto.push(spec.symbol);
        continue;
      }
      
      // Check for indices
      const isIndex = indexPatterns.some(p => symbol.includes(p));
      if (isIndex) {
        result.indices.push(spec.symbol);
        continue;
      }
      
      // Check for commodities
      const isCommodity = commodityPatterns.some(p => symbol.includes(p));
      if (isCommodity) {
        result.commodities.push(spec.symbol);
        continue;
      }
      
      // Everything else goes to other
      result.other.push(spec.symbol);
    }

    return result;
  }

  async disconnect(): Promise<void> {
    if (this.connection) {
      try {
        await this.connection.close();
      } catch (error) {
        logger.warn('Error closing connection:', error);
      }
    }
    this.isConnected = false;
    logger.info('MetaAPI disconnected');
  }
}
