// ============================================================
// Multi-Agent System Types
// ============================================================

import type { Signal, AssetInfo, StrategyDNA, PerformanceMetrics, MarketData, MacroEnvironment } from './types.js';

/** Unique agent identifier */
export type AgentId = string;

/** Agent lifecycle status */
export type AgentStatus = 'active' | 'probation' | 'retired' | 'spawning';

/** Message types for inter-agent communication */
export type MessageType =
  | 'proposal'       // Agent proposes a trade
  | 'doubt'          // Agent challenges another's proposal
  | 'support'        // Agent supports another's proposal
  | 'counter'        // Agent proposes alternative to another's proposal
  | 'verdict'        // Consensus engine final decision
  | 'performance'    // Agent broadcasts its own metrics
  | 'alert'          // Agent raises a concern (regime shift, risk, etc.)
  | 'spawn'          // System spawns a new agent
  | 'retire';        // System retires an agent

/** A message exchanged between agents */
export interface AgentMessage {
  id: string;
  type: MessageType;
  from: AgentId;
  to: AgentId | 'all';        // broadcast if 'all'
  timestamp: number;
  payload: AgentMessagePayload;
  replyTo?: string;            // id of the message being replied to
}

/** Typed payload variants */
export type AgentMessagePayload =
  | TradeProposal
  | TradeDoubt
  | TradeSupport
  | TradeCounter
  | DebateVerdict
  | PerformanceBroadcast
  | AlertPayload
  | SpawnPayload
  | RetirePayload;

/** An agent proposes a trade */
export interface TradeProposal {
  type: 'proposal';
  signal: Signal;
  conviction: number;          // 0-1, how strongly the agent believes
  reasoning: string;
  indicators: Record<string, number>;
}

/** An agent doubts another's trade */
export interface TradeDoubt {
  type: 'doubt';
  proposalId: string;
  reason: string;
  counterEvidence: Record<string, number>;  // indicators that disagree
  severity: 'mild' | 'strong' | 'veto';    // how strongly it disagrees
}

/** An agent supports a proposal */
export interface TradeSupport {
  type: 'support';
  proposalId: string;
  reason: string;
  additionalConfidence: number;  // how much extra confidence to add
}

/** An agent proposes a counter-trade */
export interface TradeCounter {
  type: 'counter';
  proposalId: string;
  alternativeSignal: Signal;
  reason: string;
}

/** Final verdict from consensus engine */
export interface DebateVerdict {
  type: 'verdict';
  proposalId: string;
  approved: boolean;
  finalConfidence: number;
  supporters: AgentId[];
  doubters: AgentId[];
  reason: string;
}

/** Agent performance broadcast */
export interface PerformanceBroadcast {
  type: 'performance';
  metrics: PerformanceMetrics;
  recentWinRate: number;      // last N trades
  recentSharpe: number;
  reputation: number;
  generation: number;
}

/** Alert raised by an agent */
export interface AlertPayload {
  type: 'alert';
  severity: 'info' | 'warning' | 'critical';
  message: string;
  data: Record<string, unknown>;
}

/** System spawns a new agent */
export interface SpawnPayload {
  type: 'spawn';
  parentId: AgentId;
  reason: string;
  dna: StrategyDNA;
}

/** System retires an agent */
export interface RetirePayload {
  type: 'retire';
  reason: string;
  finalMetrics: PerformanceMetrics | null;
}

// ============================================================
// Agent Profile
// ============================================================

/** Complete agent profile with identity, performance, and reputation */
export interface AgentProfile {
  id: AgentId;
  name: string;                     // human-readable name
  strategy: string;                 // which strategy this agent runs
  dna: StrategyDNA;
  status: AgentStatus;
  reputation: number;               // 0-100, earned through correct predictions
  createdAt: number;
  parentId: AgentId | null;         // who spawned this agent
  generation: number;               // evolution generation
  metrics: AgentPerformanceHistory;
}

/** Rolling performance history for an agent */
export interface AgentPerformanceHistory {
  totalProposals: number;
  approvedProposals: number;
  successfulTrades: number;         // proposals that led to profitable trades
  failedTrades: number;
  totalPnl: number;
  recentResults: TradeOutcome[];    // last N trade outcomes
  winStreaks: number;
  lossStreaks: number;
  currentStreak: number;            // positive = winning, negative = losing
  peakReputation: number;
  lastEvaluatedAt: number;
}

/** Outcome of a single trade for tracking */
export interface TradeOutcome {
  proposalId: string;
  asset: string;
  action: 'BUY' | 'SELL';
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  pnlPct: number;
  timestamp: number;
  wasDoubted: boolean;              // was this trade challenged?
  doubtWasCorrect: boolean;         // if doubted, was the doubt valid?
}

// ============================================================
// Debate Session
// ============================================================

/** A complete debate session around a trade proposal */
export interface DebateSession {
  id: string;
  proposal: AgentMessage;
  responses: AgentMessage[];        // doubts, supports, counters
  verdict: DebateVerdict | null;
  asset: AssetInfo;
  startedAt: number;
  resolvedAt: number | null;
  outcome: TradeOutcome | null;     // filled after trade completes
}

// ============================================================
// Spawn / Evolution Config
// ============================================================

export interface AgentSwarmConfig {
  maxAgents: number;                // max concurrent agents
  minAgents: number;                // min agents per strategy
  probationThreshold: number;       // reputation below this → probation
  retireThreshold: number;          // reputation below this → retire
  spawnCooldownMs: number;          // min time between spawns
  evaluationWindowSize: number;     // number of recent trades to evaluate
  doubtThreshold: number;           // min confidence diff to trigger doubt
  consensusQuorum: number;          // fraction of agents needed for consensus
}
