// ============================================================
// TeamBase — base class for all teams
//
// Every team now has:
//   - A Brain (structured reasoning, no API)
//   - A Loop (autonomous 24/7 lifecycle with idle states)
//   - Visible feedback of all thinking and actions
// ============================================================

import type {
  AgentId,
  TeamId,
  TeamConfig,
  TeamPrompt,
  AgentMessage,
  RequestPayload,
  ReportPayload,
  DiscussPayload,
  QuestionPayload,
  AnswerPayload,
  DirectivePayload,
  ApprovalPayload,
  VetoPayload,
  RequestType,
} from '../../shared/agent-types.js';
import { generateId } from '../../shared/utils.js';
import { createModuleLogger } from '../../shared/logger.js';
import { AgentBrain, type BrainContext, type BrainRole } from '../../shared/agent-brain.js';
import { AgentLoop, type AgentLoopConfig } from '../../shared/agent-loop.js';
import { createFeedbackHandler, printThinking } from '../../shared/live-feed.js';
import type { AgentNetwork } from '../agent-network/network.js';

/**
 * Base class for all teams.
 *
 * Every team has:
 *  - A team lead agent (registered on the network)
 *  - Member agents
 *  - Ability to send reports/requests to CEO
 *  - Ability to discuss with any other agent (cross-team)
 *  - Ability to handle directives from CEO
 */
export abstract class TeamBase {
  readonly teamId: TeamId;
  readonly teamName: string;
  readonly leadId: AgentId;
  protected network: AgentNetwork;
  protected ceoId: AgentId;
  protected memberIds: AgentId[] = [];
  protected currentPrompt: TeamPrompt | null = null;
  protected log;

  // Brain & Loop — every team has autonomous thinking and lifecycle
  readonly brain: AgentBrain;
  readonly loop: AgentLoop;

  constructor(opts: {
    teamId: TeamId;
    teamName: string;
    network: AgentNetwork;
    ceoId: AgentId;
  }) {
    this.teamId = opts.teamId;
    this.teamName = opts.teamName;
    this.network = opts.network;
    this.ceoId = opts.ceoId;
    this.leadId = generateId();
    this.log = createModuleLogger(`team:${opts.teamId}`);

    // Brain — structured reasoning engine (no API calls)
    const brainRole = this.getBrainRole();
    this.brain = new AgentBrain(this.leadId, brainRole, opts.teamName);

    // Loop — autonomous 24/7 event-driven lifecycle
    this.loop = new AgentLoop(
      this.leadId,
      opts.teamName,
      opts.teamId,
      this.brain,
      this.getLoopConfig(),
    );
    this.loop.setFeedback(createFeedbackHandler());
    this.loop.setContextProvider(() => this.getBrainContext());
    this.loop.onMessage(async (msg) => this.handleLoopMessage(msg));
    this.loop.onExplore(async (brain, ctx) => this.handleIdleExplore(brain, ctx));

    // Register team lead on network
    this.network.register(this.leadId);

    // Listen for CEO directives
    this.network.on(this.leadId, 'directive', (msg) => this.onDirective(msg));
    this.network.on(this.leadId, 'approval', (msg) => this.onApproval(msg));
    this.network.on(this.leadId, 'veto', (msg) => this.onVeto(msg));

    // Listen for cross-team discussion
    this.network.on(this.leadId, 'discuss', (msg) => this.onDiscuss(msg));
    this.network.on(this.leadId, 'question', (msg) => this.onQuestion(msg));
    this.network.on(this.leadId, 'answer', (msg) => this.onAnswer(msg));

    // Listen for requests from other teams
    this.network.on(this.leadId, 'request', (msg) => this.onRequest(msg));

    this.log.info({ leadId: this.leadId, team: this.teamId }, 'Team initialized with brain + loop');
  }

  /** Brain role for this team — subclasses can override */
  protected getBrainRole(): BrainRole {
    const roleMap: Record<TeamId, BrainRole> = {
      ceo: 'ceo',
      trading: 'trader',
      research: 'researcher',
      risk: 'risk-manager',
      evolution: 'evolutionist',
      ops: 'ops',
    };
    return roleMap[this.teamId] ?? 'ops';
  }

  /** Loop config — subclasses can override for custom timing */
  protected getLoopConfig(): Partial<AgentLoopConfig> {
    return {
      tickIntervalMs: 2_000,
      idleCooldownMs: 30_000,
      exploreProbability: 0.2,
    };
  }

  /** Provide current context to the brain for reasoning */
  protected getBrainContext(): BrainContext {
    return {
      mission: this.getMission(),
      prompt: this.currentPrompt,
    };
  }

  /** Handle messages routed through the loop */
  protected async handleLoopMessage(msg: AgentMessage): Promise<void> {
    // Default: delegate to existing message handlers
    switch (msg.type) {
      case 'directive': this.onDirective(msg); break;
      case 'approval': this.onApproval(msg); break;
      case 'veto': this.onVeto(msg); break;
      case 'discuss': this.onDiscuss(msg); break;
      case 'question': this.onQuestion(msg); break;
      case 'answer': this.onAnswer(msg); break;
      case 'request': this.onRequest(msg); break;
    }
  }

  /** What to do when idle — subclasses override for proactive exploration */
  protected async handleIdleExplore(_brain: AgentBrain, _ctx: BrainContext): Promise<void> {
    // Default: no-op. Subclasses implement proactive data exploration.
  }

  /**
   * Think about something and show it in the live feed.
   * Available to all teams for visible reasoning.
   */
  protected think(question: string, extraContext?: Partial<BrainContext>) {
    const ctx = { ...this.getBrainContext(), ...extraContext };
    const chain = this.brain.think(question, ctx);
    printThinking(this.teamName, chain);
    return chain;
  }

  /** Start the autonomous loop */
  startLoop(): void {
    this.loop.start();
  }

  /** Stop the autonomous loop */
  stopLoop(): void {
    this.loop.stop();
  }

  // ----------------------------------------------------------------
  // Team Config (for CEO registration)
  // ----------------------------------------------------------------

  getConfig(): TeamConfig {
    return {
      id: this.teamId,
      name: this.teamName,
      leadId: this.leadId,
      memberIds: [this.leadId, ...this.memberIds],
      description: this.getDescription(),
    };
  }

  protected abstract getDescription(): string;

  // ----------------------------------------------------------------
  // Upward Communication — report to CEO, request resources
  // ----------------------------------------------------------------

  async reportToCeo(
    reportType: ReportPayload['reportType'],
    summary: string,
    data: Record<string, unknown> = {},
  ): Promise<void> {
    await this.network.unicast(this.leadId, this.ceoId, 'report', {
      type: 'report',
      reportType,
      summary,
      data,
    } satisfies ReportPayload);
  }

  async requestFromCeo(
    requestType: RequestType,
    description: string,
    reason: string,
    data: Record<string, unknown> = {},
  ): Promise<void> {
    await this.network.unicast(this.leadId, this.ceoId, 'request', {
      type: 'request',
      requestType,
      description,
      reason,
      data,
    } satisfies RequestPayload);
  }

  // ----------------------------------------------------------------
  // Cross-Team Discussion — any agent can talk to any agent
  // ----------------------------------------------------------------

  async startDiscussion(
    topic: string,
    content: string,
    withAgent?: AgentId,
    data?: Record<string, unknown>,
  ): Promise<string> {
    const threadId = generateId();
    const target = withAgent ?? 'all';

    if (target === 'all') {
      await this.network.broadcast(this.leadId, 'discuss', {
        type: 'discuss',
        threadId,
        topic,
        content,
        data,
      } satisfies DiscussPayload);
    } else {
      await this.network.unicast(this.leadId, target, 'discuss', {
        type: 'discuss',
        threadId,
        topic,
        content,
        data,
      } satisfies DiscussPayload);
    }

    return threadId;
  }

  async askAgent(
    targetAgent: AgentId,
    question: string,
    threadId?: string,
    context?: Record<string, unknown>,
  ): Promise<void> {
    await this.network.unicast(this.leadId, targetAgent, 'question', {
      type: 'question',
      threadId: threadId ?? generateId(),
      question,
      context,
    } satisfies QuestionPayload);
  }

  async answerAgent(
    targetAgent: AgentId,
    questionId: string,
    answer: string,
    threadId?: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    await this.network.unicast(this.leadId, targetAgent, 'answer', {
      type: 'answer',
      threadId: threadId ?? generateId(),
      questionId,
      answer,
      data,
    } satisfies AnswerPayload);
  }

  // ----------------------------------------------------------------
  // Handlers — subclasses override these
  // ----------------------------------------------------------------

  protected onDirective(msg: AgentMessage): void {
    const directive = msg.payload as DirectivePayload;

    // Intercept prompt assignments — store before forwarding
    if (directive.directiveType === 'set-prompt' && directive.targetTeam === this.teamId) {
      const p = directive.params;
      this.currentPrompt = {
        teamId: this.teamId,
        mission: p.mission as string,
        objectives: (p.objectives as string[]) ?? [],
        constraints: (p.constraints as string[]) ?? [],
        focus: p.focus as Record<string, unknown> | undefined,
        issuedAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.log.info({ mission: this.currentPrompt.mission }, 'Team prompt updated by CEO');
    }

    this.log.info({
      directive: directive.directiveType,
      priority: directive.priority,
      reason: directive.reason,
    }, 'Received CEO directive');
    this.handleDirective(directive);
  }

  protected onApproval(msg: AgentMessage): void {
    const approval = msg.payload as ApprovalPayload;
    this.log.info({ requestId: approval.requestId.slice(0, 8), reason: approval.reason }, 'Request approved by CEO');
    this.handleApproval(approval);
  }

  protected onVeto(msg: AgentMessage): void {
    const veto = msg.payload as VetoPayload;
    this.log.warn({ requestId: veto.requestId.slice(0, 8), reason: veto.reason }, 'Request vetoed by CEO');
  }

  protected onDiscuss(msg: AgentMessage): void {
    const payload = msg.payload as DiscussPayload;
    this.log.debug({ from: msg.from.slice(0, 8), topic: payload.topic }, 'Discussion message received');
  }

  protected onQuestion(msg: AgentMessage): void {
    const payload = msg.payload as QuestionPayload;
    this.log.debug({ from: msg.from.slice(0, 8), question: payload.question }, 'Question received');
    this.handleQuestion(msg.from, payload);
  }

  protected onAnswer(msg: AgentMessage): void {
    const payload = msg.payload as AnswerPayload;
    this.log.debug({ from: msg.from.slice(0, 8), answer: payload.answer }, 'Answer received');
  }

  protected onRequest(msg: AgentMessage): void {
    const payload = msg.payload as RequestPayload;
    this.log.debug({ from: msg.from.slice(0, 8), requestType: payload.requestType }, 'Request received from another team');
    this.handleInterTeamRequest(msg.from, payload);
  }

  // Subclass hooks
  protected handleDirective(_directive: DirectivePayload): void { /* override */ }
  protected handleApproval(_approval: ApprovalPayload): void { /* override */ }
  protected handleQuestion(_from: AgentId, _payload: QuestionPayload): void { /* override */ }
  protected handleInterTeamRequest(_from: AgentId, _payload: RequestPayload): void { /* override */ }

  // ----------------------------------------------------------------
  // Prompt / Mission
  // ----------------------------------------------------------------

  getPrompt(): TeamPrompt | null {
    return this.currentPrompt;
  }

  getMission(): string {
    return this.currentPrompt?.mission ?? this.getDescription();
  }

  // ----------------------------------------------------------------
  // Members
  // ----------------------------------------------------------------

  addMember(agentId: AgentId): void {
    this.memberIds.push(agentId);
  }

  removeMember(agentId: AgentId): void {
    this.memberIds = this.memberIds.filter(id => id !== agentId);
  }

  getMembers(): AgentId[] {
    return [this.leadId, ...this.memberIds];
  }
}
