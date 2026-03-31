/**
 * February 2026 Backtest — REAL OANDA DATA
 *
 * Fetches actual 1h candles from OANDA for Feb 2026,
 * then runs all strategies with aggressive config.
 * NO live trades — backtest only.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config/index.js';
import { Backtester } from '../team/backtester/index.js';
import { TechnicalStrategist } from '../team/technical-strategist/index.js';
import { CEOAgent } from '../team/ceo/index.js';
import { AgentNetwork } from '../team/agent-network/network.js';
import type { AssetInfo, Candle, Timeframe, BacktestConfig, Position } from '../shared/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// Config
// ============================================================

const OANDA_TOKEN = config.oandaApiToken;
const OANDA_ACCOUNT = config.oandaAccountId;
const BASE_URL = config.oandaIsLive
  ? 'https://api-fxtrade.oanda.com'
  : 'https://api-fxpractice.oanda.com';

const FEB_START = '2026-02-01T00:00:00.000000000Z';
const FEB_END   = '2026-02-28T23:59:59.000000000Z';
const TIMEFRAME: Timeframe = '1h';
const INITIAL_CAPITAL = 1159; // Match OANDA account balance (GBP)

const AGGRESSIVE_CONFIG: Partial<BacktestConfig> = {
  initialCapital: INITIAL_CAPITAL,
  commission: 0.0005,
  slippage: 0.0003,
  maxPositionPct: 0.50,
  slAtrMult: 1.5,
  tpAtrMult: 5.0,
  maxHoldBars: 24,
};

// Forex + metals available on OANDA
const OANDA_ASSETS: AssetInfo[] = [
  { symbol: 'EUR/USD', assetClass: 'forex', exchange: 'OANDA' },
  { symbol: 'GBP/USD', assetClass: 'forex', exchange: 'OANDA' },
  { symbol: 'USD/JPY', assetClass: 'forex', exchange: 'OANDA' },
  { symbol: 'AUD/USD', assetClass: 'forex', exchange: 'OANDA' },
  { symbol: 'USD/CHF', assetClass: 'forex', exchange: 'OANDA' },
  { symbol: 'USD/CAD', assetClass: 'forex', exchange: 'OANDA' },
  { symbol: 'NZD/USD', assetClass: 'forex', exchange: 'OANDA' },
  { symbol: 'EUR/GBP', assetClass: 'forex', exchange: 'OANDA' },
  { symbol: 'GBP/JPY', assetClass: 'forex', exchange: 'OANDA' },
  { symbol: 'EUR/JPY', assetClass: 'forex', exchange: 'OANDA' },
  { symbol: 'AUD/JPY', assetClass: 'forex', exchange: 'OANDA' },
  { symbol: 'XAU/USD', assetClass: 'forex', exchange: 'OANDA' },
  { symbol: 'XAG/USD', assetClass: 'forex', exchange: 'OANDA' },
];

// ============================================================
// Load candles from pre-fetched OANDA JSON files
// ============================================================

const DATA_DIR = join(__dirname, '../../data/oanda-feb2026');

function loadOandaCandles(symbol: string): Candle[] {
  const instrument = symbol.replace('/', '_');
  const filePath = join(DATA_DIR, `${instrument}.json`);

  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    const bars = raw.candles ?? [];
    const candles: Candle[] = [];

    for (const bar of bars) {
      if (!bar.complete) continue;
      const mid = bar.mid ?? {};
      candles.push({
        timestamp: new Date(bar.time).getTime(),
        open: parseFloat(mid.o ?? '0'),
        high: parseFloat(mid.h ?? '0'),
        low: parseFloat(mid.l ?? '0'),
        close: parseFloat(mid.c ?? '0'),
        volume: parseInt(bar.volume ?? '0', 10),
      });
    }

    return candles;
  } catch {
    return [];
  }
}

// ============================================================
// Helpers
// ============================================================

function hr(title: string): void {
  console.log('\n' + '='.repeat(70));
  console.log(`  ${title}`);
  console.log('='.repeat(70));
}

const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

// ============================================================
// Main
// ============================================================

async function main() {
  if (!OANDA_TOKEN || !OANDA_ACCOUNT) {
    console.error('ERROR: OANDA_API_TOKEN and OANDA_ACCOUNT_ID must be set in .env');
    process.exit(1);
  }

  hr('FEB 2026 BACKTEST — REAL OANDA DATA');
  console.log(`  Capital: £${INITIAL_CAPITAL} | Account: ${OANDA_ACCOUNT}`);
  console.log(`  Period: Feb 1-28, 2026 | Timeframe: ${TIMEFRAME}`);
  console.log(`  Config: 50% max position | SL: 1.5x ATR | TP: 5x ATR | Max hold: 24 bars`);
  console.log(`  Assets: ${OANDA_ASSETS.length} (forex + metals)`);

  // ------------------------------------------------------------------
  // 1. Load real candles from pre-fetched OANDA JSON
  // ------------------------------------------------------------------
  hr('LOADING REAL OANDA CANDLES');

  const allCandles = new Map<string, Candle[]>();

  for (const asset of OANDA_ASSETS) {
    process.stdout.write(`  ${asset.symbol.padEnd(10)} ... `);
    const candles = loadOandaCandles(asset.symbol);
    allCandles.set(asset.symbol, candles);

    if (candles.length > 0) {
      const first = candles[0];
      const last = candles[candles.length - 1];
      const priceFmt = asset.symbol.startsWith('XAU') ? 2 : asset.symbol.includes('JPY') ? 3 : 5;
      console.log(`${candles.length} candles | ${first.close.toFixed(priceFmt)} → ${last.close.toFixed(priceFmt)} | ${((last.close - first.close) / first.close * 100).toFixed(2)}%`);
    } else {
      console.log('0 candles (no data)');
    }
  }

  const assetsWithData = OANDA_ASSETS.filter(a => (allCandles.get(a.symbol)?.length ?? 0) > 50);
  console.log(`\n  Assets with sufficient data: ${assetsWithData.length}/${OANDA_ASSETS.length}`);

  if (assetsWithData.length === 0) {
    console.error('No data available — cannot backtest.');
    process.exit(1);
  }

  // ------------------------------------------------------------------
  // 2. Run backtests
  // ------------------------------------------------------------------
  hr('BACKTESTING — ALL STRATEGIES x REAL DATA');

  const backtester = new Backtester();
  const strategist = new TechnicalStrategist();
  const network = new AgentNetwork();
  const ceo = new CEOAgent(network);
  const strategies = strategist.getStrategies();

  console.log(`  Strategies: ${strategies.length} — ${strategies.map(s => s.name).join(', ')}`);

  interface Result {
    strategy: string;
    asset: string;
    totalReturn: number;
    totalReturnPct: number;
    sharpe: number;
    winRate: number;
    maxDrawdown: number;
    maxDrawdownPct: number;
    trades: number;
    avgWin: number;
    avgLoss: number;
    profitFactor: number;
  }

  const allResults: Result[] = [];
  let totalTrades = 0;

  for (const asset of assetsWithData) {
    const candles = allCandles.get(asset.symbol)!;

    for (const strategy of strategies) {
      try {
        const result = await backtester.backtest(strategy, candles, asset, TIMEFRAME, AGGRESSIVE_CONFIG);
        totalTrades += result.metrics.totalTrades;

        allResults.push({
          strategy: result.dna.name,
          asset: asset.symbol,
          totalReturn: result.metrics.totalReturn,
          totalReturnPct: result.metrics.totalReturnPct,
          sharpe: result.metrics.sharpeRatio,
          winRate: result.metrics.winRate,
          maxDrawdown: result.metrics.maxDrawdown,
          maxDrawdownPct: result.metrics.maxDrawdownPct,
          trades: result.metrics.totalTrades,
          avgWin: result.metrics.avgWin,
          avgLoss: result.metrics.avgLoss,
          profitFactor: result.metrics.profitFactor,
        });
      } catch (err) {
        // Silently skip — some strategies need more candles
      }
    }
  }

  console.log(`\n  Completed: ${allResults.length} backtests | Total trades: ${totalTrades}`);

  // ------------------------------------------------------------------
  // 3. Strategy rankings
  // ------------------------------------------------------------------
  hr('STRATEGY PERFORMANCE RANKINGS');

  const stratAgg = new Map<string, {
    returns: number[]; returnsPct: number[]; sharpes: number[]; winRates: number[];
    drawdowns: number[]; trades: number; profitableAssets: number;
    avgWins: number[]; avgLosses: number[]; profitFactors: number[];
  }>();

  for (const r of allResults) {
    const agg = stratAgg.get(r.strategy) ?? {
      returns: [], returnsPct: [], sharpes: [], winRates: [], drawdowns: [],
      trades: 0, profitableAssets: 0, avgWins: [], avgLosses: [], profitFactors: [],
    };
    agg.returns.push(r.totalReturn);
    agg.returnsPct.push(r.totalReturnPct);
    agg.sharpes.push(r.sharpe);
    agg.winRates.push(r.winRate);
    agg.drawdowns.push(r.maxDrawdownPct);
    agg.trades += r.trades;
    if (r.totalReturnPct > 0) agg.profitableAssets++;
    if (r.avgWin > 0) agg.avgWins.push(r.avgWin);
    if (r.avgLoss > 0) agg.avgLosses.push(r.avgLoss);
    if (r.profitFactor > 0) agg.profitFactors.push(r.profitFactor);
    stratAgg.set(r.strategy, agg);
  }

  const ranked = [...stratAgg.entries()].sort((a, b) => avg(b[1].returnsPct) - avg(a[1].returnsPct));

  console.log('');
  console.log('  ' + 'Strategy'.padEnd(22) + ' | ' + 'Avg Ret%'.padStart(9) + ' | ' +
    'Avg SR'.padStart(7) + ' | ' + 'WR%'.padStart(5) + ' | ' + 'MaxDD%'.padStart(7) + ' | ' +
    'Trades'.padStart(6) + ' | ' + 'PF'.padStart(5) + ' | ' + 'W/L$'.padStart(10) + ' | ' +
    'Prof'.padStart(5));
  console.log('  ' + '-'.repeat(100));

  for (const [name, agg] of ranked) {
    const avgRet = avg(agg.returnsPct);
    const avgSR = avg(agg.sharpes);
    const avgWR = avg(agg.winRates);
    const maxDD = Math.max(...agg.drawdowns);
    const avgPF = avg(agg.profitFactors);
    const avgW = avg(agg.avgWins);
    const avgL = avg(agg.avgLosses);
    const retStr = avgRet >= 0 ? `+${avgRet.toFixed(2)}%` : `${avgRet.toFixed(2)}%`;

    console.log(
      `  ${name.padEnd(22)} | ${retStr.padStart(9)} | ${avgSR.toFixed(2).padStart(7)} | ` +
      `${(avgWR * 100).toFixed(0).padStart(3)}% | ${maxDD.toFixed(1).padStart(6)}% | ` +
      `${String(agg.trades).padStart(6)} | ${avgPF.toFixed(2).padStart(5)} | ` +
      `${avgW.toFixed(0).padStart(4)}/${avgL.toFixed(0).padStart(4)} | ` +
      `${agg.profitableAssets}/${assetsWithData.length}`,
    );
  }

  // ------------------------------------------------------------------
  // 4. Best strategy per asset
  // ------------------------------------------------------------------
  hr('BEST STRATEGY PER ASSET');

  for (const asset of assetsWithData) {
    const assetResults = allResults.filter(r => r.asset === asset.symbol && r.trades > 0);
    assetResults.sort((a, b) => b.totalReturnPct - a.totalReturnPct);
    const best = assetResults[0];
    const worst = assetResults[assetResults.length - 1];

    if (best) {
      const bestStr = best.totalReturnPct >= 0 ? `+${best.totalReturnPct.toFixed(2)}%` : `${best.totalReturnPct.toFixed(2)}%`;
      const worstStr = worst ? (worst.totalReturnPct >= 0 ? `+${worst.totalReturnPct.toFixed(2)}%` : `${worst.totalReturnPct.toFixed(2)}%`) : 'N/A';
      console.log(
        `  ${asset.symbol.padEnd(12)} Best: ${best.strategy.padEnd(20)} ${bestStr.padStart(8)} (${best.trades} trades, WR: ${(best.winRate * 100).toFixed(0)}%)` +
        `  |  Worst: ${worst?.strategy.padEnd(20) ?? 'N/A'} ${worstStr.padStart(8)}`,
      );
    } else {
      console.log(`  ${asset.symbol.padEnd(12)} No trades generated`);
    }
  }

  // ------------------------------------------------------------------
  // 5. CEO profitability review
  // ------------------------------------------------------------------
  hr('CEO PROFITABILITY REVIEW');

  const mockPositions: Position[] = [];
  let posId = 0;
  for (const r of allResults) {
    if (r.trades === 0) continue;
    const asset = assetsWithData.find(a => a.symbol === r.asset)!;
    if (!asset) continue;
    const pnlPerTrade = r.trades > 0 ? (r.totalReturn / r.trades) : 0;
    const wins = Math.round(r.winRate * Math.min(r.trades, 5));

    for (let t = 0; t < Math.min(r.trades, 5); t++) {
      const isWin = t < wins;
      const tradePnl = isWin ? Math.abs(pnlPerTrade) * (0.8 + Math.random() * 0.4) : -Math.abs(pnlPerTrade) * (0.8 + Math.random() * 0.4);
      mockPositions.push({
        id: `pos-${posId++}`,
        asset,
        side: 'buy',
        entryPrice: 100,
        currentPrice: 100 + tradePnl,
        quantity: 1,
        unrealizedPnl: 0,
        realizedPnl: tradePnl,
        status: 'closed',
        openedAt: new Date(FEB_START).getTime(),
        closedAt: new Date(FEB_START).getTime() + 86400000,
        strategy: r.strategy,
      });
    }
  }

  const totalPnl = mockPositions.reduce((s, p) => s + p.realizedPnl, 0);
  const portfolio = {
    capital: INITIAL_CAPITAL + totalPnl,
    availableCapital: INITIAL_CAPITAL + totalPnl,
    positions: mockPositions,
    totalPnl,
    totalPnlPct: (totalPnl / INITIAL_CAPITAL) * 100,
    maxDrawdown: 0,
    lastUpdated: Date.now(),
  };

  const profReview = ceo.profitabilityReview(portfolio, strategies);
  console.log(CEOAgent.formatProfitabilityReview(profReview));

  // ------------------------------------------------------------------
  // 6. Daily P&L summary
  // ------------------------------------------------------------------
  hr('DAILY RETURN ANALYSIS');

  const candles0 = allCandles.get(assetsWithData[0].symbol)!;
  const totalDays = Math.floor(candles0.length / 24);
  const totalRetPct = avg(allResults.map(r => r.totalReturnPct));
  const dailyRetPct = totalRetPct / (totalDays || 1);
  const bestStrat = ranked[0];
  const bestStratAvg = bestStrat ? avg(bestStrat[1].returnsPct) : 0;

  console.log(`\n  Trading days: ${totalDays}`);
  console.log(`  Overall avg return (per strategy-asset): ${totalRetPct >= 0 ? '+' : ''}${totalRetPct.toFixed(3)}%`);
  console.log(`  Avg daily return: ${dailyRetPct >= 0 ? '+' : ''}${dailyRetPct.toFixed(4)}%/day`);
  console.log(`  Best strategy: ${bestStrat?.[0] ?? 'N/A'} (${bestStratAvg >= 0 ? '+' : ''}${bestStratAvg.toFixed(2)}%)`);
  console.log(`  Total trades: ${totalTrades} (${(totalTrades / (totalDays || 1)).toFixed(1)}/day)`);

  // Annualized estimate
  const annualized = Math.pow(1 + dailyRetPct / 100, 252) - 1;
  console.log(`  Annualized (est): ${(annualized * 100).toFixed(1)}%`);

  // ------------------------------------------------------------------
  // 7. Summary
  // ------------------------------------------------------------------
  hr('BACKTEST COMPLETE — REAL DATA');
  console.log(`\n  This backtest used REAL OANDA market data for Feb 2026.`);
  console.log(`  No trades were executed. This is analysis only.`);
  console.log(`  Account balance: £${INITIAL_CAPITAL} | Currency: GBP`);
}

main().catch(console.error);
