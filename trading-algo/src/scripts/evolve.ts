import { TradingOrchestrator } from '../index.js';
import { allAssets, cryptoAssets, stockAssets, forexAssets } from '../config/assets.js';
import { config } from '../config/index.js';
import type { AssetInfo, Timeframe } from '../shared/types.js';

async function main() {
  const orchestrator = new TradingOrchestrator();
  await orchestrator.initialize();

  const timeframe: Timeframe = (process.argv[2] as Timeframe) || '1h';
  const generations = parseInt(process.argv[3] || '5', 10);
  const assetFilter = process.argv[4] || 'all';

  let assets: AssetInfo[];
  switch (assetFilter) {
    case 'crypto': assets = cryptoAssets; break;
    case 'stocks': assets = stockAssets; break;
    case 'forex': assets = forexAssets; break;
    default: assets = allAssets;
  }

  console.log(`\n=== Strategy Evolution ===`);
  console.log(`Timeframe: ${timeframe}`);
  console.log(`Generations: ${generations}`);
  console.log(`Assets: ${assets.length} (${assetFilter})`);
  console.log(`  Crypto: ${assets.filter(a => a.assetClass === 'crypto').length}`);
  console.log(`  Stocks: ${assets.filter(a => a.assetClass === 'stock').length}`);
  console.log(`  Forex:  ${assets.filter(a => a.assetClass === 'forex').length}\n`);

  for (let gen = 0; gen < generations; gen++) {
    console.log(`\n--- Generation ${gen + 1}/${generations} ---`);

    for (const asset of assets) {
      console.log(`  Evolving strategies for ${asset.symbol} (${asset.assetClass})...`);
      await orchestrator.runEvolution(asset, timeframe);
    }
  }

  console.log('\n=== Evolution Complete ===');
  await orchestrator.shutdown();
}

const watchdog = setTimeout(() => { console.error('WATCHDOG: evolve exceeded timeout — forcing exit'); process.exit(1); }, config.processWatchdogMs);
watchdog.unref();
main().catch(console.error).finally(() => clearTimeout(watchdog));
