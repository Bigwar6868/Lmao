import { writeFile, readFile, mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../../config/index.js';
import { createModuleLogger } from '../../shared/logger.js';
import type { BacktestResult, StrategyDNA } from '../../shared/types.js';

const log = createModuleLogger('journal');

interface JournalEntry {
  timestamp: number;
  date: string;
  type: 'evolution' | 'improvement' | 'discovery' | 'trade' | 'macro' | 'error';
  title: string;
  details: string;
  data?: Record<string, unknown>;
}

/**
 * Trading journal — records discoveries, improvements, and learnings.
 * Writes both structured JSON and human-readable markdown.
 */
export class TradingJournal {
  private entries: JournalEntry[] = [];
  private journalDir: string;

  constructor() {
    this.journalDir = join(config.dataDir, 'journal');
  }

  /**
   * Add a journal entry.
   */
  async addEntry(
    type: JournalEntry['type'],
    title: string,
    details: string,
    data?: Record<string, unknown>
  ): Promise<void> {
    const entry: JournalEntry = {
      timestamp: Date.now(),
      date: new Date().toISOString(),
      type,
      title,
      details,
      data,
    };

    this.entries.push(entry);
    await this.appendToMarkdown(entry);

    log.info({ type, title }, 'Journal entry added');
  }

  /**
   * Record an evolution cycle result.
   */
  async recordEvolution(
    strategyName: string,
    generation: number,
    bestFitness: number,
    improvement: number,
    bestDna: StrategyDNA
  ): Promise<void> {
    const improved = improvement > 0;
    await this.addEntry(
      improved ? 'improvement' : 'evolution',
      `${strategyName} Gen ${generation}: ${improved ? 'IMPROVED' : 'no change'}`,
      improved
        ? `Fitness improved by ${(improvement * 100).toFixed(2)}% to ${bestFitness.toFixed(4)}. ` +
          `Best params: ${JSON.stringify(bestDna.params)}`
        : `No improvement this generation. Best fitness: ${bestFitness.toFixed(4)}`,
      { generation, bestFitness, improvement, params: bestDna.params }
    );
  }

  /**
   * Record a backtest result summary.
   */
  async recordBacktest(result: BacktestResult): Promise<void> {
    const { metrics, dna, config: btConfig } = result;
    await this.addEntry(
      'trade',
      `Backtest: ${dna.name} on ${btConfig.asset.symbol}`,
      `Sharpe: ${metrics.sharpeRatio.toFixed(2)}, Win Rate: ${(metrics.winRate * 100).toFixed(1)}%, ` +
      `Return: ${metrics.totalReturnPct.toFixed(2)}%, Max DD: ${metrics.maxDrawdownPct.toFixed(2)}%, ` +
      `Trades: ${metrics.totalTrades}`,
      { metrics, dna: dna.params }
    );
  }

  /**
   * Record a macro environment observation.
   */
  async recordMacro(observation: string, data?: Record<string, unknown>): Promise<void> {
    await this.addEntry('macro', 'Macro Update', observation, data);
  }

  /**
   * Get all entries, optionally filtered by type.
   */
  getEntries(type?: JournalEntry['type']): JournalEntry[] {
    if (!type) return [...this.entries];
    return this.entries.filter((e) => e.type === type);
  }

  /**
   * Save journal to disk.
   */
  async save(): Promise<void> {
    await mkdir(this.journalDir, { recursive: true });
    const filePath = join(this.journalDir, 'evolution-log.json');
    await writeFile(filePath, JSON.stringify(this.entries, null, 2));
    log.info({ entries: this.entries.length }, 'Journal saved');
  }

  /**
   * Load journal from disk.
   */
  async load(): Promise<void> {
    try {
      const filePath = join(this.journalDir, 'evolution-log.json');
      const data = await readFile(filePath, 'utf-8');
      this.entries = JSON.parse(data);
      log.info({ entries: this.entries.length }, 'Journal loaded');
    } catch {
      log.info('No previous journal found');
    }
  }

  private async appendToMarkdown(entry: JournalEntry): Promise<void> {
    await mkdir(this.journalDir, { recursive: true });
    const filePath = join(this.journalDir, 'learnings.md');
    const icon = { evolution: '🧬', improvement: '📈', discovery: '💡', trade: '📊', macro: '🌍', error: '❌' }[entry.type];
    const line = `\n### ${icon} [${entry.date}] ${entry.title}\n${entry.details}\n`;
    try {
      await appendFile(filePath, line);
    } catch {
      await writeFile(filePath, `# Trading Journal\n${line}`);
    }
  }
}
