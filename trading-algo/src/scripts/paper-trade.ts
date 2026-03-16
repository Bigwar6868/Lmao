import { TradingOrchestrator } from '../index.js';
import { allAssets, cryptoAssets, stockAssets, forexAssets } from '../config/assets.js';
import type { AssetInfo, Timeframe } from '../shared/types.js';

async function main() {
  const orchestrator = new TradingOrchestrator();
  await orchestrator.initialize();

  const timeframe: Timeframe = (process.argv[2] as Timeframe) || '1h';
  const intervalMinutes = parseInt(process.argv[3] || '60', 10);
  const assetClass = process.argv[4] || 'all';

  let assets: AssetInfo[];
  switch (assetClass) {
    case 'crypto': assets = cryptoAssets; break;
    case 'stocks': assets = stockAssets; break;
    case 'forex': assets = forexAssets; break;
    case 'all': assets = allAssets; break;
    default: assets = allAssets;
  }

  console.log(`\n=== Paper Trading Mode ===`);
  console.log(`Timeframe: ${timeframe}, cycle interval: ${intervalMinutes} minutes`);
  console.log(`Assets (${assets.length}): ${assets.map((a) => a.symbol).join(', ')}`);
  console.log(`\n  Crypto: ${cryptoAssets.length} pairs`);
  console.log(`  Stocks: ${stockAssets.length} tickers`);
  console.log(`  Forex:  ${forexAssets.length} pairs`);
  console.log(`\nPress Ctrl+C to stop\n`);

  // Run initial cycle on ALL assets
  await orchestrator.tradingCycle(assets, timeframe);

  // Schedule recurring cycles
  const interval = setInterval(async () => {
    try {
      console.log(`\n--- Trading Cycle at ${new Date().toISOString()} ---`);
      await orchestrator.tradingCycle(assets, timeframe);
    } catch (err) {
      console.error('Trading cycle error:', (err as Error).message);
    }
  }, intervalMinutes * 60 * 1000);

  // Graceful shutdown
  process.on('SIGINT', async () => {
    clearInterval(interval);
    console.log('\n\nShutting down paper trader...');
    console.log(orchestrator.getPortfolioSummary());
    await orchestrator.shutdown();
    process.exit(0);
  });
}

main().catch(console.error);
