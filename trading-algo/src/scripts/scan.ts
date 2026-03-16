import { TradingOrchestrator } from '../index.js';
import { allAssets, cryptoAssets, stockAssets, forexAssets } from '../config/assets.js';
import { OpportunityScanner } from '../team/opportunity-scanner/index.js';
import type { AssetInfo, Timeframe } from '../shared/types.js';

async function main() {
  const orchestrator = new TradingOrchestrator();
  await orchestrator.initialize();

  const timeframe: Timeframe = (process.argv[2] as Timeframe) || '1h';
  const assetFilter = process.argv[3] || 'all';

  let assets: AssetInfo[];
  switch (assetFilter) {
    case 'crypto': assets = cryptoAssets; break;
    case 'stocks': assets = stockAssets; break;
    case 'forex': assets = forexAssets; break;
    default: assets = allAssets;
  }

  console.log(`\n=== Opportunity Scanner (${timeframe}, ${assetFilter}) ===`);
  console.log(`Scanning ${assets.length} assets across ${new Set(assets.map(a => a.assetClass)).size} classes...\n`);

  // Full analysis
  const { signals, marketDataMap } = await orchestrator.analyzeCycle(assets, timeframe);

  // Scan and rank
  const scanner = new OpportunityScanner();
  const opportunities = scanner.scan(signals, marketDataMap);

  // Report
  console.log(OpportunityScanner.formatReport(opportunities));

  // Portfolio selection
  const selected = scanner.selectPortfolio(opportunities, {
    maxPositions: 10,
    minScore: 35,
    diversify: true,
  });

  if (selected.length > 0) {
    console.log('\n=== SELECTED PORTFOLIO ===');
    console.log(`The agent would trade these ${selected.length} opportunities:\n`);

    for (let i = 0; i < selected.length; i++) {
      const o = selected[i];
      console.log(`  ${i + 1}. ${o.action} ${o.asset.symbol} (${o.asset.assetClass}) — score: ${o.score}, confidence: ${(o.avgConfidence * 100).toFixed(0)}%`);
      console.log(`     ${o.reason}`);
    }

    const classSummary = new Map<string, number>();
    for (const o of selected) {
      classSummary.set(o.asset.assetClass, (classSummary.get(o.asset.assetClass) ?? 0) + 1);
    }
    console.log(`\n  Diversification: ${[...classSummary.entries()].map(([c, n]) => `${c}=${n}`).join(', ')}`);
  } else {
    console.log('\nNo opportunities met the minimum score threshold.');
  }

  await orchestrator.shutdown();
}

main().catch(console.error);
