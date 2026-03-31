import type { Signal } from '../../shared/types.js';
import { createModuleLogger } from '../../shared/logger.js';
import { mean, stdDev } from '../../shared/utils.js';

const log = createModuleLogger('ic-decay-tracker');

/** A single IC observation for a strategy */
interface ICObservation {
  timestamp: number;
  strategy: string;
  ic: number;          // Spearman rank correlation: predicted confidence vs actual return
  sampleSize: number;
}

/** IC health assessment for a strategy */
export interface ICHealthReport {
  strategy: string;
  currentIC: number;
  rollingIC6m: number;
  rollingIC12m: number;
  icStdDev: number;
  icTrend: number;       // slope of IC over time: negative = decaying
  isDecaying: boolean;
  severity: 'healthy' | 'warning' | 'critical' | 'dead';
  recommendation: string;
}

/**
 * IC Decay Tracker — monitors rolling Information Coefficient per strategy.
 * Detects structural decay vs temporary drawdowns.
 *
 * IC = Spearman rank correlation between signal confidence and actual return.
 * Realistic IC: 0.02-0.10 is good, >0.10 is strong, >0.15 suspicious.
 */
export class ICDecayTracker {
  /** Strategy name → IC observations over time */
  private observations = new Map<string, ICObservation[]>();

  /** Strategy name → pending signals awaiting outcome */
  private pendingSignals = new Map<string, Array<{ signal: Signal; timestamp: number }>>();

  /** How many periods (cycles) to wait before measuring outcome */
  private readonly outcomeLag: number;

  /** Maximum observations to keep per strategy */
  private readonly maxHistory: number;

  constructor(outcomeLag = 5, maxHistory = 500) {
    this.outcomeLag = outcomeLag;
    this.maxHistory = maxHistory;
  }

  /**
   * Record signals generated this cycle (paired with outcomes later).
   */
  recordSignals(signals: Signal[]): void {
    const now = Date.now();
    for (const signal of signals) {
      if (signal.action === 'HOLD') continue;
      const key = signal.strategy;
      const pending = this.pendingSignals.get(key) ?? [];
      pending.push({ signal, timestamp: now });
      this.pendingSignals.set(key, pending);
    }
  }

  /**
   * Resolve pending signals with actual price outcomes.
   * Call this each cycle with current prices.
   * Returns IC values computed this cycle (if any).
   */
  resolveOutcomes(currentPrices: Map<string, number>): Map<string, number> {
    const now = Date.now();
    const lagMs = this.outcomeLag * 60_000; // assume ~1 min cycles
    const results = new Map<string, number>();

    for (const [strategy, pending] of this.pendingSignals) {
      // Find signals old enough to have outcomes
      const ready: Array<{ confidence: number; actualReturn: number }> = [];
      const stillPending: typeof pending = [];

      for (const entry of pending) {
        if (now - entry.timestamp < lagMs) {
          stillPending.push(entry);
          continue;
        }
        const currentPrice = currentPrices.get(entry.signal.asset.symbol);
        if (currentPrice === undefined) {
          stillPending.push(entry); // keep waiting
          continue;
        }

        const direction = entry.signal.action === 'BUY' ? 1 : -1;
        const actualReturn = direction * (currentPrice - entry.signal.price) / entry.signal.price;
        ready.push({ confidence: entry.signal.confidence, actualReturn });
      }

      this.pendingSignals.set(strategy, stillPending);

      // Compute IC if we have enough resolved signals
      if (ready.length >= 5) {
        const ic = this.spearmanRankCorrelation(
          ready.map(r => r.confidence),
          ready.map(r => r.actualReturn),
        );

        this.addObservation({
          timestamp: now,
          strategy,
          ic,
          sampleSize: ready.length,
        });

        results.set(strategy, ic);
        log.info({ strategy, ic: ic.toFixed(4), samples: ready.length }, 'IC computed');
      }
    }

    return results;
  }

  /**
   * Get IC health report for all tracked strategies.
   */
  getHealthReports(): ICHealthReport[] {
    const reports: ICHealthReport[] = [];

    for (const [strategy, obs] of this.observations) {
      if (obs.length < 3) continue;

      const ics = obs.map(o => o.ic);
      const currentIC = ics[ics.length - 1];

      // Rolling IC over different windows
      const recent30 = ics.slice(-30);   // ~6 months if weekly
      const recent60 = ics.slice(-60);   // ~12 months
      const rollingIC6m = mean(recent30);
      const rollingIC12m = mean(recent60);
      const icStd = stdDev(ics);

      // IC trend: simple linear regression slope over recent observations
      const icTrend = this.linearSlope(recent30);

      // Classify health
      const { isDecaying, severity, recommendation } = this.classify(
        currentIC, rollingIC6m, rollingIC12m, icTrend, icStd,
      );

      reports.push({
        strategy,
        currentIC,
        rollingIC6m,
        rollingIC12m,
        icStdDev: icStd,
        icTrend,
        isDecaying,
        severity,
        recommendation,
      });
    }

    return reports;
  }

  /**
   * Check if a specific strategy should be trusted.
   * Returns a confidence multiplier (0-1) that can scale position sizes.
   */
  getStrategyConfidenceMultiplier(strategy: string): number {
    const obs = this.observations.get(strategy);
    if (!obs || obs.length < 5) return 1.0; // trust by default until enough data

    const recentICs = obs.slice(-20).map(o => o.ic);
    const avgIC = mean(recentICs);

    // IC > 0.05 = full trust, IC ~ 0 = half trust, IC < -0.02 = minimal trust
    if (avgIC >= 0.05) return 1.0;
    if (avgIC >= 0.02) return 0.8;
    if (avgIC >= 0) return 0.6;
    if (avgIC >= -0.02) return 0.3;
    return 0.1; // negative IC = strategy is anti-predictive
  }

  private addObservation(obs: ICObservation): void {
    const list = this.observations.get(obs.strategy) ?? [];
    list.push(obs);
    // Trim to max history
    if (list.length > this.maxHistory) {
      list.splice(0, list.length - this.maxHistory);
    }
    this.observations.set(obs.strategy, list);
  }

  private classify(
    currentIC: number,
    rolling6m: number,
    rolling12m: number,
    trend: number,
    icStd: number,
  ): { isDecaying: boolean; severity: ICHealthReport['severity']; recommendation: string } {
    // Dead: IC consistently near or below zero
    if (rolling6m < 0 && rolling12m < 0) {
      return {
        isDecaying: true,
        severity: 'dead',
        recommendation: 'Retire strategy — IC is consistently negative (anti-predictive)',
      };
    }

    // Critical: 6-month IC near zero with negative trend
    if (rolling6m < 0.01 && trend < -0.001) {
      return {
        isDecaying: true,
        severity: 'critical',
        recommendation: 'Strategy losing predictive power rapidly — reduce allocation, consider retirement',
      };
    }

    // Warning: declining trend or IC below meaningful threshold
    if (trend < -0.0005 || rolling6m < 0.02) {
      return {
        isDecaying: true,
        severity: 'warning',
        recommendation: 'IC declining — monitor closely, reduce position sizes',
      };
    }

    // Healthy
    return {
      isDecaying: false,
      severity: 'healthy',
      recommendation: rolling6m > 0.05
        ? 'Strong predictive power — maintain or increase allocation'
        : 'Adequate IC — maintain current allocation',
    };
  }

  /**
   * Spearman rank correlation between two arrays.
   */
  private spearmanRankCorrelation(x: number[], y: number[]): number {
    const n = x.length;
    if (n < 3) return 0;

    const rankX = this.rank(x);
    const rankY = this.rank(y);

    // Pearson correlation on ranks
    const meanRX = mean(rankX);
    const meanRY = mean(rankY);

    let num = 0, denX = 0, denY = 0;
    for (let i = 0; i < n; i++) {
      const dx = rankX[i] - meanRX;
      const dy = rankY[i] - meanRY;
      num += dx * dy;
      denX += dx * dx;
      denY += dy * dy;
    }

    const den = Math.sqrt(denX * denY);
    return den === 0 ? 0 : num / den;
  }

  private rank(arr: number[]): number[] {
    const indexed = arr.map((v, i) => ({ v, i }));
    indexed.sort((a, b) => a.v - b.v);
    const ranks = new Array(arr.length);
    for (let i = 0; i < indexed.length; i++) {
      ranks[indexed[i].i] = i + 1;
    }
    // Handle ties: average ranks
    let i = 0;
    while (i < indexed.length) {
      let j = i;
      while (j < indexed.length && indexed[j].v === indexed[i].v) j++;
      const avgRank = (i + j + 1) / 2; // average of positions i+1..j
      for (let k = i; k < j; k++) {
        ranks[indexed[k].i] = avgRank;
      }
      i = j;
    }
    return ranks;
  }

  /**
   * Simple linear regression slope.
   */
  private linearSlope(values: number[]): number {
    const n = values.length;
    if (n < 2) return 0;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += values[i];
      sumXY += i * values[i];
      sumX2 += i * i;
    }
    const denom = n * sumX2 - sumX * sumX;
    return denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
  }

  /**
   * Format health reports for display.
   */
  static formatReport(reports: ICHealthReport[]): string {
    if (reports.length === 0) return '\nNo IC data available yet.\n';

    const lines: string[] = ['\n=== IC DECAY TRACKER ===\n'];
    for (const r of reports) {
      const icon = r.severity === 'healthy' ? 'OK' : r.severity === 'warning' ? 'WARN' : r.severity === 'critical' ? 'CRIT' : 'DEAD';
      lines.push(
        `  [${icon}] ${r.strategy.padEnd(22)} | IC: ${r.currentIC.toFixed(4)} | 6m: ${r.rollingIC6m.toFixed(4)} | 12m: ${r.rollingIC12m.toFixed(4)} | trend: ${r.icTrend >= 0 ? '+' : ''}${r.icTrend.toFixed(5)}`,
      );
      if (r.severity !== 'healthy') {
        lines.push(`         -> ${r.recommendation}`);
      }
    }
    return lines.join('\n');
  }
}
