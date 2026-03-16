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
import { AgentSwarm, ConsensusEngine, DecayDetector } from './team/agent-network/index.js';
import { eventBus } from './shared/events.js';
import { createModuleLogger } from './shared/logger.js';
import type { AssetInfo, Timeframe, Signal, MarketData, Candle } from './shared/types.js';

const log = createModuleLogger('orchestrator');

/**
 * Trading System Orchestrator — coordinates all team members.
 * Now powered by a multi-agent swarm that debates trades.
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
  private swarm: AgentSwarm;

  constructor() {
    this.swarm = new AgentSwarm({
      maxAgents: 20,
      minAgents: 2,       // at least 2 agents per strategy for debate
      probationThreshold: 30,
      retireThreshold: 15,
      spawnCooldownMs: 30_000,
      evaluationWindowSize: 20,
      doubtThreshold: 0.2,
      consensusQuorum: 0.5,
    });
  }

  async initialize(): Promise<void> {
    log.info('Initializing trading system...');
    await this.selfImprover.initialize();

    // Register strategies with the agent swarm
    const strategies = this.strategist.getStrategies();
    this.swarm.registerStrategies(strategies);

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
      agents: this.swarm.getAgentProfiles().length,
    }, 'Trading system ready');
  }

  /**
   * Run full analysis cycle on all assets.
   */
  async analyzeCycle(
    assets: AssetInfo[] = allAssets,
    timeframe: Timeframe = '1h'
  ): Promise<{ signals: Signal[]; marketDataMap: Map<string, MarketData> }> {
    log.info({ assets: assets.length, timeframe }, 'Starting analysis cycle');

    // 1. Fetch macro environment
    const macro = await this.macroEconomist.getEnvironment();
    log.info({ bias: macro.bias, risk: macro.riskLevel }, 'Macro environment assessed');

    // 2. Fetch market data for ALL assets
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
    for (const [, data] of marketDataMap) {
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
   * Multi-agent trading cycle:
   *  1. Fetch data for all 109 assets
   *  2. Each agent independently analyzes and proposes trades
   *  3. Agents debate — doubt, support, counter each other
   *  4. Consensus engine resolves debates
   *  5. Only consensus-approved trades go to risk check
   *  6. Execute approved trades
   *  7. Underperformers evolve, top performers spawn children
   */
  async tradingCycle(
    assets: AssetInfo[] = allAssets,
    timeframe: Timeframe = '1h'
  ): Promise<void> {
    // 1. Fetch macro + market data
    const macro = await this.macroEconomist.getEnvironment();
    const marketDataMap = new Map<string, MarketData>();
    for (const asset of assets) {
      try {
        const data = await this.marketAnalyst.fetchMarketData(asset, timeframe);
        if (data.candles.length > 0) marketDataMap.set(asset.symbol, data);
      } catch (err) {
        log.warn({ asset: asset.symbol, error: (err as Error).message }, 'Data fetch failed');
      }
    }

    // 2. Update prices and check stops on existing positions
    const portfolio = this.executor.getPortfolio();
    const prices = new Map<string, number>();
    for (const [, data] of marketDataMap) {
      if (data.candles.length > 0) {
        prices.set(data.asset.symbol, data.candles[data.candles.length - 1].close);
      }
    }
    await this.executor.checkStops(prices);
    this.executor.updatePrices(prices);

    // 3. Run the multi-agent swarm cycle
    //    Agents propose → debate → consensus
    const { approvedSignals, debateSummary, agentReport } = await this.swarm.runCycle(
      marketDataMap, macro,
    );

    // 4. Print debate summary
    console.log(ConsensusEngine.formatDebateSummary(debateSummary));

    // 5. Execute consensus-approved trades through risk manager
    let executed = 0;
    let rejected = 0;

    for (const { signal, confidence, proposerId } of approvedSignals) {
      const candles = marketDataMap.get(signal.asset.symbol)?.candles ?? [];
      if (candles.length < 20) continue;

      const risk = this.riskManager.assessRisk(signal, portfolio, candles, macro);
      if (risk.approved) {
        const result = await this.executor.execute(signal, risk);
        if (result.success) {
          executed++;
          log.info({
            symbol: signal.asset.symbol,
            action: signal.action,
            confidence: confidence.toFixed(2),
            proposer: proposerId.slice(0, 8),
          }, 'Consensus trade executed');
        }
      } else {
        rejected++;
      }
    }

    // 6. Print swarm status
    console.log(agentReport);

    // 7. Summary
    console.log(`\n=== Trading Cycle Summary ===`);
    console.log(`Assets scanned: ${marketDataMap.size}`);
    console.log(`Agent debates: ${debateSummary.length}`);
    console.log(`Consensus approved: ${approvedSignals.length}`);
    console.log(`Trades executed: ${executed}, risk-rejected: ${rejected}`);
    console.log(`Active agents: ${this.swarm.getAgentProfiles().filter(a => a.status === 'active').length}`);
    console.log(this.executor.getSummary());

    // 8. Print data source status if there are pending requests
    const pendingData = this.swarm.dataSourceManager.getPendingRequests();
    if (pendingData.length > 0) {
      console.log(this.swarm.dataSourceManager.formatReport());
    }
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
   * Run full diagnostic scan.
   */
  async runDiagnostics(
    assets: AssetInfo[] = allAssets,
    timeframe: Timeframe = '1h'
  ) {
    log.info('Running full diagnostic scan...');

    const macro = await this.macroEconomist.getEnvironment();
    const candlesMap = new Map<string, Candle[]>();
    for (const asset of assets) {
      try {
        const data = await this.marketAnalyst.fetchMarketData(asset, timeframe);
        if (data.candles.length > 0) candlesMap.set(asset.symbol, data.candles);
      } catch { /* skip */ }
    }

    const firstCandles = [...candlesMap.values()][0];
    const regime = firstCandles
      ? this.regimeDetector.detect(firstCandles, macro)
      : undefined;

    const firstAsset = assets[0];
    const simulation = firstCandles && regime
      ? this.scenarioSimulator.simulate(firstAsset, firstCandles, regime.regime, macro)
      : undefined;

    const report = this.diagnosticsEngine.scan({
      candles: candlesMap,
      portfolio: this.executor.getPortfolio(),
      regime,
      simulation,
      macro,
    });

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

    // Agent swarm status + governance + XAI + decay
    console.log(this.swarm.formatFullReport());

    // Decay analysis
    const decayResults = this.swarm.decayDetector.analyzeAll();
    if (decayResults.length > 0) {
      console.log(DecayDetector.formatReport(decayResults));
    }

    return { regime, simulation, report };
  }

  /** Get portfolio summary */
  getPortfolioSummary(): string {
    return this.executor.getSummary();
  }

  /** Get the agent swarm instance */
  getSwarm(): AgentSwarm {
    return this.swarm;
  }

  /** Save all system state */
  async shutdown(): Promise<void> {
    await this.selfImprover.save();
    log.info('System state saved. Shutting down.');
  }
}

// Main entry point
async function main() {
  const orchestrator = new TradingOrchestrator();
  await orchestrator.initialize();

  const swarm = orchestrator.getSwarm();
  const agents = swarm.getAgentProfiles();

  console.log('\n=== Trading Algorithm System (Multi-Agent) ===');
  console.log(`Mode: ${config.tradingMode}`);
  console.log(`Capital: $${config.initialCapital}`);
  console.log(`Assets: ${allAssets.length} total`);
  console.log(`Agents: ${agents.length} autonomous trading agents`);
  console.log(`  Each agent proposes, debates, and evolves independently`);
  console.log('\nRun scripts:');
  console.log('  npm run paper-trade  — Multi-agent paper trading (debate + consensus)');
  console.log('  npm run backtest     — Backtest ALL assets');
  console.log('  npm run analyze      — Analyze ALL markets');
  console.log('  npm run evolve       — Evolve strategies across ALL assets');
  console.log('  npm run diagnose     — Full diagnostic (includes swarm report)');
  console.log('  npm run scan         — Scan for best opportunities');
  console.log('');
}

main().catch(console.error);
