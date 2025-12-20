export type TradeStatus = 'open' | 'closed' | 'pending' | 'cancelled';
export type TradeDirection = 'buy' | 'sell';
export type ExecutionStatus = 'pending' | 'executed' | 'failed' | 'retrying';

export interface Trade {
  id?: string;
  userId: string;
  symbol: string;
  direction: TradeDirection;
  entryPrice: number;
  quantity: number;
  stopLoss?: number;
  takeProfit?: number;
  tradingAccountId: string;
  signalId?: string;
  mtPositionId?: string;
  executionStatus: ExecutionStatus;
  executionAttempts: number;
  lastExecutionError?: string;
  snapshotSettings?: any;
  status: TradeStatus;
  exitPrice?: number;
  pnl?: number;
  pnlPercent?: number;
  openedAt: Date;
  closedAt?: Date;
}

export interface Position {
  id: string;
  symbol: string;
  type: 'POSITION_TYPE_BUY' | 'POSITION_TYPE_SELL';
  volume: number;
  openPrice: number;
  currentPrice: number;
  swap: number;
  profit: number;
  stopLoss?: number;
  takeProfit?: number;
  time: Date;
  comment?: string;
}

export interface AccountInfo {
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  leverage: number;
  currency: string;
}

export interface ExecutionResult {
  success: boolean;
  positionId?: string;
  entryPrice?: number;
  error?: string;
  accountId?: string;
  accountName?: string;
}
