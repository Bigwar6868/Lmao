import type { Candle, MacroEnvironment } from '../../shared/types.js';
import { mean, stdDev } from '../../shared/utils.js';
import { createModuleLogger } from '../../shared/logger.js';
import { eventBus } from '../../shared/events.js';

const log = createModuleLogger('regime-detector');

/**
 * Market regimes — each requires different strategy behavior.
 */
export type MarketRegime =
  | 'trending_bull'      // Strong uptrend, momentum strategies thrive
  | 'trending_bear'      // Strong downtrend, short/defensive
  | 'range_bound'        // Sideways chop, mean-reversion works
  | 'high_volatility'    // Explosive moves, reduce size, widen stops
  | 'low_volatility'     // Compression, breakout imminent
  | 'crisis'             // Crash/panic, preserve capital
  | 'recovery';          // Bounce from crisis, early momentum

export interface RegimeAnalysis {
  regime: MarketRegime;
  confidence: number;            // 0-1
  trendStrength: number;         // -1 (strong bear) to +1 (strong bull)
  volatilityPercentile: number;  // 0-100, current vol vs historical
  momentumScore: number;         // -1 to +1
  volumeProfile: 'increasing' | 'decreasing' | 'stable';
  correlationShift: boolean;     // true if cross-asset correlations are spiking (risk-off)
  details: string;
  recommendedStrategies: string[];
  timestamp: number;
}

/**
 * Market Regime Detector
 *
 * Identifies the current market regime by analyzing:
 * 1. Trend direction & strength (ADX-like, EMA slope)
 * 2. Volatility regime (ATR percentile, realized vs historical vol)
 * 3. Momentum (rate of change, acceleration)
 * 4. Volume patterns (accumulation vs distribution)
 * 5. Macro overlay (VIX, yield curve, Fed stance)
 */
export class RegimeDetector {
  /**
   * Detect current market regime from price data and macro context.
   */
  detect(candles: Candle[], macro?: MacroEnvironment): RegimeAnalysis {
    if (candles.length < 50) {
      return this.defaultRegime('Insufficient data');
    }

    const closes = candles.map((c) => c.close);
    const volumes = candles.map((c) => c.volume);

    // 1. Trend analysis
    const trendStrength = this.calculateTrendStrength(closes);

    // 2. Volatility analysis
    const volatilityPercentile = this.calculateVolatilityPercentile(candles);

    // 3. Momentum
    const momentumScore = this.calculateMomentum(closes);

    // 4. Volume profile
    const volumeProfile = this.analyzeVolumeProfile(volumes);

    // 5. Correlation shift (proxy: compare recent vol to long-term)
    const correlationShift = volatilityPercentile > 85;

    // 6. Macro overlay
    const macroRiskMultiplier = this.getMacroMultiplier(macro);

    // Determine regime
    const regime = this.classifyRegime(
      trendStrength, volatilityPercentile, momentumScore, macroRiskMultiplier
    );

    const confidence = this.calculateConfidence(
      trendStrength, volatilityPercentile, momentumScore
    );

    const analysis: RegimeAnalysis = {
      regime,
      confidence,
      trendStrength,
      volatilityPercentile,
      momentumScore,
      volumeProfile,
      correlationShift,
      details: this.describeRegime(regime, trendStrength, volatilityPercentile),
      recommendedStrategies: this.getRecommendedStrategies(regime),
      timestamp: Date.now(),
    };

    log.info({
      regime, confidence: confidence.toFixed(2),
      trend: trendStrength.toFixed(2), vol: volatilityPercentile.toFixed(0),
    }, 'Regime detected');

    return analysis;
  }

  /**
   * Trend strength: -1 (strong bear) to +1 (strong bull).
   * Uses EMA slope + price position relative to moving averages.
   */
  private calculateTrendStrength(closes: number[]): number {
    const len = closes.length;

    // Short-term EMA (20)
    const ema20 = this.ema(closes, 20);
    // Long-term EMA (50)
    const ema50 = this.ema(closes, Math.min(50, len - 1));

    const currentPrice = closes[len - 1];
    const ema20Current = ema20[ema20.length - 1];
    const ema50Current = ema50[ema50.length - 1];

    // Price vs EMAs
    const aboveShort = currentPrice > ema20Current ? 1 : -1;
    const aboveLong = currentPrice > ema50Current ? 1 : -1;

    // EMA slope (normalized rate of change over last 10 periods)
    const ema20Slope = ema20.length >= 10
      ? (ema20[ema20.length - 1] - ema20[ema20.length - 10]) / ema20[ema20.length - 10]
      : 0;

    // EMA alignment (short above long = bullish)
    const emaAlignment = ema20Current > ema50Current ? 1 : -1;

    // Composite: weighted sum, clamped to [-1, 1]
    const raw = (aboveShort * 0.2) + (aboveLong * 0.2) + (emaAlignment * 0.3) + (ema20Slope * 30 * 0.3);
    return Math.max(-1, Math.min(1, raw));
  }

  /**
   * Volatility percentile: where current ATR sits vs historical ATR distribution.
   * Returns 0-100.
   */
  private calculateVolatilityPercentile(candles: Candle[]): number {
    const atrs = this.rollingATR(candles, 14);
    if (atrs.length < 20) return 50;

    const currentATR = atrs[atrs.length - 1];
    const sorted = [...atrs].sort((a, b) => a - b);
    const rank = sorted.findIndex((v) => v >= currentATR);
    return (rank / sorted.length) * 100;
  }

  /**
   * Momentum score: rate of change + acceleration.
   * Returns -1 to +1.
   */
  private calculateMomentum(closes: number[]): number {
    const len = closes.length;
    if (len < 20) return 0;

    // 10-period rate of change
    const roc10 = (closes[len - 1] - closes[len - 11]) / closes[len - 11];
    // 20-period rate of change
    const roc20 = (closes[len - 1] - closes[len - 21]) / closes[len - 21];

    // Acceleration: is momentum increasing?
    const acceleration = roc10 - (roc20 / 2);

    // Normalize: typical ROC is ±5%, map to ±1
    const normalized = (roc10 * 10) + (acceleration * 5);
    return Math.max(-1, Math.min(1, normalized));
  }

  /**
   * Volume profile analysis.
   */
  private analyzeVolumeProfile(volumes: number[]): 'increasing' | 'decreasing' | 'stable' {
    if (volumes.length < 20) return 'stable';

    const recent = mean(volumes.slice(-10));
    const older = mean(volumes.slice(-20, -10));

    const change = (recent - older) / (older || 1);
    if (change > 0.15) return 'increasing';
    if (change < -0.15) return 'decreasing';
    return 'stable';
  }

  /**
   * Macro environment risk multiplier.
   */
  private getMacroMultiplier(macro?: MacroEnvironment): number {
    if (!macro) return 0;
    switch (macro.riskLevel) {
      case 'extreme': return -1;
      case 'high': return -0.5;
      case 'medium': return 0;
      case 'low': return 0.3;
      default: return 0;
    }
  }

  /**
   * Classify regime from computed signals.
   */
  private classifyRegime(
    trend: number,
    volPercentile: number,
    momentum: number,
    macroRisk: number
  ): MarketRegime {
    // Crisis: extreme volatility + negative momentum + negative macro
    if (volPercentile > 90 && momentum < -0.3 && macroRisk < -0.3) return 'crisis';

    // Recovery: coming off high vol, momentum turning positive
    if (volPercentile > 70 && volPercentile < 90 && momentum > 0.2 && trend > 0) return 'recovery';

    // High volatility: vol > 80th percentile
    if (volPercentile > 80) return 'high_volatility';

    // Low volatility: vol < 20th percentile (squeeze)
    if (volPercentile < 20) return 'low_volatility';

    // Trending bull
    if (trend > 0.4 && momentum > 0.1) return 'trending_bull';

    // Trending bear
    if (trend < -0.4 && momentum < -0.1) return 'trending_bear';

    // Default: range bound
    return 'range_bound';
  }

  /**
   * Confidence in regime classification.
   */
  private calculateConfidence(trend: number, vol: number, momentum: number): number {
    // Stronger signals = higher confidence
    const trendClarity = Math.abs(trend);
    const volExtreme = Math.abs(vol - 50) / 50; // How far from median
    const momentumClarity = Math.abs(momentum);

    return Math.min(1, (trendClarity * 0.4 + volExtreme * 0.3 + momentumClarity * 0.3));
  }

  /**
   * Human-readable regime description.
   */
  private describeRegime(regime: MarketRegime, trend: number, vol: number): string {
    const descriptions: Record<MarketRegime, string> = {
      trending_bull: `Strong uptrend (strength: ${(trend * 100).toFixed(0)}%). Momentum strategies favored. Ride the trend with trailing stops.`,
      trending_bear: `Strong downtrend (strength: ${(Math.abs(trend) * 100).toFixed(0)}%). Defensive posture. Consider shorts or stay cash.`,
      range_bound: `Sideways market. Mean-reversion strategies optimal. Trade the range with tight stops at boundaries.`,
      high_volatility: `Elevated volatility (${vol.toFixed(0)}th percentile). Reduce position sizes. Widen stops. Avoid over-leveraging.`,
      low_volatility: `Volatility compression (${vol.toFixed(0)}th percentile). Breakout imminent. Watch for squeeze resolution with volume confirmation.`,
      crisis: `CRISIS MODE. Capital preservation is priority #1. Reduce all exposure. Move to cash/stablecoins. Wait for stabilization.`,
      recovery: `Recovery phase. Early momentum building. Gradually increase exposure. Watch for false rallies.`,
    };
    return descriptions[regime];
  }

  /**
   * Which strategies work best in each regime.
   */
  private getRecommendedStrategies(regime: MarketRegime): string[] {
    const map: Record<MarketRegime, string[]> = {
      trending_bull: ['momentum', 'breakout'],
      trending_bear: ['momentum (short)', 'mean-reversion (oversold bounces)'],
      range_bound: ['mean-reversion', 'multi-indicator'],
      high_volatility: ['mean-reversion (wide bands)', 'reduce size'],
      low_volatility: ['breakout', 'squeeze detection'],
      crisis: ['CASH — no trading', 'hedge positions'],
      recovery: ['momentum (cautious)', 'breakout (confirmed volume)'],
    };
    return map[regime];
  }

  private defaultRegime(reason: string): RegimeAnalysis {
    return {
      regime: 'range_bound', confidence: 0.1, trendStrength: 0,
      volatilityPercentile: 50, momentumScore: 0, volumeProfile: 'stable',
      correlationShift: false, details: reason,
      recommendedStrategies: ['mean-reversion'], timestamp: Date.now(),
    };
  }

  // --- Helpers ---

  private ema(data: number[], period: number): number[] {
    if (data.length < period) return [data[data.length - 1] ?? 0];
    const multiplier = 2 / (period + 1);
    const result: number[] = [];
    let ema = mean(data.slice(0, period));
    result.push(ema);
    for (let i = period; i < data.length; i++) {
      ema = (data[i] - ema) * multiplier + ema;
      result.push(ema);
    }
    return result;
  }

  private rollingATR(candles: Candle[], period: number): number[] {
    const trs: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const tr = Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close)
      );
      trs.push(tr);
    }
    const atrs: number[] = [];
    if (trs.length < period) return trs;
    let atr = mean(trs.slice(0, period));
    atrs.push(atr);
    for (let i = period; i < trs.length; i++) {
      atr = (atr * (period - 1) + trs[i]) / period;
      atrs.push(atr);
    }
    return atrs;
  }
}
