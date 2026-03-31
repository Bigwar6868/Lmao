import type { Candle, Signal, Strategy, MarketData, BacktestConfig, BacktestResult } from '../../shared/types.js';
import type { BacktestState, BacktestPosition, CompletedTrade } from './types.js';
import { calculateMetrics } from './metrics.js';
import { generateId } from '../../shared/utils.js';
import { createModuleLogger } from '../../shared/logger.js';
import { ATR } from '../technical-strategist/indicators.js';

const log = createModuleLogger('backtester');

/**
 * Event-driven backtesting engine.
 * Iterates through historical candles, runs strategy, simulates fills.
 *
 * Key features:
 * - ATR-based stop-loss and take-profit on every position
 * - Trailing stop that locks in profits
 * - Kelly-inspired position sizing based on signal confidence
 * - Time-based exit (max 48 bars holding period)
 */
export class BacktestEngine {
  private readonly SL_ATR_MULT_DEFAULT = 2.0;
  private readonly TP_ATR_MULT_DEFAULT = 3.0;
  private readonly MAX_HOLD_BARS_DEFAULT = 48;
  private readonly MAX_POSITION_PCT_DEFAULT = 0.15;

  // Per-run overrides (set from config)
  private slAtrMult = 2.0;
  private tpAtrMult = 3.0;
  private maxHoldBars = 48;
  private maxPositionPct = 0.15;

  async run(
    strategy: Strategy,
    candles: Candle[],
    config: BacktestConfig
  ): Promise<BacktestResult> {
    // Apply overrides from config
    this.slAtrMult = config.slAtrMult ?? this.slAtrMult_DEFAULT;
    this.tpAtrMult = config.tpAtrMult ?? this.tpAtrMult_DEFAULT;
    this.maxHoldBars = config.maxHoldBars ?? this.maxHoldBars_DEFAULT;
    this.maxPositionPct = config.maxPositionPct ?? this.maxPositionPct_DEFAULT;
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

    // Pre-compute ATR for the full candle series
    const atrResult = ATR(candles, 14);

    for (let i = lookback; i < candles.length; i++) {
      const currentCandle = candles[i];
      const historicalCandles = candles.slice(0, i + 1);

      // Check stops (SL, TP, trailing)
      this.checkStops(state, currentCandle);

      // Time-based exit: close positions held too long
      this.checkTimeExit(state, currentCandle, i, candles);

      // Update trailing stops
      this.updateTrailingStops(state, currentCandle, atrResult.values[i]);

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

      // Process signals — pass ATR for stop calculation
      const currentAtr = atrResult.values[i];
      for (const signal of signals) {
        this.processSignal(state, signal, currentCandle, config, currentAtr);
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
    config: BacktestConfig,
    atr: number,
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

      // Position sizing: confidence-scaled, capped at MAX_POSITION_PCT
      const equity = this.calculateEquity(state, candle);
      const confidenceScale = 0.5 + signal.confidence * 0.5; // 0.5 at min, 1.0 at max
      const allocationPct = Math.min(signal.confidence * 0.3 * confidenceScale, this.maxPositionPct);
      const allocation = equity * allocationPct;
      if (allocation < 10) return; // Skip tiny positions

      const quantity = allocation / fillPrice;
      const cost = fillPrice * quantity * (1 + commission);

      if (cost > state.cash) return;

      // Compute ATR-based stops
      const validAtr = atr > 0 ? atr : fillPrice * 0.01; // fallback: 1% of price
      const stopLoss = fillPrice - validAtr * this.slAtrMult;
      const takeProfit = fillPrice + validAtr * this.tpAtrMult;

      state.cash -= cost;
      state.positions.push({
        symbol: signal.asset.symbol,
        side: 'buy',
        entryPrice: fillPrice,
        quantity,
        entryTime: candle.timestamp,
        stopLoss,
        takeProfit,
        trailingStop: stopLoss, // starts at initial SL
        strategy: signal.strategy,
        entryBar: this.findBarIndex(candle),
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
    const toClose: Array<{ pos: BacktestPosition; price: number }> = [];

    for (const pos of state.positions) {
      // Use trailing stop if it's tighter than original SL
      const effectiveSl = pos.trailingStop !== undefined
        ? Math.max(pos.trailingStop, pos.stopLoss ?? 0)
        : pos.stopLoss;

      if (effectiveSl !== undefined) {
        if (pos.side === 'buy' && candle.low <= effectiveSl) {
          // Stop hit — exit at stop price (or open if gap down)
          toClose.push({ pos, price: Math.min(candle.open, effectiveSl) });
          continue;
        }
        if (pos.side === 'sell' && candle.high >= effectiveSl) {
          toClose.push({ pos, price: Math.max(candle.open, effectiveSl) });
          continue;
        }
      }
      if (pos.takeProfit !== undefined) {
        if (pos.side === 'buy' && candle.high >= pos.takeProfit) {
          // TP hit — exit at TP price (or open if gap up)
          toClose.push({ pos, price: Math.max(candle.open, pos.takeProfit) });
          continue;
        }
        if (pos.side === 'sell' && candle.low <= pos.takeProfit) {
          toClose.push({ pos, price: Math.min(candle.open, pos.takeProfit) });
          continue;
        }
      }
    }

    for (const { pos, price } of toClose) {
      this.closePosition(state, pos, price, candle.timestamp);
    }
  }

  /**
   * Update trailing stop: moves SL up as price moves in our favor.
   * Trail = highest price seen - 1.5x ATR (tighter than initial 2x ATR SL).
   */
  private updateTrailingStops(state: BacktestState, candle: Candle, atr: number): void {
    if (!atr || atr <= 0) return;

    for (const pos of state.positions) {
      if (pos.side === 'buy') {
        const newTrail = candle.high - atr * 1.5;
        if (pos.trailingStop === undefined || newTrail > pos.trailingStop) {
          // Only move trailing stop UP, never down
          if (newTrail > pos.entryPrice) {
            // Only activate trail once we're in profit
            pos.trailingStop = newTrail;
          }
        }
      }
    }
  }

  /**
   * Time-based exit: close positions held longer than MAX_HOLD_BARS.
   * Prevents hanging positions from consuming capital.
   */
  private checkTimeExit(state: BacktestState, candle: Candle, barIndex: number, allCandles: Candle[]): void {
    const toClose: BacktestPosition[] = [];
    for (const pos of state.positions) {
      const barsHeld = this.countBarsHeld(pos, candle, allCandles);
      if (barsHeld >= this.maxHoldBars) {
        toClose.push(pos);
      }
    }
    for (const pos of toClose) {
      this.closePosition(state, pos, candle.close, candle.timestamp);
    }
  }

  private countBarsHeld(pos: BacktestPosition, currentCandle: Candle, allCandles: Candle[]): number {
    // Estimate bars held from timestamps
    if (allCandles.length < 2) return 0;
    const avgInterval = (allCandles[allCandles.length - 1].timestamp - allCandles[0].timestamp) / (allCandles.length - 1);
    if (avgInterval <= 0) return 0;
    return Math.floor((currentCandle.timestamp - pos.entryTime) / avgInterval);
  }

  private findBarIndex(_candle: Candle): number {
    return 0; // Not critical — entryTime is used for time exits
  }

  private updatePositions(_state: BacktestState, _candle: Candle): void {
    // Nothing to update — positions tracked by entry price
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
