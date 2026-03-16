import type { PerformanceMetrics, StrategyDNA, BacktestResult } from '../../shared/types.js';
import { createModuleLogger } from '../../shared/logger.js';
import { config } from '../../config/index.js';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const log = createModuleLogger('tracker');

interface StrategyRecord {
  dna: StrategyDNA;
  metrics: PerformanceMetrics;
  asset: string;
  timeframe: string;
  timestamp: number;
}

/**
 * Tracks performance of each strategy across assets and timeframes.
 */
export class PerformanceTracker {
  private records: StrategyRecord[] = [];
  private dataDir: string;

  constructor() {
    this.dataDir = join(config.dataDir, 'results');
  }

  /**
   * Record a backtest or live result.
   */
  record(result: BacktestResult): void {
    this.records.push({
      dna: result.dna,
      metrics: result.metrics,
      asset: result.config.asset.symbol,
      timeframe: result.config.timeframe,
      timestamp: Date.now(),
    });

    log.info(
      {
        strategy: result.dna.name,
        generation: result.dna.generation,
        fitness: result.dna.fitness.toFixed(4),
        sharpe: result.metrics.sharpeRatio.toFixed(2),
      },
      'Performance recorded'
    );
  }

  /**
   * Get all records for a strategy.
   */
  getRecords(strategyName?: string): StrategyRecord[] {
    if (!strategyName) return [...this.records];
    return this.records.filter((r) => r.dna.name === strategyName);
  }

  /**
   * Get best performing DNA for a strategy.
   */
  getBestDNA(strategyName: string): StrategyDNA | null {
    const records = this.getRecords(strategyName);
    if (records.length === 0) return null;
    records.sort((a, b) => b.dna.fitness - a.dna.fitness);
    return records[0].dna;
  }

  /**
   * Get average metrics across all records for a strategy.
   */
  getAverageMetrics(strategyName: string): Partial<PerformanceMetrics> | null {
    const records = this.getRecords(strategyName);
    if (records.length === 0) return null;

    const avg = (field: keyof PerformanceMetrics) =>
      records.reduce((s, r) => s + (r.metrics[field] as number), 0) / records.length;

    return {
      sharpeRatio: avg('sharpeRatio'),
      sortinoRatio: avg('sortinoRatio'),
      winRate: avg('winRate'),
      maxDrawdownPct: avg('maxDrawdownPct'),
      totalReturnPct: avg('totalReturnPct'),
      profitFactor: avg('profitFactor'),
    };
  }

  /**
   * Save records to disk.
   */
  async save(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    const filePath = join(this.dataDir, 'performance-history.json');
    await writeFile(filePath, JSON.stringify(this.records, null, 2));
    log.info({ path: filePath, records: this.records.length }, 'Performance history saved');
  }

  /**
   * Load records from disk.
   */
  async load(): Promise<void> {
    try {
      const filePath = join(this.dataDir, 'performance-history.json');
      const data = await readFile(filePath, 'utf-8');
      this.records = JSON.parse(data);
      log.info({ records: this.records.length }, 'Performance history loaded');
    } catch {
      log.info('No previous performance history found');
    }
  }
}
