// ============================================================
// Explainability Engine (XAI) — audit trail for every decision
// ============================================================

import type { AgentId, DebateSession, TradeProposal, TradeDoubt, TradeSupport } from '../../shared/agent-types.js';
import type { Signal } from '../../shared/types.js';
import { createModuleLogger } from '../../shared/logger.js';
import { roundTo } from '../../shared/utils.js';

const log = createModuleLogger('xai');

/** A single decision with full reasoning chain */
export interface DecisionExplanation {
  id: string;
  timestamp: number;
  asset: string;
  action: string;
  outcome: 'approved' | 'rejected' | 'pending';

  // The proposal
  proposer: { agentId: AgentId; name: string; reputation: number };
  signal: Signal;
  reasoning: string;
  conviction: number;

  // The debate
  supporters: Array<{ agentId: AgentId; reason: string; confidence: number }>;
  doubters: Array<{ agentId: AgentId; reason: string; severity: string }>;

  // The verdict
  finalConfidence: number;
  verdictReason: string;

  // Risk check (if approved)
  riskApproved?: boolean;
  riskReason?: string;

  // Explainable factors
  keyFactors: ExplainableFactor[];
  humanSummary: string;
}

/** A factor that contributed to the decision */
export interface ExplainableFactor {
  name: string;
  value: number | string;
  impact: 'positive' | 'negative' | 'neutral';
  weight: number;          // 0-1, how much this factor mattered
  explanation: string;
}

/**
 * Explainability engine that generates human-readable audit trails
 * for every trading decision made by the multi-agent system.
 *
 * Addresses:
 * - SEC regulatory requirements for algorithmic transparency
 * - "You must be able to explain why your AI made a specific trade"
 * - Colorado AI Act compliance (risk-informed governance)
 */
export class ExplainabilityEngine {
  private decisions: DecisionExplanation[] = [];
  private maxHistory = 1000;

  /**
   * Generate an explanation from a completed debate session.
   */
  explainDebate(
    session: DebateSession,
    agentNames: Map<AgentId, string>,
    agentReputations: Map<AgentId, number>,
  ): DecisionExplanation {
    const proposal = session.proposal.payload as TradeProposal;
    const proposerId = session.proposal.from;
    const verdict = session.verdict;

    // Collect supporters
    const supporters = session.responses
      .filter(r => r.type === 'support')
      .map(r => {
        const support = r.payload as TradeSupport;
        return {
          agentId: r.from,
          reason: support.reason,
          confidence: support.additionalConfidence,
        };
      });

    // Collect doubters
    const doubters = session.responses
      .filter(r => r.type === 'doubt')
      .map(r => {
        const doubt = r.payload as TradeDoubt;
        return {
          agentId: r.from,
          reason: doubt.reason,
          severity: doubt.severity,
        };
      });

    // Build key factors
    const keyFactors: ExplainableFactor[] = [];

    // Signal confidence
    keyFactors.push({
      name: 'Signal Confidence',
      value: `${roundTo(proposal.signal.confidence * 100, 0)}%`,
      impact: proposal.signal.confidence > 0.6 ? 'positive' : proposal.signal.confidence < 0.4 ? 'negative' : 'neutral',
      weight: 0.3,
      explanation: `The ${proposal.signal.strategy} strategy generated a ${proposal.signal.action} signal with ${roundTo(proposal.signal.confidence * 100, 0)}% confidence`,
    });

    // Proposer reputation
    const propRep = agentReputations.get(proposerId) ?? 50;
    keyFactors.push({
      name: 'Proposer Reputation',
      value: `${roundTo(propRep, 0)}/100`,
      impact: propRep > 70 ? 'positive' : propRep < 30 ? 'negative' : 'neutral',
      weight: 0.2,
      explanation: `Agent "${agentNames.get(proposerId) ?? proposerId}" has a reputation of ${roundTo(propRep, 0)} based on past trade accuracy`,
    });

    // Debate outcome
    keyFactors.push({
      name: 'Debate Consensus',
      value: `${supporters.length} support, ${doubters.length} doubt`,
      impact: supporters.length > doubters.length ? 'positive' : doubters.length > supporters.length ? 'negative' : 'neutral',
      weight: 0.25,
      explanation: supporters.length > doubters.length
        ? `Majority of agents (${supporters.length}/${supporters.length + doubters.length}) supported this trade`
        : doubters.length > 0
          ? `${doubters.length} agent(s) raised doubts: ${doubters.map(d => d.reason).join('; ')}`
          : 'No other agents weighed in on this trade',
    });

    // Technical indicators
    for (const [key, value] of Object.entries(proposal.indicators)) {
      if (typeof value !== 'number') continue;
      let impact: 'positive' | 'negative' | 'neutral' = 'neutral';
      let explanation = `${key} = ${roundTo(value, 2)}`;

      if (key === 'rsi') {
        if (value > 70) { impact = proposal.signal.action === 'SELL' ? 'positive' : 'negative'; explanation += ' (overbought)'; }
        else if (value < 30) { impact = proposal.signal.action === 'BUY' ? 'positive' : 'negative'; explanation += ' (oversold)'; }
      }

      keyFactors.push({
        name: key.toUpperCase(),
        value: roundTo(value, 2),
        impact,
        weight: 0.1,
        explanation,
      });
    }

    // Final confidence after debate
    keyFactors.push({
      name: 'Final Confidence',
      value: `${roundTo((verdict?.finalConfidence ?? 0) * 100, 0)}%`,
      impact: (verdict?.finalConfidence ?? 0) > 0.5 ? 'positive' : 'negative',
      weight: 0.15,
      explanation: `After debate, confidence was adjusted to ${roundTo((verdict?.finalConfidence ?? 0) * 100, 0)}%`,
    });

    // Generate human summary
    const humanSummary = this.generateHumanSummary(
      proposal, verdict, supporters, doubters, agentNames, propRep,
    );

    const explanation: DecisionExplanation = {
      id: session.id,
      timestamp: session.startedAt,
      asset: session.asset.symbol,
      action: proposal.signal.action,
      outcome: verdict?.approved ? 'approved' : 'rejected',
      proposer: {
        agentId: proposerId,
        name: agentNames.get(proposerId) ?? proposerId,
        reputation: propRep,
      },
      signal: proposal.signal,
      reasoning: proposal.reasoning,
      conviction: proposal.conviction,
      supporters,
      doubters,
      finalConfidence: verdict?.finalConfidence ?? 0,
      verdictReason: verdict?.reason ?? 'No verdict',
      keyFactors,
      humanSummary,
    };

    this.decisions.push(explanation);
    if (this.decisions.length > this.maxHistory) {
      this.decisions = this.decisions.slice(-this.maxHistory / 2);
    }

    return explanation;
  }

  /**
   * Generate a plain-English summary of why a decision was made.
   */
  private generateHumanSummary(
    proposal: TradeProposal,
    verdict: { approved: boolean; finalConfidence: number; reason: string } | null,
    supporters: Array<{ reason: string }>,
    doubters: Array<{ reason: string; severity: string }>,
    agentNames: Map<AgentId, string>,
    proposerRep: number,
  ): string {
    const action = proposal.signal.action;
    const asset = proposal.signal.asset.symbol;
    const strategy = proposal.signal.strategy;
    const approved = verdict?.approved ?? false;

    let summary = `${approved ? 'EXECUTED' : 'REJECTED'}: ${action} ${asset}\n`;
    summary += `  Strategy: ${strategy} (confidence: ${roundTo(proposal.signal.confidence * 100, 0)}%)\n`;
    summary += `  Reason: ${proposal.reasoning}\n`;

    if (supporters.length > 0) {
      summary += `  Supported by ${supporters.length} agent(s): ${supporters.map(s => s.reason).join('; ')}\n`;
    }

    if (doubters.length > 0) {
      summary += `  Doubted by ${doubters.length} agent(s): ${doubters.map(d => `[${d.severity}] ${d.reason}`).join('; ')}\n`;
    }

    if (verdict) {
      summary += `  Final confidence: ${roundTo(verdict.finalConfidence * 100, 0)}% | ${verdict.reason}`;
    }

    return summary;
  }

  // ----------------------------------------------------------------
  // Queries
  // ----------------------------------------------------------------

  /** Get recent decisions with full explanations */
  getRecentDecisions(count = 20): DecisionExplanation[] {
    return this.decisions.slice(-count);
  }

  /** Get decisions for a specific asset */
  getDecisionsForAsset(asset: string, count = 10): DecisionExplanation[] {
    return this.decisions
      .filter(d => d.asset === asset)
      .slice(-count);
  }

  /** Format a human-readable audit report */
  formatAuditReport(count = 10): string {
    const recent = this.getRecentDecisions(count);
    if (recent.length === 0) return '\nNo decisions to explain yet.';

    const lines: string[] = ['\n=== DECISION AUDIT TRAIL (XAI) ===\n'];

    for (const d of recent) {
      lines.push(d.humanSummary);
      lines.push('');
    }

    const approved = recent.filter(d => d.outcome === 'approved').length;
    lines.push(`Decisions shown: ${recent.length} (${approved} approved, ${recent.length - approved} rejected)`);

    return lines.join('\n');
  }
}
