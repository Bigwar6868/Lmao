// ============================================================
// OverfitGuard — prevents overfitting via walk-forward validation
// ============================================================

import type { Strategy, Candle, AssetInfo, Timeframe, StrategyDNA, PerformanceMetrics } from '../../shared/types.js';
import { createModuleLogger } from '../../shared/logger.js';
import { BacktestEngine } from '../backtester/engine.js';
import { roundTo } from '../../shared/utils.js';

const log = createModuleLogger('overfit-guard');

/** Result of a walk-forward validation */
export interface WalkForwardResult {
  strategy: string;
  dna: StrategyDNA;
  inSampleMetrics: PerformanceMetrics;
  outOfSampleMetrics: PerformanceMetrics;
  overfitScore: number;           // 0-100, higher = more overfit
  isOverfit: boolean;
  degradation: {
    sharpe: number;               // % drop from in-sample to out-of-sample
    winRate: number;
    totalReturn: number;
    profitFactor: number;
  };
  folds: WalkForwardFold[];
  recommendation: string;
}

interface WalkForwardFold {
  foldIndex: number;
  trainStart: number;
  trainEnd: number;
  testStart: number;
  testEnd: number;
  trainMetrics: PerformanceMetrics;
  testMetrics: PerformanceMetrics;
  sharpeDrop: number;
}

/**
 * Walk-forward validation to detect overfitting.
 *
 * Instead of testing on the same data used to optimize,
 * splits data into train/test windows and checks if
 * performance holds on unseen data.
 *
 * Based on best practices from:
 * - "The paramount risk is overfitting" (industry consensus 2026)
 * - Walk-forward optimization standard in institutional quant funds
 */
export class OverfitGuard {
  private readonly numFolds: number;
  private readonly trainRatio: number;
  private readonly maxSharpeDegradation: number;
  private readonly maxWinRateDegradation: number;

  constructor(opts?: {
    numFolds?: number;
    trainRatio?: number;
    maxSharpeDegradation?: number;
    maxWinRateDegradation?: number;
  }) {
    this.numFolds = opts?.numFolds ?? 5;
    this.trainRatio = opts?.trainRatio ?? 0.7;
    this.maxSharpeDegradation = opts?.maxSharpeDegradation ?? 0.4;   // 40% max drop
    this.maxWinRateDegradation = opts?.maxWinRateDegradation ?? 0.25; // 25% max drop
  }

  /**
   * Run walk-forward validation on a strategy.
   * Returns overfitting analysis with in-sample vs out-of-sample comparison.
   */
  async validate(
    strategy: Strategy,
    candles: Candle[],
    asset: AssetInfo,
    timeframe: Timeframe,
  ): Promise<WalkForwardResult> {
    if (candles.length < 200) {
      log.warn({ candles: candles.length }, 'Insufficient data for walk-forward validation');
      return this.createInsufficientDataResult(strategy);
    }

    const engine = new BacktestEngine();
    const foldSize = Math.floor(candles.length / this.numFolds);
    const folds: WalkForwardFold[] = [];

    const allTrainMetrics: PerformanceMetrics[] = [];
    const allTestMetrics: PerformanceMetrics[] = [];

    for (let i = 0; i < this.numFolds - 1; i++) {
      const trainStart = i * foldSize;
      const trainEnd = trainStart + Math.floor(foldSize * this.trainRatio);
      const testStart = trainEnd;
      const testEnd = (i + 1) * foldSize;

      const trainCandles = candles.slice(trainStart, trainEnd);
      const testCandles = candles.slice(testStart, testEnd);

      if (trainCandles.length < 50 || testCandles.length < 20) continue;

      // Backtest on training data
      const trainResult = await engine.run({
        strategy: strategy.config,
        asset,
        timeframe,
        startDate: trainCandles[0].timestamp,
        endDate: trainCandles[trainCandles.length - 1].timestamp,
        initialCapital: 10000,
        commission: 0.001,
        slippage: 0.0005,
      }, trainCandles, strategy.dna);

      // Backtest on test data (unseen)
      const testResult = await engine.run({
        strategy: strategy.config,
        asset,
        timeframe,
        startDate: testCandles[0].timestamp,
        endDate: testCandles[testCandles.length - 1].timestamp,
        initialCapital: 10000,
        commission: 0.001,
        slippage: 0.0005,
      }, testCandles, strategy.dna);

      const sharpeDrop = trainResult.metrics.sharpeRatio > 0
        ? 1 - (testResult.metrics.sharpeRatio / trainResult.metrics.sharpeRatio)
        : 0;

      folds.push({
        foldIndex: i,
        trainStart: trainCandles[0].timestamp,
        trainEnd: trainCandles[trainCandles.length - 1].timestamp,
        testStart: testCandles[0].timestamp,
        testEnd: testCandles[testCandles.length - 1].timestamp,
        trainMetrics: trainResult.metrics,
        testMetrics: testResult.metrics,
        sharpeDrop,
      });

      allTrainMetrics.push(trainResult.metrics);
      allTestMetrics.push(testResult.metrics);
    }

    if (folds.length === 0) {
      return this.createInsufficientDataResult(strategy);
    }

    // Aggregate metrics
    const avgTrain = this.averageMetrics(allTrainMetrics);
    const avgTest = this.averageMetrics(allTestMetrics);

    // Calculate degradation
    const degradation = {
      sharpe: avgTrain.sharpeRatio > 0
        ? (avgTrain.sharpeRatio - avgTest.sharpeRatio) / avgTrain.sharpeRatio
        : 0,
      winRate: avgTrain.winRate > 0
        ? (avgTrain.winRate - avgTest.winRate) / avgTrain.winRate
        : 0,
      totalReturn: avgTrain.totalReturnPct > 0
        ? (avgTrain.totalReturnPct - avgTest.totalReturnPct) / Math.abs(avgTrain.totalReturnPct)
        : 0,
      profitFactor: avgTrain.profitFactor > 0
        ? (avgTrain.profitFactor - avgTest.profitFactor) / avgTrain.profitFactor
        : 0,
    };

    // Overfitting score: weighted combination of degradation metrics
    const overfitScore = Math.min(100, Math.max(0,
      (Math.max(0, degradation.sharpe) * 40) +
      (Math.max(0, degradation.winRate) * 30) +
      (Math.max(0, degradation.totalReturn) * 20) +
      (Math.max(0, degradation.profitFactor) * 10),
    ) * 100);

    const isOverfit =
      degradation.sharpe > this.maxSharpeDegradation ||
      degradation.winRate > this.maxWinRateDegradation ||
      overfitScore > 50;

    const recommendation = isOverfit
      ? `OVERFIT WARNING: Performance drops ${roundTo(degradation.sharpe * 100, 0)}% (Sharpe) and ${roundTo(degradation.winRate * 100, 0)}% (win rate) on unseen data. Reduce parameter count or increase regularization.`
      : `OK: Strategy holds on unseen data (Sharpe drop: ${roundTo(degradation.sharpe * 100, 0)}%, win rate drop: ${roundTo(degradation.winRate * 100, 0)}%)`;

    log.info({
      strategy: strategy.name,
      overfitScore: roundTo(overfitScore, 0),
      isOverfit,
      sharpeDrop: roundTo(degradation.sharpe * 100, 0) + '%',
      winRateDrop: roundTo(degradation.winRate * 100, 0) + '%',
      folds: folds.length,
    }, isOverfit ? 'OVERFIT DETECTED' : 'Walk-forward validation passed');

    return {
      strategy: strategy.name,
      dna: strategy.dna,
      inSampleMetrics: avgTrain,
      outOfSampleMetrics: avgTest,
      overfitScore,
      isOverfit,
      degradation,
      folds,
      recommendation,
    };
  }

  /** Format a report */
  static formatReport(results: WalkForwardResult[]): string {
    const lines: string[] = ['\n=== OVERFITTING ANALYSIS (Walk-Forward) ===\n'];

    for (const r of results) {
      const status = r.isOverfit ? 'OVERFIT' : 'OK';
      lines.push(
        `  ${status.padEnd(8)} | ${r.strategy.padEnd(20)} | ` +
        `overfit: ${roundTo(r.overfitScore, 0).toString().padStart(3)}% | ` +
        `sharpe drop: ${roundTo(r.degradation.sharpe * 100, 0)}% | ` +
        `winRate drop: ${roundTo(r.degradation.winRate * 100, 0)}%`,
      );
      lines.push(`           ${r.recommendation}`);
    }

    return lines.join('\n');
  }

  // ----------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------

  private averageMetrics(all: PerformanceMetrics[]): PerformanceMetrics {
    if (all.length === 0) return this.emptyMetrics();
    const avg = { ...this.emptyMetrics() };
    for (const m of all) {
      avg.totalReturn += m.totalReturn;
      avg.totalReturnPct += m.totalReturnPct;
      avg.sharpeRatio += m.sharpeRatio;
      avg.sortinoRatio += m.sortinoRatio;
      avg.maxDrawdown += m.maxDrawdown;
      avg.maxDrawdownPct += m.maxDrawdownPct;
      avg.winRate += m.winRate;
      avg.profitFactor += m.profitFactor;
      avg.totalTrades += m.totalTrades;
      avg.winningTrades += m.winningTrades;
      avg.losingTrades += m.losingTrades;
      avg.avgWin += m.avgWin;
      avg.avgLoss += m.avgLoss;
      avg.avgHoldingPeriod += m.avgHoldingPeriod;
      avg.calmarRatio += m.calmarRatio;
    }
    const n = all.length;
    avg.totalReturn /= n;
    avg.totalReturnPct /= n;
    avg.sharpeRatio /= n;
    avg.sortinoRatio /= n;
    avg.maxDrawdown /= n;
    avg.maxDrawdownPct /= n;
    avg.winRate /= n;
    avg.profitFactor /= n;
    avg.totalTrades /= n;
    avg.winningTrades /= n;
    avg.losingTrades /= n;
    avg.avgWin /= n;
    avg.avgLoss /= n;
    avg.avgHoldingPeriod /= n;
    avg.calmarRatio /= n;
    return avg;
  }

  private emptyMetrics(): PerformanceMetrics {
    return {
      totalReturn: 0, totalReturnPct: 0, sharpeRatio: 0, sortinoRatio: 0,
      maxDrawdown: 0, maxDrawdownPct: 0, winRate: 0, profitFactor: 0,
      totalTrades: 0, winningTrades: 0, losingTrades: 0, avgWin: 0,
      avgLoss: 0, avgHoldingPeriod: 0, calmarRatio: 0,
    };
  }

  private createInsufficientDataResult(strategy: Strategy): WalkForwardResult {
    return {
      strategy: strategy.name,
      dna: strategy.dna,
      inSampleMetrics: this.emptyMetrics(),
      outOfSampleMetrics: this.emptyMetrics(),
      overfitScore: 0,
      isOverfit: false,
      degradation: { sharpe: 0, winRate: 0, totalReturn: 0, profitFactor: 0 },
      folds: [],
      recommendation: 'Insufficient data for walk-forward validation (need 200+ candles)',
    };
  }
}
