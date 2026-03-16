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
  AgentMessage,
  AgentPerformanceHistory,
  TradeProposal,
  TradeDoubt,
  TradeSupport,
  TradeOutcome,
} from '../../shared/agent-types.js';
import { generateId, roundTo } from '../../shared/utils.js';
import { createModuleLogger } from '../../shared/logger.js';
import type { AgentNetwork } from './network.js';

const log = createModuleLogger('trading-agent');

/**
 * A TradingAgent is an autonomous wrapper around a Strategy.
 * It can:
 *  - Propose trades by analyzing market data
 *  - Doubt other agents' proposals when its own analysis disagrees
 *  - Support proposals that align with its view
 *  - Track its own performance and reputation
 *  - Self-evolve its DNA when performance drops
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
    totalProposals: 0,
    approvedProposals: 0,
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

  /** Track pending proposals */
  private pendingProposals = new Map<string, Signal>();

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

    // Register on network
    this.network.register(this.id);

    // Listen for messages directed at us
    this.network.on(this.id, 'doubt', (msg) => this.handleDoubt(msg));
    this.network.on(this.id, 'support', (msg) => this.handleSupport(msg));
    this.network.on(this.id, 'verdict', (msg) => this.handleVerdict(msg));

    // Listen for all proposals (to decide whether to doubt/support)
    this.network.on(this.id, 'proposal', (msg) => this.evaluateProposal(msg));

    log.info({ id: this.id, name: this.name, strategy: this.strategy.name }, 'Agent created');
  }

  // ----------------------------------------------------------------
  // Core: Analyze and Propose
  // ----------------------------------------------------------------

  /**
   * Analyze market data and propose trades if signals are found.
   * This is the agent's main action each cycle.
   */
  async analyze(data: MarketData, macro?: MacroEnvironment): Promise<Signal[]> {
    if (this.status === 'retired') return [];

    const signals = await this.strategy.analyze(data, macro);

    // Only propose if agent has actionable signals
    for (const signal of signals) {
      if (signal.action === 'HOLD') continue;

      // Scale confidence by reputation
      const adjustedConfidence = signal.confidence * (this.reputation / 100);

      const proposal: TradeProposal = {
        type: 'proposal',
        signal: { ...signal, confidence: adjustedConfidence },
        conviction: this.calculateConviction(signal),
        reasoning: this.buildReasoning(signal),
        indicators: signal.indicators,
      };

      const msg = await this.network.broadcast(this.id, 'proposal', proposal);
      this.pendingProposals.set(msg.id, signal);
      this.history.totalProposals++;

      log.info({
        agent: this.name,
        action: signal.action,
        asset: signal.asset.symbol,
        confidence: roundTo(adjustedConfidence, 2),
        conviction: roundTo(proposal.conviction, 2),
      }, 'Trade proposed');
    }

    return signals;
  }

  // ----------------------------------------------------------------
  // Debate: Evaluate Others' Proposals
  // ----------------------------------------------------------------

  /**
   * When another agent proposes a trade, this agent evaluates it.
   * If its own analysis disagrees, it raises a doubt.
   * If it agrees, it sends support.
   */
  private async evaluateProposal(msg: AgentMessage): Promise<void> {
    if (this.status === 'retired') return;
    const proposal = msg.payload as TradeProposal;
    const theirSignal = proposal.signal;

    // Check if our strategy even covers this asset
    if (!this.strategy.config.assetClasses.includes(theirSignal.asset.assetClass)) return;
    if (!this.strategy.config.timeframes.includes(theirSignal.timeframe)) return;

    // Compare with our own conviction on this asset
    // We don't re-analyze (too expensive), but we check our indicators
    const ourView = this.getOurView(theirSignal);

    if (ourView === null) return; // no opinion

    // DOUBT: our view disagrees with the proposal
    if (ourView.disagrees) {
      const doubt: TradeDoubt = {
        type: 'doubt',
        proposalId: msg.id,
        reason: ourView.reason,
        counterEvidence: ourView.counterIndicators,
        severity: this.reputation > 70 ? 'strong' : 'mild',
      };

      await this.network.unicast(this.id, msg.from, 'doubt', doubt, msg.id);

      log.info({
        doubter: this.name,
        proposer: msg.from.slice(0, 8),
        asset: theirSignal.asset.symbol,
        reason: ourView.reason,
      }, 'Doubt raised');
    }
    // SUPPORT: our view agrees
    else if (ourView.agrees) {
      const support: TradeSupport = {
        type: 'support',
        proposalId: msg.id,
        reason: ourView.reason,
        additionalConfidence: (this.reputation / 100) * 0.15,
      };

      await this.network.unicast(this.id, msg.from, 'support', support, msg.id);
    }
  }

  /**
   * Quick heuristic: does our strategy disagree with this signal?
   * Uses recent indicator memory instead of full re-analysis.
   */
  private getOurView(theirSignal: Signal): {
    disagrees: boolean;
    agrees: boolean;
    reason: string;
    counterIndicators: Record<string, number>;
  } | null {
    // Use the proposal's own indicators to check for contradictions
    const ind = theirSignal.indicators;

    // RSI-based doubt
    if (ind.rsi !== undefined) {
      if (theirSignal.action === 'BUY' && ind.rsi > 75) {
        return {
          disagrees: true, agrees: false,
          reason: `RSI at ${roundTo(ind.rsi, 1)} — overbought, risky to buy`,
          counterIndicators: { rsi: ind.rsi },
        };
      }
      if (theirSignal.action === 'SELL' && ind.rsi < 25) {
        return {
          disagrees: true, agrees: false,
          reason: `RSI at ${roundTo(ind.rsi, 1)} — oversold, risky to sell`,
          counterIndicators: { rsi: ind.rsi },
        };
      }
    }

    // EMA alignment doubt
    if (ind.fastEma !== undefined && ind.slowEma !== undefined) {
      const emaAligned = theirSignal.action === 'BUY'
        ? ind.fastEma > ind.slowEma
        : ind.fastEma < ind.slowEma;

      if (!emaAligned) {
        return {
          disagrees: true, agrees: false,
          reason: `EMA trend opposes ${theirSignal.action} — fast EMA ${theirSignal.action === 'BUY' ? 'below' : 'above'} slow EMA`,
          counterIndicators: { fastEma: ind.fastEma, slowEma: ind.slowEma },
        };
      }
    }

    // Confidence too low
    if (theirSignal.confidence < 0.4) {
      return {
        disagrees: true, agrees: false,
        reason: `Low confidence (${roundTo(theirSignal.confidence * 100, 0)}%) — not convincing`,
        counterIndicators: {},
      };
    }

    // Support if confidence is strong
    if (theirSignal.confidence > 0.65) {
      return {
        disagrees: false, agrees: true,
        reason: `Strong signal confidence (${roundTo(theirSignal.confidence * 100, 0)}%), indicators align`,
        counterIndicators: {},
      };
    }

    return null; // no opinion
  }

  // ----------------------------------------------------------------
  // Handle Responses
  // ----------------------------------------------------------------

  private handleDoubt(msg: AgentMessage): void {
    const doubt = msg.payload as TradeDoubt;
    log.debug({
      agent: this.name,
      doubter: msg.from.slice(0, 8),
      severity: doubt.severity,
      reason: doubt.reason,
    }, 'Received doubt');
  }

  private handleSupport(msg: AgentMessage): void {
    const support = msg.payload as TradeSupport;
    log.debug({
      agent: this.name,
      supporter: msg.from.slice(0, 8),
      extraConfidence: support.additionalConfidence,
    }, 'Received support');
  }

  private handleVerdict(msg: AgentMessage): void {
    // Verdict handled by consensus engine
  }

  // ----------------------------------------------------------------
  // Performance & Reputation
  // ----------------------------------------------------------------

  /**
   * Record the outcome of a trade this agent proposed.
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

    // Bonus/penalty for doubted trades
    if (outcome.wasDoubted) {
      if (outcome.doubtWasCorrect) {
        // The doubter was right — penalize proposer extra
        this.reputation = Math.max(0, this.reputation - 3);
      } else {
        // The doubter was wrong — reward proposer for standing firm
        this.reputation = Math.min(100, this.reputation + 2);
      }
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

  private calculateConviction(signal: Signal): number {
    // Conviction = base confidence × reputation factor × streak bonus
    let conviction = signal.confidence;
    conviction *= (this.reputation / 100);
    if (this.history.currentStreak > 3) conviction *= 1.1;
    if (this.history.currentStreak < -3) conviction *= 0.8;
    return Math.min(1, Math.max(0, conviction));
  }

  private buildReasoning(signal: Signal): string {
    const parts = [signal.reason];
    if (this.history.currentStreak > 3) parts.push(`(${this.history.currentStreak}-win streak)`);
    if (this.reputation > 75) parts.push('(high reputation)');
    if (this.reputation < 30) parts.push('(low confidence — on probation)');
    return parts.join(' ');
  }

  private set peakReputation(value: number) {
    this.history.peakReputation = value;
  }
}
