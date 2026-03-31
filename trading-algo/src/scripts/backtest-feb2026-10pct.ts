/**
 * February 2026 Backtest — 10% Daily Profit Target
 *
 * Aggressive configuration:
 * - Position size: up to 50% of equity per trade (vs 15% default)
 * - TP: 5x ATR (wider to capture bigger moves)
 * - SL: 1.5x ATR (tighter to cut losses fast)
 * - Max hold: 24 bars (1 day on 1h — reset daily)
 * - All 11 strategies running across 13 assets
 *
 * The 10% daily target means we need to size aggressively and
 * take more trades. The system will compound profits daily.
 */

import { generateSyntheticCandles } from '../shared/synthetic.js';
import { Backtester } from '../team/backtester/index.js';
import { TechnicalStrategist } from '../team/technical-strategist/index.js';
import { CEOAgent, type ProfitabilityReview } from '../team/ceo/index.js';
import { AgentNetwork } from '../team/agent-network/network.js';
import { QuantModuleManager } from '../team/quant-modules/index.js';
import { RiskManager } from '../team/risk-manager/index.js';
import type { AssetInfo, Candle, Timeframe, Signal, MarketData, BacktestConfig } from '../shared/types.js';

const FEB_2026_START = new Date('2026-02-01T00:00:00Z').getTime();
const CANDLE_COUNT = 672; // 28 days x 24 hours
const TIMEFRAME: Timeframe = '1h';
const INITIAL_CAPITAL = 10000;

// Target: 10% daily = position sizing must be aggressive
const AGGRESSIVE_CONFIG: Partial<BacktestConfig> = {
  initialCapital: INITIAL_CAPITAL,
  commission: 0.0005,     // 0.05% — lower for forex
  slippage: 0.0003,       // 0.03% slippage
  maxPositionPct: 0.50,   // Up to 50% of equity per trade
  slAtrMult: 1.5,         // Tight SL: 1.5x ATR (cut losses fast)
  tpAtrMult: 5.0,         // Wide TP: 5x ATR (let winners run)
  maxHoldBars: 24,        // Exit after 1 day max
};

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
  const offset = FEB_2026_START - candles[0].timestamp;
  return candles.map(c => ({ ...c, timestamp: c.timestamp + offset }));
}

function hr(title: string): void {
  console.log('\n' + '='.repeat(70));
  console.log(`  ${title}`);
  console.log('='.repeat(70));
}

async function main() {
  hr('FEB 2026 BACKTEST — 10% DAILY PROFIT TARGET');
  console.log(`  Capital: $${INITIAL_CAPITAL} | Target: 10%/day`);
  console.log(`  Position Size: up to 50% equity | SL: 1.5x ATR | TP: 5x ATR`);
  console.log(`  Max Hold: 24 bars (1 day) | Commission: 0.05% | Slippage: 0.03%`);
  console.log(`  Assets: ${TEST_ASSETS.length} | Candles: ${CANDLE_COUNT} (28 days)`);

  const backtester = new Backtester();
  const strategist = new TechnicalStrategist();
  const quantModules = new QuantModuleManager();
  const network = new AgentNetwork();
  const ceo = new CEOAgent(network);

  const strategies = strategist.getStrategies();
  console.log(`  Strategies: ${strategies.length} — ${strategies.map(s => s.name).join(', ')}`);

  // Generate data
  const allCandles = new Map<string, Candle[]>();
  const marketDataMap = new Map<string, MarketData>();
  for (const asset of TEST_ASSETS) {
    const candles = generateCandles(asset.symbol);
    allCandles.set(asset.symbol, candles);
    marketDataMap.set(asset.symbol, {
      asset, timeframe: TIMEFRAME, candles,
      lastUpdated: candles[candles.length - 1].timestamp,
    });
  }

  // ============================================================
  // BACKTEST ALL STRATEGIES × ALL ASSETS
  // ============================================================
  hr('BACKTESTING — AGGRESSIVE CONFIG');

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

  for (const asset of TEST_ASSETS) {
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
        console.error(`  ERROR: ${strategy.name} on ${asset.symbol}: ${(err as Error).message}`);
      }
    }
  }

  console.log(`\n  Completed: ${allResults.length} backtests | Total trades: ${totalTrades}`);

  // ============================================================
  // DAILY P&L BREAKDOWN
  // ============================================================
  hr('DAILY P&L ANALYSIS');

  // Group results by day for each strategy
  // Since we can't get daily equity from aggregate metrics, compute from returns
  const BARS_PER_DAY = 24;
  const TOTAL_DAYS = Math.floor(CANDLE_COUNT / BARS_PER_DAY);

  console.log(`  Trading days: ${TOTAL_DAYS}`);
  console.log(`  Target per day: 10% = $${(INITIAL_CAPITAL * 0.10).toFixed(0)}`);
  console.log(`  Target by end: $${(INITIAL_CAPITAL * Math.pow(1.10, TOTAL_DAYS)).toFixed(0)} (compounding)`);

  // ============================================================
  // STRATEGY RANKINGS
  // ============================================================
  hr('STRATEGY PERFORMANCE RANKINGS');

  const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

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

  // Sort by total return
  const ranked = [...stratAgg.entries()].sort((a, b) => avg(b[1].returnsPct) - avg(a[1].returnsPct));

  console.log('');
  console.log('  ' + 'Strategy'.padEnd(22) + ' | ' + 'Avg Ret%'.padStart(9) + ' | ' +
    'Avg SR'.padStart(7) + ' | ' + 'WR%'.padStart(5) + ' | ' + 'MaxDD%'.padStart(7) + ' | ' +
    'Trades'.padStart(6) + ' | ' + 'PF'.padStart(5) + ' | ' + 'W/L$'.padStart(10) + ' | ' + 'Prof'.padStart(5));
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
      `${agg.profitableAssets}/${TEST_ASSETS.length}`,
    );
  }

  // ============================================================
  // PER-ASSET BEST STRATEGY
  // ============================================================
  hr('BEST STRATEGY PER ASSET');

  for (const asset of TEST_ASSETS) {
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

  // ============================================================
  // CEO PROFITABILITY REVIEW
  // ============================================================
  hr('CEO PROFITABILITY REVIEW');

  // Build mock portfolio from aggregate results
  const mockPositions: import('../shared/types.js').Position[] = [];
  let posId = 0;
  for (const r of allResults) {
    if (r.trades === 0) continue;
    const asset = TEST_ASSETS.find(a => a.symbol === r.asset)!;
    // Scale PnL to per-trade level
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
        openedAt: FEB_2026_START,
        closedAt: FEB_2026_START + 86400000,
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

  // ============================================================
  // 10% DAILY TARGET ANALYSIS
  // ============================================================
  hr('10% DAILY PROFIT TARGET ANALYSIS');

  // Sum the total return across ALL strategies and assets
  const totalReturnPct = allResults.reduce((s, r) => s + r.totalReturnPct, 0) / TEST_ASSETS.length;
  const dailyReturnPct = totalReturnPct / TOTAL_DAYS;
  const bestStratTotal = ranked[0] ? avg(ranked[0][1].returnsPct) : 0;
  const bestDailyAvg = bestStratTotal / TOTAL_DAYS;

  console.log(`\n  Overall avg return (all strategies): ${totalReturnPct >= 0 ? '+' : ''}${totalReturnPct.toFixed(2)}%`);
  console.log(`  Overall avg daily return: ${dailyReturnPct >= 0 ? '+' : ''}${dailyReturnPct.toFixed(3)}%/day`);
  console.log(`  Target daily return: +10.000%/day`);
  console.log(`  Gap to target: ${(10 - dailyReturnPct).toFixed(3)}%/day`);
  console.log('');
  console.log(`  Best strategy avg return: ${bestStratTotal >= 0 ? '+' : ''}${bestStratTotal.toFixed(2)}% (${ranked[0]?.[0] ?? 'N/A'})`);
  console.log(`  Best strategy daily avg: ${bestDailyAvg >= 0 ? '+' : ''}${bestDailyAvg.toFixed(3)}%/day`);

  // What it would take to hit 10%/day
  const totalTradesPerDay = totalTrades / TOTAL_DAYS;
  console.log('');
  console.log('  --- What 10%/day requires ---');
  console.log(`  Current trades/day: ${totalTradesPerDay.toFixed(1)}`);
  console.log(`  If avg trade = +0.5%: need ${(10 / 0.5).toFixed(0)} winning trades/day`);
  console.log(`  If avg trade = +1.0%: need ${(10 / 1.0).toFixed(0)} winning trades/day`);
  console.log(`  If avg trade = +2.0%: need ${(10 / 2.0).toFixed(0)} winning trades/day`);

  // Reality check
  console.log('');
  console.log('  --- Reality Check ---');
  console.log('  10%/day = 2,500%/month compounding (28 days)');
  console.log('  10%/day = 365,000%/year compounding');
  console.log('  Renaissance Medallion Fund (best hedge fund ever): ~66%/year');
  console.log('  No strategy achieves 10%/day sustainably on any asset class.');
  console.log('  Realistic targets for quant systems:');
  console.log('    Conservative: 0.05-0.1%/day (15-30%/year)');
  console.log('    Aggressive:   0.2-0.5%/day  (50-125%/year)');
  console.log('    Very aggro:   1-2%/day       (with high drawdown risk)');

  // Recommendations
  hr('CEO RECOMMENDATIONS FOR PROFITABILITY');
  const enabledStrategies = strategies.filter(s => s.config.enabled);
  const disabledStrategies = strategies.filter(s => !s.config.enabled);
  console.log(`\n  Strategies active: ${enabledStrategies.length} | Disabled: ${disabledStrategies.length}`);
  if (disabledStrategies.length > 0) {
    console.log(`  Disabled by CEO: ${disabledStrategies.map(s => s.name).join(', ')}`);
  }

  console.log('\n  To maximize profitability:');
  console.log('  1. Use REAL market data (OANDA historical candles) — synthetic data has no trends');
  console.log('  2. Focus on crypto (highest vol/momentum) and GBP pairs (London breakout)');
  console.log('  3. Run evolution (npm run evolve) to optimize DNA params per-asset');
  console.log('  4. Set realistic daily target: 0.5-1%/day with strict risk management');
  console.log('  5. Compound winners — let CEO increase allocation to profitable strategies');

  hr('BACKTEST COMPLETE');
}

main().catch(console.error);
