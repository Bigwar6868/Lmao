// ============================================================
// SkillManager — agents can create, install, and learn skills
// ============================================================

import { createModuleLogger } from '../../shared/logger.js';
import type { AgentId } from '../../shared/agent-types.js';

const log = createModuleLogger('skill-manager');

/** A skill that an agent has learned */
export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  type: SkillType;
  createdBy: AgentId;
  version: number;
  params: Record<string, number>;
  performance: SkillPerformance;
  code: string;               // serialized logic or rule definition
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export type SkillType =
  | 'indicator'       // custom technical indicator
  | 'filter'          // pre-trade filter rule
  | 'exit-rule'       // custom exit condition
  | 'position-sizing' // custom sizing logic
  | 'regime-rule'     // market regime classification rule
  | 'data-transform'  // transform raw data
  | 'risk-rule';      // custom risk check

/** How well a skill performs */
export interface SkillPerformance {
  timesUsed: number;
  successRate: number;      // 0-1
  avgPnlImpact: number;    // average PnL change when skill is active
  lastUsed: number;
}

/** A learning event — what the agent learned and when */
export interface LearningEvent {
  agentId: AgentId;
  agentName: string;
  skillId: string;
  eventType: 'created' | 'improved' | 'deprecated' | 'shared';
  description: string;
  insight: string;           // what the agent learned
  timestamp: number;
}

/**
 * Manages agent skills — self-created plugins that enhance trading.
 *
 * Agents can:
 *  - Create new skills from observed patterns
 *  - Install skills shared by other agents
 *  - Evolve skill parameters based on performance
 *  - Deprecate skills that underperform
 */
export class SkillManager {
  private skills = new Map<string, AgentSkill>();
  private agentSkills = new Map<AgentId, Set<string>>(); // agent → skill ids
  private learningLog: LearningEvent[] = [];

  // ----------------------------------------------------------------
  // Skill CRUD
  // ----------------------------------------------------------------

  /**
   * Agent creates a new skill from observed market patterns.
   */
  createSkill(
    agentId: AgentId,
    agentName: string,
    opts: {
      name: string;
      description: string;
      type: SkillType;
      params: Record<string, number>;
      code: string;
    },
  ): AgentSkill {
    const skill: AgentSkill = {
      id: `skill-${Date.now()}-${agentId.slice(0, 6)}`,
      name: opts.name,
      description: opts.description,
      type: opts.type,
      createdBy: agentId,
      version: 1,
      params: opts.params,
      performance: { timesUsed: 0, successRate: 0, avgPnlImpact: 0, lastUsed: 0 },
      code: opts.code,
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.skills.set(skill.id, skill);
    this.getAgentSkills(agentId).add(skill.id);

    this.recordLearning(agentId, agentName, skill.id, 'created',
      `Created ${opts.type} skill: ${opts.name}`,
      opts.description,
    );

    log.info({
      agent: agentName,
      skill: opts.name,
      type: opts.type,
    }, 'New skill created');

    return skill;
  }

  /**
   * Agent installs a skill created by another agent.
   */
  installSkill(agentId: AgentId, agentName: string, skillId: string): boolean {
    const skill = this.skills.get(skillId);
    if (!skill) return false;

    this.getAgentSkills(agentId).add(skillId);

    this.recordLearning(agentId, agentName, skillId, 'shared',
      `Installed skill: ${skill.name}`,
      `Learned from agent ${skill.createdBy.slice(0, 8)}`,
    );

    log.info({ agent: agentName, skill: skill.name }, 'Skill installed');
    return true;
  }

  /**
   * Record skill usage outcome to update performance metrics.
   */
  recordUsage(skillId: string, success: boolean, pnlImpact: number): void {
    const skill = this.skills.get(skillId);
    if (!skill) return;

    const perf = skill.performance;
    perf.timesUsed++;
    perf.successRate = ((perf.successRate * (perf.timesUsed - 1)) + (success ? 1 : 0)) / perf.timesUsed;
    perf.avgPnlImpact = ((perf.avgPnlImpact * (perf.timesUsed - 1)) + pnlImpact) / perf.timesUsed;
    perf.lastUsed = Date.now();
    skill.updatedAt = Date.now();
  }

  /**
   * Improve a skill by evolving its parameters.
   */
  improveSkill(
    agentId: AgentId,
    agentName: string,
    skillId: string,
    newParams: Record<string, number>,
    insight: string,
  ): void {
    const skill = this.skills.get(skillId);
    if (!skill) return;

    skill.params = { ...skill.params, ...newParams };
    skill.version++;
    skill.updatedAt = Date.now();

    this.recordLearning(agentId, agentName, skillId, 'improved',
      `Improved skill: ${skill.name} (v${skill.version})`,
      insight,
    );

    log.info({
      agent: agentName,
      skill: skill.name,
      version: skill.version,
      insight,
    }, 'Skill improved');
  }

  /**
   * Deprecate a skill that consistently underperforms.
   */
  deprecateSkill(agentId: AgentId, agentName: string, skillId: string, reason: string): void {
    const skill = this.skills.get(skillId);
    if (!skill) return;

    skill.enabled = false;
    skill.updatedAt = Date.now();

    this.recordLearning(agentId, agentName, skillId, 'deprecated',
      `Deprecated skill: ${skill.name}`,
      reason,
    );

    log.info({ agent: agentName, skill: skill.name, reason }, 'Skill deprecated');
  }

  // ----------------------------------------------------------------
  // Auto-learning: detect patterns and create skills
  // ----------------------------------------------------------------

  /**
   * Analyze an agent's recent trade history and auto-create skills
   * based on patterns (e.g., "RSI < 20 on crypto always bounces").
   */
  autoLearn(
    agentId: AgentId,
    agentName: string,
    recentTrades: Array<{ indicators: Record<string, number>; pnl: number; action: string }>,
  ): AgentSkill | null {
    if (recentTrades.length < 10) return null;

    // Look for patterns: which indicator ranges predict wins?
    const wins = recentTrades.filter(t => t.pnl > 0);
    const losses = recentTrades.filter(t => t.pnl <= 0);

    if (wins.length < 5) return null;

    // Find indicator that most differentiates wins from losses
    const indicatorKeys = new Set<string>();
    for (const t of recentTrades) {
      for (const k of Object.keys(t.indicators)) indicatorKeys.add(k);
    }

    let bestIndicator = '';
    let bestSeparation = 0;
    let bestWinAvg = 0;
    let bestLossAvg = 0;

    for (const key of indicatorKeys) {
      const winValues = wins.map(t => t.indicators[key]).filter(v => v !== undefined);
      const lossValues = losses.map(t => t.indicators[key]).filter(v => v !== undefined);

      if (winValues.length < 3 || lossValues.length < 3) continue;

      const winAvg = winValues.reduce((a, b) => a + b, 0) / winValues.length;
      const lossAvg = lossValues.reduce((a, b) => a + b, 0) / lossValues.length;
      const separation = Math.abs(winAvg - lossAvg);

      if (separation > bestSeparation) {
        bestSeparation = separation;
        bestIndicator = key;
        bestWinAvg = winAvg;
        bestLossAvg = lossAvg;
      }
    }

    if (!bestIndicator || bestSeparation < 0.01) return null;

    // Create a filter skill based on the pattern
    const direction = bestWinAvg > bestLossAvg ? 'above' : 'below';
    const threshold = (bestWinAvg + bestLossAvg) / 2;

    return this.createSkill(agentId, agentName, {
      name: `${bestIndicator}-filter-${agentId.slice(0, 4)}`,
      description: `Filter trades where ${bestIndicator} is ${direction} ${threshold.toFixed(2)} (auto-learned)`,
      type: 'filter',
      params: { indicator: 0, threshold, direction: direction === 'above' ? 1 : -1 },
      code: JSON.stringify({
        indicator: bestIndicator,
        condition: direction,
        threshold,
        winRate: wins.length / recentTrades.length,
      }),
    });
  }

  // ----------------------------------------------------------------
  // Queries
  // ----------------------------------------------------------------

  /** Get all skills for an agent */
  getSkillsForAgent(agentId: AgentId): AgentSkill[] {
    const skillIds = this.agentSkills.get(agentId);
    if (!skillIds) return [];
    return [...skillIds]
      .map(id => this.skills.get(id))
      .filter((s): s is AgentSkill => s !== undefined && s.enabled);
  }

  /** Get top-performing skills across all agents */
  getTopSkills(count = 10): AgentSkill[] {
    return [...this.skills.values()]
      .filter(s => s.enabled && s.performance.timesUsed >= 5)
      .sort((a, b) => b.performance.successRate - a.performance.successRate)
      .slice(0, count);
  }

  /** Get the learning log */
  getLearningLog(count = 50): LearningEvent[] {
    return this.learningLog.slice(-count);
  }

  /** Format skills report */
  formatReport(): string {
    const skills = [...this.skills.values()];
    const active = skills.filter(s => s.enabled);

    const lines: string[] = ['\n=== AGENT SKILLS ===\n'];
    lines.push(`Total skills: ${skills.length} (${active.length} active)\n`);

    for (const s of active.sort((a, b) => b.performance.successRate - a.performance.successRate)) {
      lines.push(
        `  ${s.name} (${s.type}) v${s.version} — ` +
        `used ${s.performance.timesUsed}x, ` +
        `win: ${(s.performance.successRate * 100).toFixed(0)}%, ` +
        `PnL impact: ${s.performance.avgPnlImpact > 0 ? '+' : ''}${s.performance.avgPnlImpact.toFixed(2)}`,
      );
    }

    if (this.learningLog.length > 0) {
      lines.push('\nRecent learning:');
      for (const l of this.learningLog.slice(-5)) {
        lines.push(`  [${l.agentName}] ${l.eventType}: ${l.description}`);
        lines.push(`    Insight: ${l.insight}`);
      }
    }

    return lines.join('\n');
  }

  // ----------------------------------------------------------------
  // Internal
  // ----------------------------------------------------------------

  private getAgentSkills(agentId: AgentId): Set<string> {
    if (!this.agentSkills.has(agentId)) {
      this.agentSkills.set(agentId, new Set());
    }
    return this.agentSkills.get(agentId)!;
  }

  private recordLearning(
    agentId: AgentId,
    agentName: string,
    skillId: string,
    eventType: LearningEvent['eventType'],
    description: string,
    insight: string,
  ): void {
    this.learningLog.push({
      agentId, agentName, skillId, eventType, description, insight, timestamp: Date.now(),
    });
    if (this.learningLog.length > 500) {
      this.learningLog = this.learningLog.slice(-250);
    }
  }
}
