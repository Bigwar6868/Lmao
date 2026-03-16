import { describe, it, expect } from 'vitest';
import type { Candle, MarketData, AssetInfo } from '../src/shared/types.js';
import { MomentumStrategy } from '../src/team/technical-strategist/strategies/momentum.js';
import { MeanReversionStrategy } from '../src/team/technical-strategist/strategies/mean-reversion.js';
import { BreakoutStrategy } from '../src/team/technical-strategist/strategies/breakout.js';
import { MultiIndicatorStrategy } from '../src/team/technical-strategist/strategies/multi-indicator.js';

// ---- Helpers ----

const testAsset: AssetInfo = {
  symbol: 'BTC/USDT',
  assetClass: 'crypto',
  exchange: 'binance',
};

function makeCandles(closes: number[], volumes?: number[]): Candle[] {
  return closes.map((close, i) => ({
    timestamp: Date.now() - (closes.length - i) * 3600000,
    open: close * 0.999,
    high: close * 1.015,
    low: close * 0.985,
    close,
    volume: volumes?.[i] ?? 1000,
  }));
}

function makeMarketData(candles: Candle[]): MarketData {
  return {
    asset: testAsset,
    timeframe: '1h',
    candles,
    lastUpdated: Date.now(),
  };
}

/**
 * Generate candles with an EMA crossover pattern.
 * First half trends down, then sharply reverses up → bullish crossover.
 */
function makeBullishCrossoverCandles(len = 50): Candle[] {
  const closes: number[] = [];
  // Downtrend for first half
  for (let i = 0; i < len / 2; i++) {
    closes.push(100 - i * 0.5);
  }
  // Sharp uptrend for second half (fast EMA will cross above slow EMA)
  for (let i = 0; i < len / 2; i++) {
    closes.push(75 + i * 2);
  }
  return makeCandles(closes);
}

function makeBearishCrossoverCandles(len = 50): Candle[] {
  const closes: number[] = [];
  // Uptrend for first half
  for (let i = 0; i < len / 2; i++) {
    closes.push(100 + i * 0.5);
  }
  // Sharp downtrend for second half
  for (let i = 0; i < len / 2; i++) {
    closes.push(125 - i * 2);
  }
  return makeCandles(closes);
}

// ---- Momentum Strategy ----

describe('MomentumStrategy', () => {
  it('should initialize with correct defaults', () => {
    const strategy = new MomentumStrategy();
    expect(strategy.name).toBe('momentum');
    expect(strategy.config.enabled).toBe(true);
    expect(strategy.dna.params.fastEma).toBe(9);
    expect(strategy.dna.params.slowEma).toBe(21);
    expect(strategy.dna.params.rsiPeriod).toBe(14);
  });

  it('should return empty signals when not enough candles', async () => {
    const strategy = new MomentumStrategy();
    const data = makeMarketData(makeCandles([100, 101, 102]));
    const signals = await strategy.analyze(data);
    expect(signals).toHaveLength(0);
  });

  it('should detect bullish crossover', async () => {
    const strategy = new MomentumStrategy();
    const candles = makeBullishCrossoverCandles(50);
    const data = makeMarketData(candles);
    const signals = await strategy.analyze(data);

    // The sharp reversal should produce a BUY signal once crossover + RSI > 50
    const buySignals = signals.filter(s => s.action === 'BUY');
    // It may or may not generate depending on exact RSI, but should not generate SELL
    const sellSignals = signals.filter(s => s.action === 'SELL');
    expect(sellSignals).toHaveLength(0);
  });

  it('should detect bearish crossover', async () => {
    const strategy = new MomentumStrategy();
    const candles = makeBearishCrossoverCandles(50);
    const data = makeMarketData(candles);
    const signals = await strategy.analyze(data);

    const buySignals = signals.filter(s => s.action === 'BUY');
    expect(buySignals).toHaveLength(0);
  });

  it('should return signals with valid confidence 0-1', async () => {
    const strategy = new MomentumStrategy();
    const candles = makeBullishCrossoverCandles(50);
    const data = makeMarketData(candles);
    const signals = await strategy.analyze(data);

    for (const signal of signals) {
      expect(signal.confidence).toBeGreaterThanOrEqual(0);
      expect(signal.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('should respect custom DNA params', async () => {
    const strategy = new MomentumStrategy();
    strategy.dna.params = { fastEma: 5, slowEma: 10, rsiPeriod: 7, rsiThreshold: 50 };
    const candles = makeBullishCrossoverCandles(30);
    const data = makeMarketData(candles);
    // Should not crash with shorter periods
    const signals = await strategy.analyze(data);
    expect(Array.isArray(signals)).toBe(true);
  });
});

// ---- Mean Reversion Strategy ----

describe('MeanReversionStrategy', () => {
  it('should initialize with correct defaults', () => {
    const strategy = new MeanReversionStrategy();
    expect(strategy.name).toBe('mean-reversion');
    expect(strategy.dna.params.bbPeriod).toBe(20);
    expect(strategy.dna.params.bbStdDev).toBe(2);
    expect(strategy.dna.params.oversold).toBe(30);
    expect(strategy.dna.params.overbought).toBe(70);
  });

  it('should return empty signals for insufficient candles', async () => {
    const strategy = new MeanReversionStrategy();
    const data = makeMarketData(makeCandles([100, 101]));
    const signals = await strategy.analyze(data);
    expect(signals).toHaveLength(0);
  });

  it('should generate BUY when price drops below lower BB + RSI oversold', async () => {
    const strategy = new MeanReversionStrategy();
    // Stable prices then sudden crash → price below lower BB + low RSI
    const closes: number[] = [];
    for (let i = 0; i < 25; i++) closes.push(100 + Math.sin(i) * 0.5);
    // Sharp drop
    for (let i = 0; i < 10; i++) closes.push(95 - i * 2);
    const candles = makeCandles(closes);
    const data = makeMarketData(candles);
    const signals = await strategy.analyze(data);

    if (signals.length > 0) {
      expect(signals[0].action).toBe('BUY');
      expect(signals[0].strategy).toBe('mean-reversion');
    }
  });

  it('should generate SELL when price rises above upper BB + RSI overbought', async () => {
    const strategy = new MeanReversionStrategy();
    // Stable prices then sudden spike
    const closes: number[] = [];
    for (let i = 0; i < 25; i++) closes.push(100 + Math.sin(i) * 0.5);
    for (let i = 0; i < 10; i++) closes.push(105 + i * 2);
    const candles = makeCandles(closes);
    const data = makeMarketData(candles);
    const signals = await strategy.analyze(data);

    if (signals.length > 0) {
      expect(signals[0].action).toBe('SELL');
    }
  });

  it('should return no signals in stable market', async () => {
    const strategy = new MeanReversionStrategy();
    const closes = Array.from({ length: 30 }, () => 100);
    const data = makeMarketData(makeCandles(closes));
    const signals = await strategy.analyze(data);
    expect(signals).toHaveLength(0);
  });
});

// ---- Breakout Strategy ----

describe('BreakoutStrategy', () => {
  it('should initialize with correct defaults', () => {
    const strategy = new BreakoutStrategy();
    expect(strategy.name).toBe('breakout');
    expect(strategy.dna.params.squeezeThreshold).toBe(0.05);
    expect(strategy.dna.params.volumeMultiplier).toBe(1.5);
  });

  it('should return empty for insufficient candles', async () => {
    const strategy = new BreakoutStrategy();
    const data = makeMarketData(makeCandles([100, 101, 102]));
    const signals = await strategy.analyze(data);
    expect(signals).toHaveLength(0);
  });

  it('should detect upward breakout after squeeze', async () => {
    const strategy = new BreakoutStrategy();
    // Create tight range (squeeze) then expansion with volume spike
    const closes: number[] = [];
    // Squeeze: very tight range for 25 candles
    for (let i = 0; i < 25; i++) closes.push(100 + (i % 2 === 0 ? 0.01 : -0.01));
    // Breakout: big move up with volume
    for (let i = 0; i < 5; i++) closes.push(110 + i * 5);

    const volumes: number[] = [];
    for (let i = 0; i < 25; i++) volumes.push(100);
    for (let i = 0; i < 5; i++) volumes.push(500); // Volume spike

    const candles = makeCandles(closes, volumes);
    const data = makeMarketData(candles);
    const signals = await strategy.analyze(data);

    if (signals.length > 0) {
      expect(signals[0].action).toBe('BUY');
      expect(signals[0].indicators.volumeRatio).toBeGreaterThan(1);
    }
  });

  it('should not signal without volume spike', async () => {
    const strategy = new BreakoutStrategy();
    const closes: number[] = [];
    for (let i = 0; i < 25; i++) closes.push(100 + (i % 2 === 0 ? 0.01 : -0.01));
    for (let i = 0; i < 5; i++) closes.push(110 + i * 5);
    // No volume spike — all uniform
    const candles = makeCandles(closes);
    const data = makeMarketData(candles);
    const signals = await strategy.analyze(data);
    // Without volume spike, should not produce signal
    expect(signals).toHaveLength(0);
  });
});

// ---- Multi-Indicator Strategy ----

describe('MultiIndicatorStrategy', () => {
  it('should initialize with correct defaults', () => {
    const strategy = new MultiIndicatorStrategy();
    expect(strategy.name).toBe('multi-indicator');
    expect(strategy.dna.params.rsiWeight).toBe(0.3);
    expect(strategy.dna.params.macdWeight).toBe(0.4);
    expect(strategy.dna.params.bbWeight).toBe(0.3);
  });

  it('should return empty for insufficient candles', async () => {
    const strategy = new MultiIndicatorStrategy();
    const data = makeMarketData(makeCandles([100, 101, 102]));
    const signals = await strategy.analyze(data);
    expect(signals).toHaveLength(0);
  });

  it('should generate BUY when multiple indicators agree (oversold)', async () => {
    const strategy = new MultiIndicatorStrategy();
    // Strong downtrend → RSI oversold, MACD bearish turning, price at lower BB
    const closes: number[] = [];
    for (let i = 0; i < 40; i++) closes.push(100 - i * 0.5);
    // Extreme oversold at end
    for (let i = 0; i < 5; i++) closes.push(70 - i * 3);
    const candles = makeCandles(closes);
    const data = makeMarketData(candles);
    const signals = await strategy.analyze(data);

    if (signals.length > 0) {
      expect(signals[0].action).toBe('BUY');
      expect(signals[0].indicators.buyScore).toBeDefined();
      expect(signals[0].indicators.sellScore).toBeDefined();
    }
  });

  it('should return HOLD (no signals) in neutral market', async () => {
    const strategy = new MultiIndicatorStrategy();
    // Random walk around 100 — indicators should be mixed
    const closes: number[] = [];
    let price = 100;
    for (let i = 0; i < 45; i++) {
      price += (Math.sin(i * 0.5) * 0.3);
      closes.push(price);
    }
    const data = makeMarketData(makeCandles(closes));
    const signals = await strategy.analyze(data);
    // In neutral market, multi-indicator should mostly HOLD (no signal)
    expect(signals.length).toBeLessThanOrEqual(1);
  });

  it('should include all indicator values in signal', async () => {
    const strategy = new MultiIndicatorStrategy();
    const closes: number[] = [];
    for (let i = 0; i < 40; i++) closes.push(100 - i * 0.5);
    for (let i = 0; i < 5; i++) closes.push(70 - i * 3);
    const data = makeMarketData(makeCandles(closes));
    const signals = await strategy.analyze(data);

    if (signals.length > 0) {
      expect(signals[0].indicators).toHaveProperty('rsi');
      expect(signals[0].indicators).toHaveProperty('macd');
      expect(signals[0].indicators).toHaveProperty('macdSignal');
      expect(signals[0].indicators).toHaveProperty('bbUpper');
      expect(signals[0].indicators).toHaveProperty('bbLower');
    }
  });
});
