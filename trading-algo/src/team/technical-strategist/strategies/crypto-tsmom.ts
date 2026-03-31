/**
 * Crypto Time-Series Momentum (1-Week TSMOM)
 *
 * Based on:
 * - Liu & Tsyvinski (2021) — "Risks and Returns of Cryptocurrency" (NBER)
 * - Huang, Sangiorgi & Urquhart (2024) — Volume-weighted TSMOM in crypto
 *
 * Key findings:
 * - Crypto momentum persists for 1-8 weeks then reverses (shorter than FX/equities)
 * - 7-day lookback is optimal (not 12-month like traditional assets)
 * - Volume-weighted TSMOM achieves annualized Sharpe of ~2.17
 * - Long-only outperforms long-short in crypto (shorting is costly/risky)
 * - 50-day SMA crossover on BTC alone achieves Sharpe ~1.9
 *
 * Implementation:
 * 1. Compute 7-day (168 bar on 1h) trailing return
 * 2. Compute 50-bar SMA for trend confirmation
 * 3. Volume-weight the signal: high-volume momentum is more reliable
 * 4. Vol-scale positions inversely to 30-day realized vol
 * 5. Long-only bias (only short with very high confidence)
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
import { SMA, ATR } from '../indicators.js';
import { generateSignal } from '../signals.js';

const log = createModuleLogger('strategy:crypto-tsmom');

export class CryptoTSMOMStrategy implements Strategy {
  name = 'crypto-tsmom';
  config: StrategyConfig;
  dna: StrategyDNA;

  constructor(config?: Partial<StrategyConfig>) {
    this.config = {
      name: this.name,
      enabled: true,
      params: {},
      assetClasses: ['crypto'],
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
        // Lookback (in bars) — 7 days on 1h = 168 bars
        momentumLookback: 168,
        // Shorter confirmation lookback — 3 days
        shortLookback: 72,

        // SMA trend filter
        smaPeriod: 50,
        requireSmaAlign: 1,

        // Volume weighting
        volumeLookback: 20,
        volumeBoost: 0.15, // Extra confidence when vol > 1.5x avg

        // Volatility targeting
        targetVol: 0.15,     // 15% annualized target (higher for crypto)
        volLookback: 30,
        maxVolRatio: 4.0,    // Crypto can be very volatile

        // Signal thresholds
        minReturnThreshold: 0.005, // 0.5% minimum return for crypto
        longOnlyBias: 0.7,        // Confidence must be > 0.7 to short

        // Momentum decay — crypto mean-reverts faster
        maxHoldBars: 168, // 7 days on 1h — matches research on 1-8 week persistence
      },
      fitness: 0,
      createdAt: Date.now(),
      mutations: ['genesis'],
    };
  }

  async analyze(data: MarketData, _macro?: MacroEnvironment): Promise<Signal[]> {
    const { candles, asset, timeframe } = data;
    const p = this.dna.params;

    // Adjust lookback for timeframe
    const momentumLB = this.adjustForTimeframe(Math.round(p['momentumLookback'] ?? 168), timeframe);
    const shortLB = this.adjustForTimeframe(Math.round(p['shortLookback'] ?? 72), timeframe);
    const volLB = Math.round(p['volLookback'] ?? 30);
    const minCandles = Math.max(momentumLB, volLB) + 10;

    if (candles.length < minCandles) {
      return [];
    }

    const lastIdx = candles.length - 1;
    const price = candles[lastIdx].close;

    // 1. Compute trailing returns
    const momentumReturn = (price - candles[lastIdx - momentumLB].close) / candles[lastIdx - momentumLB].close;
    const shortReturn = (price - candles[lastIdx - shortLB].close) / candles[lastIdx - shortLB].close;

    // 2. Minimum return threshold
    const minReturn = p['minReturnThreshold'] ?? 0.005;
    if (Math.abs(momentumReturn) < minReturn) {
      return [generateSignal(asset, 'HOLD', 0, price, this.name, timeframe, {}, 'Insufficient crypto momentum')];
    }

    // 3. Compute realized volatility
    const returns: number[] = [];
    for (let i = lastIdx - volLB + 1; i <= lastIdx; i++) {
      returns.push((candles[i].close - candles[i - 1].close) / candles[i - 1].close);
    }
    const meanRet = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - meanRet) ** 2, 0) / (returns.length - 1);
    const realizedVol = Math.sqrt(variance);

    if (realizedVol <= 0) return [];

    const barsPerYear = this.getBarsPerYear(timeframe);
    const annualizedVol = realizedVol * Math.sqrt(barsPerYear);

    // Vol bounds
    const targetVol = p['targetVol'] ?? 0.15;
    const maxVolRatio = p['maxVolRatio'] ?? 4.0;
    const volRatio = annualizedVol / targetVol;

    if (volRatio > maxVolRatio) {
      return [generateSignal(asset, 'HOLD', 0, price, this.name, timeframe, {}, 'Crypto vol too extreme — crisis mode')];
    }

    // 4. SMA trend confirmation
    const requireSma = (p['requireSmaAlign'] ?? 1) > 0;
    if (requireSma) {
      const smaPeriod = Math.round(p['smaPeriod'] ?? 50);
      const smaValues = SMA(candles, smaPeriod);
      const smaVal = smaValues[lastIdx];
      if (!isNaN(smaVal)) {
        // For longs, price should be above SMA; for shorts, below
        if (momentumReturn > 0 && price < smaVal * 0.995) {
          return [generateSignal(asset, 'HOLD', 0, price, this.name, timeframe, {}, 'Bullish momentum but below SMA — no confirmation')];
        }
        if (momentumReturn < 0 && price > smaVal * 1.005) {
          return [generateSignal(asset, 'HOLD', 0, price, this.name, timeframe, {}, 'Bearish momentum but above SMA — no confirmation')];
        }
      }
    }

    // 5. Volume weighting — high volume confirms momentum
    const volLookback = Math.round(p['volumeLookback'] ?? 20);
    const avgVolume = candles.slice(lastIdx - volLookback, lastIdx).reduce((s, c) => s + c.volume, 0) / volLookback;
    const currentVolume = candles[lastIdx].volume;
    const volumeRatio = avgVolume > 0 ? currentVolume / avgVolume : 1;
    const volumeBoost = p['volumeBoost'] ?? 0.15;

    // 6. Determine signal direction
    // Long-only bias: only short with very high confidence
    const longOnlyBias = p['longOnlyBias'] ?? 0.7;
    const isBullish = momentumReturn > 0;

    if (!isBullish) {
      // For shorts, require very strong signal
      const shortConfidence = Math.abs(momentumReturn) / (annualizedVol + 0.001);
      if (shortConfidence < longOnlyBias) {
        return [generateSignal(asset, 'HOLD', 0, price, this.name, timeframe, {}, 'Bearish but below short threshold — long-only bias')];
      }
    }

    const action = isBullish ? 'BUY' : 'SELL';

    // 7. Confidence calculation
    const signalStrength = Math.min(3, Math.abs(momentumReturn) / (realizedVol + 0.001));
    const shortLongAgree = Math.sign(shortReturn) === Math.sign(momentumReturn);
    const volConfirm = volumeRatio >= 1.5;

    const confidence = Math.min(0.95, Math.max(0.4,
      0.40 +
      signalStrength * 0.12 +
      (shortLongAgree ? 0.10 : -0.05) +
      (volConfirm ? volumeBoost : 0) +
      (volRatio > 0.5 && volRatio < 2.5 ? 0.05 : 0),
    ));

    // 8. Vol-scaled position sizing info
    const volScale = Math.min(2, targetVol / annualizedVol);

    const reason = `Crypto TSMOM ${action}: 7d_ret=${(momentumReturn * 100).toFixed(2)}%, 3d_ret=${(shortReturn * 100).toFixed(2)}%, vol=${(annualizedVol * 100).toFixed(1)}%, vol_ratio=${volumeRatio.toFixed(1)}x`;

    return [generateSignal(asset, action, confidence, price, this.name, timeframe, {
      momentumReturn,
      shortReturn,
      realizedVol,
      annualizedVol,
      volumeRatio,
      volScaleFactor: volScale,
      signalStrength,
      shortLongAgree: shortLongAgree ? 1 : 0,
    }, reason)];
  }

  /** Adjust bar-based lookback for different timeframes */
  private adjustForTimeframe(bars1h: number, timeframe: string): number {
    switch (timeframe) {
      case '1h': return bars1h;
      case '4h': return Math.round(bars1h / 4);
      case '1d': return Math.round(bars1h / 24);
      default: return bars1h;
    }
  }

  private getBarsPerYear(timeframe: string): number {
    switch (timeframe) {
      case '1m': return 365 * 24 * 60;
      case '5m': return 365 * 24 * 12;
      case '15m': return 365 * 24 * 4;
      case '1h': return 365 * 24;
      case '4h': return 365 * 6;
      case '1d': return 365;
      case '1w': return 52;
      default: return 365 * 24;
    }
  }
}
