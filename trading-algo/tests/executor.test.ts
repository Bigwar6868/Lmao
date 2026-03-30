import { describe, it, expect } from 'vitest';
import type { Signal, RiskAssessment, AssetInfo } from '../src/shared/types.js';
import { TradeSimulator } from '../src/team/executor/simulator.js';
import { createOrderFromSignal, fillOrder } from '../src/team/executor/order.js';

// ---- Helpers ----

const testAsset: AssetInfo = {
  symbol: 'BTC/USDT',
  assetClass: 'crypto',
  exchange: 'binance',
};

function makeSignal(action: 'BUY' | 'SELL', price = 100, confidence = 0.8): Signal {
  return {
    asset: testAsset,
    action,
    confidence,
    price,
    timestamp: Date.now(),
    strategy: 'momentum',
    timeframe: '1h',
    indicators: {},
    reason: 'test signal',
  };
}

function makeRisk(approved = true, size = 1000): RiskAssessment {
  return {
    maxPositionSize: size * 2,
    recommendedSize: size,
    stopLossPrice: 90,
    takeProfitPrice: 120,
    riskRewardRatio: 2,
    kellyFraction: 0.1,
    approved,
    reason: approved ? 'OK' : 'Rejected',
  };
}

// ---- Order Functions ----

describe('Order Functions', () => {
  it('createOrderFromSignal should create a valid order', () => {
    const signal = makeSignal('BUY', 100);
    const order = createOrderFromSignal(signal, 10);
    expect(order.side).toBe('buy');
    expect(order.quantity).toBe(10);
    expect(order.status).toBe('pending');
    expect(order.asset.symbol).toBe('BTC/USDT');
  });

  it('createOrderFromSignal should set sell side for SELL', () => {
    const signal = makeSignal('SELL', 100);
    const order = createOrderFromSignal(signal, 5);
    expect(order.side).toBe('sell');
  });

  it('fillOrder should set filled status and price', () => {
    const signal = makeSignal('BUY', 100);
    const order = createOrderFromSignal(signal, 10);
    const filled = fillOrder(order, 101, 10);
    expect(filled.status).toBe('filled');
    expect(filled.filledPrice).toBe(101);
    expect(filled.filledQuantity).toBe(10);
    expect(filled.filledAt).toBeDefined();
  });
});

// ---- TradeSimulator ----

describe('TradeSimulator', () => {
  it('should initialize with correct capital', () => {
    const trader = new TradeSimulator({ initialCapital: 50000 });
    const portfolio = trader.getPortfolio();
    expect(portfolio.capital).toBe(50000);
    expect(portfolio.availableCapital).toBe(50000);
    expect(portfolio.positions).toHaveLength(0);
  });

  it('should execute a BUY trade successfully', async () => {
    const trader = new TradeSimulator({ initialCapital: 10000 });
    const signal = makeSignal('BUY', 100);
    const risk = makeRisk(true, 1000);
    const result = await trader.executeTrade(signal, risk);

    expect(result.success).toBe(true);
    expect(result.order.status).toBe('filled');
    expect(result.position).toBeDefined();
    expect(result.position!.side).toBe('buy');

    const portfolio = trader.getPortfolio();
    expect(portfolio.positions).toHaveLength(1);
    expect(portfolio.availableCapital).toBeLessThan(10000);
  });

  it('should reject trade when risk not approved', async () => {
    const trader = new TradeSimulator({ initialCapital: 10000 });
    const signal = makeSignal('BUY', 100);
    const risk = makeRisk(false);
    const result = await trader.executeTrade(signal, risk);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should reject HOLD signals', async () => {
    const trader = new TradeSimulator({ initialCapital: 10000 });
    const signal: Signal = { ...makeSignal('BUY', 100), action: 'HOLD' };
    const risk = makeRisk(true);
    const result = await trader.executeTrade(signal, risk);

    expect(result.success).toBe(false);
    expect(result.error).toContain('HOLD');
  });

  it('should reject BUY when max positions reached', async () => {
    const trader = new TradeSimulator({ initialCapital: 100000, maxOpenPositions: 1 });
    const signal1 = makeSignal('BUY', 100);
    const risk = makeRisk(true, 100);

    await trader.executeTrade(signal1, risk);
    const result2 = await trader.executeTrade(signal1, risk);

    expect(result2.success).toBe(false);
    expect(result2.error).toContain('Max positions');
  });

  it('should reject BUY when insufficient capital', async () => {
    const trader = new TradeSimulator({ initialCapital: 10 });
    const signal = makeSignal('BUY', 100);
    const risk = makeRisk(true, 10000);
    const result = await trader.executeTrade(signal, risk);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Insufficient capital');
  });

  it('should close position on SELL', async () => {
    const trader = new TradeSimulator({ initialCapital: 10000 });
    const buySignal = makeSignal('BUY', 100);
    const risk = makeRisk(true, 1000);

    await trader.executeTrade(buySignal, risk);
    expect(trader.getPortfolio().positions).toHaveLength(1);

    const sellSignal = makeSignal('SELL', 110);
    const sellResult = await trader.executeTrade(sellSignal, makeRisk(true));
    expect(sellResult.success).toBe(true);
    expect(trader.getPortfolio().positions).toHaveLength(0);
  });

  it('should reject SELL when no position exists', async () => {
    const trader = new TradeSimulator({ initialCapital: 10000 });
    const signal = makeSignal('SELL', 100);
    const result = await trader.executeTrade(signal, makeRisk(true));

    expect(result.success).toBe(false);
    expect(result.error).toContain('No position');
  });

  it('should update prices and calculate drawdown', () => {
    const trader = new TradeSimulator({ initialCapital: 10000 });
    // Execute a buy first
    const signal = makeSignal('BUY', 100);
    const risk = makeRisk(true, 5000);
    trader.executeTrade(signal, risk);

    // Price drops
    const prices = new Map<string, number>();
    prices.set('BTC/USDT', 80);
    trader.updatePrices(prices);

    const portfolio = trader.getPortfolio();
    expect(portfolio.maxDrawdown).toBeGreaterThan(0);
  });

  it('should trigger stop loss', async () => {
    const trader = new TradeSimulator({ initialCapital: 10000 });
    const signal = makeSignal('BUY', 100);
    const risk = makeRisk(true, 1000);
    risk.stopLossPrice = 90;

    await trader.executeTrade(signal, risk);
    expect(trader.getPortfolio().positions).toHaveLength(1);

    // Price drops below stop loss
    const prices = new Map<string, number>();
    prices.set('BTC/USDT', 85);
    await trader.checkStops(prices);

    expect(trader.getPortfolio().positions).toHaveLength(0);
  });

  it('should trigger take profit', async () => {
    const trader = new TradeSimulator({ initialCapital: 10000 });
    const signal = makeSignal('BUY', 100);
    const risk = makeRisk(true, 1000);
    risk.takeProfitPrice = 120;

    await trader.executeTrade(signal, risk);

    const prices = new Map<string, number>();
    prices.set('BTC/USDT', 125);
    await trader.checkStops(prices);

    expect(trader.getPortfolio().positions).toHaveLength(0);
  });

  it('should track order history', async () => {
    const trader = new TradeSimulator({ initialCapital: 10000 });
    const signal = makeSignal('BUY', 100);
    const risk = makeRisk(true, 1000);

    await trader.executeTrade(signal, risk);
    expect(trader.getOrderHistory()).toHaveLength(1);

    const sellSignal = makeSignal('SELL', 110);
    await trader.executeTrade(sellSignal, makeRisk(true));
    expect(trader.getOrderHistory()).toHaveLength(2);
  });

  it('should produce a summary string', () => {
    const trader = new TradeSimulator({ initialCapital: 10000 });
    const summary = trader.getSummary();
    expect(summary).toContain('Trading Simulation Summary');
    expect(summary).toContain('Capital');
  });
});
