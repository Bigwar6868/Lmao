import { config } from './config/index.js';
import { allAssets } from './config/assets.js';
import { AgentNetwork } from './team/agent-network/network.js';
import { TradingAgent } from './team/agent-network/trading-agent.js';
import { AgentSpawner } from './team/agent-network/spawner.js';
import { ExplainabilityEngine } from './team/agent-network/explainability.js';
import { DecayDetector } from './team/agent-network/decay-detector.js';
import { ConsensusEngine } from './team/agent-network/consensus.js';
import { CEOAgent } from './team/ceo/index.js';
import { TradingTeam } from './team/ceo/trading-team.js';
import { ResearchTeam } from './team/ceo/research-team.js';
import { RiskTeam } from './team/ceo/risk-team.js';
import { EvolutionTeam } from './team/ceo/evolution-team.js';
import { OpsTeam } from './team/ceo/ops-team.js';
import { DiagnosticsEngine } from './team/diagnostics/index.js';
import { eventBus } from './shared/events.js';
import { createModuleLogger } from './shared/logger.js';
import type { AssetInfo, Timeframe, Signal, MarketData, Candle } from './shared/types.js';
import type { AgentId } from './shared/agent-types.js';

const log = createModuleLogger('orchestrator');

/**
 * TradingSystem — CEO-driven multi-team trading architecture.
 *
 * Structure:
 *   CEO
 *   ├── Trading Team    — decides what/when to trade, executes
 *   ├── Research Team   — market data, macro, sentiment, scanning
 *   ├── Risk Team       — position sizing, stops, governance
 *   ├── Evolution Team  — backtests, evolves strategies, decay detection
 *   └── Ops Team        — diagnostics, data sources, monitoring
 *
 * All agents can discuss with each other across teams.
 * CEO approves/vetoes requests and issues directives.
 */
export class TradingSystem {
  // Core
  private network = new AgentNetwork();
  private ceo: CEOAgent;

  // Teams
  private tradingTeam: TradingTeam;
  private researchTeam: ResearchTeam;
  private riskTeam: RiskTeam;
  private evolutionTeam: EvolutionTeam;
  private opsTeam: OpsTeam;

  // Agent management
  private explainability = new ExplainabilityEngine();
  private spawner!: AgentSpawner;
  private agents = new Map<AgentId, TradingAgent>();
  private strategies = new Map<string, import('./shared/types.js').Strategy>();

  constructor() {
    // Create CEO
    this.ceo = new CEOAgent(this.network);

    // Create teams — each gets the network + CEO id
    this.tradingTeam = new TradingTeam(this.network, this.ceo.id);
    this.researchTeam = new ResearchTeam(this.network, this.ceo.id);
    this.riskTeam = new RiskTeam(this.network, this.ceo.id);
    this.evolutionTeam = new EvolutionTeam(this.network, this.ceo.id);
    this.opsTeam = new OpsTeam(this.network, this.ceo.id);

    log.info('TradingSystem created with CEO + 5 teams');
  }

  async initialize(): Promise<void> {
    log.info('Initializing CEO-driven trading system...');

    // 1. Register all teams with CEO
    this.ceo.registerTeam(this.tradingTeam.getConfig());
    this.ceo.registerTeam(this.researchTeam.getConfig());
    this.ceo.registerTeam(this.riskTeam.getConfig());
    this.ceo.registerTeam(this.evolutionTeam.getConfig());
    this.ceo.registerTeam(this.opsTeam.getConfig());

    // 2. Initialize evolution team (loads saved state)
    await this.evolutionTeam.initialize();

    // 3. Get strategies from research team
    const strategyList = this.researchTeam.getStrategies();
    for (const strategy of strategyList) {
      this.strategies.set(strategy.name, strategy);
    }

    // 4. Spawn initial trading agents (2 per strategy for debate)
    for (const strategy of strategyList) {
      for (let i = 0; i < 2; i++) {
        const agent = new TradingAgent({
          strategy,
          network: this.network,
          name: `${strategy.name}-prime${i > 0 ? `-${i}` : ''}`,
        });
        this.agents.set(agent.id, agent);
        this.tradingTeam.registerAgent(agent);
      }
    }

    // 5. Create spawner for dynamic agent management
    this.spawner = new AgentSpawner(
      this.network, this.agents, this.strategies,
      {
        maxAgents: 30,
        minAgents: 2,
        probationThreshold: 30,
        retireThreshold: 15,
        spawnCooldownMs: 30_000,
        evaluationWindowSize: 20,
        doubtThreshold: 0.2,
        consensusQuorum: 0.5,
      },
    );

    // 6. CEO sets initial active assets + strategies
    this.ceo.setActiveAssets(allAssets);
    this.ceo.setActiveStrategies(strategyList.map(s => s.name));

    // 7. Event listeners
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
      agents: this.agents.size,
      teams: this.ceo.getAllTeams().length,
    }, 'CEO-driven trading system ready');
  }

  // ----------------------------------------------------------------
  // Analysis Cycle (delegates to Research Team)
  // ----------------------------------------------------------------

  async analyzeCycle(
    assets: AssetInfo[] = allAssets,
    timeframe: Timeframe = '1h',
  ): Promise<{ signals: Signal[]; marketDataMap: Map<string, MarketData> }> {
    log.info({ assets: assets.length, timeframe }, 'Starting analysis cycle');

    const macro = await this.researchTeam.getMacroEnvironment();
    const marketDataMap = await this.researchTeam.fetchAllData(assets, timeframe);
    const signals = await this.researchTeam.analyzeAll(marketDataMap, macro);

    log.info({
      assetsAnalyzed: marketDataMap.size,
      totalSignals: signals.length,
      buySignals: signals.filter(s => s.action === 'BUY').length,
      sellSignals: signals.filter(s => s.action === 'SELL').length,
    }, 'Analysis cycle complete');

    return { signals, marketDataMap };
  }

  // ----------------------------------------------------------------
  // Trading Cycle — CEO-driven flow
  // ----------------------------------------------------------------

  async tradingCycle(
    assets: AssetInfo[] = allAssets,
    timeframe: Timeframe = '1h',
  ): Promise<void> {
    const cycle = this.ceo.incrementCycle();

    // 0. Check CEO pause + risk kill switch
    if (this.ceo.isPaused() || this.riskTeam.isKillSwitchActive()) {
      log.warn({ cycle }, 'System paused — skipping cycle');
      return;
    }

    log.info({ cycle, agents: this.agents.size }, 'Starting CEO-driven trading cycle');

    // 1. Research team fetches data
    const macro = await this.researchTeam.getMacroEnvironment();
    const marketDataMap = await this.researchTeam.fetchAllData(assets, timeframe);

    // 2. Update prices + check stops
    const prices = new Map<string, number>();
    for (const [, data] of marketDataMap) {
      if (data.candles.length > 0) {
        prices.set(data.asset.symbol, data.candles[data.candles.length - 1].close);
      }
    }
    await this.tradingTeam.checkStops(prices);
    this.tradingTeam.updatePrices(prices);

    // 3. Trading team runs cycle (agents analyze, debate, execute)
    const { approvedSignals, debateSummary, executed, rejected } = await this.tradingTeam.runCycle(
      marketDataMap, macro,
    );

    // 4. Print debate summary
    console.log(ConsensusEngine.formatDebateSummary(debateSummary));

    // 5. Record performance snapshots for decay detection
    for (const [id, agent] of this.agents) {
      if (agent.getStatus() === 'retired') continue;
      this.evolutionTeam.decayDetector.record({
        timestamp: Date.now(),
        agentId: id,
        strategy: agent.getStrategy().name,
        winRate: agent.getRecentWinRate(),
        sharpe: 0,
        pnl: agent.getHistory().totalPnl,
        reputation: agent.getReputation(),
        tradesCount: agent.getHistory().successfulTrades + agent.getHistory().failedTrades,
      });
    }

    // 6. Agent lifecycle management
    const { spawned, retired } = this.spawner.evaluate();
    for (const agent of spawned) {
      this.tradingTeam.registerAgent(agent);
    }

    // 7. Evolve underperformers every 5 cycles
    if (cycle % 5 === 0) {
      this.spawner.evolveUnderperformers();
    }

    // 8. Decay analysis every 15 cycles
    if (cycle % 15 === 0) {
      const decayResults = this.evolutionTeam.analyzeDecay();
      const decaying = decayResults.filter(d => d.isDecaying);
      if (decaying.length > 0) {
        log.warn({ decaying: decaying.length }, 'Strategy decay detected');
        console.log(DecayDetector.formatReport(decayResults));
      }
    }

    // 9. Print summary
    console.log(`\n=== Trading Cycle ${cycle} Summary ===`);
    console.log(`Assets scanned: ${marketDataMap.size}`);
    console.log(`Agent debates: ${debateSummary.length}`);
    console.log(`Consensus approved: ${approvedSignals.length}`);
    console.log(`Trades executed: ${executed}, risk-rejected: ${rejected}`);
    console.log(`Active agents: ${[...this.agents.values()].filter(a => a.getStatus() === 'active').length}`);
    console.log(`Spawned: ${spawned.length}, Retired: ${retired.length}`);
    console.log(this.tradingTeam.getPortfolioSummary());

    // 10. CEO dashboard
    console.log(this.ceo.formatReport(this.tradingTeam.getPortfolio()));
  }

  // ----------------------------------------------------------------
  // Backtest (delegates to Evolution Team)
  // ----------------------------------------------------------------

  async runBacktest(asset: AssetInfo, timeframe: Timeframe = '1h') {
    const data = await this.researchTeam.marketAnalyst.fetchMarketData(asset, timeframe);
    if (data.candles.length < 100) {
      log.warn({ asset: asset.symbol, candles: data.candles.length }, 'Insufficient data for backtest');
      return;
    }

    const strategies = this.researchTeam.getStrategies();
    const results = await this.evolutionTeam.runAllBacktests(strategies, data.candles, asset, timeframe);

    console.log(this.evolutionTeam.getLeaderboard());
    return results;
  }

  // ----------------------------------------------------------------
  // Evolution (delegates to Evolution Team — internal, no API)
  // ----------------------------------------------------------------

  async runEvolution(asset: AssetInfo, timeframe: Timeframe = '1h') {
    const data = await this.researchTeam.marketAnalyst.fetchMarketData(asset, timeframe);
    if (data.candles.length < 100) {
      log.warn('Insufficient data for evolution');
      return;
    }

    const strategies = this.researchTeam.getStrategies();
    for (const strategy of strategies) {
      const { improved, bestDna } = await this.evolutionTeam.evolveStrategy(
        strategy, data.candles, asset, timeframe,
      );
      if (improved) {
        this.researchTeam.strategist.updateDNA(strategy.name, bestDna);
        log.info({ strategy: strategy.name }, 'Strategy DNA updated');
      }
    }

    await this.evolutionTeam.save();
    console.log(this.evolutionTeam.getLeaderboard());
  }

  // ----------------------------------------------------------------
  // Diagnostics (delegates to Ops + Research + Risk)
  // ----------------------------------------------------------------

  async runDiagnostics(
    assets: AssetInfo[] = allAssets,
    timeframe: Timeframe = '1h',
  ) {
    log.info('Running full diagnostic scan...');

    const macro = await this.researchTeam.getMacroEnvironment();
    const marketDataMap = await this.researchTeam.fetchAllData(assets, timeframe);

    const candlesMap = new Map<string, Candle[]>();
    for (const [symbol, data] of marketDataMap) {
      if (data.candles.length > 0) candlesMap.set(symbol, data.candles);
    }

    const regime = this.researchTeam.detectRegime(marketDataMap, macro);

    const firstAsset = assets[0];
    const firstCandles = [...candlesMap.values()][0];
    const simulation = firstCandles && regime
      ? this.opsTeam.scenarioSimulator.simulate(firstAsset, firstCandles, regime.regime, macro)
      : undefined;

    const report = this.opsTeam.runDiagnostics({
      candles: candlesMap,
      portfolio: this.tradingTeam.getPortfolio(),
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
      simulation.keyRisks.forEach(r => console.log(`  - ${r}`));
      console.log('\nOpportunities:');
      simulation.opportunities.forEach(o => console.log(`  + ${o}`));
      console.log('\nScenarios:');
      for (const s of simulation.scenarios) {
        console.log(`  ${s.name} (${(s.probability * 100).toFixed(0)}%): ${s.expectedReturn > 0 ? '+' : ''}${s.expectedReturn}% expected`);
      }
    }

    console.log(DiagnosticsEngine.formatReport(report));

    // Team reports
    console.log(this.riskTeam.formatReport());
    console.log(this.opsTeam.getDataSourceReport());

    // CEO dashboard
    console.log(this.ceo.formatReport(this.tradingTeam.getPortfolio()));

    // Decay
    const decayResults = this.evolutionTeam.analyzeDecay();
    if (decayResults.length > 0) {
      console.log(DecayDetector.formatReport(decayResults));
    }

    return { regime, simulation, report };
  }

  // ----------------------------------------------------------------
  // Accessors (backwards compat for scripts)
  // ----------------------------------------------------------------

  getPortfolioSummary(): string {
    return this.tradingTeam.getPortfolioSummary();
  }

  getSwarm() {
    return {
      getAgentProfiles: () => [...this.agents.values()].map(a => a.profile),
      dataSourceManager: this.opsTeam.dataSourceManager,
      decayDetector: this.evolutionTeam.decayDetector,
      formatFullReport: () => [
        this.ceo.formatReport(this.tradingTeam.getPortfolio()),
        this.riskTeam.formatReport(),
        this.opsTeam.getDataSourceReport(),
      ].join('\n'),
    };
  }

  getCeo(): CEOAgent { return this.ceo; }
  getTradingTeam(): TradingTeam { return this.tradingTeam; }
  getResearchTeam(): ResearchTeam { return this.researchTeam; }
  getRiskTeam(): RiskTeam { return this.riskTeam; }
  getEvolutionTeam(): EvolutionTeam { return this.evolutionTeam; }
  getOpsTeam(): OpsTeam { return this.opsTeam; }

  async shutdown(): Promise<void> {
    await this.evolutionTeam.save();
    log.info('System state saved. Shutting down.');
  }
}

/** Backwards-compatible alias for scripts */
export const TradingOrchestrator = TradingSystem;

// ----------------------------------------------------------------
// Main entry point
// ----------------------------------------------------------------

async function main() {
  const system = new TradingSystem();
  await system.initialize();

  const teams = system.getCeo().getAllTeams();

  console.log('\n=== Trading Algorithm System (CEO + 5 Teams) ===');
  console.log(`Mode: ${config.tradingMode}`);
  console.log(`Capital: $${config.initialCapital}`);
  console.log(`Assets: ${allAssets.length} total`);
  console.log(`Teams: ${teams.length}`);
  for (const team of teams) {
    console.log(`  ${team.name}: ${team.memberIds.length} agents`);
  }
  console.log('\nRun scripts:');
  console.log('  npm run paper-trade  — CEO-driven multi-team paper trading');
  console.log('  npm run backtest     — Backtest ALL assets');
  console.log('  npm run analyze      — Analyze ALL markets');
  console.log('  npm run evolve       — Evolve strategies (internal, no API)');
  console.log('  npm run diagnose     — Full diagnostic (CEO dashboard)');
  console.log('  npm run scan         — Scan for best opportunities');
  console.log('');
}

// Process watchdog
const watchdog = setTimeout(() => {
  console.error(`WATCHDOG: Process exceeded ${config.processWatchdogMs}ms — forcing exit`);
  process.exit(1);
}, config.processWatchdogMs);
watchdog.unref();

main()
  .catch(console.error)
  .finally(() => clearTimeout(watchdog));
