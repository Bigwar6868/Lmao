import { TradingOrchestrator } from '../index.js';
import { allAssets, cryptoAssets, forexAssets } from '../config/assets.js';
import { config } from '../config/index.js';
import { withTimeout } from '../shared/utils.js';
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
    case 'forex': assets = forexAssets; break;
    case 'all': assets = allAssets; break;
    default: assets = allAssets;
  }

  console.log(`\n=== Live Trading Mode ===`);
  console.log(`Timeframe: ${timeframe}, cycle interval: ${intervalMinutes} minutes`);
  console.log(`Assets (${assets.length}): ${assets.map((a) => a.symbol).join(', ')}`);
  console.log(`\n  Crypto: ${cryptoAssets.length} pairs`);
  console.log(`  Forex:  ${forexAssets.length} pairs`);
  console.log(`\nPress Ctrl+C to stop\n`);

  // Run initial cycle on ALL assets (with timeout)
  try {
    await withTimeout(
      orchestrator.tradingCycle(assets, timeframe),
      config.tradingCycleTimeoutMs,
      'Initial trading cycle',
    );
  } catch (err) {
    console.error('Initial cycle error:', (err as Error).message);
  }

  // Schedule recurring cycles — guard against overlapping runs
  let cycleRunning = false;
  const interval = setInterval(async () => {
    if (cycleRunning) {
      console.warn('Previous cycle still running — skipping this interval');
      return;
    }
    cycleRunning = true;
    try {
      console.log(`\n--- Trading Cycle at ${new Date().toISOString()} ---`);
      await withTimeout(
        orchestrator.tradingCycle(assets, timeframe),
        config.tradingCycleTimeoutMs,
        'Trading cycle',
      );
    } catch (err) {
      console.error('Trading cycle error:', (err as Error).message);
    } finally {
      cycleRunning = false;
    }
  }, intervalMinutes * 60 * 1000);

  // Graceful shutdown
  process.on('SIGINT', async () => {
    clearInterval(interval);
    console.log('\n\nShutting down live trader...');
    console.log(orchestrator.getPortfolioSummary());
    await orchestrator.shutdown();
    process.exit(0);
  });
}

main().catch(console.error);
