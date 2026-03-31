import type { Candle, Order, PerformanceMetrics, StrategyDNA } from '../../shared/types.js';

export interface BacktestState {
  equity: number;
  cash: number;
  positions: BacktestPosition[];
  orders: Order[];
  equityCurve: Array<{ timestamp: number; equity: number }>;
  trades: CompletedTrade[];
}

export interface BacktestPosition {
  symbol: string;
  side: 'buy' | 'sell';
  entryPrice: number;
  quantity: number;
  entryTime: number;
  stopLoss?: number;
  takeProfit?: number;
  trailingStop?: number;
  entryBar?: number;
  strategy: string;
}

export interface CompletedTrade {
  symbol: string;
  side: 'buy' | 'sell';
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnl: number;
  pnlPct: number;
  entryTime: number;
  exitTime: number;
  strategy: string;
  holdingPeriodMs: number;
}

export interface OptimizationResult {
  bestDna: StrategyDNA;
  bestMetrics: PerformanceMetrics;
  allResults: Array<{ dna: StrategyDNA; metrics: PerformanceMetrics }>;
  totalCombinations: number;
}

export interface WalkForwardWindow {
  trainStart: number;
  trainEnd: number;
  testStart: number;
  testEnd: number;
}
