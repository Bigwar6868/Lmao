import type { Candle, Strategy, BacktestConfig, BacktestResult, AssetInfo, Timeframe } from '../../shared/types.js';
import { BacktestEngine } from './engine.js';
import { StrategyOptimizer } from './optimizer.js';
import { createModuleLogger } from '../../shared/logger.js';
import { config } from '../../config/index.js';

const log = createModuleLogger('backtester');

/**
 * Backtester — coordinates backtesting engine and optimizer.
 */
export class Backtester {
  private engine = new BacktestEngine();
  private optimizer = new StrategyOptimizer();

  /**
   * Run a single backtest.
   */
  async backtest(
    strategy: Strategy,
    candles: Candle[],
    asset: AssetInfo,
    timeframe: Timeframe,
    options?: Partial<BacktestConfig>
  ): Promise<BacktestResult> {
    const btConfig: BacktestConfig = {
      strategy: strategy.config,
      asset,
      timeframe,
      startDate: candles[0]?.timestamp ?? 0,
      endDate: candles[candles.length - 1]?.timestamp ?? Date.now(),
      initialCapital: options?.initialCapital ?? config.initialCapital,
      commission: options?.commission ?? 0.001, // 0.1% default
      slippage: options?.slippage ?? 0.0005,    // 0.05% default
      maxPositionPct: options?.maxPositionPct,
      slAtrMult: options?.slAtrMult,
      tpAtrMult: options?.tpAtrMult,
      maxHoldBars: options?.maxHoldBars,
    };

    log.info(
      { strategy: strategy.name, asset: asset.symbol, candles: candles.length },
      'Starting backtest'
    );

    const result = await this.engine.run(strategy, candles, btConfig);

    log.info(
      {
        strategy: strategy.name,
        sharpe: result.metrics.sharpeRatio.toFixed(2),
        winRate: (result.metrics.winRate * 100).toFixed(1) + '%',
        totalReturn: result.metrics.totalReturnPct.toFixed(2) + '%',
        trades: result.metrics.totalTrades,
        maxDrawdown: result.metrics.maxDrawdownPct.toFixed(2) + '%',
      },
      'Backtest complete'
    );

    return result;
  }

  /**
   * Run backtests for multiple strategies and compare.
   */
  async compareStrategies(
    strategies: Strategy[],
    candles: Candle[],
    asset: AssetInfo,
    timeframe: Timeframe
  ): Promise<BacktestResult[]> {
    const results: BacktestResult[] = [];

    for (const strategy of strategies) {
      const result = await this.backtest(strategy, candles, asset, timeframe);
      results.push(result);
    }

    // Sort by fitness (Sharpe * winRate / drawdown) — 0-trade strategies rank last
    results.sort((a, b) => {
      const fitnessA = this.optimizer.calculateFitness(
        a.metrics.sharpeRatio, a.metrics.winRate, a.metrics.maxDrawdownPct, a.metrics.totalTrades
      );
      const fitnessB = this.optimizer.calculateFitness(
        b.metrics.sharpeRatio, b.metrics.winRate, b.metrics.maxDrawdownPct, b.metrics.totalTrades
      );
      return fitnessB - fitnessA;
    });

    log.info(
      { rankings: results.map((r, i) => `${i + 1}. ${r.dna.name} (Sharpe: ${r.metrics.sharpeRatio.toFixed(2)})`) },
      'Strategy comparison complete'
    );

    return results;
  }

  /**
   * Optimize strategy parameters via grid search.
   */
  async optimize(
    strategy: Strategy,
    candles: Candle[],
    asset: AssetInfo,
    timeframe: Timeframe,
    paramRanges: Record<string, number[]>
  ) {
    const btConfig: BacktestConfig = {
      strategy: strategy.config,
      asset,
      timeframe,
      startDate: candles[0]?.timestamp ?? 0,
      endDate: candles[candles.length - 1]?.timestamp ?? Date.now(),
      initialCapital: config.initialCapital,
      commission: 0.001,
      slippage: 0.0005,
    };

    return this.optimizer.gridSearch(strategy, candles, btConfig, paramRanges);
  }

  /**
   * Walk-forward analysis.
   */
  async walkForward(
    strategy: Strategy,
    candles: Candle[],
    asset: AssetInfo,
    timeframe: Timeframe,
    paramRanges: Record<string, number[]>
  ) {
    const btConfig: BacktestConfig = {
      strategy: strategy.config,
      asset,
      timeframe,
      startDate: candles[0]?.timestamp ?? 0,
      endDate: candles[candles.length - 1]?.timestamp ?? Date.now(),
      initialCapital: config.initialCapital,
      commission: 0.001,
      slippage: 0.0005,
    };

    return this.optimizer.walkForward(strategy, candles, btConfig, paramRanges);
  }
}
