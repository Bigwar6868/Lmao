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
import type { AssetInfo, Portfolio, MacroEnvironment, Strategy } from '../../shared/types.js';
import { generateId } from '../../shared/utils.js';
import { createModuleLogger } from '../../shared/logger.js';
import { AgentBrain, OllamaProvider, type LLMProvider, type BrainContext, type ThoughtChain } from '../../shared/agent-brain.js';
import type { AgentNetwork } from '../agent-network/network.js';
import type { QuantReport } from '../quant-modules/manager.js';

/** Per-strategy performance tracked by the CEO */
export interface StrategyPerformance {
  strategy: string;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  maxDrawdown: number;
  enabled: boolean;
  disabledReason?: string;
  lastReviewedAt: number;
}

/** Result of CEO profitability review */
export interface ProfitabilityReview {
  overallPnl: number;
  overallWinRate: number;
  strategyPerformance: StrategyPerformance[];
  disabled: string[];
  reEnabled: string[];
  topPerformer: string | null;
  worstPerformer: string | null;
  isProfitable: boolean;
  recommendations: string[];
}

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

  /** CEO's AI brain — powered by Ollama (MiniMax M2.7) or Claude SDK */
  readonly brain: AgentBrain;
  private lastPortfolio?: Portfolio;
  private lastMacro?: MacroEnvironment;
  private lastQuantReport?: QuantReport;

  constructor(network: AgentNetwork, llmProvider?: LLMProvider) {
    this.id = generateId();
    this.network = network;
    this.network.register(this.id);

    // Initialize CEO brain — defaults to Ollama if OLLAMA_CEO_ENDPOINT is set
    const provider = llmProvider ?? (
      process.env.OLLAMA_CEO_ENDPOINT || process.env.OLLAMA_ENDPOINT
        ? new OllamaProvider()
        : undefined
    );
    this.brain = new AgentBrain(this.id, 'ceo', 'CEO Agent', provider);

    // CEO listens to all messages
    this.network.on(this.id, 'request', (msg) => this.handleRequest(msg));
    this.network.on(this.id, 'report', (msg) => this.handleReport(msg));
    this.network.on(this.id, 'alert', (msg) => this.handleAlert(msg));
    this.network.on(this.id, 'discuss', (msg) => this.handleDiscussion(msg));

    log.info({
      id: this.id,
      brain: provider ? `${provider.name}/${provider.model}` : 'rule-based (no LLM)',
    }, 'CEO Agent initialized');
  }

  /** Update the context the CEO brain uses for decisions */
  updateContext(portfolio?: Portfolio, macro?: MacroEnvironment, quantReport?: QuantReport): void {
    if (portfolio) this.lastPortfolio = portfolio;
    if (macro) this.lastMacro = macro;
    if (quantReport) this.lastQuantReport = quantReport;
  }

  /** Build rich context for the CEO brain */
  private getBrainContext(extra?: Record<string, unknown>): BrainContext {
    return {
      mission: 'MISSION #1: MAKE THE TEAM PROFITABLE. Disable losing strategies, double down on winners. Maximize risk-adjusted returns while preserving capital.',
      portfolio: this.lastPortfolio ? {
        capital: this.lastPortfolio.capital,
        totalPnl: this.lastPortfolio.totalPnl,
        openPositions: this.lastPortfolio.positions.filter(p => p.status === 'open').length,
        winRate: this.lastPortfolio.positions.length > 0
          ? this.lastPortfolio.positions.filter(p => p.realizedPnl > 0).length / Math.max(1, this.lastPortfolio.positions.filter(p => p.status === 'closed').length)
          : 0,
      } : undefined,
      macro: this.lastMacro,
      customData: {
        cycleCount: this.cycleCount,
        paused: this.paused,
        totalAgents: [...this.teams.values()].reduce((sum, t) => sum + t.memberIds.length, 0),
        teamCount: this.teams.size,
        pendingRequests: this.pendingRequests.length,
        activeStrategies: this.activeStrategies,
        // Quant module intelligence
        ...(this.lastQuantReport ? {
          quantModules: {
            regime: this.lastQuantReport.hmmRegime.currentState,
            regimeConfidence: this.lastQuantReport.hmmRegime.probabilities,
            regimeTransition: this.lastQuantReport.hmmRegime.transitionAlert,
            icHealth: this.lastQuantReport.icHealth.map(h => ({
              strategy: h.strategy,
              health: h.health,
              rollingIC6m: h.rollingIC6m,
              rollingIC12m: h.rollingIC12m,
            })),
            mrSuitablePairs: this.lastQuantReport.halfLifeResults.filter(r => r.suitableForMR).length,
            totalPairsAnalyzed: this.lastQuantReport.halfLifeResults.length,
            activeModules: this.lastQuantReport.moduleDecisions.filter(d => d.active).map(d => d.module),
            signalsBeforeQuant: this.lastQuantReport.adjustedSignals.length,
            crowdedAssets: this.lastQuantReport.crowding?.filter(c => c.isCrowded).length ?? 0,
            carrySignals: this.lastQuantReport.carrySignals?.length ?? 0,
            cotExtremes: this.lastQuantReport.cotSignals?.length ?? 0,
          },
        } : {}),
        ...extra,
      },
    };
  }

  /**
   * Ask the CEO brain to think about a strategic question.
   * Uses MiniMax M2.7 via Ollama if configured, otherwise rule-based.
   */
  async think(question: string, extra?: Record<string, unknown>): Promise<ThoughtChain> {
    return this.brain.thinkAsync(question, this.getBrainContext(extra));
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

    // If we have an LLM brain, use it for all decisions
    const hasLLM = this.brain.getLLMProvider() !== null;
    if (hasLLM) {
      await this.llmDecide(request);
      return;
    }

    // Fallback: hardcoded rules when no LLM available
    switch (payload.requestType) {
      case 'spawn-agent': {
        const totalAgents = [...this.teams.values()].reduce((sum, t) => sum + t.memberIds.length, 0);
        if (totalAgents < 30) {
          await this.approve(request.id, request.from, 'Agent count within limits');
        } else {
          await this.vetoRequest(request.id, request.from, 'Too many agents already active');
        }
        break;
      }
      case 'new-asset': {
        await this.approve(request.id, request.from, 'Adding asset to active list');
        const asset = payload.data.asset as AssetInfo | undefined;
        if (asset) this.activeAssets.push(asset);
        break;
      }
      case 'evolution': {
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
        log.info({ requestType: payload.requestType }, 'Request queued for review');
      }
    }
  }

  /**
   * LLM-powered decision making — the CEO brain (MiniMax M2.7 via Ollama)
   * analyzes the request with full system context and decides.
   */
  private async llmDecide(request: { id: string; from: AgentId; payload: RequestPayload }): Promise<void> {
    const { payload } = request;
    const totalAgents = [...this.teams.values()].reduce((sum, t) => sum + t.memberIds.length, 0);

    try {
      const chain = await this.brain.thinkAsync(
        `A team member requests: "${payload.requestType}" — "${payload.description}". Reason: "${payload.reason}". Should I APPROVE or VETO?`,
        this.getBrainContext({
          requestType: payload.requestType,
          requestData: payload.data,
          requestReason: payload.reason,
          totalAgents,
          maxAgents: 30,
        }),
      );

      const decision = chain.decision.toUpperCase();
      const isApprove = decision.includes('APPROVE') || decision.includes('YES') || decision.includes('ACCEPT');
      const isVeto = decision.includes('VETO') || decision.includes('DENY') || decision.includes('REJECT') || decision.includes('NO');

      log.info({
        requestType: payload.requestType,
        llmDecision: chain.decision,
        confidence: chain.confidence,
        reasoning: chain.reasoning.slice(0, 200),
        provider: (chain as ThoughtChain & { llmProvider?: string }).llmProvider,
      }, 'CEO brain decision');

      if (isApprove && !isVeto) {
        await this.approve(request.id, request.from, `[LLM] ${chain.reasoning.slice(0, 150)}`);

        // Execute side effects based on request type
        if (payload.requestType === 'new-asset') {
          const asset = payload.data.asset as AssetInfo | undefined;
          if (asset) this.activeAssets.push(asset);
        } else if (payload.requestType === 'evolution') {
          await this.issueDirective('evolve', 'evolution', payload.data, payload.reason);
        } else if (payload.requestType === 'decrease-risk') {
          await this.issueDirective('adjust-risk', 'risk', { action: 'decrease', ...payload.data }, payload.reason, 'urgent');
        }
      } else if (isVeto) {
        await this.vetoRequest(request.id, request.from, `[LLM] ${chain.reasoning.slice(0, 150)}`);
      } else {
        // Ambiguous response — fall back to safe defaults
        log.warn({ decision: chain.decision }, 'CEO brain gave ambiguous response — using safe default');
        if (payload.requestType === 'decrease-risk') {
          await this.approve(request.id, request.from, 'Risk reduction auto-approved (safety default)');
          await this.issueDirective('adjust-risk', 'risk', { action: 'decrease', ...payload.data }, payload.reason, 'urgent');
        } else {
          log.info({ requestType: payload.requestType }, 'Request queued for review (ambiguous LLM response)');
        }
      }
    } catch (err) {
      log.error({ error: (err as Error).message, requestType: payload.requestType }, 'CEO brain failed — falling back to rules');
      // Re-run with hardcoded logic by temporarily nullifying the check
      const provider = this.brain.getLLMProvider();
      if (provider) {
        // Temporarily bypass LLM for this request by using hardcoded path
        switch (payload.requestType) {
          case 'decrease-risk':
            await this.approve(request.id, request.from, 'Risk reduction approved (LLM fallback)');
            await this.issueDirective('adjust-risk', 'risk', { action: 'decrease', ...payload.data }, payload.reason, 'urgent');
            break;
          case 'evolution':
            await this.approve(request.id, request.from, 'Evolution approved (LLM fallback)');
            break;
          default:
            log.info({ requestType: payload.requestType }, 'Request queued (LLM unavailable)');
        }
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

    // React to critical reports — use brain if available
    if (payload.reportType === 'risk-alert') {
      const hasLLM = this.brain.getLLMProvider() !== null;
      if (hasLLM) {
        // Let the brain decide how to respond to risk alerts
        void this.brain.thinkAsync(
          `URGENT: Risk alert received: "${payload.summary}". Data: ${JSON.stringify(payload.data)}. Should I pause trading, reduce exposure, or monitor?`,
          this.getBrainContext({ riskAlert: payload }),
        ).then(chain => {
          const decision = chain.decision.toUpperCase();
          if (decision.includes('PAUSE') || decision.includes('STOP') || decision.includes('HALT')) {
            void this.issueDirective('pause-trading', 'trading', payload.data, `[LLM] ${chain.reasoning.slice(0, 150)}`, 'urgent');
          } else if (decision.includes('REDUCE') || decision.includes('DECREASE')) {
            void this.issueDirective('adjust-risk', 'risk', { action: 'decrease', ...payload.data }, `[LLM] ${chain.reasoning.slice(0, 150)}`, 'urgent');
          } else {
            log.info({ decision: chain.decision }, 'CEO brain advises monitoring risk (no action)');
          }
        }).catch(() => {
          // Fallback: always pause on risk alert
          void this.issueDirective('pause-trading', 'trading', payload.data, `Risk alert: ${payload.summary}`, 'urgent');
        });
      } else {
        void this.issueDirective('pause-trading', 'trading', payload.data, `Risk alert: ${payload.summary}`, 'urgent');
      }
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
  // PROFITABILITY MISSION — CEO's #1 priority
  // ----------------------------------------------------------------

  /** Track which strategies are disabled by the CEO */
  private disabledStrategies = new Set<string>();

  /** Minimum trades before the CEO judges a strategy */
  private readonly MIN_TRADES_TO_JUDGE = 5;

  /** Consecutive loss threshold to disable a strategy */
  private readonly MAX_LOSS_STREAK_BEFORE_DISABLE = 8;

  /** Negative P&L % of capital threshold to disable */
  private readonly DISABLE_PNL_THRESHOLD = -0.03; // -3% of capital

  /**
   * CEO's primary mission: review all strategy profitability and take action.
   * Disables losers, re-enables recovered strategies, reports rankings.
   *
   * Call this every N cycles from the orchestrator.
   */
  profitabilityReview(portfolio: Portfolio, strategies: Strategy[]): ProfitabilityReview {
    const closedPositions = portfolio.positions.filter(p => p.status === 'closed');
    const capital = portfolio.capital;

    // 1. Aggregate per-strategy stats
    const stratMap = new Map<string, { trades: number; wins: number; pnl: number; pnls: number[] }>();
    for (const pos of closedPositions) {
      const s = stratMap.get(pos.strategy) ?? { trades: 0, wins: 0, pnl: 0, pnls: [] };
      s.trades++;
      if (pos.realizedPnl > 0) s.wins++;
      s.pnl += pos.realizedPnl;
      s.pnls.push(pos.realizedPnl);
      stratMap.set(pos.strategy, s);
    }

    const perfList: StrategyPerformance[] = [];
    const disabled: string[] = [];
    const reEnabled: string[] = [];

    for (const strategy of strategies) {
      const stats = stratMap.get(strategy.name);
      const trades = stats?.trades ?? 0;
      const wins = stats?.wins ?? 0;
      const pnl = stats?.pnl ?? 0;
      const winRate = trades > 0 ? wins / trades : 0;

      // Max drawdown for this strategy
      let peak = 0;
      let maxDD = 0;
      const pnls = stats?.pnls ?? [];
      let cumPnl = 0;
      for (const p of pnls) {
        cumPnl += p;
        if (cumPnl > peak) peak = cumPnl;
        const dd = peak - cumPnl;
        if (dd > maxDD) maxDD = dd;
      }

      const wasEnabled = strategy.config.enabled;
      const wasDisabledByCeo = this.disabledStrategies.has(strategy.name);
      let shouldDisable = false;
      let shouldReEnable = false;
      let disabledReason: string | undefined;

      // Decision logic — only judge strategies with enough trades
      if (trades >= this.MIN_TRADES_TO_JUDGE) {
        // Disable: negative P&L exceeding threshold
        if (pnl < capital * this.DISABLE_PNL_THRESHOLD && !wasDisabledByCeo) {
          shouldDisable = true;
          disabledReason = `P&L $${pnl.toFixed(2)} exceeds ${(this.DISABLE_PNL_THRESHOLD * 100).toFixed(0)}% of capital`;
        }

        // Disable: win rate below 25% with enough trades
        if (winRate < 0.25 && trades >= 10 && !wasDisabledByCeo) {
          shouldDisable = true;
          disabledReason = `Win rate ${(winRate * 100).toFixed(0)}% critically low (${wins}/${trades})`;
        }

        // Re-enable: was disabled but recent trades are profitable
        if (wasDisabledByCeo && trades >= this.MIN_TRADES_TO_JUDGE) {
          // Check last 5 trades
          const recentPnls = pnls.slice(-5);
          const recentPnl = recentPnls.reduce((a, b) => a + b, 0);
          const recentWins = recentPnls.filter(p => p > 0).length;
          if (recentPnl > 0 && recentWins >= 3) {
            shouldReEnable = true;
          }
        }
      }

      // Apply decisions
      if (shouldDisable && !wasDisabledByCeo) {
        strategy.config.enabled = false;
        this.disabledStrategies.add(strategy.name);
        disabled.push(strategy.name);
        log.warn({ strategy: strategy.name, pnl, winRate, trades, reason: disabledReason },
          'CEO DISABLED underperforming strategy');
      }

      if (shouldReEnable && wasDisabledByCeo) {
        strategy.config.enabled = true;
        this.disabledStrategies.delete(strategy.name);
        reEnabled.push(strategy.name);
        disabledReason = undefined;
        log.info({ strategy: strategy.name, pnl, winRate, trades },
          'CEO RE-ENABLED recovered strategy');
      }

      perfList.push({
        strategy: strategy.name,
        totalTrades: trades,
        wins,
        losses: trades - wins,
        winRate,
        totalPnl: pnl,
        avgPnl: trades > 0 ? pnl / trades : 0,
        maxDrawdown: maxDD,
        enabled: strategy.config.enabled,
        disabledReason: wasDisabledByCeo && !shouldReEnable ? disabledReason ?? 'Previously disabled by CEO' : disabledReason,
        lastReviewedAt: Date.now(),
      });
    }

    // Sort by P&L — best first
    perfList.sort((a, b) => b.totalPnl - a.totalPnl);

    const overallPnl = closedPositions.reduce((s, p) => s + p.realizedPnl, 0);
    const overallWins = closedPositions.filter(p => p.realizedPnl > 0).length;
    const overallWinRate = closedPositions.length > 0 ? overallWins / closedPositions.length : 0;
    const topPerformer = perfList.find(p => p.totalTrades >= this.MIN_TRADES_TO_JUDGE)?.strategy ?? null;
    const worstPerformer = perfList.filter(p => p.totalTrades >= this.MIN_TRADES_TO_JUDGE).pop()?.strategy ?? null;

    // Build recommendations
    const recommendations: string[] = [];
    if (overallPnl < 0) {
      recommendations.push('System is unprofitable — tighten entry criteria and widen stops');
    }
    if (overallWinRate < 0.4) {
      recommendations.push('Overall win rate below 40% — review signal quality filters');
    }
    const enabledCount = perfList.filter(p => p.enabled).length;
    if (enabledCount < 3) {
      recommendations.push(`Only ${enabledCount} strategies active — consider evolving new variants`);
    }
    if (disabled.length > 0) {
      recommendations.push(`Disabled ${disabled.length} strategies this review: ${disabled.join(', ')}`);
    }
    if (reEnabled.length > 0) {
      recommendations.push(`Re-enabled ${reEnabled.length} recovered strategies: ${reEnabled.join(', ')}`);
    }
    if (topPerformer) {
      const topPerf = perfList.find(p => p.strategy === topPerformer)!;
      if (topPerf.totalPnl > 0) {
        recommendations.push(`Top performer: ${topPerformer} ($${topPerf.totalPnl.toFixed(2)}, ${(topPerf.winRate * 100).toFixed(0)}% WR) — consider increasing allocation`);
      }
    }

    const review: ProfitabilityReview = {
      overallPnl,
      overallWinRate,
      strategyPerformance: perfList,
      disabled,
      reEnabled,
      topPerformer,
      worstPerformer,
      isProfitable: overallPnl > 0,
      recommendations,
    };

    // Issue directives based on review
    if (disabled.length > 0) {
      void this.issueDirective('adjust-strategies', 'trading', {
        action: 'disable',
        strategies: disabled,
      }, `CEO disabled unprofitable strategies: ${disabled.join(', ')}`, 'urgent');
    }

    log.info({
      overallPnl: overallPnl.toFixed(2),
      winRate: (overallWinRate * 100).toFixed(0) + '%',
      enabled: enabledCount,
      disabled: disabled.length,
      reEnabled: reEnabled.length,
      isProfitable: review.isProfitable,
    }, 'CEO profitability review complete');

    return review;
  }

  /**
   * Format the profitability review for display.
   */
  static formatProfitabilityReview(review: ProfitabilityReview): string {
    const lines: string[] = [
      '\n=== CEO PROFITABILITY REVIEW ===\n',
      `Overall: ${review.isProfitable ? 'PROFITABLE' : 'UNPROFITABLE'} | PnL: $${review.overallPnl.toFixed(2)} | Win Rate: ${(review.overallWinRate * 100).toFixed(1)}%`,
      '',
      'Strategy Rankings:',
    ];

    for (const p of review.strategyPerformance) {
      const status = p.enabled ? '  ' : 'X ';
      const pnlStr = p.totalPnl >= 0 ? `+$${p.totalPnl.toFixed(2)}` : `-$${Math.abs(p.totalPnl).toFixed(2)}`;
      lines.push(
        `  ${status}${p.strategy.padEnd(22)} | ${p.totalTrades.toString().padStart(3)} trades | ` +
        `WR: ${(p.winRate * 100).toFixed(0).padStart(3)}% | PnL: ${pnlStr.padStart(10)} | ` +
        `Avg: $${p.avgPnl.toFixed(2)} | DD: $${p.maxDrawdown.toFixed(2)}`,
      );
      if (p.disabledReason) {
        lines.push(`       DISABLED: ${p.disabledReason}`);
      }
    }

    if (review.recommendations.length > 0) {
      lines.push('');
      lines.push('CEO Recommendations:');
      for (const rec of review.recommendations) {
        lines.push(`  - ${rec}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Get the set of strategies the CEO has disabled.
   */
  getDisabledStrategies(): Set<string> {
    return new Set(this.disabledStrategies);
  }

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
    const provider = this.brain.getLLMProvider();
    const lastThought = this.brain.getLastThought();
    const lines = [
      '\n=== CEO DASHBOARD ===\n',
      `Cycle: ${this.cycleCount} | Status: ${this.paused ? 'PAUSED' : 'ACTIVE'}`,
      `Brain: ${provider ? `${provider.name}/${provider.model}` : 'rule-based'} | AI: ${this.brain.isAIAvailable() ? 'ON' : 'OFF'}`,
      ...(lastThought ? [`Last thought: "${lastThought.decision.slice(0, 80)}" (${(lastThought.confidence * 100).toFixed(0)}% conf, ${lastThought.durationMs}ms)`] : []),
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

    // Disabled strategies
    if (this.disabledStrategies.size > 0) {
      lines.push('');
      lines.push(`CEO Disabled Strategies: ${[...this.disabledStrategies].join(', ')}`);
    }

    // Quant module intelligence
    if (this.lastQuantReport) {
      const qr = this.lastQuantReport;
      lines.push('');
      lines.push('Quant Intelligence:');
      lines.push(`  Regime: ${qr.hmmRegime.currentState.toUpperCase()} (bull: ${(qr.hmmRegime.probabilities.bull * 100).toFixed(0)}%, bear: ${(qr.hmmRegime.probabilities.bear * 100).toFixed(0)}%, sideways: ${(qr.hmmRegime.probabilities.sideways * 100).toFixed(0)}%)`);
      if (qr.hmmRegime.transitionAlert) {
        lines.push(`  Regime Alert: ${qr.hmmRegime.transitionAlert}`);
      }

      // IC Health summary
      const healthyCt = qr.icHealth.filter(h => h.health === 'healthy').length;
      const warningCt = qr.icHealth.filter(h => h.health === 'warning').length;
      const criticalCt = qr.icHealth.filter(h => h.health === 'critical' || h.health === 'dead').length;
      if (qr.icHealth.length > 0) {
        lines.push(`  Strategy Health: ${healthyCt} healthy, ${warningCt} warning, ${criticalCt} critical`);
        for (const h of qr.icHealth) {
          if (h.health !== 'healthy') {
            lines.push(`    [${h.health.toUpperCase()}] ${h.strategy} — IC6m: ${h.rollingIC6m?.toFixed(3) ?? 'N/A'}, IC12m: ${h.rollingIC12m?.toFixed(3) ?? 'N/A'}`);
          }
        }
      }

      // OU Half-Life
      const mrSuitable = qr.halfLifeResults.filter(r => r.suitableForMR).length;
      if (qr.halfLifeResults.length > 0) {
        lines.push(`  Mean-Reversion: ${mrSuitable}/${qr.halfLifeResults.length} pairs suitable (OU half-life)`);
      }

      // Active optional modules
      const activeModules = qr.moduleDecisions.filter(d => d.active).map(d => d.module);
      const inactiveModules = qr.moduleDecisions.filter(d => !d.active).map(d => d.module);
      lines.push(`  Active Modules: ${activeModules.length > 0 ? activeModules.join(', ') : 'none'}`);
      if (inactiveModules.length > 0) {
        lines.push(`  Inactive: ${inactiveModules.join(', ')}`);
      }

      // Carry/COT highlights
      if (qr.carrySignals && qr.carrySignals.length > 0) {
        lines.push(`  Carry Signals: ${qr.carrySignals.length} active`);
      }
      if (qr.cotSignals && qr.cotSignals.length > 0) {
        lines.push(`  COT Extremes: ${qr.cotSignals.length} pairs with extreme positioning`);
      }
      if (qr.crowding) {
        const crowded = qr.crowding.filter(c => c.isCrowded);
        if (crowded.length > 0) {
          lines.push(`  Crowding: ${crowded.length} assets crowded (position size reduced)`);
        }
      }
    }

    return lines.join('\n');
  }
}
