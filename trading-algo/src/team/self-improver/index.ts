import type { Strategy, BacktestResult, Candle, AssetInfo, Timeframe, StrategyDNA } from '../../shared/types.js';
import { PerformanceTracker } from './tracker.js';
import { StrategyEvolver } from './evolver.js';
import { StrategyRanker } from './ranker.js';
import { BacktestEngine } from '../backtester/engine.js';
import { createModuleLogger } from '../../shared/logger.js';
import { eventBus } from '../../shared/events.js';
import { config } from '../../config/index.js';

const log = createModuleLogger('self-improver');

/**
 * Self-Improvement Engine — the brain of the evolution system.
 * Tracks performance, evolves strategy parameters, ranks strategies,
 * and maintains a learning journal.
 */
export class SelfImprover {
  private tracker = new PerformanceTracker();
  private evolver = new StrategyEvolver();
  private ranker = new StrategyRanker();
  private backtestEngine = new BacktestEngine();
  private populations = new Map<string, StrategyDNA[]>();

  async initialize(): Promise<void> {
    await this.tracker.load();
    await this.ranker.load();
    log.info('Self-improver initialized');
  }

  /**
   * Record a backtest result and update rankings.
   */
  async recordResult(result: BacktestResult): Promise<void> {
    this.tracker.record(result);
    this.ranker.update(result);
  }

  /**
   * Run a full evolution cycle for a strategy.
   * 1. Get or create population
   * 2. Backtest each variant
   * 3. Evolve population
   * 4. Record improvements
   */
  async evolveStrategy(
    strategy: Strategy,
    candles: Candle[],
    asset: AssetInfo,
    timeframe: Timeframe
  ): Promise<{ improved: boolean; bestDna: StrategyDNA }> {
    const name = strategy.name;

    // Get or create population
    let population = this.populations.get(name);
    if (!population) {
      population = this.evolver.createPopulation(strategy.dna);
      this.populations.set(name, population);
      log.info({ strategy: name, populationSize: population.length }, 'Initial population created');
    }

    const previousBest = population.reduce((best, dna) =>
      dna.fitness > best.fitness ? dna : best, population[0]);

    // Backtest each variant
    for (const dna of population) {
      const variant = { ...strategy, dna, config: { ...strategy.config, params: dna.params } };
      try {
        const result = await this.backtestEngine.run(variant, candles, {
          strategy: variant.config,
          asset,
          timeframe,
          startDate: candles[0]?.timestamp ?? 0,
          endDate: candles[candles.length - 1]?.timestamp ?? Date.now(),
          initialCapital: config.initialCapital,
          commission: 0.001,
          slippage: 0.0005,
        });

        // Update fitness — penalize strategies that generate 0 trades
        const fitness = result.metrics.totalTrades === 0
          ? -Infinity
          : (result.metrics.sharpeRatio * result.metrics.winRate * 100) /
            (result.metrics.maxDrawdownPct || 1);
        dna.fitness = fitness;
      } catch {
        dna.fitness = -1;
      }
    }

    // Evolve to next generation
    const nextGen = this.evolver.evolve(population);
    this.populations.set(name, nextGen);

    const newBest = nextGen.reduce((best, dna) =>
      dna.fitness > best.fitness ? dna : best, nextGen[0]);

    const improved = newBest.fitness > previousBest.fitness;
    const improvement = previousBest.fitness > 0
      ? (newBest.fitness - previousBest.fitness) / previousBest.fitness
      : 0;

    const improvementPct = previousBest.fitness > 0
      ? `+${((newBest.fitness - previousBest.fitness) / previousBest.fitness * 100).toFixed(1)}%`
      : 'n/a';

    if (improved) {
      await eventBus.emit('evolution:improvement', {
        strategy: name,
        generation: newBest.generation,
        fitness: newBest.fitness,
        params: newBest.params,
      }, 'self-improver');

      log.info(
        { strategy: name, generation: newBest.generation, fitness: newBest.fitness.toFixed(4) },
        'Strategy improved!'
      );
      console.log(
        `[EVOLVE] ${name}  gen ${newBest.generation}  fitness: ${newBest.fitness.toFixed(4)}  improvement: ${improvementPct}`
      );
    } else {
      console.log(
        `[EVOLVE] ${name}  gen ${newBest.generation}  fitness: ${newBest.fitness.toFixed(4)}  no improvement (prev: ${previousBest.fitness.toFixed(4)})`
      );
    }

    return { improved, bestDna: newBest };
  }

  /**
   * Get current leaderboard.
   */
  getLeaderboard(): string {
    return this.ranker.printLeaderboard();
  }

  /**
   * Get best DNA for a strategy.
   */
  getBestDNA(strategyName: string): StrategyDNA | null {
    return this.ranker.getBestDNA(strategyName);
  }

  /**
   * Save all state to disk.
   */
  async save(): Promise<void> {
    await this.tracker.save();
    await this.ranker.save();
    log.info('Self-improver state saved');
  }
}
