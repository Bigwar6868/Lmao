import { config } from './config/index.js';
import { allAssets } from './config/assets.js';
import { AgentNetwork } from './team/agent-network/network.js';
import { TradingAgent } from './team/agent-network/trading-agent.js';
import { AgentSpawner } from './team/agent-network/spawner.js';
import { DecayDetector } from './team/agent-network/decay-detector.js';
import { CEOAgent } from './team/ceo/index.js';
import { TradingTeam, type TradeReviewResult } from './team/ceo/trading-team.js';
import { ResearchTeam } from './team/ceo/research-team.js';
import { RiskTeam } from './team/ceo/risk-team.js';
import { EvolutionTeam } from './team/ceo/evolution-team.js';
import { OpsTeam } from './team/ceo/ops-team.js';
import { DiagnosticsEngine } from './team/diagnostics/index.js';
import { eventBus } from './shared/events.js';
import { createModuleLogger } from './shared/logger.js';
import { attachLiveFeed, registerAgentName, printSystemEvent, printSeparator, printAgentStatusTable } from './shared/live-feed.js';
import type { AssetInfo, Timeframe, Signal, MarketData, Candle } from './shared/types.js';
import type { AgentId } from './shared/agent-types.js';
import { wireMessagingEvents, messageDispatcher } from './shared/messaging.js';

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
  private spawner!: AgentSpawner;
  private agents = new Map<AgentId, TradingAgent>();
  private strategies = new Map<string, import('./shared/types.js').Strategy>();

  constructor() {
    // Attach live feed to network — shows agent communication in real-time
    attachLiveFeed(this.network);

    // Create CEO
    this.ceo = new CEOAgent(this.network);
    registerAgentName(this.ceo.id, 'CEO');

    // Create teams — each gets the network + CEO id
    this.tradingTeam = new TradingTeam(this.network, this.ceo.id);
    this.researchTeam = new ResearchTeam(this.network, this.ceo.id);
    this.riskTeam = new RiskTeam(this.network, this.ceo.id);
    this.evolutionTeam = new EvolutionTeam(this.network, this.ceo.id);
    this.opsTeam = new OpsTeam(this.network, this.ceo.id);

    // Register team names for live feed
    registerAgentName(this.tradingTeam.leadId, 'Trading Team');
    registerAgentName(this.researchTeam.leadId, 'Research Team');
    registerAgentName(this.riskTeam.leadId, 'Risk Team');
    registerAgentName(this.evolutionTeam.leadId, 'Evolution Team');
    registerAgentName(this.opsTeam.leadId, 'Ops Team');

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

    // 2. CEO assigns team prompts — defines each team's mission
    await this.assignTeamPrompts();

    // 3. Initialize evolution team (loads saved state)
    await this.evolutionTeam.initialize();

    // 4. Get strategies from research team
    const strategyList = this.researchTeam.getStrategies();
    for (const strategy of strategyList) {
      this.strategies.set(strategy.name, strategy);
    }

    // 5. Spawn initial trading agents (1 per strategy — no debate, direct signals)
    for (const strategy of strategyList) {
      const agentName = `${strategy.name}-prime`;
      const agent = new TradingAgent({
        strategy,
        network: this.network,
        name: agentName,
      });
      this.agents.set(agent.id, agent);
      this.tradingTeam.registerAgent(agent);
      registerAgentName(agent.id, agentName);
    }

    // 6. Create spawner for dynamic agent management
    this.spawner = new AgentSpawner(
      this.network, this.agents, this.strategies,
      {
        maxAgents: 30,
        minAgents: 1,
        probationThreshold: 30,
        retireThreshold: 15,
        spawnCooldownMs: 30_000,
        evaluationWindowSize: 20,
      },
    );

    // 7. CEO sets available asset universe — Trading Team decides what to actually trade
    this.ceo.setActiveAssets(allAssets);
    this.ceo.setActiveStrategies(strategyList.map(s => s.name));

    // 8. Event listeners
    eventBus.on('signal:generated', (event) => {
      log.debug({ signal: event.data }, 'Signal received');
    });
    eventBus.on('evolution:improvement', (event) => {
      log.info({ improvement: event.data }, 'Strategy evolved!');
    });

    // 9. Wire messaging — dispatches evolution/signal/alert events to Claude + OpenClaw
    wireMessagingEvents();

    // 10. Start autonomous loops for all teams — 24/7 independent lifecycle
    this.startAllLoops();

    log.info({
      mode: config.tradingMode,
      capital: config.initialCapital,
      assets: allAssets.length,
      agents: this.agents.size,
      teams: this.ceo.getAllTeams().length,
    }, 'CEO-driven trading system ready (all team loops started)');
  }

  /** Start autonomous loops for all teams */
  private startAllLoops(): void {
    this.tradingTeam.startLoop();
    this.researchTeam.startLoop();
    this.riskTeam.startLoop();
    this.evolutionTeam.startLoop();
    this.opsTeam.startLoop();
    printSystemEvent('All team loops started — agents running 24/7');
  }

  /** Stop all team loops */
  private stopAllLoops(): void {
    this.tradingTeam.stopLoop();
    this.researchTeam.stopLoop();
    this.riskTeam.stopLoop();
    this.evolutionTeam.stopLoop();
    this.opsTeam.stopLoop();
    printSystemEvent('All team loops stopped');
  }

  /** Print status of all agent loops */
  printAgentStatus(): void {
    const teams = [
      this.tradingTeam,
      this.researchTeam,
      this.riskTeam,
      this.evolutionTeam,
      this.opsTeam,
    ];
    printAgentStatusTable(teams.map(t => ({
      name: t.teamName,
      state: t.loop.getState(),
      ticks: t.loop.getTickCount(),
      processed: t.loop.getProcessedCount(),
      queueSize: t.loop.getQueueSize(),
      idleMs: t.loop.getIdleDuration(),
    })));
  }

  /**
   * CEO assigns mission prompts to each team.
   * This defines what each team should focus on.
   */
  private async assignTeamPrompts(): Promise<void> {
    await this.ceo.setTeamPrompt('trading',
      'Autonomously decide what to trade and when. Maximize risk-adjusted returns.',
      [
        'Select the best assets to trade based on research data and market conditions',
        'Review and optimize strategy after every trade',
        'Review own performance periodically and self-adjust',
        'Request data from Research Team as needed',
        'Report trading activity and P&L to CEO',
      ],
      [
        'Never exceed risk limits set by Risk Team',
        'Do not trade during kill switch activation',
        'Respect governance rules (max exposure, position limits)',
      ],
    );

    await this.ceo.setTeamPrompt('research',
      'Provide comprehensive market intelligence across all data sources.',
      [
        'Fetch and cache OHLCV data for all asset classes (crypto, forex)',
        'Monitor macro economic indicators (FRED, global central banks)',
        'Track geopolitical risks (conflicts, sanctions, trade wars, policy changes)',
        'Analyze sentiment from news and social media',
        'Detect market regime changes (bull, bear, range, crisis)',
        'Serve data requests from Trading and Evolution teams',
      ],
      [
        'Do not make trading decisions — only provide data and analysis',
        'Cache aggressively to avoid rate limits',
      ],
      { dataSources: ['FRED', 'CCXT', 'geopolitics', 'policy', 'globalMacro', 'calendar'] },
    );

    await this.ceo.setTeamPrompt('risk',
      'Protect capital. Enforce risk limits and governance rules.',
      [
        'Monitor portfolio exposure and concentration',
        'Enforce daily loss circuit breakers',
        'Manage kill switch for emergency stops',
        'Advise CEO on risk adjustments',
      ],
      [
        'Never disable kill switch without CEO approval',
        'Always err on the side of caution',
      ],
    );

    await this.ceo.setTeamPrompt('evolution',
      'Continuously improve strategy performance through genetic evolution.',
      [
        'Backtest all strategies against historical data',
        'Evolve strategy DNA using genetic algorithm (internal only, no API)',
        'Detect strategy decay and recommend retirement',
        'Guard against overfitting with walk-forward validation',
        'Report improvements to CEO',
      ],
      [
        'No external API calls during evolution — use cached/synthetic data only',
        'Preserve top performers unchanged (elitism)',
      ],
    );

    await this.ceo.setTeamPrompt('ops',
      'Monitor system health, manage data sources, run diagnostics.',
      [
        'Run periodic health diagnostics',
        'Monitor for anomalies (flash crashes, volume spikes)',
        'Track data source availability',
        'Alert CEO on critical system issues',
        'Detect stuck tasks and request helper agents',
      ],
      [],
    );

    log.info('CEO assigned team prompts to all 5 teams');
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
    printSeparator(`CYCLE ${cycle} — ${new Date().toLocaleTimeString()}`);
    printSystemEvent(`Starting cycle ${cycle} with ${this.agents.size} agents`);

    // 1. Research team fetches data for the full asset universe
    const macro = await this.researchTeam.getMacroEnvironment();
    const marketDataMap = await this.researchTeam.fetchAllData(assets, timeframe);

    // 2. Research team generates signals
    const allSignals = await this.researchTeam.analyzeAll(marketDataMap, macro);

    // 2b. Feed brain context to teams — they use this for autonomous thinking
    this.researchTeam.updateBrainContext(marketDataMap, allSignals, macro);
    this.tradingTeam.updateBrainContext(marketDataMap, allSignals, macro);

    // 2c. Research team thinks about what it found (AI-powered if available)
    await this.researchTeam.brain.thinkAsync('What do the current signals tell us about market conditions?', {
      marketData: marketDataMap, signals: allSignals, macro,
    });

    // 3. Trading Team autonomously selects which assets to trade
    printSystemEvent(`Research complete: ${marketDataMap.size} assets scanned, ${allSignals.length} signals found`);
    const selectedAssets = this.tradingTeam.selectAssetsToTrade(marketDataMap, allSignals);
    printSystemEvent(`Trading Team selected ${selectedAssets.length}/${assets.length} assets to trade`);
    log.info({ selected: selectedAssets.length, universe: assets.length }, 'Trading Team selected assets');

    // 4. Filter market data to only selected assets
    const tradingDataMap = new Map<string, MarketData>();
    for (const asset of selectedAssets) {
      const data = marketDataMap.get(asset.symbol);
      if (data) tradingDataMap.set(asset.symbol, data);
    }

    // 5. Update prices + check stops (on ALL assets we have positions in)
    const prices = new Map<string, number>();
    for (const [, data] of marketDataMap) {
      if (data.candles.length > 0) {
        prices.set(data.asset.symbol, data.candles[data.candles.length - 1].close);
      }
    }
    await this.tradingTeam.checkStops(prices);
    this.tradingTeam.updatePrices(prices);

    // 6. Trading team runs cycle on selected assets (agents analyze → risk → execute → review+optimize)
    printSeparator('SIGNAL ANALYSIS');
    const { signals: tradeSignals, executed, rejected, reviewResults } = await this.tradingTeam.runCycle(
      tradingDataMap, macro,
    );
    printSeparator('EXECUTION');

    // 4. Print post-trade review summary
    console.log(TradingTeam.formatReviewSummary(reviewResults));

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
      registerAgentName(agent.id, agent.name);
      printSystemEvent(`Spawned new agent: ${agent.name}`);
    }
    for (const agentId of retired) {
      const retiredAgent = this.agents.get(agentId);
      printSystemEvent(`Retired agent: ${retiredAgent?.name ?? agentId.slice(0, 8)}`);
    }

    // 7. Evolve underperformers every 5 cycles
    if (cycle % 5 === 0) {
      this.spawner.evolveUnderperformers();
    }

    // 8. Trading team self-review every 10 cycles
    if (cycle % 10 === 0) {
      const review = this.tradingTeam.reviewPerformance();
      console.log(`\n=== Trade Self-Review (Cycle ${cycle}) ===`);
      console.log(review.summary);
      if (review.adjustments.length > 0) {
        console.log('Adjustments:');
        review.adjustments.forEach(a => console.log(`  - ${a}`));
      }
    }

    // 9. Decay analysis every 15 cycles
    if (cycle % 15 === 0) {
      const decayResults = this.evolutionTeam.analyzeDecay();
      const decaying = decayResults.filter(d => d.isDecaying);
      if (decaying.length > 0) {
        log.warn({ decaying: decaying.length }, 'Strategy decay detected');
        console.log(DecayDetector.formatReport(decayResults));
      }
    }

    // 10. Print summary
    console.log(`\n=== Trading Cycle ${cycle} Summary ===`);
    console.log(`Assets scanned: ${marketDataMap.size} | Trading Team selected: ${selectedAssets.length}`);
    console.log(`Signals generated: ${tradeSignals.length}`);
    console.log(`Trades executed: ${executed}, risk-rejected: ${rejected}`);
    console.log(`Post-trade reviews: ${reviewResults.length} (${reviewResults.filter(r => r.optimizationApplied).length} optimized)`);
    console.log(`Active agents: ${[...this.agents.values()].filter(a => a.getStatus() === 'active').length}`);
    console.log(`Spawned: ${spawned.length}, Retired: ${retired.length}`);
    console.log(this.tradingTeam.getPortfolioSummary());

    // 11. CEO dashboard
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
    this.stopAllLoops();
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
  console.log(`Messaging: ${messageDispatcher.getTargets().map(t => t.channel).join(', ')}`);
  console.log('\nRun scripts:');
  console.log('  npm run paper-trade  — CEO-driven multi-team paper trading');
  console.log('  npm run backtest     — Backtest ALL assets');
  console.log('  npm run analyze      — Analyze ALL markets');
  console.log('  npm run evolve       — Evolve strategies (internal, no API)');
  console.log('  npm run diagnose     — Full diagnostic (CEO dashboard)');
  console.log('  npm run scan         — Scan for best opportunities');
  console.log('');
}

// Only run main() when this file is the entry point (not when imported by scripts)
const isDirectRun = process.argv[1]?.includes('index.ts') || process.argv[1]?.includes('index.js');
if (isDirectRun) {
  const watchdog = setTimeout(() => {
    console.error(`WATCHDOG: Process exceeded ${config.processWatchdogMs}ms — forcing exit`);
    process.exit(1);
  }, config.processWatchdogMs);
  watchdog.unref();

  main()
    .catch(console.error)
    .finally(() => clearTimeout(watchdog));
}
