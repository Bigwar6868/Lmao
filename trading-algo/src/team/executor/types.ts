import type { Order, Position, Portfolio } from '../../shared/types.js';

export interface ExecutorConfig {
  mode: 'paper' | 'live';
  initialCapital: number;
  maxOpenPositions: number;
  defaultSlippage: number;
  defaultCommission: number;
}

export interface TradeExecution {
  order: Order;
  position?: Position;
  portfolio: Portfolio;
  success: boolean;
  error?: string;
}
