// ============================================================
// Core Types for the Trading Algorithm System
// ============================================================

/** Asset class categories */
export type AssetClass = 'crypto' | 'stock' | 'forex';

/** Supported timeframes */
export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d' | '1w';

/** Trade direction */
export type Side = 'buy' | 'sell';

/** Signal action */
export type SignalAction = 'BUY' | 'SELL' | 'HOLD';

/** Order types */
export type OrderType = 'market' | 'limit' | 'stop' | 'stop_limit';

/** Order status */
export type OrderStatus = 'pending' | 'filled' | 'partially_filled' | 'cancelled' | 'rejected';

/** Position status */
export type PositionStatus = 'open' | 'closed';

// ============================================================
// Market Data
// ============================================================

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface AssetInfo {
  symbol: string;
  assetClass: AssetClass;
  exchange?: string;
  baseCurrency?: string;
  quoteCurrency?: string;
}

export interface MarketData {
  asset: AssetInfo;
  timeframe: Timeframe;
  candles: Candle[];
  lastUpdated: number;
}

// ============================================================
// Signals & Strategies
// ============================================================

export interface Signal {
  asset: AssetInfo;
  action: SignalAction;
  confidence: number;       // 0.0 to 1.0
  price: number;
  timestamp: number;
  strategy: string;
  timeframe: Timeframe;
  indicators: Record<string, number>;
  reason: string;
}

export interface StrategyConfig {
  name: string;
  enabled: boolean;
  params: Record<string, number>;
  assetClasses: AssetClass[];
  timeframes: Timeframe[];
}

export interface StrategyResult {
  strategy: string;
  signals: Signal[];
  metadata: Record<string, unknown>;
}

// ============================================================
// Strategy DNA (for self-evolution)
// ============================================================

export interface StrategyDNA {
  id: string;
  name: string;
  generation: number;
  parentId: string | null;
  params: Record<string, number>;
  fitness: number;
  createdAt: number;
  mutations: string[];
}

// ============================================================
// Orders & Positions
// ============================================================

export interface Order {
  id: string;
  asset: AssetInfo;
  side: Side;
  type: OrderType;
  quantity: number;
  price?: number;
  stopPrice?: number;
  status: OrderStatus;
  filledPrice?: number;
  filledQuantity?: number;
  createdAt: number;
  filledAt?: number;
  strategy: string;
  signalId?: string;
}

export interface Position {
  id: string;
  asset: AssetInfo;
  side: Side;
  entryPrice: number;
  currentPrice: number;
  quantity: number;
  stopLoss?: number;
  takeProfit?: number;
  unrealizedPnl: number;
  realizedPnl: number;
  status: PositionStatus;
  openedAt: number;
  closedAt?: number;
  strategy: string;
}

// ============================================================
// Portfolio
// ============================================================

export interface Portfolio {
  capital: number;
  availableCapital: number;
  positions: Position[];
  totalPnl: number;
  totalPnlPct: number;
  maxDrawdown: number;
  lastUpdated: number;
}

// ============================================================
// Performance Metrics
// ============================================================

export interface PerformanceMetrics {
  totalReturn: number;
  totalReturnPct: number;
  sharpeRatio: number;
  sortinoRatio: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  winRate: number;
  profitFactor: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  avgWin: number;
  avgLoss: number;
  avgHoldingPeriod: number;
  calmarRatio: number;
}

// ============================================================
// Backtest
// ============================================================

export interface BacktestConfig {
  strategy: StrategyConfig;
  asset: AssetInfo;
  timeframe: Timeframe;
  startDate: number;
  endDate: number;
  initialCapital: number;
  commission: number;
  slippage: number;
}

export interface BacktestResult {
  config: BacktestConfig;
  metrics: PerformanceMetrics;
  trades: Order[];
  equityCurve: Array<{ timestamp: number; equity: number }>;
  dna: StrategyDNA;
}

// ============================================================
// Macro & Sentiment
// ============================================================

export interface MacroIndicator {
  name: string;
  value: number;
  previousValue: number;
  date: string;
  source: string;
  impact: 'high' | 'medium' | 'low';
}

export interface SentimentScore {
  asset: string;
  score: number;        // -1.0 (bearish) to 1.0 (bullish)
  volume: number;       // Number of data points
  source: string;
  timestamp: number;
}

export interface MacroEnvironment {
  indicators: MacroIndicator[];
  sentiment: SentimentScore[];
  riskLevel: 'low' | 'medium' | 'high' | 'extreme';
  bias: 'bullish' | 'bearish' | 'neutral';
  timestamp: number;
}

// ============================================================
// Events
// ============================================================

export type EventType =
  | 'market:data'
  | 'market:update'
  | 'signal:generated'
  | 'order:created'
  | 'order:filled'
  | 'order:cancelled'
  | 'position:opened'
  | 'position:closed'
  | 'macro:update'
  | 'sentiment:update'
  | 'evolution:cycle'
  | 'evolution:improvement'
  | 'risk:alert'
  | 'system:error';

export interface TradingEvent<T = unknown> {
  type: EventType;
  data: T;
  timestamp: number;
  source: string;
}

// ============================================================
// Risk
// ============================================================

export interface RiskAssessment {
  maxPositionSize: number;
  recommendedSize: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  riskRewardRatio: number;
  kellyFraction: number;
  approved: boolean;
  reason: string;
}

// ============================================================
// Strategy Interface (all strategies must implement)
// ============================================================

export interface Strategy {
  name: string;
  config: StrategyConfig;
  dna: StrategyDNA;
  analyze(data: MarketData, macro?: MacroEnvironment): Promise<Signal[]>;
  getDefaultDNA(): StrategyDNA;
}
