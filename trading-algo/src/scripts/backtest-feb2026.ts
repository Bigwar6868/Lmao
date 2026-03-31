/**
 * Backtest with February 2026 synthetic data.
 *
 * Generates 672 hourly candles (28 days) for key forex + crypto pairs,
 * runs all 4 strategies through the full pipeline including quant modules.
 */

import { generateSyntheticCandles } from '../shared/synthetic.js';
import { Backtester } from '../team/backtester/index.js';
import { TechnicalStrategist } from '../team/technical-strategist/index.js';
import { QuantModuleManager } from '../team/quant-modules/index.js';
import { RiskManager } from '../team/risk-manager/index.js';
import type { AssetInfo, Candle, Timeframe, Signal, MarketData } from '../shared/types.js';

const FEB_2026_START = new Date('2026-02-01T00:00:00Z').getTime();
const CANDLE_COUNT = 672; // 28 days × 24 hours
const TIMEFRAME: Timeframe = '1h';

// Key pairs to test
const TEST_ASSETS: AssetInfo[] = [
  // Forex majors
  { symbol: 'EUR/USD', assetClass: 'forex', exchange: 'OANDA' },
  { symbol: 'GBP/USD', assetClass: 'forex', exchange: 'OANDA' },
  { symbol: 'USD/JPY', assetClass: 'forex', exchange: 'OANDA' },
  { symbol: 'AUD/USD', assetClass: 'forex', exchange: 'OANDA' },
  { symbol: 'USD/CHF', assetClass: 'forex', exchange: 'OANDA' },
  { symbol: 'USD/CAD', assetClass: 'forex', exchange: 'OANDA' },
  // Forex crosses
  { symbol: 'EUR/GBP', assetClass: 'forex', exchange: 'OANDA' },
  { symbol: 'GBP/JPY', assetClass: 'forex', exchange: 'OANDA' },
  // Metals
  { symbol: 'XAU/USD', assetClass: 'forex', exchange: 'OANDA' },
  { symbol: 'XAG/USD', assetClass: 'forex', exchange: 'OANDA' },
  // Crypto
  { symbol: 'BTC/USDT', assetClass: 'crypto', exchange: 'Binance' },
  { symbol: 'ETH/USDT', assetClass: 'crypto', exchange: 'Binance' },
  { symbol: 'SOL/USDT', assetClass: 'crypto', exchange: 'Binance' },
];

function generateFeb2026Candles(symbol: string): Candle[] {
  const candles = generateSyntheticCandles(symbol, CANDLE_COUNT);
  // Shift timestamps to Feb 2026
  const firstTs = candles[0].timestamp;
  const offset = FEB_2026_START - firstTs;
  return candles.map(c => ({ ...c, timestamp: c.timestamp + offset }));
}

async function main() {
  console.log('='.repeat(70));
  console.log('  BACKTEST: February 2026 (Synthetic Data)');
  console.log('  28 days × 24h = 672 candles per asset');
  console.log('  Assets: ' + TEST_ASSETS.length);
  console.log('='.repeat(70));

  const backtester = new Backtester();
  const strategist = new TechnicalStrategist();
  const quantModules = new QuantModuleManager();
  const riskManager = new RiskManager();
  const strategies = strategist.getStrategies();

  // Generate data for all assets
  const allCandles = new Map<string, Candle[]>();
  const marketDataMap = new Map<string, MarketData>();
  for (const asset of TEST_ASSETS) {
    const candles = generateFeb2026Candles(asset.symbol);
    allCandles.set(asset.symbol, candles);
    marketDataMap.set(asset.symbol, {
      asset,
      timeframe: TIMEFRAME,
      candles,
      lastUpdated: candles[candles.length - 1].timestamp,
    });
  }

  // Run quant module analysis on the data
  const allSignals: Signal[] = [];
  for (const [, data] of marketDataMap) {
    for (const strategy of strategies) {
      const signals = strategy.analyze(data, undefined);
      if (signals.length > 0) allSignals.push(...signals);
    }
  }

  const prices = new Map<string, number>();
  for (const [sym, candles] of allCandles) {
    prices.set(sym, candles[candles.length - 1].close);
  }

  console.log(`\nGenerated ${allSignals.length} raw signals from ${TEST_ASSETS.length} assets`);

  // Run quant modules
  const quantReport = await quantModules.runCycle(allSignals, marketDataMap, prices);
  console.log(QuantModuleManager.formatReport(quantReport));

  // Backtest each asset with each strategy
  interface StrategyResult {
    strategy: string;
    totalReturn: number;
    sharpe: number;
    winRate: number;
    maxDrawdown: number;
    trades: number;
  }

  const allResults: StrategyResult[] = [];
  const assetResults = new Map<string, StrategyResult[]>();

  for (const asset of TEST_ASSETS) {
    const candles = allCandles.get(asset.symbol)!;
    const results: StrategyResult[] = [];

    for (const strategy of strategies) {
      const result = await backtester.backtest(strategy, candles, asset, TIMEFRAME);

      // Record for DSR
      quantModules.statValidator.recordTrial(strategy.name, result.metrics.sharpeRatio);

      const sr: StrategyResult = {
        strategy: result.dna.name,
        totalReturn: result.metrics.totalReturnPct,
        sharpe: result.metrics.sharpeRatio,
        winRate: result.metrics.winRate,
        maxDrawdown: result.metrics.maxDrawdownPct,
        trades: result.metrics.totalTrades,
      };
      results.push(sr);
      allResults.push(sr);
    }

    assetResults.set(asset.symbol, results);
  }

  // Print per-asset results
  console.log('\n' + '='.repeat(70));
  console.log('  RESULTS BY ASSET');
  console.log('='.repeat(70));

  for (const [symbol, results] of assetResults) {
    console.log(`\n  ${symbol}:`);
    for (const r of results) {
      const returnStr = r.totalReturn >= 0 ? `+${r.totalReturn.toFixed(2)}%` : `${r.totalReturn.toFixed(2)}%`;
      console.log(
        `    ${r.strategy.padEnd(20)} | Return: ${returnStr.padStart(8)} | Sharpe: ${r.sharpe.toFixed(2).padStart(6)} | WR: ${(r.winRate * 100).toFixed(0).padStart(3)}% | DD: ${r.maxDrawdown.toFixed(1).padStart(5)}% | Trades: ${r.trades}`,
      );
    }
  }

  // Aggregate by strategy
  console.log('\n' + '='.repeat(70));
  console.log('  AGGREGATE BY STRATEGY');
  console.log('='.repeat(70));

  const strategyAgg = new Map<string, { returns: number[]; sharpes: number[]; winRates: number[]; drawdowns: number[]; trades: number }>();
  for (const r of allResults) {
    const agg = strategyAgg.get(r.strategy) ?? { returns: [], sharpes: [], winRates: [], drawdowns: [], trades: 0 };
    agg.returns.push(r.totalReturn);
    agg.sharpes.push(r.sharpe);
    agg.winRates.push(r.winRate);
    agg.drawdowns.push(r.maxDrawdown);
    agg.trades += r.trades;
    strategyAgg.set(r.strategy, agg);
  }

  for (const [name, agg] of strategyAgg) {
    const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const avgReturn = avg(agg.returns);
    const avgSharpe = avg(agg.sharpes);
    const avgWinRate = avg(agg.winRates);
    const maxDD = Math.max(...agg.drawdowns);
    const profitable = agg.returns.filter(r => r > 0).length;

    console.log(`\n  ${name}:`);
    console.log(`    Avg Return: ${avgReturn >= 0 ? '+' : ''}${avgReturn.toFixed(2)}% | Avg Sharpe: ${avgSharpe.toFixed(2)} | Avg WR: ${(avgWinRate * 100).toFixed(0)}%`);
    console.log(`    Max Drawdown: ${maxDD.toFixed(1)}% | Total Trades: ${agg.trades} | Profitable on: ${profitable}/${TEST_ASSETS.length} assets`);
  }

  // Deflated Sharpe Ratio check
  console.log('\n' + '='.repeat(70));
  console.log('  DEFLATED SHARPE RATIO (overfitting check)');
  console.log('='.repeat(70));

  for (const strategy of strategies) {
    // Use EUR/USD returns as representative sample for DSR
    const eurusdCandles = allCandles.get('EUR/USD')!;
    const returns = eurusdCandles.slice(1).map((c, i) => (c.close - eurusdCandles[i].close) / eurusdCandles[i].close);
    const agg = strategyAgg.get(strategy.name);
    const avgSharpe = agg ? agg.sharpes.reduce((a, b) => a + b, 0) / agg.sharpes.length : 0;
    const dsr = quantModules.statValidator.computeDeflatedSharpe(strategy.name, avgSharpe, returns);
    if (dsr) {
      const verdict = dsr.isSignificant ? 'VALID' : 'NOT SIGNIFICANT';
      console.log(`\n  ${strategy.name}: DSR = ${dsr.deflatedSharpe.toFixed(3)} [${verdict}]`);
      console.log(`    Observed SR: ${dsr.observedSharpe.toFixed(3)} | Expected Max SR: ${dsr.expectedMaxSharpe.toFixed(3)} | Trials: ${dsr.totalTrials}`);
    }
  }

  // Risk assessment on best signals
  console.log('\n' + '='.repeat(70));
  console.log('  RISK ASSESSMENT (sample signals)');
  console.log('='.repeat(70));

  const sampleSignals = quantReport.adjustedSignals
    .filter(s => s.action !== 'HOLD')
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 10);

  for (const signal of sampleSignals) {
    const candles = allCandles.get(signal.asset.symbol);
    if (!candles) continue;
    const assessment = riskManager.assessRisk(signal, {
      capital: 10000,
      availableCapital: 10000,
      positions: [],
      totalPnl: 0,
      totalPnlPct: 0,
      maxDrawdown: 0,
      lastUpdated: Date.now(),
    }, candles);

    console.log(
      `\n  ${signal.action} ${signal.asset.symbol} (${signal.strategy}) conf: ${signal.confidence.toFixed(2)}`,
    );
    console.log(
      `    Size: $${assessment.recommendedSize.toFixed(2)} | SL: ${assessment.stopLossPrice.toFixed(5)} | TP: ${assessment.takeProfitPrice.toFixed(5)} | R:R: ${assessment.riskRewardRatio.toFixed(2)} | ${assessment.approved ? 'APPROVED' : 'REJECTED: ' + assessment.reason}`,
    );
  }

  console.log('\n' + '='.repeat(70));
  console.log('  BACKTEST COMPLETE');
  console.log('='.repeat(70));
}

main().catch(console.error);
