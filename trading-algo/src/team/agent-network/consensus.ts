// ============================================================
// ConsensusEngine — resolves debates between agents
// ============================================================

import type {
  AgentId,
  AgentMessage,
  TradeProposal,
  TradeDoubt,
  TradeSupport,
  TradeCounter,
  DebateVerdict,
  DebateSession,
} from '../../shared/agent-types.js';
import type { Signal } from '../../shared/types.js';
import { generateId, roundTo } from '../../shared/utils.js';
import { createModuleLogger } from '../../shared/logger.js';
import type { AgentNetwork } from './network.js';
import type { TradingAgent } from './trading-agent.js';

const log = createModuleLogger('consensus');

/**
 * Resolves trade debates using reputation-weighted voting.
 *
 * Flow:
 *  1. Agent proposes a trade → broadcast to all
 *  2. Other agents respond with doubt / support / counter
 *  3. ConsensusEngine collects responses and renders a verdict
 *  4. Verdict determines whether the trade is executed
 */
export class ConsensusEngine {
  private network: AgentNetwork;
  private agents: Map<AgentId, TradingAgent>;
  private activeSessions = new Map<string, DebateSession>();
  private completedSessions: DebateSession[] = [];
  private maxHistory = 500;

  constructor(network: AgentNetwork, agents: Map<AgentId, TradingAgent>) {
    this.network = network;
    this.agents = agents;

    // Listen for proposals and responses
    const systemId = 'consensus-engine';
    this.network.register(systemId);
    this.network.on(systemId, 'proposal', (msg) => this.onProposal(msg));
    this.network.on(systemId, 'doubt', (msg) => this.onResponse(msg));
    this.network.on(systemId, 'support', (msg) => this.onResponse(msg));
    this.network.on(systemId, 'counter', (msg) => this.onResponse(msg));
  }

  // ----------------------------------------------------------------
  // Debate lifecycle
  // ----------------------------------------------------------------

  private onProposal(msg: AgentMessage): void {
    const proposal = msg.payload as TradeProposal;
    const session: DebateSession = {
      id: msg.id,
      proposal: msg,
      responses: [],
      verdict: null,
      asset: proposal.signal.asset,
      startedAt: msg.timestamp,
      resolvedAt: null,
      outcome: null,
    };
    this.activeSessions.set(msg.id, session);
  }

  private onResponse(msg: AgentMessage): void {
    if (!msg.replyTo) return;
    const session = this.activeSessions.get(msg.replyTo);
    if (!session) return;
    session.responses.push(msg);
  }

  /**
   * Resolve all active debates and return verdicts.
   * Call this after all agents have had a chance to respond.
   */
  resolveAll(): DebateVerdict[] {
    const verdicts: DebateVerdict[] = [];

    for (const [proposalId, session] of this.activeSessions) {
      const verdict = this.resolve(session);
      session.verdict = verdict;
      session.resolvedAt = Date.now();

      verdicts.push(verdict);

      // Move to completed
      this.completedSessions.push(session);
      if (this.completedSessions.length > this.maxHistory) {
        this.completedSessions.shift();
      }
    }

    // Clear active sessions
    this.activeSessions.clear();

    return verdicts;
  }

  /**
   * Resolve a single debate session into a verdict.
   * Uses reputation-weighted voting.
   */
  private resolve(session: DebateSession): DebateVerdict {
    const proposal = session.proposal.payload as TradeProposal;
    const proposerId = session.proposal.from;
    const proposerAgent = this.agents.get(proposerId);
    const proposerRep = proposerAgent?.getReputation() ?? 50;

    // Collect votes
    const supporters: AgentId[] = [];
    const doubters: AgentId[] = [];
    let supportWeight = 0;
    let doubtWeight = 0;
    let vetoRaised = false;
    let vetoReason = '';

    for (const response of session.responses) {
      const responderId = response.from;
      const responderAgent = this.agents.get(responderId);
      const responderRep = responderAgent?.getReputation() ?? 50;

      if (response.type === 'support') {
        supporters.push(responderId);
        const support = response.payload as TradeSupport;
        supportWeight += responderRep * (1 + support.additionalConfidence);
      } else if (response.type === 'doubt') {
        doubters.push(responderId);
        const doubt = response.payload as TradeDoubt;

        // Severity multiplier
        const severityMult = doubt.severity === 'veto' ? 3 : doubt.severity === 'strong' ? 2 : 1;
        doubtWeight += responderRep * severityMult;

        if (doubt.severity === 'veto' && responderRep > 70) {
          vetoRaised = true;
          vetoReason = doubt.reason;
        }
      } else if (response.type === 'counter') {
        doubters.push(responderId);
        doubtWeight += responderRep * 1.5; // counter-proposals carry extra weight
      }
    }

    // Proposer's own weight
    const proposerWeight = proposerRep * proposal.conviction;

    // Net score: proposer + supporters - doubters
    const totalSupport = proposerWeight + supportWeight;
    const totalDoubt = doubtWeight;
    const netScore = totalSupport - totalDoubt;

    // Final confidence = base signal confidence adjusted by debate outcome
    const debateMultiplier = netScore > 0
      ? 1 + Math.min(0.3, netScore / 500)   // boost up to 30%
      : 1 - Math.min(0.5, Math.abs(netScore) / 300); // penalize up to 50%

    const finalConfidence = Math.max(0, Math.min(1,
      proposal.signal.confidence * debateMultiplier,
    ));

    // Approval logic
    let approved = !vetoRaised && finalConfidence > 0.35 && netScore > -50;

    // High-reputation proposers get more leeway
    if (!approved && proposerRep > 80 && finalConfidence > 0.35 && !vetoRaised) {
      approved = true;
    }

    const reason = vetoRaised
      ? `VETOED by high-reputation agent: ${vetoReason}`
      : approved
        ? `Approved (confidence: ${roundTo(finalConfidence * 100, 0)}%, support: ${supporters.length}, doubts: ${doubters.length})`
        : `Rejected — net debate score too low (${roundTo(netScore, 0)})`;

    log.info({
      asset: session.asset.symbol,
      action: proposal.signal.action,
      approved,
      finalConfidence: roundTo(finalConfidence, 2),
      supporters: supporters.length,
      doubters: doubters.length,
      netScore: roundTo(netScore, 0),
      vetoRaised,
    }, 'Debate resolved');

    return {
      type: 'verdict',
      proposalId: session.id,
      approved,
      finalConfidence,
      supporters,
      doubters,
      reason,
    };
  }

  // ----------------------------------------------------------------
  // Queries
  // ----------------------------------------------------------------

  /** Get verdict for a specific proposal */
  getVerdict(proposalId: string): DebateVerdict | null {
    const session = this.completedSessions.find(s => s.id === proposalId);
    return session?.verdict ?? null;
  }

  /** Get approved signals from the latest debate round */
  getApprovedSignals(): Array<{ signal: Signal; confidence: number; proposerId: AgentId }> {
    const approved: Array<{ signal: Signal; confidence: number; proposerId: AgentId }> = [];

    for (const session of this.completedSessions.slice(-100)) {
      if (!session.verdict?.approved) continue;
      const proposal = session.proposal.payload as TradeProposal;
      approved.push({
        signal: { ...proposal.signal, confidence: session.verdict.finalConfidence },
        confidence: session.verdict.finalConfidence,
        proposerId: session.proposal.from,
      });
    }

    return approved;
  }

  /** Format debate summary for console output */
  static formatDebateSummary(sessions: DebateSession[]): string {
    if (sessions.length === 0) return '\nNo debates this cycle.';

    const lines: string[] = ['\n=== AGENT DEBATE SUMMARY ===\n'];

    for (const s of sessions) {
      const proposal = s.proposal.payload as TradeProposal;
      const v = s.verdict;
      const status = v?.approved ? 'APPROVED' : 'REJECTED';
      const doubts = s.responses.filter(r => r.type === 'doubt').length;
      const supports = s.responses.filter(r => r.type === 'support').length;

      lines.push(
        `  ${status.padEnd(8)} | ${proposal.signal.action.padEnd(4)} ${proposal.signal.asset.symbol.padEnd(12)} | ` +
        `conf: ${roundTo((v?.finalConfidence ?? 0) * 100, 0)}% | ` +
        `support: ${supports} doubt: ${doubts} | ${v?.reason ?? ''}`,
      );
    }

    const approvedCount = sessions.filter(s => s.verdict?.approved).length;
    lines.push(`\nTotal debates: ${sessions.length} | Approved: ${approvedCount} | Rejected: ${sessions.length - approvedCount}`);

    return lines.join('\n');
  }

  getCompletedSessions(): DebateSession[] {
    return [...this.completedSessions];
  }

  getRecentSessions(count = 20): DebateSession[] {
    return this.completedSessions.slice(-count);
  }
}
