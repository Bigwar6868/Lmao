// ============================================================
// Position Sizing – ATR-adjusted, spread-adjusted, macro-aware
// ============================================================

import { config } from '../../config/index.js';
import { clamp, roundTo } from '../../shared/utils.js';
import { createModuleLogger } from '../../shared/logger.js';
import type { Signal, Portfolio, MacroEnvironment } from '../../shared/types.js';

const log = createModuleLogger('PositionSizer');

/**
 * Default spread baselines per asset class (in price units as fraction of price).
 * Used to normalise the 1/spread multiplier so "average" spread → multiplier ≈ 1.0.
 */
const SPREAD_BASELINE: Record<string, number> = {
  // Forex majors: ~1-2 pips on a 1.xxxx price ≈ 0.00015 relative
  forex: 0.00015,
  // Crypto: ~0.05-0.1% of price
  crypto: 0.0005,
};

export class PositionSizer {
  /**
   * Calculate dollar amount to allocate to a new position.
   *
   * 1. Base size = kellyFraction * availableCapital
   * 2. ATR adjustment: scale inversely with volatility.
   *    - volatilityRatio = atr / price. The higher the ratio the smaller the position.
   *    - atrMultiplier = clamp(0.02 / volatilityRatio, 0.25, 1.0)
   * 3. Spread adjustment (1/spread model from financial modelling):
   *    - spreadRatio = spread / price  (normalised spread)
   *    - spreadMultiplier = clamp(baseline / spreadRatio, 0.1, 2.0)
   *    - Tighter spread → larger position, wider spread → smaller position
   *    - Captures the idea that transaction cost is part of sizing: low-cost
   *      instruments can bear larger positions profitably.
   * 4. Cap at maxPositionSizePct of total portfolio capital.
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
    let adjusted = baseSize * atrMultiplier;

    // Step 3 – Spread-inverse adjustment (1/spread)
    const spreadMultiplier = this.calculateSpreadMultiplier(signal);
    adjusted *= spreadMultiplier;

    // Step 4 – hard cap at max position size
    const maxSize = (config.maxPositionSizePct / 100) * portfolio.capital;
    const finalSize = roundTo(Math.min(adjusted, maxSize), 2);

    log.debug(
      {
        kelly: kellyFraction,
        baseSize,
        atr,
        volatilityRatio,
        atrMultiplier,
        spread: signal.spread,
        spreadMultiplier,
        adjusted,
        maxSize,
        finalSize,
      },
      'Position size calculated',
    );

    return finalSize;
  }

  /**
   * Spread-inverse sizing: units ∝ 1/spread.
   *
   * Financial modelling concept: the spread is the minimum cost of a
   * round-trip. By sizing inversely to the spread we:
   *  - Allocate more capital to tight-spread (liquid) instruments
   *  - Reduce exposure on wide-spread (illiquid/exotic) instruments
   *  - Normalise transaction-cost drag across the portfolio
   *
   * Returns a multiplier (0.1 – 2.0) centred around 1.0 for "normal" spread.
   */
  calculateSpreadMultiplier(signal: Signal): number {
    if (!signal.spread || signal.spread <= 0 || signal.price <= 0) {
      return 1.0; // No spread data → no adjustment
    }

    const spreadRatio = signal.spread / signal.price;
    const baseline = SPREAD_BASELINE[signal.asset.assetClass] ?? 0.0003;

    // 1/spread normalised: baseline / actual = multiplier
    // Tight spread (ratio < baseline) → multiplier > 1.0 → larger position
    // Wide spread (ratio > baseline) → multiplier < 1.0 → smaller position
    const multiplier = clamp(baseline / Math.max(spreadRatio, 0.000001), 0.1, 2.0);

    log.debug(
      {
        symbol: signal.asset.symbol,
        spread: signal.spread,
        spreadRatio: roundTo(spreadRatio, 8),
        baseline,
        multiplier: roundTo(multiplier, 4),
      },
      'Spread-inverse adjustment',
    );

    return multiplier;
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
