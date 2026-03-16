// ============================================================
// DecayDetector — detects when a strategy stops working
// ============================================================

import type { AgentId } from '../../shared/agent-types.js';
import { createModuleLogger } from '../../shared/logger.js';
import { roundTo } from '../../shared/utils.js';

const log = createModuleLogger('decay-detector');

/** A snapshot of performance at a point in time */
export interface PerformanceSnapshot {
  timestamp: number;
  agentId: AgentId;
  strategy: string;
  winRate: number;
  sharpe: number;
  pnl: number;
  reputation: number;
  tradesCount: number;
}

/** Decay analysis result */
export interface DecayAnalysis {
  agentId: AgentId;
  strategy: string;
  isDecaying: boolean;
  decayScore: number;            // 0-100, higher = more decayed
  trend: 'improving' | 'stable' | 'declining' | 'collapsed';
  winRateTrend: number;          // slope of win rate over time
  sharpeTrend: number;           // slope of sharpe over time
  timeSincePeak: number;         // ms since best performance
  recommendation: string;
}

/**
 * Detects strategy decay — when a strategy that used to work
 * gradually loses effectiveness as the market adapts.
 *
 * Based on:
 * - "A strategy that works today will decay. Markets adapt."
 * - "Establish a continuous research pipeline to iterate on models
 *    and a governance process to retire underperforming ones."
 */
export class DecayDetector {
  private snapshots = new Map<AgentId, PerformanceSnapshot[]>();
  private readonly windowSize: number;
  private readonly decayThreshold: number;

  constructor(opts?: { windowSize?: number; decayThreshold?: number }) {
    this.windowSize = opts?.windowSize ?? 30;      // last 30 snapshots
    this.decayThreshold = opts?.decayThreshold ?? 40; // score > 40 = decaying
  }

  /**
   * Record a performance snapshot for an agent.
   */
  record(snapshot: PerformanceSnapshot): void {
    if (!this.snapshots.has(snapshot.agentId)) {
      this.snapshots.set(snapshot.agentId, []);
    }
    const history = this.snapshots.get(snapshot.agentId)!;
    history.push(snapshot);

    // Keep only last N snapshots
    if (history.length > this.windowSize * 2) {
      this.snapshots.set(snapshot.agentId, history.slice(-this.windowSize));
    }
  }

  /**
   * Analyze whether an agent's strategy is decaying.
   */
  analyze(agentId: AgentId): DecayAnalysis | null {
    const history = this.snapshots.get(agentId);
    if (!history || history.length < 5) return null;

    const recent = history.slice(-this.windowSize);
    const strategy = recent[0].strategy;

    // Calculate trends using linear regression
    const winRateTrend = this.linearSlope(recent.map(s => s.winRate));
    const sharpeTrend = this.linearSlope(recent.map(s => s.sharpe));
    const reputationTrend = this.linearSlope(recent.map(s => s.reputation));

    // Find peak performance
    const peakWinRate = Math.max(...recent.map(s => s.winRate));
    const currentWinRate = recent[recent.length - 1].winRate;
    const peakSharpe = Math.max(...recent.map(s => s.sharpe));
    const currentSharpe = recent[recent.length - 1].sharpe;

    // Find time since peak
    const peakIdx = recent.findIndex(s => s.winRate === peakWinRate);
    const timeSincePeak = recent[recent.length - 1].timestamp - recent[peakIdx].timestamp;

    // Calculate decay score
    const winRateDecay = peakWinRate > 0 ? Math.max(0, (peakWinRate - currentWinRate) / peakWinRate) : 0;
    const sharpeDecay = peakSharpe > 0 ? Math.max(0, (peakSharpe - currentSharpe) / peakSharpe) : 0;

    const decayScore = Math.min(100,
      (winRateDecay * 40 + sharpeDecay * 40 + Math.max(0, -reputationTrend * 200)) * 100,
    );

    // Determine trend
    let trend: DecayAnalysis['trend'];
    if (winRateTrend > 0.005 && sharpeTrend > 0) trend = 'improving';
    else if (Math.abs(winRateTrend) < 0.003 && Math.abs(sharpeTrend) < 0.1) trend = 'stable';
    else if (decayScore > 70) trend = 'collapsed';
    else trend = 'declining';

    const isDecaying = decayScore > this.decayThreshold;

    // Generate recommendation
    let recommendation: string;
    if (trend === 'collapsed') {
      recommendation = 'CRITICAL: Strategy has collapsed. Retire agent and spawn replacement with different DNA.';
    } else if (trend === 'declining') {
      recommendation = 'WARNING: Strategy is declining. Consider evolving DNA parameters or switching market regime.';
    } else if (trend === 'improving') {
      recommendation = 'Strategy is improving. Continue monitoring.';
    } else {
      recommendation = 'Strategy is stable. No action needed.';
    }

    const analysis: DecayAnalysis = {
      agentId,
      strategy,
      isDecaying,
      decayScore,
      trend,
      winRateTrend,
      sharpeTrend,
      timeSincePeak,
      recommendation,
    };

    if (isDecaying) {
      log.warn({
        agent: agentId.slice(0, 8),
        strategy,
        decayScore: roundTo(decayScore, 0),
        trend,
        winRateNow: roundTo(currentWinRate, 2),
        winRatePeak: roundTo(peakWinRate, 2),
      }, 'Strategy decay detected');
    }

    return analysis;
  }

  /**
   * Analyze all tracked agents.
   */
  analyzeAll(): DecayAnalysis[] {
    const results: DecayAnalysis[] = [];
    for (const agentId of this.snapshots.keys()) {
      const analysis = this.analyze(agentId);
      if (analysis) results.push(analysis);
    }
    return results.sort((a, b) => b.decayScore - a.decayScore);
  }

  /** Format a decay report */
  static formatReport(analyses: DecayAnalysis[]): string {
    if (analyses.length === 0) return '\nNo decay data yet (need more trading cycles).';

    const lines: string[] = ['\n=== STRATEGY DECAY MONITOR ===\n'];

    lines.push('Agent      | Strategy       | Trend      | Decay | WinRate Trend | Recommendation');
    lines.push('-----------|----------------|------------|-------|--------------|---------------');

    for (const a of analyses) {
      lines.push(
        `${a.agentId.slice(0, 10).padEnd(10)} | ` +
        `${a.strategy.padEnd(14)} | ` +
        `${a.trend.padEnd(10)} | ` +
        `${roundTo(a.decayScore, 0).toString().padStart(4)}% | ` +
        `${(a.winRateTrend > 0 ? '+' : '') + roundTo(a.winRateTrend * 100, 2)}%`.padEnd(13) + ` | ` +
        `${a.recommendation.slice(0, 60)}`,
      );
    }

    const decaying = analyses.filter(a => a.isDecaying).length;
    lines.push(`\nDecaying: ${decaying}/${analyses.length} strategies`);

    return lines.join('\n');
  }

  // ----------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------

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

    const denominator = n * sumX2 - sumX * sumX;
    if (denominator === 0) return 0;

    return (n * sumXY - sumX * sumY) / denominator;
  }
}
