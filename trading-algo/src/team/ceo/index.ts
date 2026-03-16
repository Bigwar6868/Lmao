// ============================================================
// CEO Agent — top-level decision maker for the trading system
// ============================================================

import type {
  AgentId,
  TeamId,
  TeamConfig,
  TeamPrompt,
  CEODashboard,
  DirectivePayload,
  DirectiveType,
  RequestPayload,
  ReportPayload,
  AgentMessage,
  DiscussionThread,
} from '../../shared/agent-types.js';
import type { AssetInfo, Portfolio } from '../../shared/types.js';
import { generateId } from '../../shared/utils.js';
import { createModuleLogger } from '../../shared/logger.js';
import type { AgentNetwork } from '../agent-network/network.js';

const log = createModuleLogger('ceo');

export class CEOAgent {
  readonly id: AgentId;
  private network: AgentNetwork;
  private teams = new Map<TeamId, TeamConfig>();
  private activeAssets: AssetInfo[] = [];
  private activeStrategies: string[] = [];
  private pendingRequests: Array<{ id: string; from: AgentId; payload: RequestPayload; receivedAt: number }> = [];
  private directives: DirectivePayload[] = [];
  private discussions = new Map<string, DiscussionThread>();
  private teamPrompts = new Map<TeamId, TeamPrompt>();
  private cycleCount = 0;
  private paused = false;

  constructor(network: AgentNetwork) {
    this.id = generateId();
    this.network = network;
    this.network.register(this.id);

    // CEO listens to all messages
    this.network.on(this.id, 'request', (msg) => this.handleRequest(msg));
    this.network.on(this.id, 'report', (msg) => this.handleReport(msg));
    this.network.on(this.id, 'alert', (msg) => this.handleAlert(msg));
    this.network.on(this.id, 'discuss', (msg) => this.handleDiscussion(msg));

    log.info({ id: this.id }, 'CEO Agent initialized');
  }

  // ----------------------------------------------------------------
  // Team Management
  // ----------------------------------------------------------------

  registerTeam(config: TeamConfig): void {
    this.teams.set(config.id, config);
    log.info({ team: config.id, members: config.memberIds.length }, 'Team registered');
  }

  getTeam(teamId: TeamId): TeamConfig | undefined {
    return this.teams.get(teamId);
  }

  getAllTeams(): TeamConfig[] {
    return [...this.teams.values()];
  }

  addAgentToTeam(teamId: TeamId, agentId: AgentId): void {
    const team = this.teams.get(teamId);
    if (team) {
      team.memberIds.push(agentId);
      log.info({ team: teamId, agentId: agentId.slice(0, 8) }, 'Agent added to team');
    }
  }

  removeAgentFromTeam(teamId: TeamId, agentId: AgentId): void {
    const team = this.teams.get(teamId);
    if (team) {
      team.memberIds = team.memberIds.filter(id => id !== agentId);
      log.info({ team: teamId, agentId: agentId.slice(0, 8) }, 'Agent removed from team');
    }
  }

  // ----------------------------------------------------------------
  // Team Prompts — CEO defines each team's mission & objectives
  // ----------------------------------------------------------------

  /**
   * Assign or update a team's mission prompt.
   * The team reads this to know what the CEO expects of them.
   */
  async setTeamPrompt(
    teamId: TeamId,
    mission: string,
    objectives: string[],
    constraints: string[] = [],
    focus?: Record<string, unknown>,
  ): Promise<void> {
    const now = Date.now();
    const existing = this.teamPrompts.get(teamId);
    const prompt: TeamPrompt = {
      teamId,
      mission,
      objectives,
      constraints,
      focus,
      issuedAt: existing?.issuedAt ?? now,
      updatedAt: now,
    };
    this.teamPrompts.set(teamId, prompt);

    // Send the prompt as a directive to the team
    await this.issueDirective('set-prompt', teamId, {
      mission,
      objectives,
      constraints,
      focus,
    }, `CEO assigned mission: ${mission}`);

    log.info({ teamId, mission, objectives: objectives.length }, 'Team prompt assigned');
  }

  getTeamPrompt(teamId: TeamId): TeamPrompt | undefined {
    return this.teamPrompts.get(teamId);
  }

  getAllPrompts(): TeamPrompt[] {
    return [...this.teamPrompts.values()];
  }

  // ----------------------------------------------------------------
  // Directives — CEO tells teams what to do
  // ----------------------------------------------------------------

  async issueDirective(
    directiveType: DirectiveType,
    targetTeam: TeamId,
    params: Record<string, unknown>,
    reason: string,
    priority: 'urgent' | 'normal' | 'low' = 'normal',
    targetAgent?: AgentId,
  ): Promise<void> {
    const directive: DirectivePayload = {
      type: 'directive',
      directiveType,
      targetTeam,
      targetAgent,
      params,
      priority,
      reason,
    };

    this.directives.push(directive);

    // Send to team lead or specific agent
    const team = this.teams.get(targetTeam);
    const to = targetAgent ?? team?.leadId ?? 'all';

    await this.network.broadcast(this.id, 'directive', directive);

    log.info({
      directive: directiveType,
      team: targetTeam,
      priority,
      reason,
    }, 'CEO issued directive');
  }

  // ----------------------------------------------------------------
  // Request Handling — agents ask CEO for resources
  // ----------------------------------------------------------------

  private handleRequest(msg: AgentMessage): void {
    const payload = msg.payload as RequestPayload;
    const request = {
      id: msg.id,
      from: msg.from,
      payload,
      receivedAt: Date.now(),
    };
    this.pendingRequests.push(request);

    log.info({
      from: msg.from.slice(0, 8),
      type: payload.requestType,
      description: payload.description,
    }, 'CEO received request');

    // Auto-decide based on request type and system state
    this.autoDecide(request);
  }

  private async autoDecide(request: { id: string; from: AgentId; payload: RequestPayload }): Promise<void> {
    const { payload } = request;

    switch (payload.requestType) {
      case 'spawn-agent': {
        // Approve if total agents < 30
        const totalAgents = [...this.teams.values()].reduce((sum, t) => sum + t.memberIds.length, 0);
        if (totalAgents < 30) {
          await this.approve(request.id, request.from, 'Agent count within limits');
        } else {
          await this.vetoRequest(request.id, request.from, 'Too many agents already active');
        }
        break;
      }
      case 'new-asset': {
        // Approve new assets — more data is good
        await this.approve(request.id, request.from, 'Adding asset to active list');
        const asset = payload.data.asset as AssetInfo | undefined;
        if (asset) this.activeAssets.push(asset);
        break;
      }
      case 'evolution': {
        // Always approve evolution requests
        await this.approve(request.id, request.from, 'Evolution approved');
        await this.issueDirective('evolve', 'evolution', payload.data, payload.reason);
        break;
      }
      case 'decrease-risk': {
        await this.approve(request.id, request.from, 'Risk reduction approved');
        await this.issueDirective('adjust-risk', 'risk', { action: 'decrease', ...payload.data }, payload.reason, 'urgent');
        break;
      }
      default: {
        // Queue for manual review (logged, not auto-decided)
        log.info({ requestType: payload.requestType }, 'Request queued for review');
      }
    }
  }

  private async approve(requestId: string, to: AgentId, reason: string): Promise<void> {
    await this.network.unicast(this.id, to, 'approval', {
      type: 'approval' as const,
      requestId,
      reason,
    });
    this.pendingRequests = this.pendingRequests.filter(r => r.id !== requestId);
    log.info({ requestId: requestId.slice(0, 8), reason }, 'CEO approved request');
  }

  private async vetoRequest(requestId: string, to: AgentId, reason: string): Promise<void> {
    await this.network.unicast(this.id, to, 'veto', {
      type: 'veto' as const,
      requestId,
      reason,
    });
    this.pendingRequests = this.pendingRequests.filter(r => r.id !== requestId);
    log.info({ requestId: requestId.slice(0, 8), reason }, 'CEO vetoed request');
  }

  // ----------------------------------------------------------------
  // Report Handling — agents inform CEO
  // ----------------------------------------------------------------

  private handleReport(msg: AgentMessage): void {
    const payload = msg.payload as ReportPayload;
    log.info({
      from: msg.from.slice(0, 8),
      reportType: payload.reportType,
      summary: payload.summary,
    }, 'CEO received report');

    // React to critical reports
    if (payload.reportType === 'risk-alert') {
      void this.issueDirective('pause-trading', 'trading', payload.data, `Risk alert: ${payload.summary}`, 'urgent');
    }
  }

  private handleAlert(msg: AgentMessage): void {
    log.warn({ from: msg.from.slice(0, 8), payload: msg.payload }, 'CEO received alert');
  }

  // ----------------------------------------------------------------
  // Discussion — CEO can participate in or observe discussions
  // ----------------------------------------------------------------

  private handleDiscussion(msg: AgentMessage): void {
    // CEO observes all discussions, tracks threads
    const payload = msg.payload as { threadId: string; topic: string };
    if (!this.discussions.has(payload.threadId)) {
      this.discussions.set(payload.threadId, {
        id: payload.threadId,
        topic: payload.topic,
        startedBy: msg.from,
        participants: new Set([msg.from]),
        messages: [],
        reportedToCeo: true, // CEO is already observing
        createdAt: Date.now(),
      });
    }
    const thread = this.discussions.get(payload.threadId)!;
    thread.participants.add(msg.from);
    thread.messages.push(msg);
  }

  getDiscussions(): DiscussionThread[] {
    return [...this.discussions.values()];
  }

  // ----------------------------------------------------------------
  // Asset & Strategy Management
  // ----------------------------------------------------------------

  setActiveAssets(assets: AssetInfo[]): void {
    this.activeAssets = assets;
    log.info({ count: assets.length }, 'Active assets updated');
  }

  getActiveAssets(): AssetInfo[] {
    return this.activeAssets;
  }

  setActiveStrategies(strategies: string[]): void {
    this.activeStrategies = strategies;
    log.info({ strategies }, 'Active strategies updated');
  }

  getActiveStrategies(): string[] {
    return this.activeStrategies;
  }

  // ----------------------------------------------------------------
  // Cycle Control
  // ----------------------------------------------------------------

  isPaused(): boolean { return this.paused; }
  pause(reason: string): void {
    this.paused = true;
    log.warn({ reason }, 'CEO PAUSED all trading');
  }
  resume(reason: string): void {
    this.paused = false;
    log.info({ reason }, 'CEO RESUMED trading');
  }

  incrementCycle(): number { return ++this.cycleCount; }
  getCycleCount(): number { return this.cycleCount; }

  // ----------------------------------------------------------------
  // Dashboard — CEO's view of the entire system
  // ----------------------------------------------------------------

  getDashboard(portfolio?: Portfolio): CEODashboard {
    return {
      teams: this.getAllTeams(),
      activeAssets: this.activeAssets.map(a => a.symbol),
      activeStrategies: this.activeStrategies,
      totalAgents: [...this.teams.values()].reduce((sum, t) => sum + t.memberIds.length, 0),
      totalCapital: portfolio?.capital ?? 0,
      dailyPnl: portfolio?.totalPnl ?? 0,
      openPositions: portfolio?.positions.filter(p => p.status === 'open').length ?? 0,
      pendingRequests: this.pendingRequests.map(r => r.payload),
      systemHealth: 100, // updated by ops team
      lastCycleAt: Date.now(),
    };
  }

  getPendingRequests() {
    return [...this.pendingRequests];
  }

  // ----------------------------------------------------------------
  // Reporting
  // ----------------------------------------------------------------

  formatReport(portfolio?: Portfolio): string {
    const dash = this.getDashboard(portfolio);
    const lines = [
      '\n=== CEO DASHBOARD ===\n',
      `Cycle: ${this.cycleCount} | Status: ${this.paused ? 'PAUSED' : 'ACTIVE'}`,
      `Agents: ${dash.totalAgents} across ${dash.teams.length} teams`,
      `Assets: ${dash.activeAssets.length} active`,
      `Strategies: ${dash.activeStrategies.join(', ') || 'none'}`,
      `Capital: $${dash.totalCapital.toFixed(2)} | PnL: $${dash.dailyPnl.toFixed(2)}`,
      `Open Positions: ${dash.openPositions}`,
      `Pending Requests: ${dash.pendingRequests.length}`,
      `Discussions: ${this.discussions.size} threads`,
      '',
      'Teams:',
    ];

    for (const team of dash.teams) {
      const prompt = this.teamPrompts.get(team.id as TeamId);
      lines.push(`  ${team.name} (${team.id}): ${team.memberIds.length} agents`);
      if (prompt) {
        lines.push(`    Mission: ${prompt.mission}`);
      }
    }

    return lines.join('\n');
  }
}
