import { TradingOrchestrator } from '../index.js';
import { allAssets, cryptoAssets, stockAssets, forexAssets } from '../config/assets.js';
import type { AssetInfo, Timeframe } from '../shared/types.js';

async function main() {
  const orchestrator = new TradingOrchestrator();
  await orchestrator.initialize();

  const timeframe: Timeframe = (process.argv[2] as Timeframe) || '1h';
  const assetFilter = process.argv[3];

  // If specific asset symbol given, backtest only that
  if (assetFilter && !['crypto', 'stocks', 'forex', 'all'].includes(assetFilter)) {
    const asset = allAssets.find((a) => a.symbol === assetFilter);
    if (!asset) {
      console.error(`Asset not found: ${assetFilter}`);
      console.error(`Available: ${allAssets.map((a) => a.symbol).join(', ')}`);
      process.exit(1);
    }
    console.log(`\n=== Backtesting ${asset.symbol} (${timeframe}) ===\n`);
    await orchestrator.runBacktest(asset, timeframe);
    await orchestrator.shutdown();
    return;
  }

  // Select asset class
  let assets: AssetInfo[];
  switch (assetFilter) {
    case 'crypto': assets = cryptoAssets; break;
    case 'stocks': assets = stockAssets; break;
    case 'forex': assets = forexAssets; break;
    default: assets = allAssets;
  }

  console.log(`\n=== Running Backtests (${timeframe}) ===`);
  console.log(`Assets: ${assets.length} (${assetFilter || 'all'})\n`);

  // Backtest ALL assets
  for (const asset of assets) {
    console.log(`\n--- Backtesting ${asset.symbol} (${asset.assetClass}) ---`);
    await orchestrator.runBacktest(asset, timeframe);
  }

  await orchestrator.shutdown();
}

main().catch(console.error);
