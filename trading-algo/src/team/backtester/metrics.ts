import type { PerformanceMetrics } from '../../shared/types.js';
import type { CompletedTrade } from './types.js';
import { mean, stdDev } from '../../shared/utils.js';

const ANNUALIZATION_FACTOR = Math.sqrt(252); // ~252 trading days/year
const RISK_FREE_RATE = 0.04; // 4% annual (approximate current T-bill rate)

export function calculateMetrics(
  trades: CompletedTrade[],
  equityCurve: Array<{ timestamp: number; equity: number }>,
  initialCapital: number
): PerformanceMetrics {
  if (trades.length === 0) {
    return emptyMetrics();
  }

  const winners = trades.filter((t) => t.pnl > 0);
  const losers = trades.filter((t) => t.pnl <= 0);

  const totalReturn = equityCurve.length > 0
    ? equityCurve[equityCurve.length - 1].equity - initialCapital
    : 0;
  const totalReturnPct = (totalReturn / initialCapital) * 100;

  const winRate = winners.length / trades.length;
  const avgWin = winners.length > 0 ? mean(winners.map((t) => t.pnl)) : 0;
  const avgLoss = losers.length > 0 ? Math.abs(mean(losers.map((t) => t.pnl))) : 0;
  const profitFactor = avgLoss > 0
    ? (winners.reduce((s, t) => s + t.pnl, 0)) / Math.abs(losers.reduce((s, t) => s + t.pnl, 0))
    : winners.length > 0 ? Infinity : 0;

  // Daily returns for Sharpe/Sortino
  const dailyReturns = calculateDailyReturns(equityCurve);
  const sharpeRatio = calculateSharpe(dailyReturns);
  const sortinoRatio = calculateSortino(dailyReturns);

  // Drawdown
  const { maxDrawdown, maxDrawdownPct } = calculateMaxDrawdown(equityCurve);

  // Calmar ratio
  const calmarRatio = maxDrawdownPct !== 0 ? totalReturnPct / maxDrawdownPct : 0;

  // Average holding period
  const avgHoldingPeriod = mean(trades.map((t) => t.holdingPeriodMs));

  return {
    totalReturn,
    totalReturnPct,
    sharpeRatio,
    sortinoRatio,
    maxDrawdown,
    maxDrawdownPct,
    winRate,
    profitFactor,
    totalTrades: trades.length,
    winningTrades: winners.length,
    losingTrades: losers.length,
    avgWin,
    avgLoss,
    avgHoldingPeriod,
    calmarRatio,
  };
}

function calculateDailyReturns(equityCurve: Array<{ timestamp: number; equity: number }>): number[] {
  if (equityCurve.length < 2) return [];
  const returns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1].equity;
    if (prev !== 0) {
      returns.push((equityCurve[i].equity - prev) / prev);
    }
  }
  return returns;
}

function calculateSharpe(dailyReturns: number[]): number {
  if (dailyReturns.length < 2) return 0;
  const avgReturn = mean(dailyReturns);
  const sd = stdDev(dailyReturns);
  if (sd === 0) return 0;
  const dailyRiskFree = RISK_FREE_RATE / 252;
  return ((avgReturn - dailyRiskFree) / sd) * ANNUALIZATION_FACTOR;
}

function calculateSortino(dailyReturns: number[]): number {
  if (dailyReturns.length < 2) return 0;
  const avgReturn = mean(dailyReturns);
  const negativeReturns = dailyReturns.filter((r) => r < 0);
  if (negativeReturns.length === 0) return avgReturn > 0 ? Infinity : 0;
  const downDev = Math.sqrt(mean(negativeReturns.map((r) => r * r)));
  if (downDev === 0) return 0;
  const dailyRiskFree = RISK_FREE_RATE / 252;
  return ((avgReturn - dailyRiskFree) / downDev) * ANNUALIZATION_FACTOR;
}

function calculateMaxDrawdown(
  equityCurve: Array<{ timestamp: number; equity: number }>
): { maxDrawdown: number; maxDrawdownPct: number } {
  if (equityCurve.length === 0) return { maxDrawdown: 0, maxDrawdownPct: 0 };

  let peak = equityCurve[0].equity;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;

  for (const point of equityCurve) {
    if (point.equity > peak) peak = point.equity;
    const drawdown = peak - point.equity;
    const drawdownPct = peak > 0 ? (drawdown / peak) * 100 : 0;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
      maxDrawdownPct = drawdownPct;
    }
  }

  return { maxDrawdown, maxDrawdownPct };
}

function emptyMetrics(): PerformanceMetrics {
  return {
    totalReturn: 0, totalReturnPct: 0, sharpeRatio: 0, sortinoRatio: 0,
    maxDrawdown: 0, maxDrawdownPct: 0, winRate: 0, profitFactor: 0,
    totalTrades: 0, winningTrades: 0, losingTrades: 0,
    avgWin: 0, avgLoss: 0, avgHoldingPeriod: 0, calmarRatio: 0,
  };
}
