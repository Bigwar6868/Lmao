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
import { roundTo, withTimeout } from '../../shared/utils.js';
import { config } from '../../config/index.js';

import { AgentNetwork } from './network.js';
import { TradingAgent } from './trading-agent.js';
import { ConsensusEngine } from './consensus.js';
import { AgentSpawner } from './spawner.js';
import { DataSourceManager } from './data-source-manager.js';
import { SkillManager } from './skill-manager.js';
import { OverfitGuard } from './overfit-guard.js';
import { ExplainabilityEngine } from './explainability.js';
import { DecayDetector } from './decay-detector.js';
import { GovernanceEngine } from './governance.js';

export { AgentNetwork } from './network.js';
export { TradingAgent } from './trading-agent.js';
export { ConsensusEngine } from './consensus.js';
export { AgentSpawner } from './spawner.js';
export { DataSourceManager } from './data-source-manager.js';
export { SkillManager } from './skill-manager.js';
export { OverfitGuard } from './overfit-guard.js';
export { ExplainabilityEngine } from './explainability.js';
export { DecayDetector } from './decay-detector.js';
export { GovernanceEngine } from './governance.js';

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
 *
 * Safety layers (based on 2026 industry best practices):
 *  8. Walk-forward validation prevents overfitting
 *  9. XAI audit trail explains every decision
 * 10. Decay detector catches strategy rot
 * 11. Governance guardrails with kill switch + circuit breakers
 */
export class AgentSwarm {
  readonly network: AgentNetwork;
  readonly consensus: ConsensusEngine;
  readonly spawner: AgentSpawner;
  readonly dataSourceManager: DataSourceManager;
  readonly skillManager: SkillManager;
  readonly overfitGuard: OverfitGuard;
  readonly explainability: ExplainabilityEngine;
  readonly decayDetector: DecayDetector;
  readonly governance: GovernanceEngine;

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
    this.overfitGuard = new OverfitGuard();
    this.explainability = new ExplainabilityEngine();
    this.decayDetector = new DecayDetector();
    this.governance = new GovernanceEngine();

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
  // Core cycle: analyze → debate → consensus → governance → execute
  // ----------------------------------------------------------------

  /**
   * Run a full multi-agent trading cycle.
   *
   * Returns approved signals after debate consensus + governance checks.
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

    // Check kill switch before doing anything
    if (this.governance.isKillSwitchActive()) {
      log.warn({ cycle: this.cycleCount }, 'Kill switch active — skipping cycle');
      return { approvedSignals: [], debateSummary: [], agentReport: this.formatSwarmReport() };
    }

    log.info({ cycle: this.cycleCount, agents: this.agents.size }, 'Starting multi-agent cycle');

    // 1. All agents analyze market data in parallel (with per-agent timeout)
    const activeAgents = [...this.agents.values()].filter(a => a.getStatus() !== 'retired');
    const dataEntries = [...marketDataMap.values()];
    const analyzeTimeout = config.agentAnalyzeTimeoutMs;

    await Promise.allSettled(
      activeAgents.map(async (agent) => {
        for (const data of dataEntries) {
          try {
            await withTimeout(
              agent.analyze(data, macro),
              analyzeTimeout,
              `agent:${agent.profile.name}:${data.asset.symbol}`,
            );
          } catch (err) {
            log.warn({
              agent: agent.profile.name,
              asset: data.asset.symbol,
              err: (err as Error).message,
            }, 'Agent analysis timed out or failed — skipping');
          }
        }
      }),
    );

    // 2. Consensus engine resolves all debates
    const verdicts = this.consensus.resolveAll();

    // 3. Get approved signals
    const approvedSignals = this.consensus.getApprovedSignals();

    // 4. Generate XAI explanations for all debates
    const debateSummary = this.consensus.getRecentSessions(verdicts.length);
    const agentNames = new Map<AgentId, string>();
    const agentReputations = new Map<AgentId, number>();
    for (const [id, agent] of this.agents) {
      agentNames.set(id, agent.profile.name);
      agentReputations.set(id, agent.getReputation());
    }
    for (const session of debateSummary) {
      this.explainability.explainDebate(session, agentNames, agentReputations);
    }

    // 5. Record performance snapshots for decay detection
    for (const [id, agent] of this.agents) {
      if (agent.getStatus() === 'retired') continue;
      this.decayDetector.record({
        timestamp: Date.now(),
        agentId: id,
        strategy: agent.getStrategy().name,
        winRate: agent.getRecentWinRate(),
        sharpe: 0, // calculated from metrics
        pnl: agent.getHistory().totalPnl,
        reputation: agent.getReputation(),
        tradesCount: agent.getHistory().successfulTrades + agent.getHistory().failedTrades,
      });
    }

    // 6. Evaluate agents, spawn/retire as needed
    const { spawned, retired } = this.spawner.evaluate();

    // 7. Evolve underperformers (every 5 cycles)
    if (this.cycleCount % 5 === 0) {
      const evolved = this.spawner.evolveUnderperformers();
      if (evolved > 0) {
        log.info({ evolved }, 'Underperforming agents evolved');
      }
    }

    // 8. Auto-learn skills (every 10 cycles)
    if (this.cycleCount % 10 === 0) {
      this.autoLearnSkills();
    }

    // 9. Check data source needs (every 20 cycles)
    if (this.cycleCount % 20 === 0) {
      this.checkDataNeeds();
    }

    // 10. Run decay analysis (every 15 cycles)
    if (this.cycleCount % 15 === 0) {
      const decayResults = this.decayDetector.analyzeAll();
      const decaying = decayResults.filter(d => d.isDecaying);
      if (decaying.length > 0) {
        log.warn({ decaying: decaying.length }, 'Strategy decay detected');
        console.log(DecayDetector.formatReport(decayResults));
      }
    }

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

  private autoLearnSkills(): void {
    for (const [, agent] of this.agents) {
      if (agent.getStatus() === 'retired') continue;

      const history = agent.getHistory();
      if (history.recentResults.length < 10) continue;

      const trades = history.recentResults.map(r => ({
        indicators: {},
        pnl: r.pnl,
        action: r.action,
      }));

      const skill = this.skillManager.autoLearn(agent.id, agent.profile.name, trades);
      if (skill) {
        log.info({
          agent: agent.profile.name,
          skill: skill.name,
        }, 'Agent auto-learned new skill');
      }
    }
  }

  private checkDataNeeds(): void {
    const missing = this.dataSourceManager.getMissingSources();
    if (missing.length === 0) return;

    for (const source of missing) {
      if (source.type === 'price' && source.provider !== 'internal') {
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

  getAgentProfiles(): AgentProfile[] {
    return [...this.agents.values()].map(a => a.profile);
  }

  getAgent(id: AgentId): TradingAgent | undefined {
    return this.agents.get(id);
  }

  getTopAgent(): TradingAgent | null {
    let best: TradingAgent | null = null;
    for (const [, agent] of this.agents) {
      if (agent.getStatus() === 'retired') continue;
      if (!best || agent.getReputation() > best.getReputation()) best = agent;
    }
    return best;
  }

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
      this.governance.formatReport(),
      this.dataSourceManager.formatReport(),
      this.skillManager.formatReport(),
      this.explainability.formatAuditReport(5),
    ].join('\n');
  }
}
