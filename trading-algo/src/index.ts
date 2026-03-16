import { config } from './config/index.js';
import { allAssets, cryptoAssets } from './config/assets.js';
import { MarketAnalyst } from './team/market-analyst/index.js';
import { TechnicalStrategist } from './team/technical-strategist/index.js';
import { MacroEconomist } from './team/macro-economist/index.js';
import { SentimentAnalyst } from './team/sentiment-analyst/index.js';
import { RiskManager } from './team/risk-manager/index.js';
import { Backtester } from './team/backtester/index.js';
import { Executor } from './team/executor/index.js';
import { SelfImprover } from './team/self-improver/index.js';
import { RegimeDetector } from './team/regime-detector/index.js';
import { ScenarioSimulator } from './team/scenario-simulator/index.js';
import { DiagnosticsEngine } from './team/diagnostics/index.js';
import { OpportunityScanner } from './team/opportunity-scanner/index.js';
import { eventBus } from './shared/events.js';
import { createModuleLogger } from './shared/logger.js';
import type { AssetInfo, Timeframe, Signal, MarketData, Candle } from './shared/types.js';

const log = createModuleLogger('orchestrator');

/**
 * Trading System Orchestrator — coordinates all team members.
 * Scans ALL asset classes, ranks opportunities, and builds its own portfolio.
 */
export class TradingOrchestrator {
  private marketAnalyst = new MarketAnalyst();
  private strategist = new TechnicalStrategist();
  private macroEconomist = new MacroEconomist();
  private sentimentAnalyst = new SentimentAnalyst();
  private riskManager = new RiskManager();
  private backtester = new Backtester();
  private executor = new Executor();
  private selfImprover = new SelfImprover();
  private regimeDetector = new RegimeDetector();
  private scenarioSimulator = new ScenarioSimulator();
  private diagnosticsEngine = new DiagnosticsEngine();
  private scanner = new OpportunityScanner();

  async initialize(): Promise<void> {
    log.info('Initializing trading system...');
    await this.selfImprover.initialize();

    // Listen for events
    eventBus.on('signal:generated', (event) => {
      log.debug({ signal: event.data }, 'Signal received');
    });

    eventBus.on('evolution:improvement', (event) => {
      log.info({ improvement: event.data }, 'Strategy evolved!');
    });

    log.info({
      mode: config.tradingMode,
      capital: config.initialCapital,
      assets: allAssets.length,
    }, 'Trading system ready');
  }

  /**
   * Run full analysis cycle on all assets.
   * Returns signals AND the market data map for downstream use.
   */
  async analyzeCycle(
    assets: AssetInfo[] = allAssets,
    timeframe: Timeframe = '1h'
  ): Promise<{ signals: Signal[]; marketDataMap: Map<string, MarketData> }> {
    log.info({ assets: assets.length, timeframe }, 'Starting analysis cycle');

    // 1. Fetch macro environment
    const macro = await this.macroEconomist.getEnvironment();
    log.info({ bias: macro.bias, risk: macro.riskLevel }, 'Macro environment assessed');

    // 2. Fetch market data for ALL assets across ALL classes
    const marketDataMap = new Map<string, MarketData>();
    for (const asset of assets) {
      try {
        const data = await this.marketAnalyst.fetchMarketData(asset, timeframe);
        if (data.candles.length > 0) {
          marketDataMap.set(asset.symbol, data);
        }
      } catch (err) {
        log.warn({ asset: asset.symbol, error: (err as Error).message }, 'Failed to fetch data');
      }
    }

    // 3. Run technical analysis on EVERY asset
    const allSignals: Signal[] = [];
    for (const [symbol, data] of marketDataMap) {
      const signals = await this.strategist.analyzeAll(data, macro);
      allSignals.push(...signals);
    }

    log.info({
      assetsAnalyzed: marketDataMap.size,
      totalSignals: allSignals.length,
      buySignals: allSignals.filter((s) => s.action === 'BUY').length,
      sellSignals: allSignals.filter((s) => s.action === 'SELL').length,
    }, 'Analysis cycle complete');

    return { signals: allSignals, marketDataMap };
  }

  /**
   * Smart trading cycle: scan ALL assets → rank opportunities →
   * select best portfolio → execute trades.
   * The agent autonomously chooses which assets to trade.
   */
  async tradingCycle(
    assets: AssetInfo[] = allAssets,
    timeframe: Timeframe = '1h'
  ): Promise<void> {
    // 1. Analyze ALL assets across crypto, stocks, forex
    const { signals, marketDataMap } = await this.analyzeCycle(assets, timeframe);
    const portfolio = this.executor.getPortfolio();
    const macro = await this.macroEconomist.getEnvironment();

    // 2. Update prices and check stops on existing positions
    const prices = new Map<string, number>();
    for (const signal of signals) {
      prices.set(signal.asset.symbol, signal.price);
    }
    await this.executor.checkStops(prices);
    this.executor.updatePrices(prices);

    // 3. Scan and rank all opportunities
    const opportunities = this.scanner.scan(signals, marketDataMap, macro);

    // 4. Let the agent select its own portfolio
    const maxNewPositions = Math.max(1, 10 - portfolio.positions.length);
    const selected = this.scanner.selectPortfolio(opportunities, {
      maxPositions: maxNewPositions,
      minScore: 35,
      minConfidence: 0.55,
      diversify: true,
    });

    // 5. Print opportunity report
    if (opportunities.length > 0) {
      console.log(OpportunityScanner.formatReport(opportunities));
    }

    // 6. Execute trades on selected opportunities
    let executed = 0;
    let rejected = 0;

    for (const opp of selected) {
      // Use the highest-confidence signal from this opportunity
      const bestSignal = opp.signals.sort((a, b) => b.confidence - a.confidence)[0];
      const candles = marketDataMap.get(opp.asset.symbol)?.candles ?? [];

      if (candles.length < 20) continue;

      const risk = this.riskManager.assessRisk(bestSignal, portfolio, candles, macro);
      if (risk.approved) {
        const result = await this.executor.execute(bestSignal, risk);
        if (result.success) {
          executed++;
          log.info({
            symbol: opp.asset.symbol,
            action: opp.action,
            score: opp.score,
            strategy: bestSignal.strategy,
          }, 'Trade executed from opportunity');
        }
      } else {
        rejected++;
        log.debug({ symbol: opp.asset.symbol, reason: risk.reason }, 'Opportunity rejected by risk');
      }
    }

    // 7. Summary
    console.log(`\n=== Trading Cycle Summary ===`);
    console.log(`Assets scanned: ${marketDataMap.size} (crypto: ${assets.filter(a => a.assetClass === 'crypto').length}, stocks: ${assets.filter(a => a.assetClass === 'stock').length}, forex: ${assets.filter(a => a.assetClass === 'forex').length})`);
    console.log(`Signals generated: ${signals.length}`);
    console.log(`Opportunities found: ${opportunities.length}`);
    console.log(`Selected for trading: ${selected.length}`);
    console.log(`Trades executed: ${executed}, rejected: ${rejected}`);
    console.log(this.executor.getSummary());
  }

  /**
   * Run backtest for all strategies on an asset.
   */
  async runBacktest(asset: AssetInfo, timeframe: Timeframe = '1h') {
    const data = await this.marketAnalyst.fetchMarketData(asset, timeframe);
    if (data.candles.length < 100) {
      log.warn({ asset: asset.symbol, candles: data.candles.length }, 'Insufficient data for backtest');
      return;
    }

    const strategies = this.strategist.getStrategies();
    const results = await this.backtester.compareStrategies(strategies, data.candles, asset, timeframe);

    for (const result of results) {
      await this.selfImprover.recordResult(result);
    }

    console.log(this.selfImprover.getLeaderboard());
    return results;
  }

  /**
   * Run evolution cycle for all strategies.
   */
  async runEvolution(asset: AssetInfo, timeframe: Timeframe = '1h') {
    const data = await this.marketAnalyst.fetchMarketData(asset, timeframe);
    if (data.candles.length < 100) {
      log.warn('Insufficient data for evolution');
      return;
    }

    const strategies = this.strategist.getStrategies();
    for (const strategy of strategies) {
      const { improved, bestDna } = await this.selfImprover.evolveStrategy(
        strategy, data.candles, asset, timeframe
      );

      if (improved) {
        this.strategist.updateDNA(strategy.name, bestDna);
        log.info({ strategy: strategy.name }, 'Strategy DNA updated with evolved parameters');
      }
    }

    await this.selfImprover.save();
    console.log(this.selfImprover.getLeaderboard());
  }

  /**
   * Run full diagnostic scan — detect anomalies, risks, problems.
   */
  async runDiagnostics(
    assets: AssetInfo[] = allAssets,
    timeframe: Timeframe = '1h'
  ) {
    log.info('Running full diagnostic scan...');

    // Fetch data
    const macro = await this.macroEconomist.getEnvironment();
    const candlesMap = new Map<string, Candle[]>();
    for (const asset of assets) {
      try {
        const data = await this.marketAnalyst.fetchMarketData(asset, timeframe);
        if (data.candles.length > 0) candlesMap.set(asset.symbol, data.candles);
      } catch { /* skip */ }
    }

    // Detect regime for first asset with data
    const firstCandles = [...candlesMap.values()][0];
    const regime = firstCandles
      ? this.regimeDetector.detect(firstCandles, macro)
      : undefined;

    // Run scenario simulation for first asset
    const firstAsset = assets[0];
    const simulation = firstCandles && regime
      ? this.scenarioSimulator.simulate(firstAsset, firstCandles, regime.regime, macro)
      : undefined;

    // Run diagnostics
    const report = this.diagnosticsEngine.scan({
      candles: candlesMap,
      portfolio: this.executor.getPortfolio(),
      regime,
      simulation,
      macro,
    });

    // Print reports
    if (regime) {
      console.log(`\n=== Market Regime: ${regime.regime.toUpperCase()} (${(regime.confidence * 100).toFixed(0)}% confidence) ===`);
      console.log(regime.details);
      console.log(`Recommended strategies: ${regime.recommendedStrategies.join(', ')}`);
    }

    if (simulation) {
      console.log(`\n=== Scenario Simulation: ${firstAsset.symbol} ===`);
      console.log(`Outlook: ${simulation.overallOutlook.toUpperCase()}`);
      console.log(`Best case: ${simulation.bestScenario} | Worst case: ${simulation.worstScenario}`);
      console.log('\nKey Risks:');
      simulation.keyRisks.forEach((r) => console.log(`  - ${r}`));
      console.log('\nOpportunities:');
      simulation.opportunities.forEach((o) => console.log(`  + ${o}`));
      console.log('\nScenarios:');
      for (const s of simulation.scenarios) {
        console.log(`  ${s.name} (${(s.probability * 100).toFixed(0)}%): ${s.expectedReturn > 0 ? '+' : ''}${s.expectedReturn}% expected`);
      }
    }

    console.log(DiagnosticsEngine.formatReport(report));
    return { regime, simulation, report };
  }

  /**
   * Get portfolio summary.
   */
  getPortfolioSummary(): string {
    return this.executor.getSummary();
  }

  /**
   * Save all system state.
   */
  async shutdown(): Promise<void> {
    await this.selfImprover.save();
    log.info('System state saved. Shutting down.');
  }
}

// Main entry point
async function main() {
  const orchestrator = new TradingOrchestrator();
  await orchestrator.initialize();

  console.log('\n=== Trading Algorithm System ===');
  console.log(`Mode: ${config.tradingMode}`);
  console.log(`Capital: $${config.initialCapital}`);
  console.log(`Assets: ${allAssets.length} total (8 crypto, 8 stocks, 6 forex)`);
  console.log('\nRun scripts:');
  console.log('  npm run backtest     — Backtest ALL assets');
  console.log('  npm run paper-trade  — Paper trade ALL assets (agent selects portfolio)');
  console.log('  npm run analyze      — Analyze ALL markets');
  console.log('  npm run evolve       — Evolve strategies across ALL assets');
  console.log('  npm run diagnose     — Run diagnostic scan');
  console.log('  npm run scan         — Scan for best opportunities');
  console.log('');
}

main().catch(console.error);
