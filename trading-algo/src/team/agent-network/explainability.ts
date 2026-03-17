// ============================================================
// Explainability Engine (XAI) — audit trail for every decision
// ============================================================

import type { AgentId } from '../../shared/agent-types.js';
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
  outcome: 'executed' | 'risk-rejected' | 'pending';

  // The signal
  agentId: AgentId;
  agentName: string;
  reputation: number;
  signal: Signal;

  // Risk check
  riskApproved?: boolean;
  riskReason?: string;

  // Post-trade review
  reviewOutcome?: 'WIN' | 'LOSS';
  reviewReasons?: string[];
  optimizationApplied?: boolean;
  adjustments?: string[];

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
   * Generate an explanation for a trade signal.
   */
  explainSignal(
    signal: Signal,
    agentId: AgentId,
    agentName: string,
    agentReputation: number,
    riskApproved?: boolean,
    riskReason?: string,
  ): DecisionExplanation {
    const keyFactors: ExplainableFactor[] = [];

    // Signal confidence
    keyFactors.push({
      name: 'Signal Confidence',
      value: `${roundTo(signal.confidence * 100, 0)}%`,
      impact: signal.confidence > 0.6 ? 'positive' : signal.confidence < 0.4 ? 'negative' : 'neutral',
      weight: 0.35,
      explanation: `The ${signal.strategy} strategy generated a ${signal.action} signal with ${roundTo(signal.confidence * 100, 0)}% confidence`,
    });

    // Agent reputation
    keyFactors.push({
      name: 'Agent Reputation',
      value: `${roundTo(agentReputation, 0)}/100`,
      impact: agentReputation > 70 ? 'positive' : agentReputation < 30 ? 'negative' : 'neutral',
      weight: 0.25,
      explanation: `Agent "${agentName}" has a reputation of ${roundTo(agentReputation, 0)} based on past trade accuracy`,
    });

    // Technical indicators
    for (const [key, value] of Object.entries(signal.indicators)) {
      if (typeof value !== 'number') continue;
      let impact: 'positive' | 'negative' | 'neutral' = 'neutral';
      let explanation = `${key} = ${roundTo(value, 2)}`;

      if (key === 'rsi') {
        if (value > 70) { impact = signal.action === 'SELL' ? 'positive' : 'negative'; explanation += ' (overbought)'; }
        else if (value < 30) { impact = signal.action === 'BUY' ? 'positive' : 'negative'; explanation += ' (oversold)'; }
      }

      keyFactors.push({ name: key.toUpperCase(), value: roundTo(value, 2), impact, weight: 0.1, explanation });
    }

    // Risk decision
    if (riskApproved !== undefined) {
      keyFactors.push({
        name: 'Risk Assessment',
        value: riskApproved ? 'Approved' : 'Rejected',
        impact: riskApproved ? 'positive' : 'negative',
        weight: 0.3,
        explanation: riskReason ?? (riskApproved ? 'Trade passes all risk constraints' : 'Trade rejected by risk manager'),
      });
    }

    const outcome = riskApproved === undefined ? 'pending' : riskApproved ? 'executed' : 'risk-rejected';
    const humanSummary = `${outcome === 'executed' ? 'EXECUTED' : outcome === 'risk-rejected' ? 'RISK-REJECTED' : 'PENDING'}: ` +
      `${signal.action} ${signal.asset.symbol}\n` +
      `  Strategy: ${signal.strategy} (confidence: ${roundTo(signal.confidence * 100, 0)}%)\n` +
      `  Agent: ${agentName} (reputation: ${roundTo(agentReputation, 0)})\n` +
      (riskReason ? `  Risk: ${riskReason}` : '');

    const explanation: DecisionExplanation = {
      id: `${signal.asset.symbol}-${Date.now()}`,
      timestamp: Date.now(),
      asset: signal.asset.symbol,
      action: signal.action,
      outcome,
      agentId,
      agentName,
      reputation: agentReputation,
      signal,
      riskApproved,
      riskReason,
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
   * Attach post-trade review results to a decision.
   */
  attachReview(
    asset: string,
    reviewOutcome: 'WIN' | 'LOSS',
    reasons: string[],
    optimizationApplied: boolean,
    adjustments: string[],
  ): void {
    // Find the most recent decision for this asset
    for (let i = this.decisions.length - 1; i >= 0; i--) {
      const d = this.decisions[i];
      if (d.asset === asset && d.outcome === 'executed' && !d.reviewOutcome) {
        d.reviewOutcome = reviewOutcome;
        d.reviewReasons = reasons;
        d.optimizationApplied = optimizationApplied;
        d.adjustments = adjustments;
        break;
      }
    }
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
      if (d.reviewOutcome) {
        lines.push(`  Review: ${d.reviewOutcome} | ${d.reviewReasons?.join('; ') ?? ''}`);
        if (d.optimizationApplied) {
          lines.push(`  Optimized: ${d.adjustments?.join('; ') ?? ''}`);
        }
      }
      lines.push('');
    }

    const executed = recent.filter(d => d.outcome === 'executed').length;
    lines.push(`Decisions shown: ${recent.length} (${executed} executed, ${recent.length - executed} rejected)`);

    return lines.join('\n');
  }
}
