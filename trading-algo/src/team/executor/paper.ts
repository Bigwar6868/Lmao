import type { Order, Position, Portfolio, Signal, RiskAssessment } from '../../shared/types.js';
import type { ExecutorConfig, TradeExecution } from './types.js';
import { createOrderFromSignal, fillOrder } from './order.js';
import { generateId } from '../../shared/utils.js';
import { createModuleLogger } from '../../shared/logger.js';
import { eventBus } from '../../shared/events.js';

const log = createModuleLogger('paper-trader');

/**
 * Paper trading engine — simulates real trading without risking capital.
 */
export class PaperTrader {
  private portfolio: Portfolio;
  private orderHistory: Order[] = [];
  private config: ExecutorConfig;
  private peakEquity: number;

  constructor(config?: Partial<ExecutorConfig>) {
    this.config = {
      mode: 'paper',
      initialCapital: config?.initialCapital ?? 10000,
      maxOpenPositions: config?.maxOpenPositions ?? 10,
      defaultSlippage: config?.defaultSlippage ?? 0.0005,
      defaultCommission: config?.defaultCommission ?? 0.001,
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

    log.info({ capital: this.config.initialCapital }, 'Paper trader initialized');
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

    // Check max positions
    if (signal.action === 'BUY' && this.portfolio.positions.length >= this.config.maxOpenPositions) {
      return { order: {} as Order, portfolio: this.portfolio, success: false, error: 'Max positions reached' };
    }

    const quantity = risk.recommendedSize / signal.price;
    const order = createOrderFromSignal(signal, quantity);

    // Simulate fill with slippage
    const slippage = signal.action === 'BUY' ? 1 + this.config.defaultSlippage : 1 - this.config.defaultSlippage;
    const fillPrice = signal.price * slippage;
    const commission = fillPrice * quantity * this.config.defaultCommission;

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

      await eventBus.emit('order:filled', filledOrder, 'paper-trader');
      await eventBus.emit('position:opened', position, 'paper-trader');

      log.info(
        { symbol: signal.asset.symbol, side: 'buy', price: fillPrice, quantity, strategy: signal.strategy },
        'Paper trade executed'
      );

      return { order: filledOrder, position, portfolio: this.portfolio, success: true };
    } else {
      // SELL: close existing position
      const posIndex = this.portfolio.positions.findIndex(
        (p) => p.asset.symbol === signal.asset.symbol && p.status === 'open'
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

      await eventBus.emit('order:filled', filledOrder, 'paper-trader');
      await eventBus.emit('position:closed', position, 'paper-trader');

      log.info(
        { symbol: signal.asset.symbol, side: 'sell', price: fillPrice, pnl: pnl.toFixed(2), strategy: signal.strategy },
        'Paper position closed'
      );

      return { order: filledOrder, position, portfolio: this.portfolio, success: true };
    }
  }

  /**
   * Update all position prices (called on market data update).
   */
  updatePrices(prices: Map<string, number>): void {
    for (const pos of this.portfolio.positions) {
      const price = prices.get(pos.asset.symbol);
      if (price !== undefined) {
        pos.currentPrice = price;
        pos.unrealizedPnl = (price - pos.entryPrice) * pos.quantity;
      }
    }

    // Calculate total equity and drawdown
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

  /**
   * Check and trigger stop losses / take profits.
   */
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
      `=== Paper Trading Summary ===`,
      `Capital: $${p.capital.toFixed(2)}`,
      `Available: $${p.availableCapital.toFixed(2)}`,
      `Open Positions: ${p.positions.length}`,
      `Total P&L: $${p.totalPnl.toFixed(2)} (${p.totalPnlPct.toFixed(2)}%)`,
      `Max Drawdown: ${p.maxDrawdown.toFixed(2)}%`,
      `Total Orders: ${this.orderHistory.length}`,
    ].join('\n');
  }
}
