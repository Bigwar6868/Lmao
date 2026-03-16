import { TradingOrchestrator } from '../index.js';
import { cryptoAssets, stockAssets } from '../config/assets.js';
import type { Timeframe } from '../shared/types.js';

async function main() {
  const orchestrator = new TradingOrchestrator();
  await orchestrator.initialize();

  const timeframe: Timeframe = (process.argv[2] as Timeframe) || '1h';
  const assetSymbol = process.argv[3];

  console.log(`\n=== Running Backtests (${timeframe}) ===\n`);

  // If specific asset given, backtest only that
  if (assetSymbol) {
    const asset = [...cryptoAssets, ...stockAssets].find((a) => a.symbol === assetSymbol);
    if (!asset) {
      console.error(`Asset not found: ${assetSymbol}`);
      process.exit(1);
    }
    await orchestrator.runBacktest(asset, timeframe);
  } else {
    // Backtest top crypto assets
    for (const asset of cryptoAssets.slice(0, 3)) {
      console.log(`\n--- Backtesting ${asset.symbol} ---`);
      await orchestrator.runBacktest(asset, timeframe);
    }
  }

  await orchestrator.shutdown();
}

main().catch(console.error);
