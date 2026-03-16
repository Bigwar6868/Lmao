import { TradingOrchestrator } from '../index.js';
import { cryptoAssets } from '../config/assets.js';
import type { Timeframe } from '../shared/types.js';

async function main() {
  const orchestrator = new TradingOrchestrator();
  await orchestrator.initialize();

  const timeframe: Timeframe = (process.argv[2] as Timeframe) || '1h';
  const intervalMinutes = parseInt(process.argv[3] || '60', 10);

  console.log(`\n=== Paper Trading Mode ===`);
  console.log(`Timeframe: ${timeframe}`);
  console.log(`Cycle interval: ${intervalMinutes} minutes`);
  console.log(`Assets: ${cryptoAssets.map((a) => a.symbol).join(', ')}`);
  console.log(`Press Ctrl+C to stop\n`);

  // Run initial cycle
  await orchestrator.tradingCycle(cryptoAssets, timeframe);

  // Schedule recurring cycles
  const interval = setInterval(async () => {
    try {
      console.log(`\n--- Trading Cycle at ${new Date().toISOString()} ---`);
      await orchestrator.tradingCycle(cryptoAssets, timeframe);
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
