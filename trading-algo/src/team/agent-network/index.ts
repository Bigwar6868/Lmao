// ============================================================
// AgentSwarm — the multi-agent trading system
// ============================================================

import type {
  Strategy,
  MarketData,
  MacroEnvironment,
  Signal,
} from '../../shared/types.js';
import type {
  AgentId,
  AgentSwarmConfig,
  AgentProfile,
  TradeProposal,
  DebateSession,
} from '../../shared/agent-types.js';
import { createModuleLogger } from '../../shared/logger.js';
import { roundTo } from '../../shared/utils.js';

import { AgentNetwork } from './network.js';
import { TradingAgent } from './trading-agent.js';
import { ConsensusEngine } from './consensus.js';
import { AgentSpawner } from './spawner.js';
import { DataSourceManager } from './data-source-manager.js';
import { SkillManager } from './skill-manager.js';

export { AgentNetwork } from './network.js';
export { TradingAgent } from './trading-agent.js';
export { ConsensusEngine } from './consensus.js';
export { AgentSpawner } from './spawner.js';
export { DataSourceManager } from './data-source-manager.js';
export { SkillManager } from './skill-manager.js';

const log = createModuleLogger('agent-swarm');

const DEFAULT_CONFIG: AgentSwarmConfig = {
  maxAgents: 20,
  minAgents: 1,
  probationThreshold: 30,
  retireThreshold: 15,
  spawnCooldownMs: 60_000,   // 1 minute between spawns
  evaluationWindowSize: 20,
  doubtThreshold: 0.2,
  consensusQuorum: 0.5,
};

/**
 * AgentSwarm — orchestrates the multi-agent trading system.
 *
 * Each strategy spawns autonomous agents that:
 *  1. Independently analyze markets and propose trades
 *  2. Debate each other's proposals (doubt, support, counter)
 *  3. Reach consensus through reputation-weighted voting
 *  4. Self-evolve DNA when performance drops
 *  5. Spawn children from top performers
 *  6. Learn new skills from observed patterns
 *  7. Request new data sources when needed
 */
export class AgentSwarm {
  readonly network: AgentNetwork;
  readonly consensus: ConsensusEngine;
  readonly spawner: AgentSpawner;
  readonly dataSourceManager: DataSourceManager;
  readonly skillManager: SkillManager;

  private agents = new Map<AgentId, TradingAgent>();
  private strategies = new Map<string, Strategy>();
  private config: AgentSwarmConfig;
  private cycleCount = 0;

  constructor(config?: Partial<AgentSwarmConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.network = new AgentNetwork();
    this.consensus = new ConsensusEngine(this.network, this.agents);
    this.dataSourceManager = new DataSourceManager();
    this.skillManager = new SkillManager();

    // Spawner is initialized after strategies are registered
    this.spawner = new AgentSpawner(
      this.network, this.agents, this.strategies, this.config,
    );

    log.info({ config: this.config }, 'AgentSwarm initialized');
  }

  // ----------------------------------------------------------------
  // Setup
  // ----------------------------------------------------------------

  /**
   * Register strategies and spawn initial agents.
   * Each strategy gets at least `minAgents` agents.
   */
  registerStrategies(strategies: Strategy[]): void {
    for (const strategy of strategies) {
      this.strategies.set(strategy.name, strategy);

      // Spawn initial agents — use the strategy directly (class instance)
      for (let i = 0; i < this.config.minAgents; i++) {
        const agent = new TradingAgent({
          strategy,
          network: this.network,
          name: `${strategy.name}-prime${i > 0 ? `-${i}` : ''}`,
        });
        this.agents.set(agent.id, agent);
      }
    }

    log.info({
      strategies: strategies.length,
      agents: this.agents.size,
    }, 'Strategies registered, initial agents spawned');
  }

  // ----------------------------------------------------------------
  // Core cycle: analyze → debate → consensus → execute
  // ----------------------------------------------------------------

  /**
   * Run a full multi-agent trading cycle.
   *
   * Returns approved signals after debate consensus.
   */
  async runCycle(
    marketDataMap: Map<string, MarketData>,
    macro?: MacroEnvironment,
  ): Promise<{
    approvedSignals: Array<{ signal: Signal; confidence: number; proposerId: AgentId }>;
    debateSummary: DebateSession[];
    agentReport: string;
  }> {
    this.cycleCount++;
    log.info({ cycle: this.cycleCount, agents: this.agents.size }, 'Starting multi-agent cycle');

    // 1. All agents analyze market data independently
    for (const [, agent] of this.agents) {
      if (agent.getStatus() === 'retired') continue;

      for (const [, data] of marketDataMap) {
        await agent.analyze(data, macro);
      }
    }

    // 2. Wait for debate messages to settle (agents auto-respond to proposals)
    // The network delivers messages synchronously, so they've already been processed

    // 3. Consensus engine resolves all debates
    const verdicts = this.consensus.resolveAll();

    // 4. Get approved signals
    const approvedSignals = this.consensus.getApprovedSignals();

    // 5. Evaluate agents, spawn/retire as needed
    const { spawned, retired } = this.spawner.evaluate();

    // 6. Evolve underperformers
    if (this.cycleCount % 5 === 0) {  // every 5 cycles
      const evolved = this.spawner.evolveUnderperformers();
      if (evolved > 0) {
        log.info({ evolved }, 'Underperforming agents evolved');
      }
    }

    // 7. Auto-learn skills from recent trades (every 10 cycles)
    if (this.cycleCount % 10 === 0) {
      this.autoLearnSkills();
    }

    // 8. Check data source needs (every 20 cycles)
    if (this.cycleCount % 20 === 0) {
      this.checkDataNeeds();
    }

    const debateSummary = this.consensus.getRecentSessions(verdicts.length);

    log.info({
      cycle: this.cycleCount,
      proposals: verdicts.length,
      approved: approvedSignals.length,
      rejected: verdicts.length - approvedSignals.length,
      spawned: spawned.length,
      retired: retired.length,
    }, 'Multi-agent cycle complete');

    return {
      approvedSignals,
      debateSummary,
      agentReport: this.formatSwarmReport(),
    };
  }

  // ----------------------------------------------------------------
  // Self-learning
  // ----------------------------------------------------------------

  /**
   * Each agent tries to learn new skills from its trade history.
   */
  private autoLearnSkills(): void {
    for (const [, agent] of this.agents) {
      if (agent.getStatus() === 'retired') continue;

      const history = agent.getHistory();
      if (history.recentResults.length < 10) continue;

      // Convert to format for auto-learn
      const trades = history.recentResults.map(r => ({
        indicators: {}, // would come from signal data in production
        pnl: r.pnl,
        action: r.action,
      }));

      // Try to learn a pattern
      const skill = this.skillManager.autoLearn(agent.id, agent.profile.name, trades);
      if (skill) {
        log.info({
          agent: agent.profile.name,
          skill: skill.name,
        }, 'Agent auto-learned new skill');
      }
    }
  }

  /**
   * Check if agents need data sources they don't have.
   */
  private checkDataNeeds(): void {
    const missing = this.dataSourceManager.getMissingSources();
    if (missing.length === 0) return;

    // Agents can request missing sources
    for (const source of missing) {
      if (source.type === 'price' && source.provider !== 'internal') {
        // Find the agent with the highest reputation to make the request
        const topAgent = this.getTopAgent();
        if (topAgent) {
          void this.dataSourceManager.requestDataSource(
            topAgent.id,
            topAgent.profile.name,
            source.type,
            `Need ${source.name} for live market data`,
            `${source.name} API key not configured (${source.apiKeyEnv})`,
            [source.provider],
          );
        }
      }
    }
  }

  // ----------------------------------------------------------------
  // Queries
  // ----------------------------------------------------------------

  /** Get all agent profiles */
  getAgentProfiles(): AgentProfile[] {
    return [...this.agents.values()].map(a => a.profile);
  }

  /** Get agent by ID */
  getAgent(id: AgentId): TradingAgent | undefined {
    return this.agents.get(id);
  }

  /** Get the top-performing agent */
  getTopAgent(): TradingAgent | null {
    let best: TradingAgent | null = null;
    for (const [, agent] of this.agents) {
      if (agent.getStatus() === 'retired') continue;
      if (!best || agent.getReputation() > best.getReputation()) best = agent;
    }
    return best;
  }

  /** Record trade outcome for the proposing agent */
  recordTradeOutcome(proposerId: AgentId, outcome: Parameters<TradingAgent['recordOutcome']>[0]): void {
    const agent = this.agents.get(proposerId);
    if (agent) agent.recordOutcome(outcome);
  }

  // ----------------------------------------------------------------
  // Reports
  // ----------------------------------------------------------------

  formatSwarmReport(): string {
    const profiles = this.getAgentProfiles();
    const active = profiles.filter(p => p.status === 'active');
    const probation = profiles.filter(p => p.status === 'probation');
    const retired = profiles.filter(p => p.status === 'retired');

    const lines: string[] = ['\n=== AGENT SWARM STATUS ===\n'];
    lines.push(`Cycle: ${this.cycleCount} | Agents: ${profiles.length} (${active.length} active, ${probation.length} probation, ${retired.length} retired)\n`);

    lines.push('Agent                          | Strategy       | Rep  | Status     | W/L      | Streak | PnL');
    lines.push('-------------------------------|----------------|------|------------|----------|--------|--------');

    const sorted = [...profiles]
      .filter(p => p.status !== 'retired')
      .sort((a, b) => b.reputation - a.reputation);

    for (const p of sorted) {
      const wins = p.metrics.successfulTrades;
      const losses = p.metrics.failedTrades;
      const streak = p.metrics.currentStreak;
      const streakStr = streak > 0 ? `+${streak}W` : streak < 0 ? `${streak}L` : '0';

      lines.push(
        `${p.name.slice(0, 30).padEnd(30)} | ` +
        `${p.strategy.padEnd(14)} | ` +
        `${roundTo(p.reputation, 0).toString().padStart(4)} | ` +
        `${p.status.padEnd(10)} | ` +
        `${wins}/${losses}`.padEnd(8) + ` | ` +
        `${streakStr.padStart(6)} | ` +
        `$${roundTo(p.metrics.totalPnl, 2)}`,
      );
    }

    return lines.join('\n');
  }

  formatFullReport(): string {
    return [
      this.formatSwarmReport(),
      this.dataSourceManager.formatReport(),
      this.skillManager.formatReport(),
    ].join('\n');
  }
}
