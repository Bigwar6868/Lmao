// ============================================================
// Kelly Criterion – Optimal position sizing
// ============================================================

import { config } from '../../config/index.js';
import { clamp } from '../../shared/utils.js';
import { createModuleLogger } from '../../shared/logger.js';
import type { Order } from '../../shared/types.js';

const log = createModuleLogger('KellyCriterion');

export class KellyCriterion {
  /**
   * Calculate fractional Kelly sizing.
   *
   * f* = (p * b - q) / b
   *   p = winRate, q = 1 - p, b = avgWin / avgLoss
   *
   * Result is multiplied by config.kellyFraction (half-Kelly by default)
   * and clamped to [0, 0.25].
   */
  calculate(winRate: number, avgWin: number, avgLoss: number): number {
    if (avgLoss === 0 || avgWin === 0 || winRate <= 0 || winRate >= 1) {
      log.warn({ winRate, avgWin, avgLoss }, 'Invalid inputs – returning 0');
      return 0;
    }

    const p = winRate;
    const q = 1 - p;
    const b = avgWin / avgLoss;

    const fullKelly = (p * b - q) / b;
    const fractionalKelly = fullKelly * config.kellyFraction;
    const clamped = clamp(fractionalKelly, 0, 0.25);

    log.debug(
      { p, q, b, fullKelly, fractionalKelly, clamped },
      'Kelly calculation',
    );

    return clamped;
  }

  /**
   * Derive Kelly fraction from a set of historical trades.
   */
  calculateFromTrades(trades: Order[]): number {
    const filled = trades.filter(
      (t) =>
        t.status === 'filled' &&
        t.filledPrice !== undefined &&
        t.price !== undefined,
    );

    if (filled.length === 0) {
      log.warn('No filled trades – returning 0');
      return 0;
    }

    let wins = 0;
    let totalWin = 0;
    let losses = 0;
    let totalLoss = 0;

    for (const trade of filled) {
      const entry = trade.price!;
      const exit = trade.filledPrice!;
      const pnl =
        trade.side === 'buy' ? exit - entry : entry - exit;

      if (pnl > 0) {
        wins++;
        totalWin += pnl;
      } else if (pnl < 0) {
        losses++;
        totalLoss += Math.abs(pnl);
      }
    }

    if (wins === 0 || losses === 0) {
      log.warn({ wins, losses }, 'Insufficient win/loss data – returning 0');
      return 0;
    }

    const winRate = wins / (wins + losses);
    const avgWin = totalWin / wins;
    const avgLoss = totalLoss / losses;

    return this.calculate(winRate, avgWin, avgLoss);
  }
}
