// ============================================================
// 24/7 Auto-Trading — Continuous autonomous trading loop
//
// The system runs indefinitely:
//   1. Research Team fetches latest data
//   2. Trading Team autonomously selects assets & executes
//   3. Self-reviews performance periodically
//   4. Evolves strategies on a schedule
//   5. CEO oversees everything
//
// Usage: npm run auto-trade [timeframe] [cycleSec] [assetClass]
// ============================================================

import { TradingOrchestrator } from '../index.js';
import { allAssets, cryptoAssets, forexAssets } from '../config/assets.js';
import { config } from '../config/index.js';
import { withTimeout } from '../shared/utils.js';
import { createModuleLogger } from '../shared/logger.js';
import type { AssetInfo, Timeframe } from '../shared/types.js';

const log = createModuleLogger('auto-trade');

async function main() {
  const system = new TradingOrchestrator();
  await system.initialize();

  const timeframe: Timeframe = (process.argv[2] as Timeframe) || '1h';
  const cycleSec = parseInt(process.argv[3] || String(config.autoTradeCycleMs / 1000), 10);
  const assetClass = process.argv[4] || 'all';

  let assets: AssetInfo[];
  switch (assetClass) {
    case 'crypto': assets = cryptoAssets; break;
    case 'forex': assets = forexAssets; break;
    case 'all': assets = allAssets; break;
    default: assets = allAssets;
  }

  const cycleMs = cycleSec * 1000;
  const reviewInterval = config.autoTradeReviewInterval;
  const evolveInterval = config.autoTradeEvolveInterval;

  console.log('\n=== 24/7 AUTO-TRADING MODE ===');
  console.log(`Timeframe: ${timeframe}`);
  console.log(`Cycle interval: ${cycleSec}s`);
  console.log(`Asset universe: ${assets.length} (${assetClass})`);
  console.log(`Self-review every: ${reviewInterval} cycles`);
  console.log(`Evolution every: ${evolveInterval} cycles`);
  console.log(`Trading mode: ${config.tradingMode}`);
  console.log(`Initial capital: $${config.initialCapital}`);
  console.log('\nPress Ctrl+C to stop\n');

  let cycleCount = 0;
  let cycleRunning = false;
  let consecutiveErrors = 0;

  const runCycle = async () => {
    if (cycleRunning) {
      log.warn('Previous cycle still running — skipping');
      return;
    }

    cycleRunning = true;
    cycleCount++;

    try {
      const startTime = Date.now();
      log.info({ cycle: cycleCount }, 'Starting auto-trade cycle');

      // Main trading cycle — Trading Team decides what to trade
      await withTimeout(
        system.tradingCycle(assets, timeframe),
        config.tradingCycleTimeoutMs,
        `Auto-trade cycle ${cycleCount}`,
      );

      const elapsed = Date.now() - startTime;
      consecutiveErrors = 0;

      log.info({ cycle: cycleCount, elapsed }, 'Auto-trade cycle complete');

      // Evolution on schedule
      if (cycleCount % evolveInterval === 0) {
        log.info({ cycle: cycleCount }, 'Running scheduled evolution');
        try {
          const firstAsset = assets[0];
          await withTimeout(
            system.runEvolution(firstAsset, timeframe),
            config.tradingCycleTimeoutMs,
            'Scheduled evolution',
          );
        } catch (err) {
          log.warn({ err: (err as Error).message }, 'Evolution cycle failed');
        }
      }

      // Agent status every 25 cycles
      if (cycleCount % 25 === 0) {
        system.printAgentStatus();
      }

      // Periodic diagnostics every 100 cycles
      if (cycleCount % 100 === 0) {
        log.info({ cycle: cycleCount }, 'Running periodic diagnostics');
        try {
          await system.runDiagnostics(assets, timeframe);
        } catch (err) {
          log.warn({ err: (err as Error).message }, 'Diagnostics failed');
        }
      }

    } catch (err) {
      consecutiveErrors++;
      log.error({
        cycle: cycleCount,
        error: (err as Error).message,
        consecutiveErrors,
      }, 'Auto-trade cycle error');

      // If too many consecutive errors, pause and alert
      if (consecutiveErrors >= 5) {
        log.error('5 consecutive errors — pausing for 5 minutes');
        console.error('\n!!! ALERT: 5 consecutive cycle errors — auto-pausing for 5 minutes !!!');
        await new Promise(r => setTimeout(r, 5 * 60 * 1000));
        consecutiveErrors = 0;
      }
    } finally {
      cycleRunning = false;
    }
  };

  // Run initial cycle
  await runCycle();

  // Schedule continuous cycles
  const interval = setInterval(runCycle, cycleMs);

  // Graceful shutdown
  const shutdown = async () => {
    clearInterval(interval);
    console.log('\n\n=== AUTO-TRADE SHUTDOWN ===');
    console.log(`Total cycles: ${cycleCount}`);
    console.log(system.getPortfolioSummary());

    // Final self-review
    const review = system.getTradingTeam().reviewPerformance();
    console.log('\nFinal Trade Review:');
    console.log(review.summary);
    if (review.adjustments.length > 0) {
      review.adjustments.forEach(a => console.log(`  - ${a}`));
    }

    // CEO dashboard
    console.log(system.getCeo().formatReport(system.getTradingTeam().getPortfolio()));

    await system.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// No watchdog for auto-trade — it's meant to run indefinitely
main().catch((err) => {
  console.error('Fatal auto-trade error:', err);
  process.exit(1);
});
