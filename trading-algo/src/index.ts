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
import { eventBus } from './shared/events.js';
import { createModuleLogger } from './shared/logger.js';
import type { AssetInfo, Timeframe, Signal, MarketData, Candle } from './shared/types.js';

const log = createModuleLogger('orchestrator');

/**
 * Trading System Orchestrator — coordinates all team members.
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
   */
  async analyzeCycle(
    assets: AssetInfo[] = cryptoAssets,
    timeframe: Timeframe = '1h'
  ): Promise<Signal[]> {
    log.info({ assets: assets.length, timeframe }, 'Starting analysis cycle');

    // 1. Fetch macro environment
    const macro = await this.macroEconomist.getEnvironment();
    log.info({ bias: macro.bias, risk: macro.riskLevel }, 'Macro environment assessed');

    // 2. Fetch market data for all assets
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

    // 3. Run technical analysis on each asset
    const allSignals: Signal[] = [];
    for (const [symbol, data] of marketDataMap) {
      const signals = await this.strategist.analyzeAll(data, macro);
      allSignals.push(...signals);
    }

    log.info({
      totalSignals: allSignals.length,
      buySignals: allSignals.filter((s) => s.action === 'BUY').length,
      sellSignals: allSignals.filter((s) => s.action === 'SELL').length,
    }, 'Analysis cycle complete');

    return allSignals;
  }

  /**
   * Run paper trading cycle: analyze → risk check → execute.
   */
  async tradingCycle(
    assets: AssetInfo[] = cryptoAssets,
    timeframe: Timeframe = '1h'
  ): Promise<void> {
    const signals = await this.analyzeCycle(assets, timeframe);
    const portfolio = this.executor.getPortfolio();

    // Check stops first
    const prices = new Map<string, number>();
    for (const signal of signals) {
      prices.set(signal.asset.symbol, signal.price);
    }
    await this.executor.checkStops(prices);
    this.executor.updatePrices(prices);

    // Execute actionable signals
    const actionableSignals = signals.filter((s) => s.action !== 'HOLD' && s.confidence > 0.6);

    for (const signal of actionableSignals) {
      // Get candles for ATR calculation
      const candles = (await this.marketAnalyst.fetchMarketData(signal.asset, timeframe)).candles;

      const risk = this.riskManager.assessRisk(signal, portfolio, candles);
      if (risk.approved) {
        await this.executor.execute(signal, risk);
      } else {
        log.debug({ symbol: signal.asset.symbol, reason: risk.reason }, 'Trade rejected');
      }
    }

    log.info(this.executor.getSummary());
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
    assets: AssetInfo[] = cryptoAssets,
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
  console.log(`Assets: ${allAssets.length} total`);
  console.log('\nRun scripts:');
  console.log('  npm run backtest     — Run backtests');
  console.log('  npm run paper-trade  — Start paper trading');
  console.log('  npm run analyze      — Analyze markets');
  console.log('  npm run evolve       — Evolve strategies');
  console.log('  npm run diagnose     — Run diagnostic scan');
  console.log('');
}

main().catch(console.error);
