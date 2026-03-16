import { TradingOrchestrator } from '../index.js';
import { cryptoAssets } from '../config/assets.js';
import type { Timeframe } from '../shared/types.js';

async function main() {
  const orchestrator = new TradingOrchestrator();
  await orchestrator.initialize();

  const timeframe: Timeframe = (process.argv[2] as Timeframe) || '1h';
  const generations = parseInt(process.argv[3] || '5', 10);

  console.log(`\n=== Strategy Evolution ===`);
  console.log(`Timeframe: ${timeframe}`);
  console.log(`Generations: ${generations}`);
  console.log(`Assets: ${cryptoAssets.slice(0, 3).map((a) => a.symbol).join(', ')}\n`);

  for (let gen = 0; gen < generations; gen++) {
    console.log(`\n--- Generation ${gen + 1}/${generations} ---`);

    for (const asset of cryptoAssets.slice(0, 3)) {
      console.log(`  Evolving strategies for ${asset.symbol}...`);
      await orchestrator.runEvolution(asset, timeframe);
    }
  }

  console.log('\n=== Evolution Complete ===');
  await orchestrator.shutdown();
}

main().catch(console.error);
