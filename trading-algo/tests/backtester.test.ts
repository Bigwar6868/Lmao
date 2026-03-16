import { describe, it, expect } from 'vitest';
import { calculateMetrics } from '../src/team/backtester/metrics.js';
import type { CompletedTrade } from '../src/team/backtester/types.js';

describe('Backtester Metrics', () => {
  it('should return empty metrics for no trades', () => {
    const metrics = calculateMetrics([], [], 10000);
    expect(metrics.totalTrades).toBe(0);
    expect(metrics.winRate).toBe(0);
    expect(metrics.sharpeRatio).toBe(0);
  });

  it('should calculate win rate correctly', () => {
    const trades: CompletedTrade[] = [
      { symbol: 'BTC', side: 'buy', entryPrice: 100, exitPrice: 110, quantity: 1, pnl: 10, pnlPct: 10, entryTime: 0, exitTime: 1000, strategy: 'test', holdingPeriodMs: 1000 },
      { symbol: 'BTC', side: 'buy', entryPrice: 100, exitPrice: 90, quantity: 1, pnl: -10, pnlPct: -10, entryTime: 0, exitTime: 1000, strategy: 'test', holdingPeriodMs: 1000 },
      { symbol: 'BTC', side: 'buy', entryPrice: 100, exitPrice: 120, quantity: 1, pnl: 20, pnlPct: 20, entryTime: 0, exitTime: 1000, strategy: 'test', holdingPeriodMs: 1000 },
    ];
    const equityCurve = [
      { timestamp: 0, equity: 10000 },
      { timestamp: 1000, equity: 10010 },
      { timestamp: 2000, equity: 10000 },
      { timestamp: 3000, equity: 10020 },
    ];

    const metrics = calculateMetrics(trades, equityCurve, 10000);
    expect(metrics.totalTrades).toBe(3);
    expect(metrics.winningTrades).toBe(2);
    expect(metrics.losingTrades).toBe(1);
    expect(metrics.winRate).toBeCloseTo(0.6667, 3);
  });

  it('should calculate profit factor', () => {
    const trades: CompletedTrade[] = [
      { symbol: 'BTC', side: 'buy', entryPrice: 100, exitPrice: 115, quantity: 1, pnl: 15, pnlPct: 15, entryTime: 0, exitTime: 1000, strategy: 'test', holdingPeriodMs: 1000 },
      { symbol: 'BTC', side: 'buy', entryPrice: 100, exitPrice: 90, quantity: 1, pnl: -10, pnlPct: -10, entryTime: 0, exitTime: 1000, strategy: 'test', holdingPeriodMs: 1000 },
    ];
    const equityCurve = [
      { timestamp: 0, equity: 10000 },
      { timestamp: 1000, equity: 10015 },
      { timestamp: 2000, equity: 10005 },
    ];

    const metrics = calculateMetrics(trades, equityCurve, 10000);
    // Profit factor = gross profit / gross loss = 15 / 10 = 1.5
    expect(metrics.profitFactor).toBeCloseTo(1.5, 1);
  });

  it('should detect max drawdown', () => {
    const trades: CompletedTrade[] = [
      { symbol: 'BTC', side: 'buy', entryPrice: 100, exitPrice: 90, quantity: 1, pnl: -10, pnlPct: -10, entryTime: 0, exitTime: 1000, strategy: 'test', holdingPeriodMs: 1000 },
    ];
    const equityCurve = [
      { timestamp: 0, equity: 10000 },
      { timestamp: 1, equity: 12000 },
      { timestamp: 2, equity: 9000 },  // 12000 → 9000 = 25%
      { timestamp: 3, equity: 11000 },
    ];

    const metrics = calculateMetrics(trades, equityCurve, 10000);
    expect(metrics.maxDrawdownPct).toBeCloseTo(25, 0);
  });
});
