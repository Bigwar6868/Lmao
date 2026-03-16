import type { StrategyDNA, BacktestResult } from '../../shared/types.js';
import { createModuleLogger } from '../../shared/logger.js';
import { config } from '../../config/index.js';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const log = createModuleLogger('ranker');

interface RankingEntry {
  dna: StrategyDNA;
  asset: string;
  timeframe: string;
  fitness: number;
  sharpe: number;
  winRate: number;
  maxDrawdown: number;
  totalReturn: number;
  updatedAt: number;
}

/**
 * Ranks strategies by performance and maintains a leaderboard.
 */
export class StrategyRanker {
  private rankings: RankingEntry[] = [];
  private dataDir: string;

  constructor() {
    this.dataDir = join(config.dataDir, 'results');
  }

  /**
   * Update rankings with new backtest result.
   */
  update(result: BacktestResult): void {
    const entry: RankingEntry = {
      dna: result.dna,
      asset: result.config.asset.symbol,
      timeframe: result.config.timeframe,
      fitness: result.dna.fitness,
      sharpe: result.metrics.sharpeRatio,
      winRate: result.metrics.winRate,
      maxDrawdown: result.metrics.maxDrawdownPct,
      totalReturn: result.metrics.totalReturnPct,
      updatedAt: Date.now(),
    };

    // Replace existing entry for same strategy+asset or add new
    const existingIdx = this.rankings.findIndex(
      (r) => r.dna.name === entry.dna.name && r.asset === entry.asset && r.timeframe === entry.timeframe
    );

    if (existingIdx >= 0) {
      // Only replace if new result is better
      if (entry.fitness > this.rankings[existingIdx].fitness) {
        this.rankings[existingIdx] = entry;
        log.info({ strategy: entry.dna.name, asset: entry.asset, fitness: entry.fitness.toFixed(4) }, 'Ranking improved');
      }
    } else {
      this.rankings.push(entry);
    }

    // Sort by fitness
    this.rankings.sort((a, b) => b.fitness - a.fitness);
  }

  /**
   * Get top N strategies overall.
   */
  getTopStrategies(n: number = 10): RankingEntry[] {
    return this.rankings.slice(0, n);
  }

  /**
   * Get best strategy for a specific asset.
   */
  getBestForAsset(asset: string): RankingEntry | null {
    return this.rankings.find((r) => r.asset === asset) ?? null;
  }

  /**
   * Get best DNA for a strategy type.
   */
  getBestDNA(strategyName: string): StrategyDNA | null {
    const entry = this.rankings.find((r) => r.dna.name === strategyName);
    return entry?.dna ?? null;
  }

  /**
   * Print leaderboard to console.
   */
  printLeaderboard(): string {
    if (this.rankings.length === 0) return 'No rankings yet.';

    const lines = ['=== Strategy Leaderboard ===', ''];
    lines.push(
      'Rank | Strategy | Asset | Sharpe | Win% | MaxDD% | Return%'
    );
    lines.push('-'.repeat(70));

    for (let i = 0; i < Math.min(20, this.rankings.length); i++) {
      const r = this.rankings[i];
      lines.push(
        `${(i + 1).toString().padStart(4)} | ${r.dna.name.padEnd(20)} | ${r.asset.padEnd(10)} | ` +
        `${r.sharpe.toFixed(2).padStart(6)} | ${(r.winRate * 100).toFixed(1).padStart(5)} | ` +
        `${r.maxDrawdown.toFixed(1).padStart(6)} | ${r.totalReturn.toFixed(1).padStart(7)}`
      );
    }

    return lines.join('\n');
  }

  /**
   * Save rankings to disk.
   */
  async save(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    const filePath = join(this.dataDir, 'strategy-rankings.json');
    await writeFile(filePath, JSON.stringify(this.rankings, null, 2));
    log.info({ path: filePath }, 'Rankings saved');
  }

  /**
   * Load rankings from disk.
   */
  async load(): Promise<void> {
    try {
      const filePath = join(this.dataDir, 'strategy-rankings.json');
      const data = await readFile(filePath, 'utf-8');
      this.rankings = JSON.parse(data);
      log.info({ entries: this.rankings.length }, 'Rankings loaded');
    } catch {
      log.info('No previous rankings found');
    }
  }
}
