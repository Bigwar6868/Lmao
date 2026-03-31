/**
 * Full System Integration Backtest
 *
 * Tests the ENTIRE pipeline end-to-end:
 * 1. All 11 strategies generate signals on 13 assets
 * 2. Backtester runs with ATR stops, trailing stops, time exits
 * 3. CEO profitability review: disables losers, ranks strategies
 * 4. Quant modules: regime detection, IC health, DSR validation
 * 5. Risk manager: position sizing, risk assessment
 *
 * This is the CEO's system audit — verifying every team works.
 */

import { generateSyntheticCandles } from '../shared/synthetic.js';
import { Backtester } from '../team/backtester/index.js';
import { TechnicalStrategist } from '../team/technical-strategist/index.js';
import { QuantModuleManager } from '../team/quant-modules/index.js';
import { RiskManager } from '../team/risk-manager/index.js';
import { CEOAgent, type ProfitabilityReview } from '../team/ceo/index.js';
import { AgentNetwork } from '../team/agent-network/network.js';
import type { AssetInfo, Candle, Timeframe, Signal, MarketData, Portfolio, Strategy, Position } from '../shared/types.js';

const START_TS = new Date('2026-02-01T00:00:00Z').getTime();
const CANDLE_COUNT = 720; // 30 days × 24h
const TIMEFRAME: Timeframe = '1h';

const TEST_ASSETS: AssetInfo[] = [
  // Forex majors
  { symbol: 'EUR/USD', assetClass: 'forex', exchange: 'OANDA' },
  { symbol: 'GBP/USD', assetClass: 'forex', exchange: 'OANDA' },
  { symbol: 'USD/JPY', assetClass: 'forex', exchange: 'OANDA' },
  { symbol: 'AUD/USD', assetClass: 'forex', exchange: 'OANDA' },
  { symbol: 'USD/CHF', assetClass: 'forex', exchange: 'OANDA' },
  { symbol: 'USD/CAD', assetClass: 'forex', exchange: 'OANDA' },
  // Crosses
  { symbol: 'EUR/GBP', assetClass: 'forex', exchange: 'OANDA' },
  { symbol: 'GBP/JPY', assetClass: 'forex', exchange: 'OANDA' },
  // Metals
  { symbol: 'XAU/USD', assetClass: 'forex', exchange: 'OANDA' },
  // Crypto
  { symbol: 'BTC/USDT', assetClass: 'crypto', exchange: 'Binance' },
  { symbol: 'ETH/USDT', assetClass: 'crypto', exchange: 'Binance' },
  { symbol: 'SOL/USDT', assetClass: 'crypto', exchange: 'Binance' },
  { symbol: 'BNB/USDT', assetClass: 'crypto', exchange: 'Binance' },
];

function generateCandles(symbol: string): Candle[] {
  const candles = generateSyntheticCandles(symbol, CANDLE_COUNT);
  const firstTs = candles[0].timestamp;
  const offset = START_TS - firstTs;
  return candles.map(c => ({ ...c, timestamp: c.timestamp + offset }));
}

function hr(title: string): void {
  console.log('\n' + '='.repeat(70));
  console.log(`  ${title}`);
  console.log('='.repeat(70));
}

function subhr(title: string): void {
  console.log(`\n  --- ${title} ---`);
}

async function main() {
  hr('FULL SYSTEM INTEGRATION BACKTEST');
  console.log(`  Assets: ${TEST_ASSETS.length} | Candles: ${CANDLE_COUNT} | Timeframe: ${TIMEFRAME}`);
  console.log(`  Date range: Feb 1 - Mar 2, 2026 (synthetic data)`);

  // Initialize all modules
  const backtester = new Backtester();
  const strategist = new TechnicalStrategist();
  const quantModules = new QuantModuleManager();
  const riskManager = new RiskManager();
  const network = new AgentNetwork();
  const ceo = new CEOAgent(network);

  const strategies = strategist.getStrategies();
  console.log(`  Strategies: ${strategies.length} — ${strategies.map(s => s.name).join(', ')}`);

  // ============================================================
  // PHASE 1: DATA GENERATION
  // ============================================================
  hr('PHASE 1: DATA GENERATION');

  const allCandles = new Map<string, Candle[]>();
  const marketDataMap = new Map<string, MarketData>();
  for (const asset of TEST_ASSETS) {
    const candles = generateCandles(asset.symbol);
    allCandles.set(asset.symbol, candles);
    marketDataMap.set(asset.symbol, {
      asset, timeframe: TIMEFRAME, candles,
      lastUpdated: candles[candles.length - 1].timestamp,
    });
    console.log(`  ${asset.symbol}: ${candles.length} candles, range $${candles[0].close.toFixed(2)} - $${candles[candles.length - 1].close.toFixed(2)}`);
  }

  // ============================================================
  // PHASE 2: SIGNAL GENERATION — test all 11 strategies
  // ============================================================
  hr('PHASE 2: SIGNAL GENERATION (all 11 strategies)');

  const allSignals: Signal[] = [];
  const signalsByStrategy = new Map<string, Signal[]>();
  const signalsByAsset = new Map<string, Signal[]>();

  for (const [symbol, data] of marketDataMap) {
    for (const strategy of strategies) {
      try {
        const signals = await strategy.analyze(data);
        for (const signal of signals) {
          allSignals.push(signal);
          const sList = signalsByStrategy.get(strategy.name) ?? [];
          sList.push(signal);
          signalsByStrategy.set(strategy.name, sList);
          const aList = signalsByAsset.get(symbol) ?? [];
          aList.push(signal);
          signalsByAsset.set(symbol, aList);
        }
      } catch (err) {
        console.error(`  ERROR: ${strategy.name} on ${symbol}: ${(err as Error).message}`);
      }
    }
  }

  console.log(`\n  Total signals: ${allSignals.length}`);
  console.log(`  BUY: ${allSignals.filter(s => s.action === 'BUY').length} | SELL: ${allSignals.filter(s => s.action === 'SELL').length} | HOLD: ${allSignals.filter(s => s.action === 'HOLD').length}`);

  subhr('Signal Count by Strategy');
  for (const [name, signals] of signalsByStrategy) {
    const buys = signals.filter(s => s.action === 'BUY').length;
    const sells = signals.filter(s => s.action === 'SELL').length;
    const holds = signals.filter(s => s.action === 'HOLD').length;
    const avgConf = signals.filter(s => s.action !== 'HOLD').reduce((s, sig) => s + sig.confidence, 0) /
      Math.max(1, signals.filter(s => s.action !== 'HOLD').length);
    const status = buys + sells > 0 ? 'ACTIVE' : 'NO SIGNALS';
    console.log(`  ${status === 'ACTIVE' ? '+' : '-'} ${name.padEnd(22)} | BUY: ${String(buys).padStart(3)} | SELL: ${String(sells).padStart(3)} | HOLD: ${String(holds).padStart(3)} | Avg Conf: ${(avgConf * 100).toFixed(0)}% [${status}]`);
  }

  // Check which strategies generated NO actionable signals — potential problem
  const deadStrategies = [...signalsByStrategy.entries()]
    .filter(([, signals]) => signals.every(s => s.action === 'HOLD'))
    .map(([name]) => name);
  if (deadStrategies.length > 0) {
    console.log(`\n  WARNING: ${deadStrategies.length} strategies produced only HOLD signals: ${deadStrategies.join(', ')}`);
  }

  // ============================================================
  // PHASE 3: QUANT MODULE ANALYSIS
  // ============================================================
  hr('PHASE 3: QUANT MODULE ANALYSIS');

  const prices = new Map<string, number>();
  for (const [sym, candles] of allCandles) {
    prices.set(sym, candles[candles.length - 1].close);
  }

  const quantReport = await quantModules.runCycle(allSignals, marketDataMap, prices);
  console.log(`  Regime: ${quantReport.hmmRegime.currentState.toUpperCase()} (confidence: ${(quantReport.hmmRegime.confidence * 100).toFixed(0)}%)`);
  const sp = quantReport.hmmRegime.stateProbabilities;
  console.log(`    Bull: ${((sp.bull ?? 0) * 100).toFixed(0)}% | Bear: ${((sp.bear ?? 0) * 100).toFixed(0)}% | Sideways: ${((sp.sideways ?? 0) * 100).toFixed(0)}%`);
  console.log(`  Signals after quant filter: ${quantReport.adjustedSignals.length}/${allSignals.length}`);
  console.log(`  IC Health:`);
  for (const h of quantReport.icHealth) {
    console.log(`    ${h.strategy.padEnd(22)} — ${h.health.toUpperCase()}`);
  }
  console.log(`  MR-suitable pairs: ${quantReport.halfLifeResults.filter(r => r.suitableForMR).length}/${quantReport.halfLifeResults.length}`);
  const activeModules = quantReport.moduleDecisions.filter(d => d.active).map(d => d.module);
  console.log(`  Active quant modules: ${activeModules.join(', ') || 'none'}`);

  // ============================================================
  // PHASE 4: BACKTESTING — all strategies on all assets
  // ============================================================
  hr('PHASE 4: BACKTESTING (all strategies × all assets)');

  interface StratResult {
    strategy: string;
    asset: string;
    totalReturn: number;
    sharpe: number;
    winRate: number;
    maxDrawdown: number;
    trades: number;
    avgPnl: number;
    profitFactor: number;
  }

  const allResults: StratResult[] = [];
  let totalBacktests = 0;
  let totalTrades = 0;

  for (const asset of TEST_ASSETS) {
    const candles = allCandles.get(asset.symbol)!;

    for (const strategy of strategies) {
      try {
        const result = await backtester.backtest(strategy, candles, asset, TIMEFRAME);
        totalBacktests++;

        const trades = result.metrics.totalTrades;
        totalTrades += trades;

        // Record trial for DSR
        quantModules.statValidator.recordTrial(strategy.name, result.metrics.sharpeRatio);

        const winningTrades = Math.round(result.metrics.winRate * trades);
        const losingTrades = trades - winningTrades;
        const avgWin = result.metrics.totalReturnPct > 0 && winningTrades > 0
          ? (result.metrics.totalReturnPct / winningTrades) : 0;
        const avgLoss = losingTrades > 0
          ? (Math.abs(result.metrics.maxDrawdownPct) / losingTrades) : 1;
        const pf = avgLoss > 0 ? (winningTrades * avgWin) / (losingTrades * avgLoss) : 0;

        allResults.push({
          strategy: result.dna.name,
          asset: asset.symbol,
          totalReturn: result.metrics.totalReturnPct,
          sharpe: result.metrics.sharpeRatio,
          winRate: result.metrics.winRate,
          maxDrawdown: result.metrics.maxDrawdownPct,
          trades,
          avgPnl: trades > 0 ? result.metrics.totalReturnPct / trades : 0,
          profitFactor: pf,
        });
      } catch (err) {
        console.error(`  ERROR backtesting ${strategy.name} on ${asset.symbol}: ${(err as Error).message}`);
      }
    }
  }

  console.log(`  Completed: ${totalBacktests} backtests | Total trades: ${totalTrades}`);

  // ============================================================
  // PHASE 5: AGGREGATE RESULTS
  // ============================================================
  hr('PHASE 5: STRATEGY PERFORMANCE RANKINGS');

  const stratAgg = new Map<string, {
    returns: number[]; sharpes: number[]; winRates: number[];
    drawdowns: number[]; trades: number; profitableAssets: number; totalAssets: number;
  }>();

  for (const r of allResults) {
    const agg = stratAgg.get(r.strategy) ?? {
      returns: [], sharpes: [], winRates: [], drawdowns: [],
      trades: 0, profitableAssets: 0, totalAssets: 0,
    };
    agg.returns.push(r.totalReturn);
    agg.sharpes.push(r.sharpe);
    agg.winRates.push(r.winRate);
    agg.drawdowns.push(r.maxDrawdown);
    agg.trades += r.trades;
    agg.totalAssets++;
    if (r.totalReturn > 0) agg.profitableAssets++;
    stratAgg.set(r.strategy, agg);
  }

  const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  // Sort by average return
  const ranked = [...stratAgg.entries()].sort((a, b) => avg(b[1].returns) - avg(a[1].returns));

  console.log('');
  console.log('  ' + 'Strategy'.padEnd(22) + ' | ' + 'Avg Ret'.padStart(8) + ' | ' + 'Avg SR'.padStart(7) +
    ' | ' + 'Avg WR'.padStart(7) + ' | ' + 'MaxDD'.padStart(6) + ' | ' + 'Trades'.padStart(6) +
    ' | ' + 'Profit'.padStart(6));
  console.log('  ' + '-'.repeat(80));

  for (const [name, agg] of ranked) {
    const avgRet = avg(agg.returns);
    const avgSR = avg(agg.sharpes);
    const avgWR = avg(agg.winRates);
    const maxDD = Math.max(...agg.drawdowns);
    const retStr = avgRet >= 0 ? `+${avgRet.toFixed(2)}%` : `${avgRet.toFixed(2)}%`;

    console.log(
      `  ${name.padEnd(22)} | ${retStr.padStart(8)} | ${avgSR.toFixed(2).padStart(7)} | ` +
      `${(avgWR * 100).toFixed(0).padStart(5)}% | ${maxDD.toFixed(1).padStart(5)}% | ` +
      `${String(agg.trades).padStart(6)} | ${agg.profitableAssets}/${agg.totalAssets}`,
    );
  }

  // ============================================================
  // PHASE 6: CEO PROFITABILITY REVIEW
  // ============================================================
  hr('PHASE 6: CEO PROFITABILITY REVIEW');

  // Build a mock portfolio from backtest results for CEO to review
  const mockPositions: Position[] = [];
  let posId = 0;
  for (const r of allResults) {
    if (r.trades === 0) continue;
    // Create synthetic closed positions to represent the backtest outcome
    const asset = TEST_ASSETS.find(a => a.symbol === r.asset)!;
    const avgTradeReturn = r.trades > 0 ? r.totalReturn / r.trades : 0;
    const wins = Math.round(r.winRate * r.trades);

    for (let t = 0; t < Math.min(r.trades, 5); t++) {
      // Alternate wins/losses based on win rate
      const isWin = t < wins;
      const pnl = isWin
        ? Math.abs(avgTradeReturn) * 100 * (0.5 + Math.random())
        : -Math.abs(avgTradeReturn) * 100 * (0.5 + Math.random());

      mockPositions.push({
        id: `pos-${posId++}`,
        asset,
        side: 'buy',
        entryPrice: 100,
        currentPrice: 100 + pnl / 10,
        quantity: 1,
        unrealizedPnl: 0,
        realizedPnl: pnl,
        status: 'closed',
        openedAt: START_TS,
        closedAt: START_TS + 86400000,
        strategy: r.strategy,
      });
    }
  }

  const mockPortfolio: Portfolio = {
    capital: 10000,
    availableCapital: 10000,
    positions: mockPositions,
    totalPnl: mockPositions.reduce((s, p) => s + p.realizedPnl, 0),
    totalPnlPct: 0,
    maxDrawdown: 0,
    lastUpdated: Date.now(),
  };
  mockPortfolio.totalPnlPct = (mockPortfolio.totalPnl / mockPortfolio.capital) * 100;

  console.log(`  Mock portfolio: ${mockPositions.length} closed positions across ${strategies.length} strategies`);
  console.log(`  Total PnL: $${mockPortfolio.totalPnl.toFixed(2)} (${mockPortfolio.totalPnlPct.toFixed(2)}%)`);

  // Run CEO profitability review
  const profReview = ceo.profitabilityReview(mockPortfolio, strategies);
  console.log(CEOAgent.formatProfitabilityReview(profReview));

  // ============================================================
  // PHASE 7: RISK MANAGEMENT CHECK
  // ============================================================
  hr('PHASE 7: RISK MANAGEMENT CHECKS');

  const actionableSignals = quantReport.adjustedSignals
    .filter(s => s.action !== 'HOLD')
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 15);

  let approved = 0;
  let rejected = 0;

  for (const signal of actionableSignals) {
    const candles = allCandles.get(signal.asset.symbol);
    if (!candles) continue;

    const assessment = riskManager.assessRisk(signal, mockPortfolio, candles);

    if (assessment.approved) approved++;
    else rejected++;

    console.log(
      `  ${assessment.approved ? 'APPROVED' : 'REJECTED'} | ${signal.action} ${signal.asset.symbol.padEnd(10)} (${signal.strategy.padEnd(18)}) ` +
      `conf: ${signal.confidence.toFixed(2)} | size: $${assessment.recommendedSize.toFixed(0)} | R:R: ${assessment.riskRewardRatio.toFixed(1)} ` +
      `${!assessment.approved ? '| ' + assessment.reason : ''}`,
    );
  }

  console.log(`\n  Risk gate: ${approved} approved, ${rejected} rejected out of ${actionableSignals.length} signals`);

  // ============================================================
  // PHASE 8: DEFLATED SHARPE RATIO (overfitting check)
  // ============================================================
  hr('PHASE 8: DEFLATED SHARPE RATIO');

  const eurusdCandles = allCandles.get('EUR/USD')!;
  const returns = eurusdCandles.slice(1).map((c, i) => (c.close - eurusdCandles[i].close) / eurusdCandles[i].close);

  for (const strategy of strategies) {
    const agg = stratAgg.get(strategy.name);
    const avgSharpe = agg ? avg(agg.sharpes) : 0;
    const dsr = quantModules.statValidator.computeDeflatedSharpe(strategy.name, avgSharpe, returns);
    if (dsr) {
      const verdict = dsr.isSignificant ? 'VALID' : 'NOT SIGNIFICANT';
      console.log(`  ${strategy.name.padEnd(22)} DSR: ${dsr.deflatedSharpe.toFixed(3)} [${verdict}] (obs: ${dsr.observedSharpe.toFixed(3)}, max: ${dsr.expectedMaxSharpe.toFixed(3)}, trials: ${dsr.totalTrials})`);
    }
  }

  // ============================================================
  // PHASE 9: SYSTEM HEALTH SUMMARY
  // ============================================================
  hr('SYSTEM HEALTH SUMMARY');

  const enabledStrats = strategies.filter(s => s.config.enabled);
  const disabledStrats = strategies.filter(s => !s.config.enabled);

  console.log(`\n  Strategies: ${enabledStrats.length} enabled, ${disabledStrats.length} disabled by CEO`);
  if (disabledStrats.length > 0) {
    console.log(`  Disabled: ${disabledStrats.map(s => s.name).join(', ')}`);
  }
  console.log(`  Total backtests run: ${totalBacktests}`);
  console.log(`  Total trades simulated: ${totalTrades}`);
  console.log(`  Quant regime: ${quantReport.hmmRegime.currentState}`);
  console.log(`  Risk gate pass rate: ${actionableSignals.length > 0 ? ((approved / actionableSignals.length) * 100).toFixed(0) : 0}%`);
  console.log(`  CEO profitability verdict: ${profReview.isProfitable ? 'PROFITABLE' : 'UNPROFITABLE'}`);
  console.log(`  CEO disabled this review: ${profReview.disabled.length}`);
  console.log(`  CEO re-enabled this review: ${profReview.reEnabled.length}`);

  // Check for issues
  const issues: string[] = [];
  if (enabledStrats.length < 3) issues.push('Too few strategies enabled — system may be under-diversified');
  if (totalTrades < 50) issues.push('Very few trades generated — strategies may be too conservative');
  if (deadStrategies.length > 3) issues.push(`${deadStrategies.length} strategies produced no signals — check asset class coverage`);
  if (approved === 0 && actionableSignals.length > 0) issues.push('Risk manager rejected ALL signals — thresholds may be too tight');

  if (issues.length > 0) {
    console.log('\n  ISSUES DETECTED:');
    for (const issue of issues) {
      console.log(`    ! ${issue}`);
    }
  } else {
    console.log('\n  All systems operational. No critical issues detected.');
  }

  // CEO recommendations
  if (profReview.recommendations.length > 0) {
    console.log('\n  CEO RECOMMENDATIONS:');
    for (const rec of profReview.recommendations) {
      console.log(`    -> ${rec}`);
    }
  }

  hr('BACKTEST COMPLETE');
}

main().catch(console.error);
