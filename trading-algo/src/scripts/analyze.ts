import { TradingOrchestrator } from '../index.js';
import { cryptoAssets, stockAssets, forexAssets, allAssets } from '../config/assets.js';
import { config } from '../config/index.js';
import type { AssetInfo, Timeframe } from '../shared/types.js';

async function main() {
  const orchestrator = new TradingOrchestrator();
  await orchestrator.initialize();

  const timeframe: Timeframe = (process.argv[2] as Timeframe) || '1h';
  const assetClass = process.argv[3] || 'all';

  let assets: AssetInfo[];
  switch (assetClass) {
    case 'crypto': assets = cryptoAssets; break;
    case 'stocks': assets = stockAssets; break;
    case 'forex': assets = forexAssets; break;
    case 'all': assets = allAssets; break;
    default: assets = cryptoAssets;
  }

  console.log(`\n=== Market Analysis (${timeframe}, ${assetClass}) ===\n`);

  const { signals } = await orchestrator.analyzeCycle(assets, timeframe);

  // Display results
  const buySignals = signals.filter((s) => s.action === 'BUY');
  const sellSignals = signals.filter((s) => s.action === 'SELL');

  if (buySignals.length > 0) {
    console.log('\n📈 BUY Signals:');
    for (const s of buySignals.sort((a, b) => b.confidence - a.confidence)) {
      console.log(
        `  ${s.asset.symbol.padEnd(12)} | Confidence: ${(s.confidence * 100).toFixed(0)}% | ` +
        `Strategy: ${s.strategy} | ${s.reason}`
      );
    }
  }

  if (sellSignals.length > 0) {
    console.log('\n📉 SELL Signals:');
    for (const s of sellSignals.sort((a, b) => b.confidence - a.confidence)) {
      console.log(
        `  ${s.asset.symbol.padEnd(12)} | Confidence: ${(s.confidence * 100).toFixed(0)}% | ` +
        `Strategy: ${s.strategy} | ${s.reason}`
      );
    }
  }

  if (buySignals.length === 0 && sellSignals.length === 0) {
    console.log('\n⏸️  No actionable signals at this time.');
  }

  console.log(`\nTotal signals: ${signals.length} (${buySignals.length} buy, ${sellSignals.length} sell)`);

  await orchestrator.shutdown();
}

const watchdog = setTimeout(() => { console.error('WATCHDOG: analyze exceeded timeout — forcing exit'); process.exit(1); }, config.processWatchdogMs);
watchdog.unref();
main().catch(console.error).finally(() => clearTimeout(watchdog));
