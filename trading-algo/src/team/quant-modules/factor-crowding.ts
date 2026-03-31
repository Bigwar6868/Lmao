import type { Signal } from '../../shared/types.js';
import { createModuleLogger } from '../../shared/logger.js';

const log = createModuleLogger('factor-crowding');

/** Crowding analysis for a single asset */
export interface CrowdingReport {
  symbol: string;
  convergentStrategies: string[];
  crowdingScore: number;          // 0-1: how crowded this asset is
  direction: 'BUY' | 'SELL' | 'mixed';
  sizeMultiplier: number;         // recommended position size reduction
  isCrowded: boolean;
}

/**
 * Factor Crowding Detector (Optional Module)
 *
 * When multiple strategies point the same direction on the same asset,
 * it looks like high conviction — but research shows crowding increases
 * correlated drawdown risk. A one-SD increase in crowding reduces
 * momentum factor returns by ~8% annualized (Kang et al., 2021).
 *
 * This module scales down position sizes when crowding is detected.
 */
export class FactorCrowdingDetector {
  /** History of recent signal patterns for persistence detection */
  private signalHistory: Array<{ timestamp: number; byAsset: Map<string, Signal[]> }> = [];
  private readonly maxHistory = 50;

  /**
   * Analyze signals for crowding patterns.
   */
  analyze(signals: Signal[]): CrowdingReport[] {
    // Group signals by asset
    const byAsset = new Map<string, Signal[]>();
    for (const sig of signals) {
      if (sig.action === 'HOLD') continue;
      const list = byAsset.get(sig.asset.symbol) ?? [];
      list.push(sig);
      byAsset.set(sig.asset.symbol, list);
    }

    // Store for persistence tracking
    this.signalHistory.push({ timestamp: Date.now(), byAsset });
    if (this.signalHistory.length > this.maxHistory) {
      this.signalHistory.splice(0, this.signalHistory.length - this.maxHistory);
    }

    const reports: CrowdingReport[] = [];

    for (const [symbol, sigs] of byAsset) {
      const uniqueStrategies = [...new Set(sigs.map(s => s.strategy))];
      const buyCount = sigs.filter(s => s.action === 'BUY').length;
      const sellCount = sigs.filter(s => s.action === 'SELL').length;

      // Direction consensus
      let direction: CrowdingReport['direction'] = 'mixed';
      if (buyCount > 0 && sellCount === 0) direction = 'BUY';
      else if (sellCount > 0 && buyCount === 0) direction = 'SELL';

      // Crowding score: how many strategies agree (normalized)
      const totalStrategies = 4; // momentum, MR, breakout, multi-indicator
      const agreementRatio = uniqueStrategies.length / totalStrategies;

      // Persistence: has this crowding pattern persisted across cycles?
      const persistenceFactor = this.checkPersistence(symbol, direction);

      // Combined crowding score
      const crowdingScore = Math.min(1, agreementRatio * 0.6 + persistenceFactor * 0.4);

      // Crowded if 3+ strategies agree for 3+ cycles
      const isCrowded = uniqueStrategies.length >= 3 && persistenceFactor > 0.3;

      // Position size reduction: linear scale from 1.0 (no crowding) to 0.5 (max crowding)
      const sizeMultiplier = isCrowded ? Math.max(0.5, 1 - crowdingScore * 0.5) : 1.0;

      reports.push({
        symbol,
        convergentStrategies: uniqueStrategies,
        crowdingScore,
        direction,
        sizeMultiplier,
        isCrowded,
      });

      if (isCrowded) {
        log.info({
          symbol,
          strategies: uniqueStrategies.length,
          direction,
          crowdingScore: crowdingScore.toFixed(3),
          sizeMultiplier: sizeMultiplier.toFixed(2),
        }, 'Crowding detected — reducing position size');
      }
    }

    return reports;
  }

  /**
   * Get size multiplier for a specific asset.
   * Returns 1.0 if no crowding data or not crowded.
   */
  getSizeMultiplier(symbol: string, signals: Signal[]): number {
    const reports = this.analyze(signals);
    const report = reports.find(r => r.symbol === symbol);
    return report?.sizeMultiplier ?? 1.0;
  }

  /**
   * Check how persistent the crowding pattern has been.
   */
  private checkPersistence(symbol: string, direction: string): number {
    if (this.signalHistory.length < 2) return 0;

    let matchCount = 0;
    const lookback = Math.min(this.signalHistory.length, 10);

    for (let i = this.signalHistory.length - lookback; i < this.signalHistory.length - 1; i++) {
      const entry = this.signalHistory[i];
      const sigs = entry.byAsset.get(symbol);
      if (!sigs || sigs.length < 2) continue;

      const buyCount = sigs.filter(s => s.action === 'BUY').length;
      const sellCount = sigs.filter(s => s.action === 'SELL').length;
      const prevDir = buyCount > sellCount ? 'BUY' : sellCount > buyCount ? 'SELL' : 'mixed';

      if (prevDir === direction) matchCount++;
    }

    return lookback > 0 ? matchCount / lookback : 0;
  }

  /** Format report */
  static formatReport(reports: CrowdingReport[]): string {
    const crowded = reports.filter(r => r.isCrowded);
    if (crowded.length === 0) return '\nNo factor crowding detected.\n';

    const lines: string[] = ['\n=== FACTOR CROWDING ===\n'];
    for (const r of crowded) {
      lines.push(
        `  [CROWD] ${r.symbol.padEnd(12)} | ${r.convergentStrategies.length} strategies ${r.direction} | score: ${r.crowdingScore.toFixed(2)} | size: ${(r.sizeMultiplier * 100).toFixed(0)}%`,
      );
    }
    return lines.join('\n');
  }
}
