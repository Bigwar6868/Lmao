import type { Signal, RiskAssessment, Order, AssetInfo, Portfolio, Position } from '../../shared/types.js';
import type { ExecutorConfig, TradeExecution } from './types.js';
import { createOrderFromSignal, fillOrder } from './order.js';
import { generateId } from '../../shared/utils.js';
import { createModuleLogger } from '../../shared/logger.js';
import { eventBus } from '../../shared/events.js';
import { config } from '../../config/index.js';
import { OandaClient } from './oanda.js';

const log = createModuleLogger('live-executor');

/**
 * Live trade executor — routes orders to the correct broker:
 *  - Forex + metals → OANDA v20 REST API
 *  - Crypto → CCXT (Binance / Bybit)
 *
 * Fetches live bid/ask spread before execution so the PositionSizer
 * can apply 1/spread unit adjustment.
 */
export class LiveExecutor {
  private portfolio: Portfolio;
  private orderHistory: Order[] = [];
  private config: ExecutorConfig;
  private peakEquity: number;
  private exchange: any = null;
  private oanda: OandaClient;

  constructor(executorConfig?: Partial<ExecutorConfig>) {
    this.config = {
      mode: 'live',
      initialCapital: executorConfig?.initialCapital ?? config.initialCapital,
      maxOpenPositions: executorConfig?.maxOpenPositions ?? 10,
      defaultSlippage: executorConfig?.defaultSlippage ?? 0.0005,
      defaultCommission: executorConfig?.defaultCommission ?? 0.001,
    };

    this.peakEquity = this.config.initialCapital;

    this.portfolio = {
      capital: this.config.initialCapital,
      availableCapital: this.config.initialCapital,
      positions: [],
      totalPnl: 0,
      totalPnlPct: 0,
      maxDrawdown: 0,
      lastUpdated: Date.now(),
    };

    this.oanda = new OandaClient();
    this.initExchange();
    log.info({ capital: this.config.initialCapital }, 'Live executor initialized');
  }

  /**
   * Initialize CCXT exchange connection for crypto trading.
   */
  private async initExchange(): Promise<void> {
    try {
      const ccxt = await import('ccxt');

      if (config.binanceApiKey && config.binanceSecret) {
        this.exchange = new ccxt.binance({
          apiKey: config.binanceApiKey,
          secret: config.binanceSecret,
          enableRateLimit: true,
        });
        log.info('Connected to Binance exchange');
      } else if (config.bybitApiKey && config.bybitSecret) {
        this.exchange = new ccxt.bybit({
          apiKey: config.bybitApiKey,
          secret: config.bybitSecret,
          enableRateLimit: true,
        });
        log.info('Connected to Bybit exchange');
      } else {
        log.warn('No crypto exchange API keys configured');
      }
    } catch (err) {
      log.warn({ err }, 'CCXT not available');
    }
  }

  /**
   * Fetch live spread for a symbol (used to enrich signals for 1/spread sizing).
   */
  async getSpread(symbol: string): Promise<number | undefined> {
    if (this.oanda.isConfigured) {
      const prices = await this.oanda.getPrices([symbol]);
      const pricing = prices.get(symbol);
      if (pricing && pricing.spread > 0) {
        return pricing.spread;
      }
    }
    return undefined;
  }

  /**
   * Execute a trade based on signal and risk assessment.
   */
  async executeTrade(signal: Signal, risk: RiskAssessment): Promise<TradeExecution> {
    if (!risk.approved) {
      log.warn({ reason: risk.reason }, 'Trade rejected by risk manager');
      return { order: {} as Order, portfolio: this.portfolio, success: false, error: risk.reason };
    }

    if (signal.action === 'HOLD') {
      return { order: {} as Order, portfolio: this.portfolio, success: false, error: 'HOLD signal' };
    }

    if (signal.action === 'BUY' && this.portfolio.positions.length >= this.config.maxOpenPositions) {
      return { order: {} as Order, portfolio: this.portfolio, success: false, error: 'Max positions reached' };
    }

    const quantity = risk.recommendedSize / signal.price;
    const order = createOrderFromSignal(signal, quantity);
    const side = signal.action === 'BUY' ? 'buy' as const : 'sell' as const;

    let fillPrice = signal.price;
    let commission: number;

    // Route to the correct broker
    const isForexOrMetal = signal.asset.assetClass === 'forex';

    if (isForexOrMetal && this.oanda.isConfigured) {
      // ---- OANDA for forex + metals ----
      try {
        const result = await this.oanda.placeMarketOrder(
          signal.asset.symbol,
          side,
          risk.recommendedSize,
          signal.price,
          risk.stopLossPrice > 0 ? risk.stopLossPrice : undefined,
          risk.takeProfitPrice > 0 ? risk.takeProfitPrice : undefined,
        );
        fillPrice = result.fillPrice;
        commission = result.commission;
        log.info(
          { symbol: signal.asset.symbol, side, price: fillPrice, units: result.units, tradeId: result.tradeId },
          'OANDA order filled',
        );
      } catch (err) {
        log.error({ err, symbol: signal.asset.symbol }, 'OANDA order failed');
        return { order, portfolio: this.portfolio, success: false, error: (err as Error).message };
      }
    } else if (this.exchange && signal.asset.assetClass === 'crypto') {
      // ---- CCXT for crypto ----
      try {
        const exchangeOrder = await this.exchange.createMarketOrder(
          signal.asset.symbol,
          side,
          quantity,
        );
        fillPrice = exchangeOrder.average ?? exchangeOrder.price ?? signal.price;
        commission = exchangeOrder.fee?.cost ?? (fillPrice * quantity * this.config.defaultCommission);
        log.info(
          { symbol: signal.asset.symbol, side, price: fillPrice, orderId: exchangeOrder.id },
          'Exchange order placed',
        );
      } catch (err) {
        log.error({ err, symbol: signal.asset.symbol }, 'Exchange order failed');
        return { order, portfolio: this.portfolio, success: false, error: (err as Error).message };
      }
    } else {
      // ---- Local tracking fallback ----
      const slippage = signal.action === 'BUY' ? 1 + this.config.defaultSlippage : 1 - this.config.defaultSlippage;
      fillPrice = signal.price * slippage;
      commission = fillPrice * quantity * this.config.defaultCommission;
    }

    if (signal.action === 'BUY') {
      const totalCost = fillPrice * quantity + commission;
      if (totalCost > this.portfolio.availableCapital) {
        return { order, portfolio: this.portfolio, success: false, error: 'Insufficient capital' };
      }

      const filledOrder = fillOrder(order, fillPrice, quantity);
      this.orderHistory.push(filledOrder);

      const position: Position = {
        id: generateId(),
        asset: signal.asset,
        side: 'buy',
        entryPrice: fillPrice,
        currentPrice: fillPrice,
        quantity,
        stopLoss: risk.stopLossPrice,
        takeProfit: risk.takeProfitPrice,
        unrealizedPnl: -commission,
        realizedPnl: 0,
        status: 'open',
        openedAt: Date.now(),
        strategy: signal.strategy,
      };

      this.portfolio.positions.push(position);
      this.portfolio.availableCapital -= totalCost;
      this.portfolio.lastUpdated = Date.now();

      await eventBus.emit('order:filled', filledOrder, 'live-executor');
      await eventBus.emit('position:opened', position, 'live-executor');

      log.info(
        { symbol: signal.asset.symbol, side: 'buy', price: fillPrice, quantity, spread: signal.spread, strategy: signal.strategy },
        'Live trade executed',
      );

      return { order: filledOrder, position, portfolio: this.portfolio, success: true };
    } else {
      // SELL: close existing position
      const posIndex = this.portfolio.positions.findIndex(
        (p) => p.asset.symbol === signal.asset.symbol && p.status === 'open',
      );

      if (posIndex === -1) {
        return { order, portfolio: this.portfolio, success: false, error: 'No position to close' };
      }

      const position = this.portfolio.positions[posIndex];
      const pnl = (fillPrice - position.entryPrice) * position.quantity - commission;

      position.realizedPnl = pnl;
      position.status = 'closed';
      position.closedAt = Date.now();
      position.currentPrice = fillPrice;

      this.portfolio.availableCapital += fillPrice * position.quantity - commission;
      this.portfolio.totalPnl += pnl;
      this.portfolio.totalPnlPct = (this.portfolio.totalPnl / this.config.initialCapital) * 100;
      this.portfolio.positions.splice(posIndex, 1);
      this.portfolio.lastUpdated = Date.now();

      const filledOrder = fillOrder(order, fillPrice, position.quantity);
      this.orderHistory.push(filledOrder);

      await eventBus.emit('order:filled', filledOrder, 'live-executor');
      await eventBus.emit('position:closed', position, 'live-executor');

      log.info(
        { symbol: signal.asset.symbol, side: 'sell', price: fillPrice, pnl: pnl.toFixed(2), strategy: signal.strategy },
        'Live position closed',
      );

      return { order: filledOrder, position, portfolio: this.portfolio, success: true };
    }
  }

  updatePrices(prices: Map<string, number>): void {
    for (const pos of this.portfolio.positions) {
      const price = prices.get(pos.asset.symbol);
      if (price !== undefined) {
        pos.currentPrice = price;
        pos.unrealizedPnl = (price - pos.entryPrice) * pos.quantity;
      }
    }

    const totalEquity = this.portfolio.availableCapital +
      this.portfolio.positions.reduce((sum, p) => sum + p.currentPrice * p.quantity, 0);

    this.portfolio.capital = totalEquity;
    if (totalEquity > this.peakEquity) this.peakEquity = totalEquity;
    const drawdown = ((this.peakEquity - totalEquity) / this.peakEquity) * 100;
    if (drawdown > this.portfolio.maxDrawdown) {
      this.portfolio.maxDrawdown = drawdown;
    }
    this.portfolio.lastUpdated = Date.now();
  }

  async checkStops(currentPrices: Map<string, number>): Promise<void> {
    const toClose: Position[] = [];

    for (const pos of this.portfolio.positions) {
      const price = currentPrices.get(pos.asset.symbol);
      if (!price) continue;

      if (pos.stopLoss && price <= pos.stopLoss) {
        log.info({ symbol: pos.asset.symbol, price, stopLoss: pos.stopLoss }, 'Stop loss triggered');
        toClose.push(pos);
      } else if (pos.takeProfit && price >= pos.takeProfit) {
        log.info({ symbol: pos.asset.symbol, price, takeProfit: pos.takeProfit }, 'Take profit triggered');
        toClose.push(pos);
      }
    }

    for (const pos of toClose) {
      const price = currentPrices.get(pos.asset.symbol)!;
      const signal: Signal = {
        asset: pos.asset,
        action: 'SELL',
        confidence: 1,
        price,
        timestamp: Date.now(),
        strategy: pos.strategy,
        timeframe: '1h',
        indicators: {},
        reason: pos.stopLoss && price <= pos.stopLoss ? 'Stop loss triggered' : 'Take profit triggered',
      };
      await this.executeTrade(signal, {
        maxPositionSize: 0, recommendedSize: 0,
        stopLossPrice: 0, takeProfitPrice: 0,
        riskRewardRatio: 0, kellyFraction: 0,
        approved: true, reason: 'Closing position',
      });
    }
  }

  getPortfolio(): Portfolio {
    return { ...this.portfolio };
  }

  getOrderHistory(): Order[] {
    return [...this.orderHistory];
  }

  getSummary(): string {
    const p = this.portfolio;
    return [
      `=== Live Trading Summary ===`,
      `Capital: $${p.capital.toFixed(2)}`,
      `Available: $${p.availableCapital.toFixed(2)}`,
      `Open Positions: ${p.positions.length}`,
      `Total P&L: $${p.totalPnl.toFixed(2)} (${p.totalPnlPct.toFixed(2)}%)`,
      `Max Drawdown: ${p.maxDrawdown.toFixed(2)}%`,
      `Total Orders: ${this.orderHistory.length}`,
    ].join('\n');
  }
}
