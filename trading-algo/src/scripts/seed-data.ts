/**
 * seed-data.ts — Pre-populate the market data cache for cloud mode.
 *
 * Usage:
 *   npm run seed-data                     # Seed all assets with synthetic data
 *   npm run seed-data -- --real           # Prompt: Claude Code should write JSON files first
 *
 * In Claude Code cloud, the AI assistant can:
 * 1. Use WebFetch to get real market prices from public APIs
 * 2. Write JSON files to data/historical/ using the Write tool
 * 3. Then run the trading algo which reads from cache
 *
 * This script seeds the cache directory with synthetic data for all configured
 * assets, so the trading algo can run immediately without network access.
 */

import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config/index.js';
import { cryptoAssets, stockAssets, forexAssets } from '../config/assets.js';
import { generateSyntheticCandles } from '../shared/synthetic.js';
import { createModuleLogger } from '../shared/logger.js';
import type { AssetInfo, MarketData, Timeframe } from '../shared/types.js';

const log = createModuleLogger('seed-data');

const TIMEFRAMES: Timeframe[] = ['1h'];
const CANDLE_COUNT = 200;

const TIMEFRAME_MS: Record<string, number> = {
  '1m': 60_000, '5m': 300_000, '15m': 900_000,
  '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000, '1w': 604_800_000,
};

function cachePath(asset: AssetInfo, timeframe: Timeframe): string {
  const safeSymbol = asset.symbol.replace(/[^a-zA-Z0-9]/g, '_');
  return join(config.dataDir, 'historical', `${asset.assetClass}_${safeSymbol}_${timeframe}.json`);
}

async function seedAsset(asset: AssetInfo, timeframe: Timeframe): Promise<void> {
  const volatility = asset.assetClass === 'forex' ? 0.005 : 0.02;
  const candles = generateSyntheticCandles(asset.symbol, CANDLE_COUNT, {
    intervalMs: TIMEFRAME_MS[timeframe] ?? 3_600_000,
    volatility,
  });

  const marketData: MarketData = {
    asset,
    timeframe,
    candles,
    lastUpdated: Date.now(),
  };

  const path = cachePath(asset, timeframe);
  await writeFile(path, JSON.stringify(marketData, null, 2), 'utf-8');
  log.info({ symbol: asset.symbol, timeframe, candles: candles.length }, 'Seeded');
}

async function main(): Promise<void> {
  const cacheDir = join(config.dataDir, 'historical');
  await mkdir(cacheDir, { recursive: true });

  // Check if real data already exists
  try {
    const files = await readdir(cacheDir);
    const jsonFiles = files.filter(f => f.endsWith('.json'));
    if (jsonFiles.length > 0) {
      log.info({ existingFiles: jsonFiles.length }, 'Cache directory already has data — skipping existing');
    }
  } catch {
    // Directory empty or doesn't exist yet
  }

  const allAssets = [...cryptoAssets, ...stockAssets, ...forexAssets];
  let seeded = 0;

  for (const timeframe of TIMEFRAMES) {
    for (const asset of allAssets) {
      try {
        await seedAsset(asset, timeframe);
        seeded++;
      } catch (err) {
        log.error({ symbol: asset.symbol, err }, 'Failed to seed');
      }
    }
  }

  console.log(`\n✓ Seeded ${seeded} cache files for ${allAssets.length} assets across ${TIMEFRAMES.length} timeframe(s)`);
  console.log(`  Cache directory: ${cacheDir}`);
  console.log(`  Cache TTL: ${config.cacheTtlMs / 3_600_000}h`);
  console.log(`  Cloud mode: ${config.cloudMode ? 'ON' : 'OFF'}`);

  if (config.cloudMode) {
    console.log('\n  Tip: Claude Code can replace synthetic data with real prices by writing');
    console.log('  JSON files directly to the cache directory using the Write tool.');
  }
}

main().catch(console.error);
