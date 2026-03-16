import type { Candle, Signal, Strategy, MarketData, BacktestConfig, BacktestResult } from '../../shared/types.js';
import type { BacktestState, BacktestPosition, CompletedTrade } from './types.js';
import { calculateMetrics } from './metrics.js';
import { generateId } from '../../shared/utils.js';
import { createModuleLogger } from '../../shared/logger.js';

const log = createModuleLogger('backtester');

/**
 * Event-driven backtesting engine.
 * Iterates through historical candles, runs strategy, simulates fills.
 */
export class BacktestEngine {
  async run(
    strategy: Strategy,
    candles: Candle[],
    config: BacktestConfig
  ): Promise<BacktestResult> {
    const state: BacktestState = {
      equity: config.initialCapital,
      cash: config.initialCapital,
      positions: [],
      orders: [],
      equityCurve: [{ timestamp: candles[0]?.timestamp ?? Date.now(), equity: config.initialCapital }],
      trades: [],
    };

    const lookback = Math.max(
      strategy.dna.params.slowEma ?? 50,
      strategy.dna.params.bbPeriod ?? 20,
      strategy.dna.params.macdSlow ?? 26,
      50 // minimum lookback
    );

    for (let i = lookback; i < candles.length; i++) {
      const currentCandle = candles[i];
      const historicalCandles = candles.slice(0, i + 1);

      // Check stops
      this.checkStops(state, currentCandle);

      // Update position prices
      this.updatePositions(state, currentCandle);

      // Generate signals from strategy
      const marketData: MarketData = {
        asset: config.asset,
        timeframe: config.timeframe,
        candles: historicalCandles,
        lastUpdated: currentCandle.timestamp,
      };

      const signals = await strategy.analyze(marketData);

      // Process signals
      for (const signal of signals) {
        this.processSignal(state, signal, currentCandle, config);
      }

      // Record equity
      const equity = this.calculateEquity(state, currentCandle);
      state.equityCurve.push({ timestamp: currentCandle.timestamp, equity });
      state.equity = equity;
    }

    // Close remaining positions at last candle price
    const lastCandle = candles[candles.length - 1];
    if (lastCandle) {
      this.closeAllPositions(state, lastCandle);
    }

    const metrics = calculateMetrics(state.trades, state.equityCurve, config.initialCapital);

    return {
      config,
      metrics,
      trades: state.orders,
      equityCurve: state.equityCurve,
      dna: strategy.dna,
    };
  }

  private processSignal(
    state: BacktestState,
    signal: Signal,
    candle: Candle,
    config: BacktestConfig
  ): void {
    if (signal.action === 'HOLD') return;

    const { commission, slippage } = config;
    const fillPrice = signal.action === 'BUY'
      ? candle.close * (1 + slippage)
      : candle.close * (1 - slippage);

    if (signal.action === 'BUY') {
      // Check if we already have a position
      const existing = state.positions.find((p) => p.symbol === signal.asset.symbol && p.side === 'buy');
      if (existing) return;

      // Check if we have a short to close
      const shortPos = state.positions.find((p) => p.symbol === signal.asset.symbol && p.side === 'sell');
      if (shortPos) {
        this.closePosition(state, shortPos, fillPrice, candle.timestamp);
      }

      // Open long position (use 10% of available cash by default, or signal confidence-weighted)
      const allocationPct = Math.min(signal.confidence * 0.2, 0.1);
      const allocation = state.cash * allocationPct;
      if (allocation < 10) return; // Skip tiny positions

      const quantity = allocation / fillPrice;
      const cost = fillPrice * quantity * (1 + commission);

      if (cost > state.cash) return;

      state.cash -= cost;
      state.positions.push({
        symbol: signal.asset.symbol,
        side: 'buy',
        entryPrice: fillPrice,
        quantity,
        entryTime: candle.timestamp,
        strategy: signal.strategy,
      });

      state.orders.push({
        id: generateId(),
        asset: signal.asset,
        side: 'buy',
        type: 'market',
        quantity,
        status: 'filled',
        filledPrice: fillPrice,
        filledQuantity: quantity,
        createdAt: candle.timestamp,
        filledAt: candle.timestamp,
        strategy: signal.strategy,
      });
    } else if (signal.action === 'SELL') {
      // Close any long position
      const longPos = state.positions.find((p) => p.symbol === signal.asset.symbol && p.side === 'buy');
      if (longPos) {
        this.closePosition(state, longPos, fillPrice, candle.timestamp);
      }
    }
  }

  private closePosition(
    state: BacktestState,
    position: BacktestPosition,
    exitPrice: number,
    exitTime: number
  ): void {
    const pnl = position.side === 'buy'
      ? (exitPrice - position.entryPrice) * position.quantity
      : (position.entryPrice - exitPrice) * position.quantity;

    const pnlPct = ((exitPrice - position.entryPrice) / position.entryPrice) * 100 *
      (position.side === 'buy' ? 1 : -1);

    state.trades.push({
      symbol: position.symbol,
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice,
      quantity: position.quantity,
      pnl,
      pnlPct,
      entryTime: position.entryTime,
      exitTime,
      strategy: position.strategy,
      holdingPeriodMs: exitTime - position.entryTime,
    });

    state.cash += exitPrice * position.quantity;
    state.positions = state.positions.filter((p) => p !== position);

    state.orders.push({
      id: generateId(),
      asset: { symbol: position.symbol, assetClass: 'crypto' },
      side: position.side === 'buy' ? 'sell' : 'buy',
      type: 'market',
      quantity: position.quantity,
      status: 'filled',
      filledPrice: exitPrice,
      filledQuantity: position.quantity,
      createdAt: exitTime,
      filledAt: exitTime,
      strategy: position.strategy,
    });
  }

  private checkStops(state: BacktestState, candle: Candle): void {
    const toClose: BacktestPosition[] = [];

    for (const pos of state.positions) {
      if (pos.stopLoss !== undefined) {
        if (pos.side === 'buy' && candle.low <= pos.stopLoss) {
          toClose.push(pos);
          continue;
        }
        if (pos.side === 'sell' && candle.high >= pos.stopLoss) {
          toClose.push(pos);
          continue;
        }
      }
      if (pos.takeProfit !== undefined) {
        if (pos.side === 'buy' && candle.high >= pos.takeProfit) {
          toClose.push(pos);
          continue;
        }
        if (pos.side === 'sell' && candle.low <= pos.takeProfit) {
          toClose.push(pos);
          continue;
        }
      }
    }

    for (const pos of toClose) {
      const exitPrice = pos.stopLoss !== undefined
        ? (pos.side === 'buy' ? Math.min(candle.open, pos.stopLoss) : Math.max(candle.open, pos.stopLoss))
        : (pos.takeProfit ?? candle.close);
      this.closePosition(state, pos, exitPrice, candle.timestamp);
    }
  }

  private updatePositions(state: BacktestState, candle: Candle): void {
    // Nothing to update in backtest mode — positions are tracked by entry price
  }

  private calculateEquity(state: BacktestState, candle: Candle): number {
    let equity = state.cash;
    for (const pos of state.positions) {
      equity += candle.close * pos.quantity;
    }
    return equity;
  }

  private closeAllPositions(state: BacktestState, candle: Candle): void {
    const positions = [...state.positions];
    for (const pos of positions) {
      this.closePosition(state, pos, candle.close, candle.timestamp);
    }
  }
}
