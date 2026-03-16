// ============================================================
// Risk Team — position sizing, stops, governance, kill switch
// ============================================================

import type {
  AgentId,
  DirectivePayload,
  QuestionPayload,
} from '../../shared/agent-types.js';
import type { AgentNetwork } from '../agent-network/network.js';
import { GovernanceEngine } from '../agent-network/governance.js';
import { TeamBase } from './team-base.js';

export class RiskTeam extends TeamBase {
  readonly governance = new GovernanceEngine();

  constructor(network: AgentNetwork, ceoId: AgentId) {
    super({ teamId: 'risk', teamName: 'Risk Team', network, ceoId });
  }

  protected getDescription(): string {
    return 'Position sizing, stop losses, exposure limits, governance, kill switch';
  }

  isKillSwitchActive(): boolean {
    return this.governance.isKillSwitchActive();
  }

  // ----------------------------------------------------------------
  // CEO Directive Handling
  // ----------------------------------------------------------------

  protected handleDirective(directive: DirectivePayload): void {
    switch (directive.directiveType) {
      case 'adjust-risk': {
        const action = directive.params.action as string;
        this.log.info({ action, params: directive.params }, 'CEO risk adjustment');
        if (action === 'decrease') {
          // Could tighten governance rules
          this.log.warn('Risk parameters tightened by CEO');
        }
        break;
      }
      case 'pause-trading': {
        this.governance.activateKillSwitch(directive.reason);
        this.log.warn({ reason: directive.reason }, 'Kill switch activated by CEO');
        break;
      }
      case 'resume-trading': {
        this.governance.deactivateKillSwitch();
        this.log.info('Kill switch deactivated by CEO');
        break;
      }
      default:
        this.log.debug({ directive: directive.directiveType }, 'Unhandled directive');
    }
  }

  protected handleQuestion(from: AgentId, payload: QuestionPayload): void {
    void this.answerAgent(from, payload.threadId, `Kill switch: ${this.governance.isKillSwitchActive() ? 'ACTIVE' : 'OFF'}`, payload.threadId, {
      killSwitch: this.governance.isKillSwitchActive(),
    });
  }

  formatReport(): string {
    return this.governance.formatReport();
  }
}
