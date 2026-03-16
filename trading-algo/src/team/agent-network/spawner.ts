// ============================================================
// AgentSpawner — spawns, retires, and evolves agents
// ============================================================

import type { Strategy, StrategyDNA } from '../../shared/types.js';
import type { AgentId, AgentSwarmConfig } from '../../shared/agent-types.js';
import { generateId } from '../../shared/utils.js';
import { createModuleLogger } from '../../shared/logger.js';
import { StrategyEvolver } from '../self-improver/evolver.js';
import { TradingAgent } from './trading-agent.js';
import type { AgentNetwork } from './network.js';

const log = createModuleLogger('agent-spawner');

/**
 * Manages the lifecycle of trading agents:
 *  - Spawns new agents from top performers (clone + mutate)
 *  - Puts underperformers on probation
 *  - Retires consistently bad agents
 *  - Evolves agent DNA when performance drops
 */
export class AgentSpawner {
  private network: AgentNetwork;
  private agents: Map<AgentId, TradingAgent>;
  private strategies: Map<string, Strategy>;
  private evolver = new StrategyEvolver();
  private config: AgentSwarmConfig;
  private lastSpawnTime = 0;

  constructor(
    network: AgentNetwork,
    agents: Map<AgentId, TradingAgent>,
    strategies: Map<string, Strategy>,
    config: AgentSwarmConfig,
  ) {
    this.network = network;
    this.agents = agents;
    this.strategies = strategies;
    this.config = config;
  }

  /**
   * Evaluate all agents and spawn/retire as needed.
   * Called each trading cycle.
   */
  evaluate(): { spawned: TradingAgent[]; retired: AgentId[] } {
    const spawned: TradingAgent[] = [];
    const retired: AgentId[] = [];

    // 1. Evaluate each agent's status
    for (const [id, agent] of this.agents) {
      const status = agent.evaluateStatus(
        this.config.probationThreshold,
        this.config.retireThreshold,
      );

      if (status === 'retired') {
        retired.push(id);
      }
    }

    // 2. Remove retired agents
    for (const id of retired) {
      this.agents.delete(id);
      log.info({ agentId: id.slice(0, 8) }, 'Agent retired and removed');
    }

    // 3. Check if we need to spawn replacements
    const activeByStrategy = this.getActiveCountByStrategy();

    for (const [strategyName, strategy] of this.strategies) {
      const activeCount = activeByStrategy.get(strategyName) ?? 0;

      // Always maintain minimum agents per strategy
      if (activeCount < this.config.minAgents) {
        const needed = this.config.minAgents - activeCount;
        for (let i = 0; i < needed; i++) {
          const newAgent = this.spawnFromBest(strategyName, strategy, 'Below minimum agents');
          if (newAgent) spawned.push(newAgent);
        }
      }
    }

    // 4. Spawn from top performers if under max and cooldown passed
    if (this.agents.size < this.config.maxAgents && this.canSpawn()) {
      const topAgent = this.getTopPerformer();
      if (topAgent && topAgent.getReputation() > 70) {
        const strategy = this.strategies.get(topAgent.getStrategy().name);
        if (strategy) {
          const child = this.spawnChild(topAgent, strategy, 'Cloning top performer');
          if (child) spawned.push(child);
        }
      }
    }

    if (spawned.length > 0 || retired.length > 0) {
      log.info({
        spawned: spawned.length,
        retired: retired.length,
        totalAgents: this.agents.size,
      }, 'Agent population updated');
    }

    return { spawned, retired };
  }

  /**
   * Force-evolve underperforming agents.
   * Mutates their DNA to try new parameter combinations.
   */
  evolveUnderperformers(): number {
    let evolved = 0;

    for (const [, agent] of this.agents) {
      if (agent.getStatus() !== 'probation') continue;

      const currentDna = agent.getDNA();
      const mutatedDna = this.evolver.mutate(currentDna);
      mutatedDna.generation = currentDna.generation + 1;

      agent.updateDNA(mutatedDna);
      evolved++;

      log.info({
        agent: agent.profile.name,
        generation: mutatedDna.generation,
        mutations: mutatedDna.mutations.slice(-3),
      }, 'Agent DNA evolved (underperformer)');
    }

    return evolved;
  }

  // ----------------------------------------------------------------
  // Spawn helpers
  // ----------------------------------------------------------------

  private spawnFromBest(strategyName: string, strategy: Strategy, reason: string): TradingAgent | null {
    // Find best existing agent for this strategy, or use default DNA
    const existing = [...this.agents.values()]
      .filter(a => a.getStrategy().name === strategyName)
      .sort((a, b) => b.getReputation() - a.getReputation());

    const baseDna = existing.length > 0
      ? this.evolver.mutate(existing[0].getDNA())
      : strategy.getDefaultDNA();

    return this.createAgent(strategy, baseDna, existing[0]?.id ?? null, reason);
  }

  private spawnChild(parent: TradingAgent, strategy: Strategy, reason: string): TradingAgent | null {
    const childDna = this.evolver.mutate(parent.getDNA());
    childDna.generation = parent.getDNA().generation + 1;
    return this.createAgent(strategy, childDna, parent.id, reason);
  }

  private createAgent(
    strategy: Strategy,
    dna: StrategyDNA,
    parentId: AgentId | null,
    reason: string,
  ): TradingAgent | null {
    if (this.agents.size >= this.config.maxAgents) return null;

    // Use the strategy directly — update DNA on the agent after creation
    const agent = new TradingAgent({
      strategy,
      network: this.network,
      parentId: parentId ?? undefined,
      generation: dna.generation,
    });

    agent.updateDNA(dna);
    this.agents.set(agent.id, agent);
    this.lastSpawnTime = Date.now();

    // Broadcast spawn event
    void this.network.broadcast(agent.id, 'spawn', {
      type: 'spawn',
      parentId: parentId ?? 'none',
      reason,
      dna,
    });

    log.info({
      newAgent: agent.profile.name,
      parentId: parentId?.slice(0, 8) ?? 'none',
      strategy: strategy.name,
      generation: dna.generation,
      reason,
    }, 'New agent spawned');

    return agent;
  }

  // ----------------------------------------------------------------
  // Queries
  // ----------------------------------------------------------------

  private getActiveCountByStrategy(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const [, agent] of this.agents) {
      if (agent.getStatus() === 'retired') continue;
      const name = agent.getStrategy().name;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return counts;
  }

  private getTopPerformer(): TradingAgent | null {
    let best: TradingAgent | null = null;
    for (const [, agent] of this.agents) {
      if (agent.getStatus() !== 'active') continue;
      if (!best || agent.getReputation() > best.getReputation()) {
        best = agent;
      }
    }
    return best;
  }

  private canSpawn(): boolean {
    return Date.now() - this.lastSpawnTime > this.config.spawnCooldownMs;
  }
}
