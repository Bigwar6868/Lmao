// ============================================================
// Governance — safety guardrails, kill switches, human override
// ============================================================

import type { Signal, Portfolio } from '../../shared/types.js';
import type { AgentId } from '../../shared/agent-types.js';
import { createModuleLogger } from '../../shared/logger.js';
import { roundTo } from '../../shared/utils.js';

const log = createModuleLogger('governance');

/** A governance rule that can block or modify trades */
export interface GovernanceRule {
  id: string;
  name: string;
  type: 'hard-limit' | 'soft-limit' | 'circuit-breaker' | 'human-override';
  enabled: boolean;
  check: (ctx: GovernanceContext) => GovernanceResult;
}

/** Context passed to governance rules */
export interface GovernanceContext {
  signal: Signal;
  portfolio: Portfolio;
  agentId: AgentId;
  recentLosses: number;      // consecutive losses
  dailyPnl: number;          // today's PnL
  totalExposure: number;     // total portfolio exposure %
}

/** Result of a governance check */
export interface GovernanceResult {
  allowed: boolean;
  reason: string;
  ruleId: string;
  severity: 'info' | 'warning' | 'block';
  requiresHumanApproval?: boolean;
}

/** Governance configuration */
export interface GovernanceConfig {
  maxDailyLoss: number;         // max daily loss in $ before circuit breaker
  maxDailyLossPct: number;      // max daily loss as % of capital
  maxConsecutiveLosses: number;  // max consecutive losses before pause
  maxExposurePct: number;        // max total portfolio exposure %
  maxSinglePositionPct: number;  // max single position as % of portfolio
  maxTradesPerDay: number;       // max trades per day
  killSwitchActive: boolean;     // global kill switch
  humanApprovalAbove: number;    // require human approval for trades above this $ value
  allowedAssetClasses: string[]; // which asset classes are allowed
}

/**
 * Governance engine with safety guardrails.
 *
 * Addresses:
 * - "Hybrid human-AI oversight" (industry best practice 2026)
 * - Circuit breakers for cascading losses
 * - Kill switch for emergency stop
 * - Position limits to prevent concentration risk
 * - Human approval for large trades
 */
export class GovernanceEngine {
  private config: GovernanceConfig;
  private rules: GovernanceRule[] = [];
  private todayTrades = 0;
  private todayPnl = 0;
  private todayDate = new Date().toDateString();
  private blockedTrades: Array<{ signal: Signal; reason: string; timestamp: number }> = [];

  constructor(config?: Partial<GovernanceConfig>) {
    this.config = {
      maxDailyLoss: 500,
      maxDailyLossPct: 5,
      maxConsecutiveLosses: 5,
      maxExposurePct: 80,
      maxSinglePositionPct: 10,
      maxTradesPerDay: 50,
      killSwitchActive: false,
      humanApprovalAbove: 5000,
      allowedAssetClasses: ['crypto', 'forex'],
      ...config,
    };

    this.initializeRules();
    log.info({ config: this.config }, 'Governance engine initialized');
  }

  /**
   * Check if a trade is allowed by all governance rules.
   */
  check(ctx: GovernanceContext): { allowed: boolean; results: GovernanceResult[] } {
    // Reset daily counters if new day
    this.resetDailyIfNeeded();

    const results: GovernanceResult[] = [];
    let allowed = true;

    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      const result = rule.check(ctx);
      results.push(result);

      if (!result.allowed) {
        allowed = false;
        log.warn({
          rule: rule.name,
          asset: ctx.signal.asset.symbol,
          reason: result.reason,
        }, 'Trade blocked by governance');
      }
    }

    if (!allowed) {
      this.blockedTrades.push({
        signal: ctx.signal,
        reason: results.filter(r => !r.allowed).map(r => r.reason).join('; '),
        timestamp: Date.now(),
      });
    }

    return { allowed, results };
  }

  /**
   * Record a trade for daily limit tracking.
   */
  recordTrade(pnl: number): void {
    this.resetDailyIfNeeded();
    this.todayTrades++;
    this.todayPnl += pnl;
  }

  /**
   * Activate the kill switch — blocks ALL trades.
   */
  activateKillSwitch(reason: string): void {
    this.config.killSwitchActive = true;
    log.error({ reason }, 'KILL SWITCH ACTIVATED — all trading halted');
  }

  /**
   * Deactivate the kill switch.
   */
  deactivateKillSwitch(): void {
    this.config.killSwitchActive = false;
    log.info('Kill switch deactivated — trading resumed');
  }

  /** Check if kill switch is active */
  isKillSwitchActive(): boolean {
    return this.config.killSwitchActive;
  }

  /** Get blocked trades */
  getBlockedTrades(count = 20): Array<{ signal: Signal; reason: string; timestamp: number }> {
    return this.blockedTrades.slice(-count);
  }

  /** Update governance config */
  updateConfig(update: Partial<GovernanceConfig>): void {
    this.config = { ...this.config, ...update };
    log.info({ config: this.config }, 'Governance config updated');
  }

  /** Format governance report */
  formatReport(): string {
    const lines: string[] = ['\n=== GOVERNANCE STATUS ===\n'];

    lines.push(`Kill Switch: ${this.config.killSwitchActive ? 'ACTIVE (all trading halted)' : 'OFF'}`);
    lines.push(`Today's trades: ${this.todayTrades}/${this.config.maxTradesPerDay}`);
    lines.push(`Today's PnL: $${roundTo(this.todayPnl, 2)}`);
    lines.push(`Max daily loss: $${this.config.maxDailyLoss} (${this.config.maxDailyLossPct}%)`);
    lines.push(`Max exposure: ${this.config.maxExposurePct}%`);
    lines.push(`Max position: ${this.config.maxSinglePositionPct}%`);
    lines.push(`Human approval above: $${this.config.humanApprovalAbove}`);
    lines.push(`Allowed classes: ${this.config.allowedAssetClasses.join(', ')}`);

    if (this.blockedTrades.length > 0) {
      lines.push(`\nRecently blocked trades: ${this.blockedTrades.length}`);
      for (const t of this.blockedTrades.slice(-5)) {
        lines.push(`  X ${t.signal.action} ${t.signal.asset.symbol}: ${t.reason}`);
      }
    }

    return lines.join('\n');
  }

  // ----------------------------------------------------------------
  // Rule setup
  // ----------------------------------------------------------------

  private initializeRules(): void {
    // Kill switch
    this.rules.push({
      id: 'kill-switch',
      name: 'Kill Switch',
      type: 'circuit-breaker',
      enabled: true,
      check: () => ({
        allowed: !this.config.killSwitchActive,
        reason: 'Kill switch is active — all trading halted',
        ruleId: 'kill-switch',
        severity: 'block',
      }),
    });

    // Daily loss limit
    this.rules.push({
      id: 'daily-loss',
      name: 'Daily Loss Circuit Breaker',
      type: 'circuit-breaker',
      enabled: true,
      check: (ctx) => {
        const maxLoss = Math.min(
          this.config.maxDailyLoss,
          ctx.portfolio.capital * (this.config.maxDailyLossPct / 100),
        );
        const exceeded = this.todayPnl < -maxLoss;
        if (exceeded) {
          this.activateKillSwitch(`Daily loss limit exceeded: $${roundTo(this.todayPnl, 2)}`);
        }
        return {
          allowed: !exceeded,
          reason: exceeded
            ? `Daily loss limit exceeded ($${roundTo(this.todayPnl, 2)} < -$${roundTo(maxLoss, 2)})`
            : 'Within daily loss limits',
          ruleId: 'daily-loss',
          severity: exceeded ? 'block' : 'info',
        };
      },
    });

    // Consecutive losses
    this.rules.push({
      id: 'consecutive-losses',
      name: 'Consecutive Loss Breaker',
      type: 'circuit-breaker',
      enabled: true,
      check: (ctx) => {
        const exceeded = ctx.recentLosses >= this.config.maxConsecutiveLosses;
        return {
          allowed: !exceeded,
          reason: exceeded
            ? `${ctx.recentLosses} consecutive losses — trading paused`
            : 'Within consecutive loss limits',
          ruleId: 'consecutive-losses',
          severity: exceeded ? 'block' : 'info',
        };
      },
    });

    // Max exposure
    this.rules.push({
      id: 'max-exposure',
      name: 'Max Exposure Limit',
      type: 'hard-limit',
      enabled: true,
      check: (ctx) => {
        const exceeded = ctx.totalExposure > this.config.maxExposurePct;
        return {
          allowed: !exceeded,
          reason: exceeded
            ? `Total exposure ${roundTo(ctx.totalExposure, 0)}% exceeds ${this.config.maxExposurePct}% limit`
            : 'Within exposure limits',
          ruleId: 'max-exposure',
          severity: exceeded ? 'block' : 'info',
        };
      },
    });

    // Max trades per day
    this.rules.push({
      id: 'max-trades',
      name: 'Max Trades Per Day',
      type: 'hard-limit',
      enabled: true,
      check: () => {
        const exceeded = this.todayTrades >= this.config.maxTradesPerDay;
        return {
          allowed: !exceeded,
          reason: exceeded
            ? `${this.todayTrades} trades today — daily limit reached`
            : 'Within daily trade limits',
          ruleId: 'max-trades',
          severity: exceeded ? 'block' : 'info',
        };
      },
    });

    // Asset class filter
    this.rules.push({
      id: 'asset-class',
      name: 'Allowed Asset Classes',
      type: 'hard-limit',
      enabled: true,
      check: (ctx) => {
        const allowed = this.config.allowedAssetClasses.includes(ctx.signal.asset.assetClass);
        return {
          allowed,
          reason: allowed
            ? `${ctx.signal.asset.assetClass} is an allowed asset class`
            : `${ctx.signal.asset.assetClass} is not in allowed classes: ${this.config.allowedAssetClasses.join(', ')}`,
          ruleId: 'asset-class',
          severity: allowed ? 'info' : 'block',
        };
      },
    });

    // Human approval for large trades
    this.rules.push({
      id: 'human-approval',
      name: 'Human Approval Required',
      type: 'human-override',
      enabled: true,
      check: (ctx) => {
        const tradeValue = ctx.signal.price * (ctx.portfolio.capital * this.config.maxSinglePositionPct / 100);
        const needsApproval = tradeValue > this.config.humanApprovalAbove;
        return {
          allowed: !needsApproval, // blocks until human approves
          reason: needsApproval
            ? `Trade value ~$${roundTo(tradeValue, 0)} exceeds $${this.config.humanApprovalAbove} — needs human approval`
            : 'Within auto-approval limits',
          ruleId: 'human-approval',
          severity: needsApproval ? 'warning' : 'info',
          requiresHumanApproval: needsApproval,
        };
      },
    });
  }

  private resetDailyIfNeeded(): void {
    const today = new Date().toDateString();
    if (today !== this.todayDate) {
      this.todayDate = today;
      this.todayTrades = 0;
      this.todayPnl = 0;

      // Auto-deactivate kill switch on new day (if it was triggered by daily limits)
      if (this.config.killSwitchActive) {
        log.info('New day — resetting daily limits (kill switch remains active, deactivate manually)');
      }
    }
  }
}
