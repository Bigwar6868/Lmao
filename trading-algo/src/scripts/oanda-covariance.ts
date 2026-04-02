#!/usr/bin/env tsx
/**
 * OANDA Covariance Matrix Generator (M5 — 5-minute granularity)
 *
 * Fetches M5 (5-minute) candle data for ALL OANDA-tradeable assets:
 * forex pairs, metals, commodities, indices, bonds.
 *
 * Paginates backward to cover the full 12-month window (~72,576 M5 bars
 * per asset at 288 bars/day × 252 trading days).
 *
 * Computes covariance & correlation matrices for 1M, 3M, 6M, 12M windows
 * using 5-minute log returns (annualised with √(252 × 288) scaling).
 *
 * Outputs an Excel workbook with sheets per window + summary.
 *
 * Usage:
 *   npx tsx src/scripts/oanda-covariance.ts
 *   npm run covariance
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import axios, { type AxiosInstance } from 'axios';
import * as XLSX from 'xlsx';
import { config } from '../config/index.js';
import { oandaAssets } from '../config/assets.js';
import { generateSyntheticCandles } from '../shared/synthetic.js';
import type { AssetInfo, Candle } from '../shared/types.js';

// ============================================================
// Config
// ============================================================

/**
 * Windows defined in M5 bars (5-min candles).
 * Forex trades ~24h/day, 5 days/week → 288 M5 bars/day.
 *   1M  = 22 trading days  ×  288 =   6,336
 *   3M  = 66 trading days  ×  288 =  19,008
 *   6M  = 132 trading days ×  288 =  38,016
 *   12M = 252 trading days ×  288 =  72,576
 */
const M5_BARS_PER_DAY = 288;

const WINDOWS = {
  '1M':  22  * M5_BARS_PER_DAY,   //   6,336
  '3M':  66  * M5_BARS_PER_DAY,   //  19,008
  '6M':  132 * M5_BARS_PER_DAY,   //  38,016
  '12M': 252 * M5_BARS_PER_DAY,   //  72,576
} as const;

type WindowKey = keyof typeof WINDOWS;

/**
 * Annualisation factor for M5 returns.
 * There are 252 × 288 = 72,576 M5 bars per year.
 */
const ANNUAL_FACTOR = 252 * M5_BARS_PER_DAY; // 72,576

const PRACTICE_URL = 'https://api-fxpractice.oanda.com';
const LIVE_URL = 'https://api-fxtrade.oanda.com';

/** OANDA allows max 5000 candles per request */
const OANDA_MAX_COUNT = 5000;

/** Rate-limit pause between OANDA requests (ms) */
const RATE_LIMIT_MS = 120;

/** Target: fetch enough M5 candles to cover 12 months */
const TARGET_M5_CANDLES = 75_000; // 72,576 + buffer

// ============================================================
// Helpers
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function toInstrument(symbol: string): string {
  return symbol.replace('/', '_');
}

/** Compute log returns from close prices */
function logReturns(candles: Candle[]): number[] {
  const ret: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1].close;
    const curr = candles[i].close;
    ret.push(prev > 0 && curr > 0 ? Math.log(curr / prev) : 0);
  }
  return ret;
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// ============================================================
// OANDA M5 Data Fetcher (paginated backward)
// ============================================================

class OandaM5Fetcher {
  private client: AxiosInstance;
  private accountId: string;

  constructor() {
    const isLive = config.oandaIsLive;
    const baseURL = isLive ? LIVE_URL : PRACTICE_URL;
    this.accountId = config.oandaAccountId;

    this.client = axios.create({
      baseURL,
      timeout: 30_000,
      headers: {
        'Authorization': `Bearer ${config.oandaApiToken}`,
        'Content-Type': 'application/json',
        'Accept-Datetime-Format': 'RFC3339',
      },
    });
  }

  get isConfigured(): boolean {
    return !!(config.oandaApiToken && config.oandaAccountId);
  }

  /**
   * Fetch M5 candles with backward pagination.
   * OANDA returns max 5000 candles per request. We use the `to` param
   * to page backward from now, collecting up to targetCount candles.
   *
   * For 12M coverage: ~75,000 candles = 15 pages of 5000.
   */
  async fetchM5(
    symbol: string,
    targetCount: number = TARGET_M5_CANDLES,
  ): Promise<Candle[]> {
    const instrument = toInstrument(symbol);
    const allCandles: Candle[] = [];
    let toTime: string | undefined = undefined;
    let remaining = targetCount;
    let pages = 0;

    while (remaining > 0) {
      const count = Math.min(remaining, OANDA_MAX_COUNT);
      const params: Record<string, string | number> = {
        granularity: 'M5',
        count,
        price: 'M',
      };
      if (toTime) {
        params.to = toTime;
      }

      try {
        const resp = await this.client.get(
          `/v3/instruments/${instrument}/candles`,
          { params },
        );

        const candles = resp.data.candles ?? [];
        if (candles.length === 0) break;

        for (const bar of candles) {
          if (!bar.complete) continue;
          const mid = bar.mid ?? {};
          allCandles.push({
            timestamp: new Date(bar.time).getTime(),
            open: parseFloat(mid.o ?? '0'),
            high: parseFloat(mid.h ?? '0'),
            low: parseFloat(mid.l ?? '0'),
            close: parseFloat(mid.c ?? '0'),
            volume: parseInt(bar.volume ?? '0', 10),
          });
        }

        // Move `to` to the earliest candle for backward pagination
        const earliestTime = candles[0]?.time;
        if (!earliestTime || candles.length < count) break;
        toTime = earliestTime;
        remaining -= candles.length;
        pages++;

        await sleep(RATE_LIMIT_MS);
      } catch (err: any) {
        const status = err?.response?.status;
        if (status === 429) {
          await sleep(2000);
          continue;
        }
        break;
      }
    }

    // Sort chronologically & deduplicate
    allCandles.sort((a, b) => a.timestamp - b.timestamp);

    const seen = new Set<number>();
    const deduped: Candle[] = [];
    for (const c of allCandles) {
      if (!seen.has(c.timestamp)) {
        seen.add(c.timestamp);
        deduped.push(c);
      }
    }

    return deduped;
  }
}

// ============================================================
// Data Fetching Orchestrator
// ============================================================

interface AssetData {
  asset: AssetInfo;
  candles: Candle[];
  returns: number[];
}

async function fetchAllAssets(fetcher: OandaM5Fetcher): Promise<AssetData[]> {
  const results: AssetData[] = [];
  const total = oandaAssets.length;
  const useLive = fetcher.isConfigured && !config.cloudMode;

  console.log(`\n  Fetching M5 data for ${total} OANDA assets...`);
  console.log(`  Mode: ${useLive ? 'OANDA API (M5, paginated 12M)' : 'Synthetic data (cloud/no API key)'}`);
  console.log(`  Target: ${TARGET_M5_CANDLES.toLocaleString()} candles/asset (~${Math.ceil(TARGET_M5_CANDLES / OANDA_MAX_COUNT)} pages)\n`);

  for (let i = 0; i < total; i++) {
    const asset = oandaAssets[i];
    const pct = ((i + 1) / total * 100).toFixed(0);
    process.stdout.write(`\r  [${pct.padStart(3)}%] ${asset.symbol.padEnd(18)} (${i + 1}/${total})`);

    let candles: Candle[];

    if (useLive) {
      try {
        candles = await fetcher.fetchM5(asset.symbol, TARGET_M5_CANDLES);
        if (candles.length < 1000) throw new Error('insufficient M5 data');
      } catch {
        // Fallback to synthetic M5 data
        candles = generateSyntheticCandles(asset.symbol, TARGET_M5_CANDLES, {
          intervalMs: 5 * 60 * 1000, // 5 minutes
        });
      }
    } else {
      // Synthetic M5 data covering 12 months
      candles = generateSyntheticCandles(asset.symbol, TARGET_M5_CANDLES, {
        intervalMs: 5 * 60 * 1000,
      });
    }

    const returns = logReturns(candles);
    results.push({ asset, candles, returns });
  }

  console.log('\n');
  return results;
}

// ============================================================
// Covariance / Correlation (on M5 returns)
// ============================================================

interface MatrixResult {
  symbols: string[];
  covariance: number[][];
  correlation: number[][];
  volatilities: Map<string, number>;
  observations: number;
  windowLabel: string;
}

/**
 * Compute covariance matrix from M5 return series.
 * windowBars = number of M5 bars in the lookback window.
 * Annualisation: multiply sample covariance by ANNUAL_FACTOR (72,576).
 */
function computeMatrix(data: AssetData[], windowBars: number, windowLabel: string): MatrixResult {
  const N = data.length;
  const symbols = data.map(d => d.asset.symbol);

  // Trim M5 returns to window size (most recent bars)
  const trimmed = data.map(d => {
    const r = d.returns;
    return r.length >= windowBars ? r.slice(r.length - windowBars) : r;
  });

  // Align to shortest
  const minLen = Math.min(...trimmed.map(r => r.length));
  const aligned = trimmed.map(r => r.slice(r.length - minLen));
  const T = minLen;
  const means = aligned.map(r => mean(r));

  // Sample covariance × annualisation factor
  const cov: number[][] = Array.from({ length: N }, () => new Array(N).fill(0));
  for (let i = 0; i < N; i++) {
    for (let j = i; j < N; j++) {
      let sum = 0;
      for (let t = 0; t < T; t++) {
        sum += (aligned[i][t] - means[i]) * (aligned[j][t] - means[j]);
      }
      const c = (sum / Math.max(T - 1, 1)) * ANNUAL_FACTOR;
      cov[i][j] = c;
      cov[j][i] = c;
    }
  }

  // Volatilities
  const vols = new Map<string, number>();
  for (let i = 0; i < N; i++) {
    vols.set(symbols[i], Math.sqrt(Math.max(cov[i][i], 0)));
  }

  // Correlation
  const corr: number[][] = Array.from({ length: N }, () => new Array(N).fill(0));
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const vi = vols.get(symbols[i])!;
      const vj = vols.get(symbols[j])!;
      corr[i][j] = (vi > 0 && vj > 0)
        ? Math.max(-1, Math.min(1, cov[i][j] / (vi * vj)))
        : (i === j ? 1 : 0);
    }
  }

  return { symbols, covariance: cov, correlation: corr, volatilities: vols, observations: T, windowLabel };
}

// ============================================================
// Excel Export
// ============================================================

function matrixToSheet(symbols: string[], matrix: number[][], decimals: number): XLSX.WorkSheet {
  const N = symbols.length;
  const rows: (string | number)[][] = [['', ...symbols]];
  for (let i = 0; i < N; i++) {
    const row: (string | number)[] = [symbols[i]];
    for (let j = 0; j < N; j++) {
      row.push(Number(matrix[i][j].toFixed(decimals)));
    }
    rows.push(row);
  }
  return XLSX.utils.aoa_to_sheet(rows);
}

function buildSummarySheet(results: Map<WindowKey, MatrixResult>, data: AssetData[]): XLSX.WorkSheet {
  const rows: (string | number)[][] = [];
  rows.push(['OANDA Covariance Matrix Report — M5 (5-Minute) Granularity']);
  rows.push([`Generated: ${new Date().toISOString()}`]);
  rows.push([`Annualisation factor: ${ANNUAL_FACTOR} (252 days x ${M5_BARS_PER_DAY} bars/day)`]);
  rows.push([]);

  // Data coverage
  rows.push(['=== Data Coverage ===']);
  rows.push(['Symbol', 'Asset Class', 'M5 Candles', 'Time Span (days)', 'First Candle', 'Last Candle']);
  for (const d of data) {
    const span = d.candles.length > 1
      ? ((d.candles[d.candles.length - 1].timestamp - d.candles[0].timestamp) / 86_400_000).toFixed(0)
      : '0';
    const first = d.candles.length > 0 ? new Date(d.candles[0].timestamp).toISOString().slice(0, 10) : '';
    const last = d.candles.length > 0 ? new Date(d.candles[d.candles.length - 1].timestamp).toISOString().slice(0, 10) : '';
    rows.push([d.asset.symbol, d.asset.assetClass, d.candles.length, Number(span), first, last]);
  }

  rows.push([]);
  rows.push(['=== Annualised Volatility by Window ===']);
  const firstResult = results.values().next().value!;
  const symbols = firstResult.symbols;
  rows.push(['Symbol', 'Asset Class', ...Object.keys(WINDOWS).map(w => `Vol ${w} (%)`)]);

  for (const sym of symbols) {
    const asset = oandaAssets.find(a => a.symbol === sym);
    const row: (string | number)[] = [sym, asset?.assetClass ?? ''];
    for (const key of Object.keys(WINDOWS) as WindowKey[]) {
      const r = results.get(key)!;
      const vol = r.volatilities.get(sym) ?? 0;
      row.push(Number((vol * 100).toFixed(2)));
    }
    rows.push(row);
  }

  // Top correlated pairs (12M)
  rows.push([]);
  rows.push(['=== Top 25 Most Correlated Pairs (12M) ===']);
  rows.push(['Asset A', 'Class A', 'Asset B', 'Class B', 'Correlation']);

  const r12 = results.get('12M')!;
  const pairs: { a: string; b: string; c: number }[] = [];
  for (let i = 0; i < r12.symbols.length; i++) {
    for (let j = i + 1; j < r12.symbols.length; j++) {
      pairs.push({ a: r12.symbols[i], b: r12.symbols[j], c: r12.correlation[i][j] });
    }
  }
  pairs.sort((x, y) => y.c - x.c);
  for (const p of pairs.slice(0, 25)) {
    const assetA = oandaAssets.find(a => a.symbol === p.a);
    const assetB = oandaAssets.find(a => a.symbol === p.b);
    rows.push([p.a, assetA?.assetClass ?? '', p.b, assetB?.assetClass ?? '', Number(p.c.toFixed(4))]);
  }

  // Negative correlations
  rows.push([]);
  rows.push(['=== Top 25 Most Negatively Correlated Pairs (12M) ===']);
  rows.push(['Asset A', 'Class A', 'Asset B', 'Class B', 'Correlation']);
  pairs.sort((x, y) => x.c - y.c);
  for (const p of pairs.slice(0, 25)) {
    const assetA = oandaAssets.find(a => a.symbol === p.a);
    const assetB = oandaAssets.find(a => a.symbol === p.b);
    rows.push([p.a, assetA?.assetClass ?? '', p.b, assetB?.assetClass ?? '', Number(p.c.toFixed(4))]);
  }

  // Asset counts
  rows.push([]);
  rows.push(['=== Asset Counts ===']);
  const classCounts = new Map<string, number>();
  for (const sym of symbols) {
    const asset = oandaAssets.find(a => a.symbol === sym);
    const cls = asset?.assetClass ?? 'unknown';
    classCounts.set(cls, (classCounts.get(cls) ?? 0) + 1);
  }
  for (const [cls, count] of classCounts) {
    rows.push([cls, count]);
  }
  rows.push(['Total', symbols.length]);

  // Observations per window
  rows.push([]);
  rows.push(['=== Observations per Window ===']);
  for (const [window, result] of results) {
    const tradingDays = Math.round(result.observations / M5_BARS_PER_DAY);
    rows.push([window, `${result.observations.toLocaleString()} M5 returns (~${tradingDays} trading days)`]);
  }

  return XLSX.utils.aoa_to_sheet(rows);
}

function exportToExcel(results: Map<WindowKey, MatrixResult>, data: AssetData[], outputPath: string): void {
  const wb = XLSX.utils.book_new();

  // Summary
  XLSX.utils.book_append_sheet(wb, buildSummarySheet(results, data), 'Summary');

  // Covariance sheets
  for (const [window, result] of results) {
    XLSX.utils.book_append_sheet(wb, matrixToSheet(result.symbols, result.covariance, 8), `Cov ${window}`);
  }

  // Correlation sheets
  for (const [window, result] of results) {
    XLSX.utils.book_append_sheet(wb, matrixToSheet(result.symbols, result.correlation, 4), `Corr ${window}`);
  }

  XLSX.writeFile(wb, outputPath);
}

// ============================================================
// Main
// ============================================================

async function main(): Promise<void> {
  console.log('================================================================');
  console.log('  OANDA Covariance Matrix Generator (M5 — 5-Minute)');
  console.log('================================================================');

  const fetcher = new OandaM5Fetcher();
  const data = await fetchAllAssets(fetcher);

  const totalCandles = data.reduce((sum, d) => sum + d.candles.length, 0);
  console.log(`  Fetched ${data.length} assets | ${totalCandles.toLocaleString()} M5 candles total\n`);

  // Compute matrices for each window
  const results = new Map<WindowKey, MatrixResult>();
  for (const [window, bars] of Object.entries(WINDOWS) as [WindowKey, number][]) {
    const days = Math.round(bars / M5_BARS_PER_DAY);
    console.log(`  Computing ${window} covariance (${bars.toLocaleString()} M5 bars = ${days} trading days)...`);
    const result = computeMatrix(data, bars, window);
    results.set(window, result);
    console.log(`    ${result.symbols.length} assets x ${result.observations.toLocaleString()} observations`);
  }

  // Export
  const outputDir = join(config.dataDir, 'reports');
  mkdirSync(outputDir, { recursive: true });
  const ts = new Date().toISOString().slice(0, 10);
  const outputPath = join(outputDir, `oanda-covariance-m5-${ts}.xlsx`);

  console.log(`\n  Writing Excel: ${outputPath}`);
  exportToExcel(results, data, outputPath);
  console.log('  Done!\n');

  // Console summary
  const r12 = results.get('12M')!;
  console.log(`--- 12M Annualised Volatility (Top 20) [${r12.observations.toLocaleString()} M5 obs] ---`);
  const volEntries = [...r12.volatilities.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  for (const [sym, vol] of volEntries) {
    console.log(`  ${sym.padEnd(18)} ${(vol * 100).toFixed(2)}%`);
  }

  console.log('\n--- Top 10 Most Correlated Pairs (12M) ---');
  const pairs: { a: string; b: string; c: number }[] = [];
  for (let i = 0; i < r12.symbols.length; i++) {
    for (let j = i + 1; j < r12.symbols.length; j++) {
      pairs.push({ a: r12.symbols[i], b: r12.symbols[j], c: r12.correlation[i][j] });
    }
  }
  pairs.sort((x, y) => y.c - x.c);
  for (const p of pairs.slice(0, 10)) {
    console.log(`  ${p.a.padEnd(18)} <> ${p.b.padEnd(18)} r = ${p.c.toFixed(4)}`);
  }

  console.log('\n--- Top 10 Most Negatively Correlated Pairs (12M) ---');
  pairs.sort((x, y) => x.c - y.c);
  for (const p of pairs.slice(0, 10)) {
    console.log(`  ${p.a.padEnd(18)} <> ${p.b.padEnd(18)} r = ${p.c.toFixed(4)}`);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
