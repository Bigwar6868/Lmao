// ============================================================
// Position Sizing – ATR-adjusted, macro-aware
// ============================================================

import { config } from '../../config/index.js';
import { clamp, roundTo } from '../../shared/utils.js';
import { createModuleLogger } from '../../shared/logger.js';
import type { Signal, Portfolio, MacroEnvironment } from '../../shared/types.js';

const log = createModuleLogger('PositionSizer');

export class PositionSizer {
  /**
   * Calculate dollar amount to allocate to a new position.
   *
   * 1. Base size = kellyFraction * availableCapital
   * 2. ATR adjustment: scale inversely with volatility.
   *    - volatilityRatio = atr / price. The higher the ratio the smaller the position.
   *    - atrMultiplier = clamp(0.02 / volatilityRatio, 0.25, 1.0)
   * 3. Cap at maxPositionSizePct of total portfolio capital.
   */
  calculateSize(
    signal: Signal,
    portfolio: Portfolio,
    atr: number,
    kellyFraction: number,
  ): number {
    if (kellyFraction <= 0 || portfolio.availableCapital <= 0) {
      return 0;
    }

    // Step 1 – base size from Kelly
    const baseSize = kellyFraction * portfolio.availableCapital;

    // Step 2 – ATR volatility adjustment
    const volatilityRatio = atr / signal.price;
    // 0.02 is a "normal" volatility baseline (~2%)
    const atrMultiplier = clamp(0.02 / Math.max(volatilityRatio, 0.0001), 0.25, 1.0);
    const adjusted = baseSize * atrMultiplier;

    // Step 3 – hard cap at max position size
    const maxSize = (config.maxPositionSizePct / 100) * portfolio.capital;
    const finalSize = roundTo(Math.min(adjusted, maxSize), 2);

    log.debug(
      {
        kelly: kellyFraction,
        baseSize,
        atr,
        volatilityRatio,
        atrMultiplier,
        adjusted,
        maxSize,
        finalSize,
      },
      'Position size calculated',
    );

    return finalSize;
  }

  /**
   * Scale position size according to macro risk level.
   *
   * low      → 100%
   * medium   → 80%
   * high     → 50%
   * extreme  → 25%
   */
  adjustForMacro(size: number, macro: MacroEnvironment): number {
    const scaleMap: Record<MacroEnvironment['riskLevel'], number> = {
      low: 1.0,
      medium: 0.8,
      high: 0.5,
      extreme: 0.25,
    };

    const scale = scaleMap[macro.riskLevel];
    const adjusted = roundTo(size * scale, 2);

    log.debug(
      { riskLevel: macro.riskLevel, scale, original: size, adjusted },
      'Macro adjustment applied',
    );

    return adjusted;
  }
}
