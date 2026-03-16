// ============================================================
// Multi-Agent System Types
// ============================================================

import type { Signal, AssetInfo, StrategyDNA, PerformanceMetrics, MarketData, MacroEnvironment } from './types.js';

/** Unique agent identifier */
export type AgentId = string;

/** Agent lifecycle status */
export type AgentStatus = 'active' | 'probation' | 'retired' | 'spawning';

/** Team identifiers */
export type TeamId = 'ceo' | 'trading' | 'research' | 'risk' | 'evolution' | 'ops';

/** Agent role within a team */
export type AgentRole = 'ceo' | 'team-lead' | 'member';

/** Message types for inter-agent communication */
export type MessageType =
  // Trade flow
  | 'proposal'       // Agent proposes a trade
  | 'doubt'          // Agent challenges another's proposal
  | 'support'        // Agent supports another's proposal
  | 'counter'        // Agent proposes alternative to another's proposal
  | 'verdict'        // Consensus engine final decision
  | 'performance'    // Agent broadcasts its own metrics
  | 'alert'          // Agent raises a concern (regime shift, risk, etc.)
  | 'spawn'          // System spawns a new agent
  | 'retire'         // System retires an agent
  // CEO directives
  | 'directive'      // CEO tells agents/teams what to do
  | 'approval'       // CEO approves a request
  | 'veto'           // CEO rejects a request
  // Agent ↔ CEO / Team Lead reports
  | 'report'         // Agent reports findings upward
  | 'request'        // Agent requests resources (new agent, data, strategy)
  // Peer discussion (any agent ↔ any agent, cross-team)
  | 'discuss'        // Free-form discussion message
  | 'question'       // Agent asks another agent
  | 'answer';        // Agent answers another agent

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
  | RetirePayload
  | DirectivePayload
  | ApprovalPayload
  | VetoPayload
  | ReportPayload
  | RequestPayload
  | DiscussPayload
  | QuestionPayload
  | AnswerPayload;

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

// ============================================================
// CEO Directives
// ============================================================

export type DirectiveType =
  | 'focus-assets'        // "Focus on BTC, ETH, NVDA"
  | 'deploy-strategy'     // "Deploy breakout on crypto"
  | 'spawn-agent'         // "Spawn 3 more momentum agents"
  | 'retire-agent'        // "Retire agent X"
  | 'adjust-risk'         // "Reduce position sizes by 30%"
  | 'pause-trading'       // "Stop all trading"
  | 'resume-trading'      // "Resume trading"
  | 'evolve'              // "Evolve strategy X internally"
  | 'research'            // "Research new asset/strategy"
  | 'rebalance';          // "Rebalance team allocation"

export interface DirectivePayload {
  type: 'directive';
  directiveType: DirectiveType;
  targetTeam: TeamId;
  targetAgent?: AgentId;
  params: Record<string, unknown>;
  priority: 'urgent' | 'normal' | 'low';
  reason: string;
}

export interface ApprovalPayload {
  type: 'approval';
  requestId: string;
  reason: string;
}

export interface VetoPayload {
  type: 'veto';
  requestId: string;
  reason: string;
}

// ============================================================
// Agent Reports & Requests
// ============================================================

export type RequestType =
  | 'spawn-agent'         // "I need a helper for forex analysis"
  | 'new-strategy'        // "I found a pattern worth trying"
  | 'new-data-source'     // "We need on-chain data"
  | 'new-asset'           // "We should track ATOM/USDT"
  | 'increase-risk'       // "Market is trending, increase exposure"
  | 'decrease-risk'       // "Market volatile, decrease exposure"
  | 'evolution'           // "Strategy X is decaying, needs evolution"
  | 'retire-agent';       // "Agent X is useless"

export interface ReportPayload {
  type: 'report';
  reportType: 'performance' | 'analysis' | 'opportunity' | 'risk-alert' | 'status' | 'meeting-outcome';
  summary: string;
  data: Record<string, unknown>;
}

export interface RequestPayload {
  type: 'request';
  requestType: RequestType;
  description: string;
  reason: string;
  data: Record<string, unknown>;
}

// ============================================================
// Peer Discussion (any agent ↔ any agent)
// ============================================================

export interface DiscussPayload {
  type: 'discuss';
  threadId: string;
  topic: string;
  content: string;
  data?: Record<string, unknown>;
}

export interface QuestionPayload {
  type: 'question';
  threadId: string;
  question: string;
  context?: Record<string, unknown>;
}

export interface AnswerPayload {
  type: 'answer';
  threadId: string;
  questionId: string;
  answer: string;
  data?: Record<string, unknown>;
}

// ============================================================
// Discussion Threads
// ============================================================

export interface DiscussionThread {
  id: string;
  topic: string;
  startedBy: AgentId;
  participants: Set<AgentId>;
  messages: AgentMessage[];
  conclusion?: string;
  reportedToCeo: boolean;
  createdAt: number;
  closedAt?: number;
}

// ============================================================
// Team Structure
// ============================================================

export interface TeamConfig {
  id: TeamId;
  name: string;
  leadId?: AgentId;
  memberIds: AgentId[];
  description: string;
}

/** CEO's view of system state */
export interface CEODashboard {
  teams: TeamConfig[];
  activeAssets: string[];
  activeStrategies: string[];
  totalAgents: number;
  totalCapital: number;
  dailyPnl: number;
  openPositions: number;
  pendingRequests: RequestPayload[];
  systemHealth: number;          // 0-100
  lastCycleAt: number;
}
