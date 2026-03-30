// ============================================================
// Risk Manager – Facade that orchestrates all risk sub-modules
// ============================================================

import { config } from '../../config/index.js';
import { mean, roundTo } from '../../shared/utils.js';
import { createModuleLogger } from '../../shared/logger.js';
import { eventBus } from '../../shared/events.js';
import type {
  Signal,
  Portfolio,
  Candle,
  MacroEnvironment,
  RiskAssessment,
} from '../../shared/types.js';

import { KellyCriterion } from './kelly.js';
import { PositionSizer } from './position-sizing.js';
import { StopLossManager } from './stops.js';
import { PortfolioManager } from './portfolio.js';

export { KellyCriterion } from './kelly.js';
export { PositionSizer } from './position-sizing.js';
export { StopLossManager } from './stops.js';
export { PortfolioManager } from './portfolio.js';
export type { RiskLimits, PositionRisk, PortfolioRisk } from './types.js';

const log = createModuleLogger('RiskManager');

/** Maximum number of concurrent open positions. */
const MAX_OPEN_POSITIONS = 20;

/** Maximum percentage of portfolio capital exposed to a single asset. */
const MAX_EXPOSURE_PER_ASSET_PCT = 15;

/** Drawdown warning threshold (% of max). Emits risk:alert when crossed. */
const DRAWDOWN_WARN_PCT = 0.75;

/** Minimum confidence to approve a trade. Below this = HOLD. */
const MIN_CONFIDENCE = 0.55;

export class RiskManager {
  readonly kelly = new KellyCriterion();
  readonly sizer = new PositionSizer();
  readonly stops = new StopLossManager();
  readonly portfolioMgr = new PortfolioManager();

  // ------------------------------------------------------------------
  // Core risk assessment
  // ------------------------------------------------------------------

  /**
   * Produce a full RiskAssessment for a given signal.
   *
   * 1. Calculate ATR from recent candles.
   * 2. Derive Kelly fraction from portfolio trade history (fallback to default).
   * 3. Determine position size (ATR-adjusted, macro-adjusted).
   * 4. Compute stop-loss and take-profit levels.
   * 5. Run portfolio constraint checks.
   * 6. Return a complete RiskAssessment.
   */
  assessRisk(
    signal: Signal,
    portfolio: Portfolio,
    candles: Candle[],
    macro?: MacroEnvironment,
  ): RiskAssessment {
    // 1. ATR (Average True Range) from the last 14 candles
    const atr = this.calculateAtr(candles, 14);

    // 2. Kelly fraction – use a sensible default when no trade history exists
    const kellyFrac = config.kellyFraction * 0.5; // conservative default
    // (In a live system this would call kelly.calculateFromTrades on historical orders)

    // 3. Position size — scaled by signal confidence
    let positionSize = this.sizer.calculateSize(signal, portfolio, atr, kellyFrac);
    // Confidence scaling: high confidence (0.8+) → full size, low (0.55) → 60% size
    const confidenceScale = 0.5 + (signal.confidence * 0.5);
    positionSize = roundTo(positionSize * confidenceScale, 2);
    if (macro) {
      positionSize = this.sizer.adjustForMacro(positionSize, macro);
    }

    // 4. Stop loss & take profit — widen for high-confidence signals
    const side = signal.action === 'BUY' ? 'buy' as const : 'sell' as const;
    // High confidence → wider stops (give trade room), low confidence → tighter stops
    const stopMultiplier = 0.8 + (signal.confidence * 0.4); // 0.8x at conf=0, 1.2x at conf=1.0
    const stopLossPrice = this.stops.calculateStopLoss(signal.price, side, atr * stopMultiplier);
    // Higher R:R for high-confidence: 1.5:1 at low conf → 3:1 at high conf
    const tpMultiplier = 1.0 + (signal.confidence * 0.5); // 1.0x at conf=0, 1.5x at conf=1.0
    const takeProfitPrice = this.stops.calculateTakeProfit(signal.price, side, atr * tpMultiplier);

    // Risk-reward ratio
    const riskPerUnit = Math.abs(signal.price - stopLossPrice);
    const rewardPerUnit = Math.abs(takeProfitPrice - signal.price);
    const riskRewardRatio =
      riskPerUnit > 0 ? roundTo(rewardPerUnit / riskPerUnit, 2) : 0;

    // 5. Portfolio constraints
    const { allowed, reason } = this.isTradeAllowed(signal, portfolio);

    // Max position size (hard cap from config)
    const maxPositionSize = roundTo(
      (config.maxPositionSizePct / 100) * portfolio.capital,
      2,
    );

    // Emit warning if drawdown is approaching the limit
    this.checkDrawdownWarning(portfolio);

    const assessment: RiskAssessment = {
      maxPositionSize,
      recommendedSize: roundTo(positionSize, 2),
      stopLossPrice,
      takeProfitPrice,
      riskRewardRatio,
      kellyFraction: roundTo(kellyFrac, 4),
      approved: allowed && positionSize > 0 && signal.action !== 'HOLD' && signal.confidence >= MIN_CONFIDENCE,
      reason: !allowed
        ? reason
        : positionSize <= 0
          ? 'Position size is zero – insufficient capital or edge'
          : signal.action === 'HOLD'
            ? 'Signal is HOLD – no trade'
            : signal.confidence < MIN_CONFIDENCE
              ? `Confidence ${signal.confidence.toFixed(2)} below minimum ${MIN_CONFIDENCE} – skipping`
              : 'Trade approved',
    };

    log.info(
      {
        symbol: signal.asset.symbol,
        action: signal.action,
        approved: assessment.approved,
        size: assessment.recommendedSize,
        rr: assessment.riskRewardRatio,
      },
      'Risk assessment complete',
    );

    return assessment;
  }

  // ------------------------------------------------------------------
  // Trade gate-keeping
  // ------------------------------------------------------------------

  /**
   * Pre-flight checks before a trade can be placed.
   */
  isTradeAllowed(
    signal: Signal,
    portfolio: Portfolio,
  ): { allowed: boolean; reason: string } {
    // Drawdown limit
    if (this.portfolioMgr.isDrawdownExceeded(portfolio)) {
      return { allowed: false, reason: 'Maximum drawdown exceeded' };
    }

    // Max open positions
    const openCount = portfolio.positions.filter(
      (p) => p.status === 'open',
    ).length;
    if (openCount >= MAX_OPEN_POSITIONS) {
      return {
        allowed: false,
        reason: `Maximum open positions reached (${MAX_OPEN_POSITIONS})`,
      };
    }

    // Max exposure per asset
    const { byAsset } = this.portfolioMgr.getExposure(portfolio);
    const symbol = signal.asset.symbol;
    const currentExposure = byAsset.get(symbol) ?? 0;
    const exposurePct =
      portfolio.capital > 0 ? (currentExposure / portfolio.capital) * 100 : 0;

    if (exposurePct >= MAX_EXPOSURE_PER_ASSET_PCT) {
      return {
        allowed: false,
        reason: `Exposure to ${symbol} already at ${roundTo(exposurePct, 1)}% (limit ${MAX_EXPOSURE_PER_ASSET_PCT}%)`,
      };
    }

    return { allowed: true, reason: 'All checks passed' };
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  /**
   * Average True Range over `period` candles.
   */
  private calculateAtr(candles: Candle[], period: number): number {
    if (candles.length < 2) return 0;

    const trueRanges: number[] = [];
    const slice = candles.slice(-Math.min(candles.length, period + 1));

    for (let i = 1; i < slice.length; i++) {
      const curr = slice[i];
      const prevClose = slice[i - 1].close;
      const tr = Math.max(
        curr.high - curr.low,
        Math.abs(curr.high - prevClose),
        Math.abs(curr.low - prevClose),
      );
      trueRanges.push(tr);
    }

    return trueRanges.length > 0 ? roundTo(mean(trueRanges), 6) : 0;
  }

  /**
   * Emit a risk:alert event when drawdown approaches the configured maximum.
   */
  private checkDrawdownWarning(portfolio: Portfolio): void {
    const equity = this.getCurrentEquity(portfolio);
    const drawdownPct =
      portfolio.capital > 0
        ? ((portfolio.capital - equity) / portfolio.capital) * 100
        : 0;

    const warnThreshold = config.maxDrawdownPct * DRAWDOWN_WARN_PCT;

    if (drawdownPct >= warnThreshold) {
      const alertData = {
        drawdownPct: roundTo(drawdownPct, 2),
        maxDrawdownPct: config.maxDrawdownPct,
        message: `Drawdown at ${roundTo(drawdownPct, 2)}% – approaching ${config.maxDrawdownPct}% limit`,
      };

      log.warn(alertData, 'Drawdown warning');
      void eventBus.emit('risk:alert', alertData, 'RiskManager');
    }
  }

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
}
