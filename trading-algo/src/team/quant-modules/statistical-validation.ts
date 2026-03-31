import type { PerformanceMetrics } from '../../shared/types.js';
import { createModuleLogger } from '../../shared/logger.js';
import { mean, stdDev } from '../../shared/utils.js';

const log = createModuleLogger('stat-validation');

/** Walk-Forward Efficiency result */
export interface WFEResult {
  strategy: string;
  inSampleReturn: number;
  outOfSampleReturn: number;
  wfe: number;                    // OOS / IS ratio (0-1+ range)
  windows: number;
  verdict: 'robust' | 'acceptable' | 'suspicious' | 'overfitting';
  details: string;
}

/** Deflated Sharpe Ratio result */
export interface DeflatedSharpeResult {
  strategy: string;
  observedSharpe: number;
  deflatedSharpe: number;
  expectedMaxSharpe: number;      // E[max SR] from N trials
  pValue: number;                 // probability of observing this SR by chance
  totalTrials: number;
  isSignificant: boolean;         // deflated SR > 0 and p < 0.05
  details: string;
}

/**
 * Statistical Validation Module
 *
 * 1. Walk-Forward Efficiency (WFE): measures OOS/IS return ratio.
 *    Goldilocks zone: 50-85%. Below 40% = overfitting. Above 100% = suspicious.
 *
 * 2. Deflated Sharpe Ratio (DSR): corrects observed Sharpe for:
 *    - Selection bias (best of N trials)
 *    - Non-normal returns (skewness, kurtosis)
 *    Based on Bailey & López de Prado (2014).
 */
export class StatisticalValidator {
  /** Record of all backtest trials per strategy (for DSR) */
  private trialHistory = new Map<string, number[]>(); // strategy → array of Sharpe ratios

  /**
   * Compute Walk-Forward Efficiency from IS and OOS results.
   */
  computeWFE(
    strategy: string,
    inSampleResults: PerformanceMetrics[],
    outOfSampleResults: PerformanceMetrics[],
  ): WFEResult {
    if (inSampleResults.length === 0 || outOfSampleResults.length === 0) {
      return {
        strategy,
        inSampleReturn: 0,
        outOfSampleReturn: 0,
        wfe: 0,
        windows: 0,
        verdict: 'overfitting',
        details: 'Insufficient data for WFE calculation',
      };
    }

    const avgIS = mean(inSampleResults.map(m => m.totalReturnPct));
    const avgOOS = mean(outOfSampleResults.map(m => m.totalReturnPct));

    // WFE = OOS return / IS return
    const wfe = avgIS !== 0 ? avgOOS / avgIS : 0;

    let verdict: WFEResult['verdict'];
    let details: string;

    if (wfe < 0) {
      verdict = 'overfitting';
      details = `WFE ${(wfe * 100).toFixed(1)}% — OOS returns are NEGATIVE while IS positive. Severe overfitting.`;
    } else if (wfe < 0.4) {
      verdict = 'overfitting';
      details = `WFE ${(wfe * 100).toFixed(1)}% — below 40% threshold. Strategy is curve-fitted and will fail live.`;
    } else if (wfe < 0.5) {
      verdict = 'suspicious';
      details = `WFE ${(wfe * 100).toFixed(1)}% — borderline. May have some overfitting. Proceed with caution.`;
    } else if (wfe <= 0.85) {
      verdict = 'robust';
      details = `WFE ${(wfe * 100).toFixed(1)}% — in the Goldilocks zone (50-85%). Strategy appears robust.`;
    } else if (wfe <= 1.0) {
      verdict = 'acceptable';
      details = `WFE ${(wfe * 100).toFixed(1)}% — OOS close to IS. Good, but verify with more data.`;
    } else {
      verdict = 'suspicious';
      details = `WFE ${(wfe * 100).toFixed(1)}% — OOS EXCEEDS IS (>100%). Possibly lucky or data issue.`;
    }

    log.info({ strategy, wfe: wfe.toFixed(3), verdict }, 'WFE computed');

    return {
      strategy,
      inSampleReturn: avgIS,
      outOfSampleReturn: avgOOS,
      wfe,
      windows: Math.min(inSampleResults.length, outOfSampleResults.length),
      verdict,
      details,
    };
  }

  /**
   * Record a backtest trial (Sharpe ratio) for DSR computation.
   * Must record ALL trials, not just the best one.
   */
  recordTrial(strategy: string, sharpeRatio: number): void {
    const trials = this.trialHistory.get(strategy) ?? [];
    trials.push(sharpeRatio);
    this.trialHistory.set(strategy, trials);
  }

  /**
   * Compute Deflated Sharpe Ratio.
   *
   * DSR corrects for:
   * 1. Selection bias: choosing the best of N backtests inflates apparent Sharpe
   * 2. Non-normal returns: skewness and kurtosis affect SR distribution
   *
   * Based on Bailey & López de Prado (2014):
   * DSR = (SR_observed - E[max(SR)]) / std(SR)
   */
  computeDeflatedSharpe(
    strategy: string,
    observedSharpe: number,
    returns: number[],
  ): DeflatedSharpeResult {
    const trials = this.trialHistory.get(strategy) ?? [];
    const totalTrials = Math.max(trials.length, 1);

    // Return statistics
    const T = returns.length;
    if (T < 10) {
      return {
        strategy,
        observedSharpe,
        deflatedSharpe: 0,
        expectedMaxSharpe: 0,
        totalTrials,
        pValue: 1,
        isSignificant: false,
        details: 'Insufficient return data for DSR',
      };
    }

    const skew = this.skewness(returns);
    const kurt = this.kurtosis(returns);

    // Standard error of Sharpe Ratio (Lo 2002, corrected for non-normality)
    const seSR = Math.sqrt(
      (1 - skew * observedSharpe + ((kurt - 1) / 4) * observedSharpe * observedSharpe) / T,
    );

    // Expected maximum Sharpe from N independent trials (Bailey & López de Prado)
    // E[max(SR)] ≈ sqrt(V[SR]) * ((1-γ)*Φ^(-1)(1-1/N) + γ*Φ^(-1)(1-1/(N*e)))
    // Simplified: E[max(SR)] ≈ sqrt(2*ln(N)) * std(SR) for large N
    const gamma = 0.5772; // Euler-Mascheroni
    let expectedMaxSR = 0;
    if (totalTrials > 1) {
      const z1 = this.inverseNormalCDF(1 - 1 / totalTrials);
      const z2 = this.inverseNormalCDF(1 - 1 / (totalTrials * Math.E));
      expectedMaxSR = seSR * ((1 - gamma) * z1 + gamma * z2);
    }

    // Deflated Sharpe Ratio
    const deflatedSharpe = seSR > 0 ? (observedSharpe - expectedMaxSR) / seSR : 0;

    // P-value: probability of observing this Sharpe by chance
    const pValue = 1 - this.normalCDF(deflatedSharpe);

    const isSignificant = deflatedSharpe > 0 && pValue < 0.05;

    const details = isSignificant
      ? `DSR ${deflatedSharpe.toFixed(2)} (p=${pValue.toFixed(4)}) — Sharpe survives correction for ${totalTrials} trials. Signal is real.`
      : `DSR ${deflatedSharpe.toFixed(2)} (p=${pValue.toFixed(4)}) — Sharpe does NOT survive correction for ${totalTrials} trials. Likely overfitting.`;

    log.info({
      strategy,
      observedSharpe: observedSharpe.toFixed(2),
      deflatedSharpe: deflatedSharpe.toFixed(2),
      trials: totalTrials,
      pValue: pValue.toFixed(4),
      significant: isSignificant,
    }, 'Deflated Sharpe computed');

    return {
      strategy,
      observedSharpe,
      deflatedSharpe,
      expectedMaxSharpe: expectedMaxSR,
      totalTrials,
      pValue,
      isSignificant,
      details,
    };
  }

  /** Get all trial counts (for reporting) */
  getTrialCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const [s, t] of this.trialHistory) counts.set(s, t.length);
    return counts;
  }

  // --- Statistical helpers ---

  private skewness(values: number[]): number {
    const n = values.length;
    if (n < 3) return 0;
    const m = mean(values);
    const s = stdDev(values);
    if (s === 0) return 0;
    let sum = 0;
    for (const v of values) sum += ((v - m) / s) ** 3;
    return (n / ((n - 1) * (n - 2))) * sum;
  }

  private kurtosis(values: number[]): number {
    const n = values.length;
    if (n < 4) return 3; // normal
    const m = mean(values);
    const s = stdDev(values);
    if (s === 0) return 3;
    let sum = 0;
    for (const v of values) sum += ((v - m) / s) ** 4;
    // Excess kurtosis + 3 for raw kurtosis
    return ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * sum -
      (3 * (n - 1) * (n - 1)) / ((n - 2) * (n - 3)) + 3;
  }

  /** Approximate inverse normal CDF (Beasley-Springer-Moro algorithm) */
  private inverseNormalCDF(p: number): number {
    if (p <= 0) return -8;
    if (p >= 1) return 8;
    if (p === 0.5) return 0;

    // Rational approximation for central region
    const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
               1.383577518672690e2, -3.066479806614716e1, 2.506628277459239e0];
    const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
               6.680131188771972e1, -1.328068155288572e1];

    const pLow = 0.02425;
    const pHigh = 1 - pLow;

    let q: number, r: number;
    if (p < pLow) {
      q = Math.sqrt(-2 * Math.log(p));
      return ((((((-7.784894002430293e-3 * q - 3.223964580411365e-1) * q - 2.400758277161838e0) * q -
        2.549732539343734e0) * q + 4.374664141464968e0) * q + 2.938163982698783e0) /
        ((((7.784695709041462e-3 * q + 3.224671290700398e-1) * q + 2.445134137142996e0) * q +
        3.754408661907416e0) * q + 1));
    } else if (p <= pHigh) {
      q = p - 0.5;
      r = q * q;
      return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
        (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
    } else {
      q = Math.sqrt(-2 * Math.log(1 - p));
      return -((((((-7.784894002430293e-3 * q - 3.223964580411365e-1) * q - 2.400758277161838e0) * q -
        2.549732539343734e0) * q + 4.374664141464968e0) * q + 2.938163982698783e0) /
        ((((7.784695709041462e-3 * q + 3.224671290700398e-1) * q + 2.445134137142996e0) * q +
        3.754408661907416e0) * q + 1));
    }
  }

  /** Normal CDF approximation (Abramowitz and Stegun) */
  private normalCDF(x: number): number {
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
    const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.SQRT2;
    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return 0.5 * (1.0 + sign * y);
  }

  /** Format combined report */
  static formatReport(wfeResults: WFEResult[], dsrResults: DeflatedSharpeResult[]): string {
    const lines: string[] = ['\n=== STATISTICAL VALIDATION ===\n'];

    if (wfeResults.length > 0) {
      lines.push('Walk-Forward Efficiency:');
      for (const r of wfeResults) {
        const icon = r.verdict === 'robust' ? 'OK' : r.verdict === 'acceptable' ? 'OK' : r.verdict === 'suspicious' ? '??' : 'XX';
        lines.push(`  [${icon}] ${r.strategy.padEnd(22)} WFE: ${(r.wfe * 100).toFixed(1)}% (IS: ${r.inSampleReturn.toFixed(1)}%, OOS: ${r.outOfSampleReturn.toFixed(1)}%) — ${r.verdict}`);
      }
    }

    if (dsrResults.length > 0) {
      lines.push('\nDeflated Sharpe Ratio:');
      for (const r of dsrResults) {
        const icon = r.isSignificant ? 'OK' : 'XX';
        lines.push(`  [${icon}] ${r.strategy.padEnd(22)} SR: ${r.observedSharpe.toFixed(2)} -> DSR: ${r.deflatedSharpe.toFixed(2)} (p=${r.pValue.toFixed(3)}, ${r.totalTrials} trials)`);
      }
    }

    return lines.join('\n');
  }
}
