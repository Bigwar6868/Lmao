import type { Candle, Strategy, BacktestConfig, StrategyDNA } from '../../shared/types.js';
import type { OptimizationResult, WalkForwardWindow } from './types.js';
import { BacktestEngine } from './engine.js';
import { generateId } from '../../shared/utils.js';
import { createModuleLogger } from '../../shared/logger.js';

const log = createModuleLogger('optimizer');

/**
 * Strategy parameter optimizer via grid search and walk-forward analysis.
 */
export class StrategyOptimizer {
  private engine = new BacktestEngine();

  /**
   * Grid search over parameter ranges to find optimal DNA.
   */
  async gridSearch(
    strategy: Strategy,
    candles: Candle[],
    config: BacktestConfig,
    paramRanges: Record<string, number[]>
  ): Promise<OptimizationResult> {
    const paramNames = Object.keys(paramRanges);
    const combinations = this.generateCombinations(paramRanges);
    const results: OptimizationResult['allResults'] = [];

    log.info({ totalCombinations: combinations.length }, 'Starting grid search');

    for (const combo of combinations) {
      const dna: StrategyDNA = {
        ...strategy.dna,
        id: generateId(),
        params: { ...strategy.dna.params },
        generation: strategy.dna.generation + 1,
        parentId: strategy.dna.id,
      };

      for (let i = 0; i < paramNames.length; i++) {
        dna.params[paramNames[i]] = combo[i];
      }

      // Apply DNA to strategy
      const testStrategy = { ...strategy, dna };
      try {
        const result = await this.engine.run(testStrategy, candles, config);
        const fitness = this.calculateFitness(
          result.metrics.sharpeRatio,
          result.metrics.winRate,
          result.metrics.maxDrawdownPct
        );
        dna.fitness = fitness;
        results.push({ dna, metrics: result.metrics });
      } catch {
        // Skip failed combinations
      }
    }

    results.sort((a, b) => b.dna.fitness - a.dna.fitness);

    const best = results[0] ?? {
      dna: strategy.dna,
      metrics: { sharpeRatio: 0, winRate: 0, maxDrawdownPct: 0 } as any,
    };

    log.info(
      { bestFitness: best.dna.fitness, bestParams: best.dna.params },
      'Grid search complete'
    );

    return {
      bestDna: best.dna,
      bestMetrics: best.metrics,
      allResults: results,
      totalCombinations: combinations.length,
    };
  }

  /**
   * Walk-forward analysis: train on window, test on next window, slide forward.
   */
  async walkForward(
    strategy: Strategy,
    candles: Candle[],
    config: BacktestConfig,
    paramRanges: Record<string, number[]>,
    windowCount: number = 4,
    trainRatio: number = 0.7
  ): Promise<OptimizationResult['allResults']> {
    const windows = this.createWindows(candles, windowCount, trainRatio);
    const outOfSampleResults: OptimizationResult['allResults'] = [];

    for (const window of windows) {
      const trainCandles = candles.filter(
        (c) => c.timestamp >= window.trainStart && c.timestamp <= window.trainEnd
      );
      const testCandles = candles.filter(
        (c) => c.timestamp >= window.testStart && c.timestamp <= window.testEnd
      );

      if (trainCandles.length < 50 || testCandles.length < 10) continue;

      // Optimize on training data
      const trainConfig = { ...config, startDate: window.trainStart, endDate: window.trainEnd };
      const optimized = await this.gridSearch(strategy, trainCandles, trainConfig, paramRanges);

      // Test on out-of-sample data
      const testStrategy = { ...strategy, dna: optimized.bestDna };
      const testConfig = { ...config, startDate: window.testStart, endDate: window.testEnd };
      const testResult = await this.engine.run(testStrategy, testCandles, testConfig);

      outOfSampleResults.push({
        dna: optimized.bestDna,
        metrics: testResult.metrics,
      });
    }

    return outOfSampleResults;
  }

  private generateCombinations(ranges: Record<string, number[]>): number[][] {
    const keys = Object.keys(ranges);
    if (keys.length === 0) return [[]];

    const result: number[][] = [];
    const values = keys.map((k) => ranges[k]);

    function recurse(depth: number, current: number[]) {
      if (depth === values.length) {
        result.push([...current]);
        return;
      }
      for (const val of values[depth]) {
        current.push(val);
        recurse(depth + 1, current);
        current.pop();
      }
    }

    recurse(0, []);
    return result;
  }

  private createWindows(
    candles: Candle[],
    count: number,
    trainRatio: number
  ): WalkForwardWindow[] {
    if (candles.length === 0) return [];
    const totalPeriod = candles[candles.length - 1].timestamp - candles[0].timestamp;
    const windowSize = totalPeriod / count;
    const trainSize = windowSize * trainRatio;
    const windows: WalkForwardWindow[] = [];

    for (let i = 0; i < count; i++) {
      const start = candles[0].timestamp + i * windowSize;
      windows.push({
        trainStart: start,
        trainEnd: start + trainSize,
        testStart: start + trainSize,
        testEnd: start + windowSize,
      });
    }

    return windows;
  }

  calculateFitness(sharpe: number, winRate: number, maxDrawdownPct: number): number {
    const drawdownPenalty = maxDrawdownPct > 0 ? maxDrawdownPct : 1;
    return (sharpe * winRate * 100) / drawdownPenalty;
  }
}
