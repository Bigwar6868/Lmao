// ============================================================
// Stop-Loss / Take-Profit / Trailing Stop Management
// ============================================================

import { config } from '../../config/index.js';
import { roundTo } from '../../shared/utils.js';
import { createModuleLogger } from '../../shared/logger.js';

const log = createModuleLogger('StopLossManager');

export class StopLossManager {
  /**
   * ATR-based initial stop loss.
   *
   * Longs: entry - (atr * defaultStopLossAtr)
   * Shorts: entry + (atr * defaultStopLossAtr)
   */
  calculateStopLoss(
    entryPrice: number,
    side: 'buy' | 'sell',
    atr: number,
  ): number {
    const distance = atr * config.defaultStopLossAtr;
    const stop =
      side === 'buy'
        ? entryPrice - distance
        : entryPrice + distance;

    log.debug({ entryPrice, side, atr, distance, stop }, 'Stop loss calculated');
    return roundTo(Math.max(stop, 0), 6);
  }

  /**
   * ATR-based take profit.
   *
   * Longs: entry + (atr * defaultTakeProfitAtr)
   * Shorts: entry - (atr * defaultTakeProfitAtr)
   */
  calculateTakeProfit(
    entryPrice: number,
    side: 'buy' | 'sell',
    atr: number,
  ): number {
    const distance = atr * config.defaultTakeProfitAtr;
    const tp =
      side === 'buy'
        ? entryPrice + distance
        : entryPrice - distance;

    log.debug({ entryPrice, side, atr, distance, tp }, 'Take profit calculated');
    return roundTo(Math.max(tp, 0), 6);
  }

  /**
   * Trailing stop tracks the highest price observed.
   *
   * trailingStop = highestPrice - (atr * defaultStopLossAtr)
   */
  calculateTrailingStop(
    currentPrice: number,
    highestPrice: number,
    atr: number,
  ): number {
    const trailing = highestPrice - atr * config.defaultStopLossAtr;
    const stop = roundTo(Math.max(trailing, 0), 6);

    log.debug(
      { currentPrice, highestPrice, atr, stop },
      'Trailing stop calculated',
    );
    return stop;
  }

  /**
   * Determine whether the stop has been triggered.
   *
   * Long positions trigger when currentPrice <= stopPrice.
   * Short positions trigger when currentPrice >= stopPrice.
   */
  shouldTriggerStop(
    currentPrice: number,
    stopPrice: number,
    side: 'buy' | 'sell',
  ): boolean {
    const triggered =
      side === 'buy'
        ? currentPrice <= stopPrice
        : currentPrice >= stopPrice;

    if (triggered) {
      log.info({ currentPrice, stopPrice, side }, 'Stop triggered');
    }

    return triggered;
  }
}
