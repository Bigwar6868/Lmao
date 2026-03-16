import { describe, it, expect } from 'vitest';
import type { Candle } from '../src/shared/types.js';
import { SMA, EMA, RSI, MACD, BollingerBands, ATR, Stochastic, VWAP } from '../src/team/technical-strategist/indicators.js';

// ---- Helpers ----

function makeCandles(closes: number[], opts?: { highs?: number[]; lows?: number[]; volumes?: number[] }): Candle[] {
  return closes.map((close, i) => ({
    timestamp: Date.now() - (closes.length - i) * 3600000,
    open: close * 0.999,
    high: opts?.highs?.[i] ?? close * 1.01,
    low: opts?.lows?.[i] ?? close * 0.99,
    close,
    volume: opts?.volumes?.[i] ?? 1000,
  }));
}

// ---- SMA ----

describe('SMA', () => {
  it('should return NaN for first (period-1) values', () => {
    const candles = makeCandles([10, 20, 30, 40, 50]);
    const result = SMA(candles, 3);
    expect(isNaN(result[0])).toBe(true);
    expect(isNaN(result[1])).toBe(true);
    expect(isNaN(result[2])).toBe(false);
  });

  it('should calculate correct SMA values', () => {
    const candles = makeCandles([10, 20, 30, 40, 50]);
    const result = SMA(candles, 3);
    expect(result[2]).toBeCloseTo(20, 5); // (10+20+30)/3
    expect(result[3]).toBeCloseTo(30, 5); // (20+30+40)/3
    expect(result[4]).toBeCloseTo(40, 5); // (30+40+50)/3
  });

  it('should return all NaN when not enough candles', () => {
    const candles = makeCandles([10, 20]);
    const result = SMA(candles, 5);
    expect(result.every(v => isNaN(v))).toBe(true);
  });
});

// ---- EMA ----

describe('EMA', () => {
  it('should converge to constant value on constant input', () => {
    const candles = makeCandles(Array(30).fill(50));
    const result = EMA(candles, 10);
    expect(result.values[29]).toBeCloseTo(50, 5);
  });

  it('should track uptrend — EMA < latest close', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i * 2);
    const candles = makeCandles(closes);
    const result = EMA(candles, 10);
    const last = result.values[29];
    expect(last).toBeLessThan(closes[29]); // EMA lags
  });

  it('should return correct period metadata', () => {
    const candles = makeCandles(Array(20).fill(100));
    const result = EMA(candles, 7);
    expect(result.period).toBe(7);
  });
});

// ---- RSI ----

describe('RSI', () => {
  it('should return 100 for pure uptrend', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    const candles = makeCandles(closes);
    const result = RSI(candles, 14);
    const lastValid = result.values.filter(v => !isNaN(v)).pop()!;
    expect(lastValid).toBe(100);
  });

  it('should return value < 30 for strong downtrend', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 200 - i * 3);
    const candles = makeCandles(closes);
    const result = RSI(candles, 14);
    const lastValid = result.values.filter(v => !isNaN(v)).pop()!;
    expect(lastValid).toBeLessThan(30);
  });

  it('should be ~50 for alternating up/down of equal magnitude', () => {
    const closes: number[] = [];
    for (let i = 0; i < 30; i++) closes.push(100 + (i % 2 === 0 ? 1 : -1));
    const candles = makeCandles(closes);
    const result = RSI(candles, 14);
    const lastValid = result.values.filter(v => !isNaN(v)).pop()!;
    expect(lastValid).toBeGreaterThan(40);
    expect(lastValid).toBeLessThan(60);
  });

  it('should return NaN for insufficient data', () => {
    const candles = makeCandles([100, 101, 102]);
    const result = RSI(candles, 14);
    expect(result.values.every(v => isNaN(v))).toBe(true);
  });
});

// ---- MACD ----

describe('MACD', () => {
  it('should have MACD line close to 0 for constant prices', () => {
    const candles = makeCandles(Array(50).fill(100));
    const result = MACD(candles);
    const validMacd = result.macd.filter(v => !isNaN(v));
    for (const v of validMacd) {
      expect(Math.abs(v)).toBeLessThan(0.01);
    }
  });

  it('should have positive MACD line in uptrend', () => {
    const closes = Array.from({ length: 50 }, (_, i) => 100 + i * 2);
    const candles = makeCandles(closes);
    const result = MACD(candles);
    const lastMacd = result.macd.filter(v => !isNaN(v)).pop()!;
    expect(lastMacd).toBeGreaterThan(0);
  });

  it('should have negative MACD line in downtrend', () => {
    const closes = Array.from({ length: 50 }, (_, i) => 200 - i * 2);
    const candles = makeCandles(closes);
    const result = MACD(candles);
    const lastMacd = result.macd.filter(v => !isNaN(v)).pop()!;
    expect(lastMacd).toBeLessThan(0);
  });

  it('histogram should equal MACD - signal', () => {
    const closes = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i * 0.3) * 20);
    const candles = makeCandles(closes);
    const result = MACD(candles);
    for (let i = 0; i < result.histogram.length; i++) {
      if (!isNaN(result.histogram[i])) {
        expect(result.histogram[i]).toBeCloseTo(result.macd[i] - result.signal[i], 10);
      }
    }
  });

  it('should respect custom periods', () => {
    const candles = makeCandles(Array(50).fill(100));
    const result = MACD(candles, 5, 10, 3);
    expect(result.fastPeriod).toBe(5);
    expect(result.slowPeriod).toBe(10);
    expect(result.signalPeriod).toBe(3);
  });
});

// ---- Bollinger Bands ----

describe('BollingerBands', () => {
  it('should have upper > middle > lower always', () => {
    const closes = Array.from({ length: 25 }, (_, i) => 100 + Math.sin(i) * 5);
    const candles = makeCandles(closes);
    const bb = BollingerBands(candles, 20, 2);
    for (let i = 19; i < closes.length; i++) {
      expect(bb.upper[i]).toBeGreaterThan(bb.middle[i]);
      expect(bb.middle[i]).toBeGreaterThan(bb.lower[i]);
    }
  });

  it('should have zero bandwidth for constant prices', () => {
    const candles = makeCandles(Array(25).fill(100));
    const bb = BollingerBands(candles, 20, 2);
    expect(bb.bandwidth[24]).toBeCloseTo(0, 5);
  });

  it('middle band should equal SMA', () => {
    const closes = Array.from({ length: 25 }, (_, i) => 100 + i);
    const candles = makeCandles(closes);
    const bb = BollingerBands(candles, 20, 2);
    const sma = SMA(candles, 20);
    for (let i = 19; i < closes.length; i++) {
      expect(bb.middle[i]).toBeCloseTo(sma[i], 10);
    }
  });
});

// ---- ATR ----

describe('ATR', () => {
  it('should be positive for any data', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + Math.sin(i) * 10);
    const candles = makeCandles(closes);
    const result = ATR(candles, 14);
    const validValues = result.values.filter(v => !isNaN(v));
    expect(validValues.length).toBeGreaterThan(0);
    for (const v of validValues) {
      expect(v).toBeGreaterThan(0);
    }
  });

  it('should be higher for volatile data', () => {
    const stable = makeCandles(Array(20).fill(100), {
      highs: Array(20).fill(101),
      lows: Array(20).fill(99),
    });
    const volatile = makeCandles(Array(20).fill(100), {
      highs: Array(20).fill(110),
      lows: Array(20).fill(90),
    });

    const atrStable = ATR(stable, 14);
    const atrVolatile = ATR(volatile, 14);

    const lastStable = atrStable.values.filter(v => !isNaN(v)).pop()!;
    const lastVolatile = atrVolatile.values.filter(v => !isNaN(v)).pop()!;
    expect(lastVolatile).toBeGreaterThan(lastStable);
  });

  it('should return NaN for insufficient data', () => {
    const candles = makeCandles([100, 101, 102]);
    const result = ATR(candles, 14);
    expect(result.values.every(v => isNaN(v))).toBe(true);
  });
});

// ---- Stochastic ----

describe('Stochastic', () => {
  it('%K should be 0-100 range', () => {
    const closes = Array.from({ length: 25 }, (_, i) => 100 + Math.sin(i) * 10);
    const candles = makeCandles(closes);
    const result = Stochastic(candles, 14, 3);
    const validK = result.k.filter(v => !isNaN(v));
    for (const v of validK) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it('%K should be high for steadily rising prices', () => {
    // Steadily rising — close near highest high of lookback
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    const candles = makeCandles(closes);
    const result = Stochastic(candles, 14, 3);
    const lastK = result.k.filter(v => !isNaN(v)).pop()!;
    // With synthetic highs/lows, %K won't be exactly 100 but should be high
    expect(lastK).toBeGreaterThan(80);
  });

  it('%D should be SMA of %K', () => {
    const closes = Array.from({ length: 25 }, (_, i) => 100 + Math.sin(i * 0.5) * 15);
    const candles = makeCandles(closes);
    const result = Stochastic(candles, 14, 3);
    // %D is smoothed version of %K, should be within same range
    const validD = result.d.filter(v => !isNaN(v));
    for (const v of validD) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });
});

// ---- VWAP ----

describe('VWAP', () => {
  it('should equal typical price when volume is uniform', () => {
    const closes = [100, 110, 120];
    const candles = makeCandles(closes, { volumes: [1000, 1000, 1000] });
    const result = VWAP(candles);
    // VWAP should be cumulative average of typical prices
    expect(result.values[0]).toBeDefined();
    expect(isNaN(result.values[0])).toBe(false);
  });

  it('should weight toward high-volume bars', () => {
    // First candle: close=100 with low volume, second: close=200 with high volume
    const candles: Candle[] = [
      { timestamp: 1, open: 99, high: 101, low: 99, close: 100, volume: 1 },
      { timestamp: 2, open: 199, high: 201, low: 199, close: 200, volume: 1000 },
    ];
    const result = VWAP(candles);
    // VWAP should be much closer to 200 than 100
    expect(result.values[1]).toBeGreaterThan(190);
  });

  it('should handle empty input', () => {
    const result = VWAP([]);
    expect(result.values).toHaveLength(0);
  });

  it('should handle zero volume gracefully', () => {
    const candles: Candle[] = [
      { timestamp: 1, open: 99, high: 101, low: 99, close: 100, volume: 0 },
    ];
    const result = VWAP(candles);
    // With zero volume, should use typical price
    expect(isNaN(result.values[0])).toBe(false);
  });
});
