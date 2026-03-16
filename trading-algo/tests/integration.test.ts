import { describe, it, expect } from 'vitest';
import type { Candle, MarketData, AssetInfo, Signal, MacroEnvironment } from '../src/shared/types.js';
import { EventBus } from '../src/shared/events.js';
import { MomentumStrategy } from '../src/team/technical-strategist/strategies/momentum.js';
import { MeanReversionStrategy } from '../src/team/technical-strategist/strategies/mean-reversion.js';
import { BreakoutStrategy } from '../src/team/technical-strategist/strategies/breakout.js';
import { MultiIndicatorStrategy } from '../src/team/technical-strategist/strategies/multi-indicator.js';
import { PaperTrader } from '../src/team/executor/paper.js';
import { StrategyEvolver } from '../src/team/self-improver/evolver.js';
import { MacroEconomist } from '../src/team/macro-economist/index.js';
import { GeopoliticalAnalyzer } from '../src/team/macro-economist/geopolitical.js';
import { SMA, EMA, RSI, MACD, BollingerBands, ATR, Stochastic, VWAP } from '../src/team/technical-strategist/indicators.js';

// ---- Helpers ----

const testAsset: AssetInfo = {
  symbol: 'ETH/USDT',
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

// ---- Integration: Full analysis pipeline ----

describe('Full Analysis Pipeline', () => {
  it('should run all 4 strategies on same data without errors', async () => {
    const closes = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i * 0.3) * 20);
    const data = makeMarketData(makeCandles(closes));

    const strategies = [
      new MomentumStrategy(),
      new MeanReversionStrategy(),
      new BreakoutStrategy(),
      new MultiIndicatorStrategy(),
    ];

    const allSignals: Signal[] = [];
    for (const strategy of strategies) {
      const signals = await strategy.analyze(data);
      allSignals.push(...signals);
      // Verify signals have valid structure
      for (const s of signals) {
        expect(s.asset.symbol).toBe('ETH/USDT');
        expect(s.confidence).toBeGreaterThanOrEqual(0);
        expect(s.confidence).toBeLessThanOrEqual(1);
        expect(['BUY', 'SELL', 'HOLD']).toContain(s.action);
        expect(s.strategy).toBeDefined();
        expect(s.timeframe).toBe('1h');
      }
    }
  });

  it('should run all 8 indicators on same data without errors', () => {
    const closes = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i * 0.3) * 20);
    const candles = makeCandles(closes);

    const sma = SMA(candles, 20);
    const ema = EMA(candles, 20);
    const rsi = RSI(candles, 14);
    const macd = MACD(candles, 12, 26, 9);
    const bb = BollingerBands(candles, 20, 2);
    const atr = ATR(candles, 14);
    const stoch = Stochastic(candles, 14, 3);
    const vwap = VWAP(candles);

    // All should return arrays of correct length
    expect(sma).toHaveLength(50);
    expect(ema.values).toHaveLength(50);
    expect(rsi.values).toHaveLength(50);
    expect(macd.macd).toHaveLength(50);
    expect(bb.upper).toHaveLength(50);
    expect(atr.values).toHaveLength(50);
    expect(stoch.k).toHaveLength(50);
    expect(vwap.values).toHaveLength(50);
  });
});

// ---- Integration: Event-driven flow ----

describe('Event-Driven Flow', () => {
  it('should emit and receive market data events', async () => {
    const bus = new EventBus();
    let receivedData: any = null;

    bus.on('market:data', (event) => {
      receivedData = event.data;
    });

    const candles = makeCandles([100, 101, 102]);
    await bus.emit('market:data', { asset: testAsset, candles }, 'market-analyst');

    expect(receivedData).not.toBeNull();
    expect(receivedData.asset.symbol).toBe('ETH/USDT');
  });

  it('should chain signal → order events', async () => {
    const bus = new EventBus();
    const events: string[] = [];

    bus.on('signal:generated', () => { events.push('signal'); });
    bus.on('order:filled', () => { events.push('order'); });
    bus.on('position:opened', () => { events.push('position'); });

    await bus.emit('signal:generated', {}, 'strategist');
    await bus.emit('order:filled', {}, 'executor');
    await bus.emit('position:opened', {}, 'executor');

    expect(events).toEqual(['signal', 'order', 'position']);
  });
});

// ---- Integration: Strategy → Execution ----

describe('Strategy → Execution Pipeline', () => {
  it('should execute a signal from strategy through paper trader', async () => {
    // Generate a BUY signal
    const strategy = new MomentumStrategy();
    const closes: number[] = [];
    for (let i = 0; i < 25; i++) closes.push(100 - i * 0.5);
    for (let i = 0; i < 25; i++) closes.push(88 + i * 2);
    const data = makeMarketData(makeCandles(closes));
    const signals = await strategy.analyze(data);

    if (signals.length > 0 && signals[0].action === 'BUY') {
      const trader = new PaperTrader({ initialCapital: 10000 });
      const risk = {
        maxPositionSize: 2000,
        recommendedSize: 1000,
        stopLossPrice: signals[0].price * 0.95,
        takeProfitPrice: signals[0].price * 1.1,
        riskRewardRatio: 2,
        kellyFraction: 0.1,
        approved: true,
        reason: 'OK',
      };

      const result = await trader.executeTrade(signals[0], risk);
      expect(result.success).toBe(true);
      expect(trader.getPortfolio().positions.length).toBe(1);
    }
  });
});

// ---- Integration: Evolution + Strategy ----

describe('Evolution + Strategy Pipeline', () => {
  it('should create population from strategy DNA and evolve', () => {
    const strategy = new MomentumStrategy();
    const evolver = new StrategyEvolver();

    const population = evolver.createPopulation(strategy.dna, 5);
    expect(population).toHaveLength(5);

    // Assign fake fitness
    population[0].fitness = 100;
    population[1].fitness = 80;
    population[2].fitness = 60;
    population[3].fitness = 40;
    population[4].fitness = 20;

    const nextGen = evolver.evolve(population);
    expect(nextGen.length).toBeGreaterThan(0);

    // Best should be preserved
    const topFitness = Math.max(...nextGen.map(d => d.fitness));
    expect(topFitness).toBe(100);
  });
});

// ---- Integration: Macro → Strategy ----

describe('Macro → Strategy Integration', () => {
  it('should feed macro environment to strategy analysis', async () => {
    const economist = new MacroEconomist();
    const env = await economist.getEnvironment();

    const strategy = new MomentumStrategy();
    const closes = Array.from({ length: 50 }, (_, i) => 100 + i);
    const data = makeMarketData(makeCandles(closes));

    // Strategy accepts macro but currently doesn't use it for momentum
    // Just ensure it doesn't crash
    const signals = await strategy.analyze(data, env);
    expect(Array.isArray(signals)).toBe(true);
  });

  it('should assess geopolitical risk for assets in portfolio', () => {
    const analyzer = new GeopoliticalAnalyzer();

    // Check risk for different asset classes
    const btcRisk = analyzer.getFactorsForAsset('BTC/USDT');
    const nvdaRisk = analyzer.getFactorsForAsset('NVDA');
    const eurUsdRisk = analyzer.getFactorsForAsset('EUR/USD');

    // Each asset class should have relevant factors
    expect(btcRisk.length).toBeGreaterThan(0);
    expect(nvdaRisk.length).toBeGreaterThan(0);
    expect(eurUsdRisk.length).toBeGreaterThan(0);
  });
});

// ---- Integration: Multi-asset analysis ----

describe('Multi-Asset Analysis', () => {
  it('should analyze crypto, stock, and forex assets', async () => {
    const assets: AssetInfo[] = [
      { symbol: 'BTC/USDT', assetClass: 'crypto', exchange: 'binance' },
      { symbol: 'AAPL', assetClass: 'stock', exchange: 'nasdaq' },
      { symbol: 'EUR/USD', assetClass: 'forex' },
    ];

    const strategy = new MultiIndicatorStrategy();
    const allSignals: Signal[] = [];

    for (const asset of assets) {
      const closes = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i * 0.3) * 20);
      const data: MarketData = {
        asset,
        timeframe: '1h',
        candles: makeCandles(closes),
        lastUpdated: Date.now(),
      };

      const signals = await strategy.analyze(data);
      allSignals.push(...signals);

      for (const s of signals) {
        expect(s.asset.symbol).toBe(asset.symbol);
      }
    }
  });
});
