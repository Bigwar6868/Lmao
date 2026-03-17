// ============================================================
// TradingAgent — autonomous agent wrapping a strategy
// ============================================================

import type {
  Strategy,
  Signal,
  MarketData,
  MacroEnvironment,
  StrategyDNA,
  PerformanceMetrics,
} from '../../shared/types.js';
import type {
  AgentId,
  AgentProfile,
  AgentStatus,
  AgentPerformanceHistory,
  TradeOutcome,
} from '../../shared/agent-types.js';
import { generateId, roundTo } from '../../shared/utils.js';
import { createModuleLogger } from '../../shared/logger.js';
import type { AgentNetwork } from './network.js';

const log = createModuleLogger('trading-agent');

/**
 * A TradingAgent is an autonomous wrapper around a Strategy.
 * It can:
 *  - Analyze market data and generate signals
 *  - Track its own performance and reputation
 *  - Self-evolve its DNA when performance drops
 *
 * Post-trade review and optimization happen at the team level
 * after every executed trade.
 */
export class TradingAgent {
  readonly id: AgentId;
  readonly name: string;
  private strategy: Strategy;
  private network: AgentNetwork;
  private status: AgentStatus = 'active';
  private reputation = 65;  // start with moderate trust
  private parentId: AgentId | null;
  private generation: number;
  private createdAt = Date.now();

  /** Rolling performance history */
  private history: AgentPerformanceHistory = {
    totalSignals: 0,
    successfulTrades: 0,
    failedTrades: 0,
    totalPnl: 0,
    recentResults: [],
    winStreaks: 0,
    lossStreaks: 0,
    currentStreak: 0,
    peakReputation: 65,
    lastEvaluatedAt: Date.now(),
  };

  constructor(opts: {
    strategy: Strategy;
    network: AgentNetwork;
    parentId?: AgentId;
    generation?: number;
    reputation?: number;
    name?: string;
  }) {
    this.id = generateId();
    this.strategy = opts.strategy;
    this.network = opts.network;
    this.parentId = opts.parentId ?? null;
    this.generation = opts.generation ?? opts.strategy.dna.generation;
    this.name = opts.name ?? `${opts.strategy.name}-agent-${this.id.slice(0, 6)}`;

    if (opts.reputation !== undefined) this.reputation = opts.reputation;

    // Register on network for team communication
    this.network.register(this.id);

    log.info({ id: this.id, name: this.name, strategy: this.strategy.name }, 'Agent created');
  }

  // ----------------------------------------------------------------
  // Core: Analyze and Return Signals
  // ----------------------------------------------------------------

  /**
   * Analyze market data and return signals directly.
   * No debate — signals are evaluated by the team and sent to risk/executor.
   */
  async analyze(data: MarketData, macro?: MacroEnvironment): Promise<Signal[]> {
    if (this.status === 'retired') return [];

    const signals = await this.strategy.analyze(data, macro);

    const actionableSignals: Signal[] = [];
    for (const signal of signals) {
      if (signal.action === 'HOLD') continue;

      // Scale confidence by reputation
      const adjustedConfidence = signal.confidence * (this.reputation / 100);
      actionableSignals.push({ ...signal, confidence: adjustedConfidence });
      this.history.totalSignals++;

      log.info({
        agent: this.name,
        action: signal.action,
        asset: signal.asset.symbol,
        confidence: roundTo(adjustedConfidence, 2),
      }, 'Signal generated');
    }

    return actionableSignals;
  }

  // ----------------------------------------------------------------
  // Performance & Reputation
  // ----------------------------------------------------------------

  /**
   * Record the outcome of a trade this agent's signal led to.
   * Updates reputation based on result.
   */
  recordOutcome(outcome: TradeOutcome): void {
    this.history.recentResults.push(outcome);
    if (this.history.recentResults.length > 50) {
      this.history.recentResults.shift();
    }

    if (outcome.pnl > 0) {
      this.history.successfulTrades++;
      this.history.currentStreak = Math.max(1, this.history.currentStreak + 1);
      this.history.winStreaks = Math.max(this.history.winStreaks, this.history.currentStreak);
      // Reputation boost: proportional to PnL %
      this.reputation = Math.min(100, this.reputation + Math.min(5, outcome.pnlPct * 0.5));
    } else {
      this.history.failedTrades++;
      this.history.currentStreak = Math.min(-1, this.history.currentStreak - 1);
      this.history.lossStreaks = Math.max(this.history.lossStreaks, Math.abs(this.history.currentStreak));
      // Reputation penalty
      this.reputation = Math.max(0, this.reputation - Math.min(8, Math.abs(outcome.pnlPct) * 0.8));
    }

    this.history.totalPnl += outcome.pnl;
    this.peakReputation = Math.max(this.reputation, this.history.peakReputation);
    this.history.lastEvaluatedAt = Date.now();

    log.info({
      agent: this.name,
      pnl: roundTo(outcome.pnl, 2),
      reputation: roundTo(this.reputation, 1),
      streak: this.history.currentStreak,
    }, 'Trade outcome recorded');
  }

  /**
   * Get the agent's current win rate from recent results.
   */
  getRecentWinRate(window = 20): number {
    const recent = this.history.recentResults.slice(-window);
    if (recent.length === 0) return 0.5; // assume neutral
    return recent.filter(r => r.pnl > 0).length / recent.length;
  }

  /**
   * Should this agent be put on probation or retired?
   */
  evaluateStatus(probationThreshold: number, retireThreshold: number): AgentStatus {
    if (this.status === 'retired') return 'retired';

    if (this.reputation < retireThreshold && this.history.recentResults.length >= 10) {
      this.status = 'retired';
      this.network.unregister(this.id);
      log.warn({ agent: this.name, reputation: this.reputation }, 'Agent retired due to poor performance');
    } else if (this.reputation < probationThreshold) {
      this.status = 'probation';
      log.info({ agent: this.name, reputation: this.reputation }, 'Agent placed on probation');
    } else if (this.status === 'probation' && this.reputation >= probationThreshold + 10) {
      this.status = 'active';
      log.info({ agent: this.name, reputation: this.reputation }, 'Agent recovered from probation');
    }

    return this.status;
  }

  // ----------------------------------------------------------------
  // Getters
  // ----------------------------------------------------------------

  get profile(): AgentProfile {
    return {
      id: this.id,
      name: this.name,
      strategy: this.strategy.name,
      dna: this.strategy.dna,
      status: this.status,
      reputation: this.reputation,
      createdAt: this.createdAt,
      parentId: this.parentId,
      generation: this.generation,
      metrics: { ...this.history },
    };
  }

  getReputation(): number { return this.reputation; }
  getStatus(): AgentStatus { return this.status; }
  getStrategy(): Strategy { return this.strategy; }
  getDNA(): StrategyDNA { return this.strategy.dna; }
  getHistory(): AgentPerformanceHistory { return { ...this.history }; }

  /** Update the strategy's DNA (after evolution) */
  updateDNA(dna: StrategyDNA): void {
    this.strategy.dna = dna;
    this.generation = dna.generation;
    log.info({ agent: this.name, generation: dna.generation }, 'DNA updated');
  }

  // ----------------------------------------------------------------
  // Internal Helpers
  // ----------------------------------------------------------------

  private set peakReputation(value: number) {
    this.history.peakReputation = value;
  }
}
