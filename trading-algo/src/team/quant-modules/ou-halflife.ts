import type { Candle } from '../../shared/types.js';
import { createModuleLogger } from '../../shared/logger.js';
import { mean } from '../../shared/utils.js';

const log = createModuleLogger('ou-halflife');

/** Half-life analysis for a single asset */
export interface HalfLifeResult {
  symbol: string;
  halfLife: number;           // in periods (candles)
  halfLifeDays: number;       // approximate days (assuming 1h candles)
  lambda: number;             // mean-reversion speed (negative = reverts)
  isMeanReverting: boolean;   // ADF-like test: lambda significantly negative
  suitableForMR: boolean;     // half-life in tradeable range (5-30 days)
  confidence: number;         // R² of the regression
  recommendation: string;
}

/**
 * Ornstein-Uhlenbeck Half-Life Calculator
 *
 * The OU process: dX(t) = θ(μ - X(t))dt + σdW(t)
 * Half-life: H = -ln(2) / λ, where λ is the regression slope of ΔX(t) on X(t-1)
 *
 * For mean-reversion trading:
 * - Half-life < 5 days: too fast, eaten by spreads
 * - Half-life 5-30 days: sweet spot for MR strategies
 * - Half-life > 30 days: too slow, capital locked too long
 * - Half-life > 90 days or positive λ: not mean-reverting
 */
export class OUHalfLifeFilter {
  /** Maximum half-life (days) to consider suitable for MR trading */
  private readonly maxHalfLifeDays: number;
  /** Minimum half-life (days) — below this, spreads eat the edge */
  private readonly minHalfLifeDays: number;
  /** Periods per day (24 for 1h candles) */
  private readonly periodsPerDay: number;

  /** Cache of computed half-lives per symbol */
  private cache = new Map<string, { result: HalfLifeResult; computedAt: number }>();
  private readonly cacheTtlMs = 60 * 60 * 1000; // 1 hour

  constructor(minDays = 3, maxDays = 40, periodsPerDay = 24) {
    this.minHalfLifeDays = minDays;
    this.maxHalfLifeDays = maxDays;
    this.periodsPerDay = periodsPerDay;
  }

  /**
   * Compute OU half-life for an asset.
   */
  compute(symbol: string, candles: Candle[]): HalfLifeResult {
    // Check cache
    const cached = this.cache.get(symbol);
    if (cached && Date.now() - cached.computedAt < this.cacheTtlMs) {
      return cached.result;
    }

    if (candles.length < 50) {
      const result = this.insufficientData(symbol);
      this.cache.set(symbol, { result, computedAt: Date.now() });
      return result;
    }

    const closes = candles.map(c => c.close);

    // Step 1: Compute log prices (OU process works better on logs)
    const logPrices = closes.map(c => Math.log(c));

    // Step 2: Run ADF-like regression: ΔX(t) = λ * X(t-1) + ε
    // X(t) - X(t-1) = λ * X(t-1) + intercept + ε
    const { lambda, rSquared } = this.regressDelta(logPrices);

    // Step 3: Compute half-life
    const halfLifePeriods = lambda < 0 ? -Math.LN2 / lambda : Infinity;
    const halfLifeDays = halfLifePeriods / this.periodsPerDay;

    // Step 4: ADF significance check (simplified)
    // If lambda is not significantly negative, the series is not mean-reverting
    const isMeanReverting = lambda < -0.001 && rSquared > 0.001;

    // Step 5: Suitability check
    const suitableForMR = isMeanReverting &&
      halfLifeDays >= this.minHalfLifeDays &&
      halfLifeDays <= this.maxHalfLifeDays;

    let recommendation: string;
    if (!isMeanReverting) {
      recommendation = 'Not mean-reverting — skip for MR strategies';
    } else if (halfLifeDays < this.minHalfLifeDays) {
      recommendation = `Half-life too short (${halfLifeDays.toFixed(1)}d) — spreads will eat the edge`;
    } else if (halfLifeDays > this.maxHalfLifeDays) {
      recommendation = `Half-life too long (${halfLifeDays.toFixed(1)}d) — capital locked too long`;
    } else {
      recommendation = `Good MR candidate (H=${halfLifeDays.toFixed(1)}d) — proceed with mean-reversion`;
    }

    const result: HalfLifeResult = {
      symbol,
      halfLife: halfLifePeriods,
      halfLifeDays,
      lambda,
      isMeanReverting,
      suitableForMR,
      confidence: rSquared,
      recommendation,
    };

    this.cache.set(symbol, { result, computedAt: Date.now() });

    log.info({
      symbol,
      halfLifeDays: halfLifeDays.toFixed(1),
      lambda: lambda.toFixed(6),
      suitable: suitableForMR,
    }, 'OU half-life computed');

    return result;
  }

  /**
   * Batch compute for multiple assets. Returns only MR-suitable pairs.
   */
  filterSuitablePairs(assets: Map<string, Candle[]>): HalfLifeResult[] {
    const results: HalfLifeResult[] = [];
    for (const [symbol, candles] of assets) {
      const result = this.compute(symbol, candles);
      results.push(result);
    }
    return results;
  }

  /**
   * Get suitability score for a symbol (0-1).
   * Used by the AI decision layer to weight MR strategy allocation.
   */
  getSuitabilityScore(symbol: string): number {
    const cached = this.cache.get(symbol);
    if (!cached) return 0.5; // unknown, default moderate

    const r = cached.result;
    if (!r.isMeanReverting) return 0;
    if (!r.suitableForMR) return 0.2;

    // Ideal half-life is ~10-20 days. Score peaks there.
    const idealHL = 15;
    const distance = Math.abs(r.halfLifeDays - idealHL) / idealHL;
    return Math.max(0.3, 1 - distance) * Math.min(1, r.confidence * 10);
  }

  /**
   * OLS regression: ΔX(t) = λ * X(t-1) + intercept
   * Returns lambda (mean-reversion speed) and R².
   */
  private regressDelta(series: number[]): { lambda: number; rSquared: number; intercept: number } {
    const n = series.length - 1;
    if (n < 10) return { lambda: 0, rSquared: 0, intercept: 0 };

    // y = ΔX(t) = X(t) - X(t-1)
    // x = X(t-1)
    const x: number[] = [];
    const y: number[] = [];
    for (let i = 1; i < series.length; i++) {
      x.push(series[i - 1]);
      y.push(series[i] - series[i - 1]);
    }

    // OLS: y = a + b*x
    const meanX = mean(x);
    const meanY = mean(y);

    let ssXY = 0, ssXX = 0, ssTot = 0, ssRes = 0;
    for (let i = 0; i < n; i++) {
      ssXY += (x[i] - meanX) * (y[i] - meanY);
      ssXX += (x[i] - meanX) ** 2;
    }

    const lambda = ssXX > 0 ? ssXY / ssXX : 0;
    const intercept = meanY - lambda * meanX;

    // R²
    for (let i = 0; i < n; i++) {
      const predicted = intercept + lambda * x[i];
      ssRes += (y[i] - predicted) ** 2;
      ssTot += (y[i] - meanY) ** 2;
    }

    const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0;

    return { lambda, rSquared, intercept };
  }

  private insufficientData(symbol: string): HalfLifeResult {
    return {
      symbol,
      halfLife: Infinity,
      halfLifeDays: Infinity,
      lambda: 0,
      isMeanReverting: false,
      suitableForMR: false,
      confidence: 0,
      recommendation: 'Insufficient data for OU analysis',
    };
  }

  /** Format results table */
  static formatReport(results: HalfLifeResult[]): string {
    if (results.length === 0) return '\nNo OU half-life data available.\n';

    const lines: string[] = ['\n=== OU HALF-LIFE FILTER ===\n'];
    const suitable = results.filter(r => r.suitableForMR);
    const unsuitable = results.filter(r => !r.suitableForMR);

    if (suitable.length > 0) {
      lines.push('MR-Suitable pairs:');
      for (const r of suitable.sort((a, b) => a.halfLifeDays - b.halfLifeDays)) {
        lines.push(`  [OK] ${r.symbol.padEnd(12)} H=${r.halfLifeDays.toFixed(1)}d | λ=${r.lambda.toFixed(5)} | R²=${r.confidence.toFixed(4)}`);
      }
    }

    if (unsuitable.length > 0) {
      lines.push(`\nFiltered out (${unsuitable.length} pairs):`);
      for (const r of unsuitable.slice(0, 10)) {
        const reason = !r.isMeanReverting ? 'not MR' : r.halfLifeDays < 3 ? 'too fast' : 'too slow';
        lines.push(`  [--] ${r.symbol.padEnd(12)} H=${isFinite(r.halfLifeDays) ? r.halfLifeDays.toFixed(1) + 'd' : 'inf'} (${reason})`);
      }
      if (unsuitable.length > 10) lines.push(`  ... and ${unsuitable.length - 10} more`);
    }

    return lines.join('\n');
  }
}
