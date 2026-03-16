import { TradingOrchestrator } from '../index.js';
import { cryptoAssets, stockAssets, forexAssets, allAssets } from '../config/assets.js';
import { config } from '../config/index.js';
import type { AssetInfo, Timeframe } from '../shared/types.js';

async function main() {
  const orchestrator = new TradingOrchestrator();
  await orchestrator.initialize();

  const timeframe: Timeframe = (process.argv[2] as Timeframe) || '1h';
  const assetClass = process.argv[3] || 'crypto';

  let assets: AssetInfo[];
  switch (assetClass) {
    case 'crypto': assets = cryptoAssets; break;
    case 'stocks': assets = stockAssets; break;
    case 'forex': assets = forexAssets; break;
    case 'all': assets = allAssets; break;
    default: assets = cryptoAssets;
  }

  console.log(`\n=== Full Diagnostic Scan (${timeframe}, ${assetClass}) ===`);
  console.log('Analyzing market regime, running scenario simulations, detecting problems...\n');

  const { regime, simulation, report } = await orchestrator.runDiagnostics(assets, timeframe);

  // Summary
  console.log('\n=== EXECUTIVE SUMMARY ===');
  console.log(`Health Score: ${report.healthScore}/100`);
  console.log(`Market Regime: ${regime?.regime ?? 'unknown'}`);
  console.log(`Outlook: ${simulation?.overallOutlook ?? 'unknown'}`);
  console.log(`Emergencies: ${report.emergencies.length}`);
  console.log(`Critical Issues: ${report.criticals.length}`);
  console.log(`Warnings: ${report.warnings.length}`);

  await orchestrator.shutdown();
}

const watchdog = setTimeout(() => { console.error('WATCHDOG: diagnose exceeded timeout — forcing exit'); process.exit(1); }, config.processWatchdogMs);
watchdog.unref();
main().catch(console.error).finally(() => clearTimeout(watchdog));
