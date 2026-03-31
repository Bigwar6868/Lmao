/**
 * Time-Series Momentum (TSMOM) Strategy
 *
 * Based on Moskowitz, Ooi & Pedersen (2012) — "Time Series Momentum"
 * Published in Journal of Financial Economics.
 *
 * Core finding: Assets that performed well over the past 1-12 months
 * continue to perform well, and vice versa. This is the single most
 * robust factor across all asset classes.
 *
 * FX-specific: Menkhoff et al. (2012) confirmed TSMOM in currencies
 * with Sharpe ratios of 0.5-0.8 using 1-month to 12-month lookbacks.
 *
 * Implementation:
 * 1. Compute cumulative return over lookback period (default: 20 bars = ~1 month on 1h)
 * 2. Compute volatility (realized vol) over same period
 * 3. Signal = sign(return) — go long if positive, short if negative
 * 4. Position size = target_vol / realized_vol (volatility scaling)
 * 5. Combine with exponential decay for recency weighting
 *
 * Key insight: Volatility-scaling is crucial. Without it, Sharpe drops ~40%.
 * The strategy is NOT about prediction — it's about persistence of trends.
 */

import type {
  MarketData,
  MacroEnvironment,
  Signal,
  Strategy,
  StrategyConfig,
  StrategyDNA,
} from '../../../shared/types.js';
import { generateId } from '../../../shared/utils.js';
import { createModuleLogger } from '../../../shared/logger.js';
import { EMA, ATR } from '../indicators.js';
import { generateSignal } from '../signals.js';

const log = createModuleLogger('strategy:tsmom');

export class TSMOMStrategy implements Strategy {
  name = 'tsmom';
  config: StrategyConfig;
  dna: StrategyDNA;

  constructor(config?: Partial<StrategyConfig>) {
    this.config = {
      name: this.name,
      enabled: true,
      params: {},
      assetClasses: ['crypto', 'forex'],
      timeframes: ['1h', '4h', '1d'],
      ...config,
    };
    this.dna = this.getDefaultDNA();
  }

  getDefaultDNA(): StrategyDNA {
    return {
      id: generateId(),
      name: this.name,
      generation: 0,
      parentId: null,
      params: {
        // Lookback periods (in bars)
        shortLookback: 12,    // 12 bars (~12h on 1h TF) — fast signal
        longLookback: 48,     // 48 bars (~2 days on 1h TF) — trend confirmation
        volLookback: 20,      // 20 bars for vol estimation

        // Signal thresholds
        minReturnThreshold: 0.002,  // Minimum 0.2% return to generate signal
        minVolRatio: 0.5,           // Minimum vol ratio to trade
        maxVolRatio: 3.0,           // Maximum vol ratio (avoid crisis)

        // Volatility targeting
        targetVol: 0.10,      // 10% annualized target vol
        volScaling: 1,        // 1 = on, 0 = off

        // Trend confirmation
        trendEmaPeriod: 50,   // Require price above/below EMA for trend
        requireTrendAlign: 1, // 1 = require EMA alignment

        // Decay weighting
        decayFactor: 0.95,    // Exponential decay for recency
      },
      fitness: 0,
      createdAt: Date.now(),
      mutations: ['genesis'],
    };
  }

  async analyze(data: MarketData, _macro?: MacroEnvironment): Promise<Signal[]> {
    const { candles, asset, timeframe } = data;
    const p = this.dna.params;

    const shortLB = Math.round(p['shortLookback'] ?? 12);
    const longLB = Math.round(p['longLookback'] ?? 48);
    const volLB = Math.round(p['volLookback'] ?? 20);
    const minCandles = Math.max(longLB, volLB) + 10;

    if (candles.length < minCandles) {
      return [];
    }

    const lastIdx = candles.length - 1;
    const price = candles[lastIdx].close;

    // 1. Compute returns over lookback periods
    const shortReturn = (price - candles[lastIdx - shortLB].close) / candles[lastIdx - shortLB].close;
    const longReturn = (price - candles[lastIdx - longLB].close) / candles[lastIdx - longLB].close;

    // 2. Compute realized volatility (annualized)
    const returns: number[] = [];
    for (let i = lastIdx - volLB + 1; i <= lastIdx; i++) {
      returns.push((candles[i].close - candles[i - 1].close) / candles[i - 1].close);
    }
    const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / (returns.length - 1);
    const realizedVol = Math.sqrt(variance);

    if (realizedVol <= 0) return [];

    // Annualize (assume ~252 trading days, adjust by timeframe)
    const barsPerYear = this.getBarsPerYear(timeframe);
    const annualizedVol = realizedVol * Math.sqrt(barsPerYear);

    // 3. Check volatility bounds
    const minVol = p['minVolRatio'] ?? 0.5;
    const maxVol = p['maxVolRatio'] ?? 3.0;
    const targetVol = p['targetVol'] ?? 0.10;
    const volRatio = annualizedVol / targetVol;

    if (volRatio < minVol) {
      return [generateSignal(asset, 'HOLD', 0, price, this.name, timeframe, {}, 'Volatility too low — no momentum signal')];
    }
    if (volRatio > maxVol) {
      return [generateSignal(asset, 'HOLD', 0, price, this.name, timeframe, {}, 'Volatility too high — crisis regime')];
    }

    // 4. Minimum return threshold
    const minReturn = p['minReturnThreshold'] ?? 0.002;
    if (Math.abs(shortReturn) < minReturn && Math.abs(longReturn) < minReturn) {
      return [generateSignal(asset, 'HOLD', 0, price, this.name, timeframe, {}, 'Insufficient momentum')];
    }

    // 5. TSMOM signal: exponentially-weighted combination of short and long returns
    const decay = p['decayFactor'] ?? 0.95;
    const weightedReturn = shortReturn * (1 - decay) + longReturn * decay;
    // Normalize by volatility — this is the key Moskowitz insight
    const volNormSignal = weightedReturn / realizedVol;

    // 6. Trend confirmation (optional)
    const requireTrend = (p['requireTrendAlign'] ?? 1) > 0;
    if (requireTrend) {
      const trendEma = EMA(candles, Math.round(p['trendEmaPeriod'] ?? 50)).values;
      const trendVal = trendEma[lastIdx];
      if (trendVal) {
        if (volNormSignal > 0 && price < trendVal * 0.998) {
          return [generateSignal(asset, 'HOLD', 0, price, this.name, timeframe, {}, 'TSMOM bullish but below EMA trend')];
        }
        if (volNormSignal < 0 && price > trendVal * 1.002) {
          return [generateSignal(asset, 'HOLD', 0, price, this.name, timeframe, {}, 'TSMOM bearish but above EMA trend')];
        }
      }
    }

    // 7. Determine action and confidence
    const action = volNormSignal > 0 ? 'BUY' : 'SELL';

    // Confidence: based on signal strength, vol-normalization, and trend agreement
    const signalStrength = Math.min(3, Math.abs(volNormSignal)); // cap at 3 sigma
    const shortLongAgree = Math.sign(shortReturn) === Math.sign(longReturn);

    const confidence = Math.min(0.95, Math.max(0.35,
      0.35 +
      signalStrength * 0.15 +             // stronger signal = higher confidence
      (shortLongAgree ? 0.1 : -0.05) +    // agreement boost
      (volRatio > 0.8 && volRatio < 2.0 ? 0.05 : 0)  // ideal vol regime
    ));

    // 8. Volatility-scaled ATR stops
    const atrResult = ATR(candles, 14);
    const atr = atrResult.values[lastIdx] ?? price * 0.01;
    const volScale = (p['volScaling'] ?? 1) > 0 ? Math.min(2, targetVol / annualizedVol) : 1;

    const reason = `TSMOM ${action}: short_ret=${(shortReturn * 100).toFixed(2)}%, long_ret=${(longReturn * 100).toFixed(2)}%, vol_norm=${volNormSignal.toFixed(2)}σ, ann_vol=${(annualizedVol * 100).toFixed(1)}%`;

    return [generateSignal(asset, action, confidence, price, this.name, timeframe, {
      shortReturn,
      longReturn,
      realizedVol,
      annualizedVol,
      volNormSignal,
      volScaleFactor: volScale,
      signalStrength,
      shortLongAgree: shortLongAgree ? 1 : 0,
    }, reason)];
  }

  private getBarsPerYear(timeframe: string): number {
    switch (timeframe) {
      case '1m': return 252 * 24 * 60;
      case '5m': return 252 * 24 * 12;
      case '15m': return 252 * 24 * 4;
      case '1h': return 252 * 24;
      case '4h': return 252 * 6;
      case '1d': return 252;
      case '1w': return 52;
      default: return 252 * 24;
    }
  }
}
