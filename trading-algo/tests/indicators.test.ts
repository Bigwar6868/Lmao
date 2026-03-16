import { describe, it, expect } from 'vitest';
import type { Candle } from '../src/shared/types.js';

// Helper to create test candles
function makeCandles(closes: number[], volume = 1000): Candle[] {
  return closes.map((close, i) => ({
    timestamp: Date.now() - (closes.length - i) * 3600000,
    open: close * 0.999,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume,
  }));
}

describe('Indicator Math', () => {
  it('SMA calculation', () => {
    const values = [10, 20, 30, 40, 50];
    const period = 3;
    // SMA(3) of [10,20,30,40,50] = [20, 30, 40] (last 3 windows)
    const sma = [];
    for (let i = period - 1; i < values.length; i++) {
      const sum = values.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
      sma.push(sum / period);
    }
    expect(sma).toEqual([20, 30, 40]);
  });

  it('EMA calculation converges', () => {
    // EMA with period 10 on constant values should equal that value
    const constant = 50;
    const values = Array(20).fill(constant);
    const period = 10;
    const multiplier = 2 / (period + 1);
    let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < values.length; i++) {
      ema = (values[i] - ema) * multiplier + ema;
    }
    expect(ema).toBeCloseTo(constant, 10);
  });

  it('RSI should be between 0 and 100', () => {
    // Simple RSI check — on uptrending data, RSI should be > 50
    const uptrend = Array.from({ length: 30 }, (_, i) => 100 + i * 2);
    const gains: number[] = [];
    const losses: number[] = [];
    for (let i = 1; i < uptrend.length; i++) {
      const change = uptrend[i] - uptrend[i - 1];
      if (change > 0) {
        gains.push(change);
        losses.push(0);
      } else {
        gains.push(0);
        losses.push(Math.abs(change));
      }
    }
    const period = 14;
    let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
    let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
    const rs = avgGain / (avgLoss || 0.0001);
    const rsi = 100 - (100 / (1 + rs));
    expect(rsi).toBeGreaterThan(50);
    expect(rsi).toBeLessThanOrEqual(100);
  });

  it('Bollinger Bands widen with volatility', () => {
    const stableData = Array(20).fill(100);
    const volatileData = [90, 110, 85, 115, 80, 120, 75, 125, 70, 130, 90, 110, 85, 115, 80, 120, 75, 125, 70, 130];

    const calcBandwidth = (data: number[]) => {
      const period = 20;
      const mean = data.reduce((a, b) => a + b, 0) / period;
      const variance = data.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
      const sd = Math.sqrt(variance);
      return sd * 2 * 2 / mean; // bandwidth = 2*stddev*2 / middle
    };

    const stableBw = calcBandwidth(stableData);
    const volatileBw = calcBandwidth(volatileData);

    expect(volatileBw).toBeGreaterThan(stableBw);
  });
});

describe('Performance Metrics', () => {
  it('Sharpe ratio should be positive for profitable strategy', () => {
    // Simulate daily returns of a profitable strategy
    const dailyReturns = Array.from({ length: 252 }, () => 0.001 + Math.random() * 0.002);
    const avgReturn = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
    const variance = dailyReturns.reduce((a, b) => a + (b - avgReturn) ** 2, 0) / (dailyReturns.length - 1);
    const stdDev = Math.sqrt(variance);
    const dailyRiskFree = 0.04 / 252;
    const sharpe = ((avgReturn - dailyRiskFree) / stdDev) * Math.sqrt(252);
    expect(sharpe).toBeGreaterThan(0);
  });

  it('Max drawdown calculation', () => {
    const equityCurve = [
      { timestamp: 0, equity: 10000 },
      { timestamp: 1, equity: 11000 },
      { timestamp: 2, equity: 10500 },
      { timestamp: 3, equity: 9000 },  // Max drawdown: 11000 → 9000 = 18.18%
      { timestamp: 4, equity: 9500 },
      { timestamp: 5, equity: 12000 },
    ];

    let peak = equityCurve[0].equity;
    let maxDd = 0;
    for (const { equity } of equityCurve) {
      if (equity > peak) peak = equity;
      const dd = ((peak - equity) / peak) * 100;
      if (dd > maxDd) maxDd = dd;
    }

    expect(maxDd).toBeCloseTo(18.18, 1);
  });
});

describe('Kelly Criterion', () => {
  it('should return positive fraction for edge', () => {
    const winRate = 0.55;
    const avgWin = 100;
    const avgLoss = 80;
    const b = avgWin / avgLoss;
    const kelly = (winRate * b - (1 - winRate)) / b;
    expect(kelly).toBeGreaterThan(0);
    expect(kelly).toBeLessThan(1);
  });

  it('should return 0 for no edge', () => {
    const winRate = 0.4;
    const avgWin = 80;
    const avgLoss = 100;
    const b = avgWin / avgLoss;
    const kelly = (winRate * b - (1 - winRate)) / b;
    expect(kelly).toBeLessThanOrEqual(0);
  });
});
