// ============================================================
// Portfolio Management – Positions, exposure, drawdown
// ============================================================

import { config } from '../../config/index.js';
import { roundTo } from '../../shared/utils.js';
import { createModuleLogger } from '../../shared/logger.js';
import type { Portfolio, Position } from '../../shared/types.js';

const log = createModuleLogger('PortfolioManager');

export class PortfolioManager {
  /**
   * Bootstrap a fresh portfolio with the given initial capital.
   */
  createPortfolio(initialCapital: number): Portfolio {
    return {
      capital: initialCapital,
      availableCapital: initialCapital,
      positions: [],
      totalPnl: 0,
      totalPnlPct: 0,
      maxDrawdown: 0,
      lastUpdated: Date.now(),
    };
  }

  /**
   * Update the current price of a position and recalculate PnL.
   * Returns a new Portfolio object (immutable update).
   */
  updatePositionPrice(
    portfolio: Portfolio,
    symbol: string,
    price: number,
  ): Portfolio {
    const positions = portfolio.positions.map((pos) => {
      if (pos.asset.symbol !== symbol || pos.status !== 'open') return pos;

      const unrealizedPnl =
        pos.side === 'buy'
          ? (price - pos.entryPrice) * pos.quantity
          : (pos.entryPrice - price) * pos.quantity;

      return { ...pos, currentPrice: price, unrealizedPnl: roundTo(unrealizedPnl, 2) };
    });

    return this.recalculate({ ...portfolio, positions });
  }

  /**
   * Add a new position to the portfolio.
   */
  addPosition(portfolio: Portfolio, position: Position): Portfolio {
    const positionCost = position.entryPrice * position.quantity;
    const availableCapital = roundTo(portfolio.availableCapital - positionCost, 2);

    if (availableCapital < 0) {
      log.warn(
        { positionCost, availableCapital: portfolio.availableCapital },
        'Insufficient capital for new position',
      );
    }

    const updated: Portfolio = {
      ...portfolio,
      positions: [...portfolio.positions, position],
      availableCapital: Math.max(availableCapital, 0),
    };

    log.info(
      { symbol: position.asset.symbol, side: position.side, quantity: position.quantity },
      'Position added',
    );

    return this.recalculate(updated);
  }

  /**
   * Close a position, realise PnL and free capital.
   */
  closePosition(
    portfolio: Portfolio,
    positionId: string,
    exitPrice: number,
  ): Portfolio {
    const positions = portfolio.positions.map((pos) => {
      if (pos.id !== positionId || pos.status !== 'open') return pos;

      const realizedPnl =
        pos.side === 'buy'
          ? (exitPrice - pos.entryPrice) * pos.quantity
          : (pos.entryPrice - exitPrice) * pos.quantity;

      return {
        ...pos,
        currentPrice: exitPrice,
        unrealizedPnl: 0,
        realizedPnl: roundTo(pos.realizedPnl + realizedPnl, 2),
        status: 'closed' as const,
        closedAt: Date.now(),
      };
    });

    // Free up capital from the closed position
    const closedPos = portfolio.positions.find((p) => p.id === positionId);
    const freedCapital = closedPos
      ? closedPos.entryPrice * closedPos.quantity
      : 0;
    const closedPnl = closedPos
      ? closedPos.side === 'buy'
        ? (exitPrice - closedPos.entryPrice) * closedPos.quantity
        : (closedPos.entryPrice - exitPrice) * closedPos.quantity
      : 0;

    const updated: Portfolio = {
      ...portfolio,
      positions,
      availableCapital: roundTo(
        portfolio.availableCapital + freedCapital + closedPnl,
        2,
      ),
    };

    log.info(
      { positionId, exitPrice, closedPnl: roundTo(closedPnl, 2) },
      'Position closed',
    );

    return this.recalculate(updated);
  }

  /**
   * Return total and per-asset exposure (dollar amounts).
   */
  getExposure(portfolio: Portfolio): {
    total: number;
    byAsset: Map<string, number>;
  } {
    const byAsset = new Map<string, number>();
    let total = 0;

    for (const pos of portfolio.positions) {
      if (pos.status !== 'open') continue;
      const exposure = pos.currentPrice * pos.quantity;
      total += exposure;
      const symbol = pos.asset.symbol;
      byAsset.set(symbol, (byAsset.get(symbol) ?? 0) + exposure);
    }

    return { total: roundTo(total, 2), byAsset };
  }

  /**
   * Check whether the portfolio's drawdown exceeds the configured limit.
   */
  isDrawdownExceeded(portfolio: Portfolio): boolean {
    const peakCapital = portfolio.capital; // initial capital acts as peak
    const currentEquity = this.getCurrentEquity(portfolio);
    const drawdownPct =
      peakCapital > 0 ? ((peakCapital - currentEquity) / peakCapital) * 100 : 0;

    return drawdownPct > config.maxDrawdownPct;
  }

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------

  private getCurrentEquity(portfolio: Portfolio): number {
    const unrealized = portfolio.positions
      .filter((p) => p.status === 'open')
      .reduce((sum, p) => sum + p.unrealizedPnl, 0);
    const realized = portfolio.positions.reduce(
      (sum, p) => sum + p.realizedPnl,
      0,
    );
    return portfolio.capital + realized + unrealized;
  }

  private recalculate(portfolio: Portfolio): Portfolio {
    const equity = this.getCurrentEquity(portfolio);
    const totalPnl = roundTo(equity - portfolio.capital, 2);
    const totalPnlPct =
      portfolio.capital > 0
        ? roundTo((totalPnl / portfolio.capital) * 100, 2)
        : 0;

    const drawdown =
      portfolio.capital > 0
        ? roundTo(
            Math.max(
              ((portfolio.capital - equity) / portfolio.capital) * 100,
              0,
            ),
            2,
          )
        : 0;

    const maxDrawdown = Math.max(portfolio.maxDrawdown, drawdown);

    return {
      ...portfolio,
      totalPnl,
      totalPnlPct,
      maxDrawdown,
      lastUpdated: Date.now(),
    };
  }
}
