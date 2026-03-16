// ============================================================
// Trading Team — decides what/when to trade, executes orders
// ============================================================

import type {
  AgentId,
  DirectivePayload,
  ApprovalPayload,
  QuestionPayload,
  RequestPayload,
} from '../../shared/agent-types.js';
import type { Signal, MarketData, MacroEnvironment, Candle } from '../../shared/types.js';
import { withTimeout } from '../../shared/utils.js';
import { config } from '../../config/index.js';
import type { AgentNetwork } from '../agent-network/network.js';
import type { TradingAgent } from '../agent-network/trading-agent.js';
import { ConsensusEngine } from '../agent-network/consensus.js';
import { Executor } from '../executor/index.js';
import { RiskManager } from '../risk-manager/index.js';
import { TeamBase } from './team-base.js';

export class TradingTeam extends TeamBase {
  private agents = new Map<AgentId, TradingAgent>();
  readonly consensus: ConsensusEngine;
  private executor = new Executor();
  private riskManager = new RiskManager();
  private paused = false;

  constructor(network: AgentNetwork, ceoId: AgentId) {
    super({ teamId: 'trading', teamName: 'Trading Team', network, ceoId });
    this.consensus = new ConsensusEngine(network, this.agents);
  }

  protected getDescription(): string {
    return 'Decides what/when to trade, proposes signals, debates, executes orders';
  }

  // ----------------------------------------------------------------
  // Agent Management
  // ----------------------------------------------------------------

  registerAgent(agent: TradingAgent): void {
    this.agents.set(agent.id, agent);
    this.addMember(agent.id);
    this.log.info({ agent: agent.profile.name }, 'Trading agent registered');
  }

  getAgents(): Map<AgentId, TradingAgent> {
    return this.agents;
  }

  getAgent(id: AgentId): TradingAgent | undefined {
    return this.agents.get(id);
  }

  // ----------------------------------------------------------------
  // Core Trading Cycle
  // ----------------------------------------------------------------

  async runCycle(
    marketDataMap: Map<string, MarketData>,
    macro?: MacroEnvironment,
  ): Promise<{
    approvedSignals: Array<{ signal: Signal; confidence: number; proposerId: AgentId }>;
    debateSummary: ReturnType<ConsensusEngine['getRecentSessions']>;
    executed: number;
    rejected: number;
  }> {
    if (this.paused) {
      this.log.warn('Trading paused by CEO — skipping cycle');
      return { approvedSignals: [], debateSummary: [], executed: 0, rejected: 0 };
    }

    // 1. All agents analyze market data in parallel
    const activeAgents = [...this.agents.values()].filter(a => a.getStatus() !== 'retired');
    const dataEntries = [...marketDataMap.values()];
    const analyzeTimeout = config.agentAnalyzeTimeoutMs;

    await Promise.allSettled(
      activeAgents.map(async (agent) => {
        for (const data of dataEntries) {
          try {
            await withTimeout(
              agent.analyze(data, macro),
              analyzeTimeout,
              `agent:${agent.profile.name}:${data.asset.symbol}`,
            );
          } catch (err) {
            this.log.warn({
              agent: agent.profile.name,
              asset: data.asset.symbol,
              err: (err as Error).message,
            }, 'Agent analysis timed out — skipping');
          }
        }
      }),
    );

    // 2. Consensus engine resolves debates
    const verdicts = this.consensus.resolveAll();
    const approvedSignals = this.consensus.getApprovedSignals();
    const debateSummary = this.consensus.getRecentSessions(verdicts.length);

    // 3. Execute approved trades through risk manager
    const portfolio = this.executor.getPortfolio();
    let executed = 0;
    let rejected = 0;

    for (const { signal, confidence, proposerId } of approvedSignals) {
      const candles = marketDataMap.get(signal.asset.symbol)?.candles ?? [];
      if (candles.length < 20) continue;

      const risk = this.riskManager.assessRisk(signal, portfolio, candles, macro);
      if (risk.approved) {
        const result = await this.executor.execute(signal, risk);
        if (result.success) {
          executed++;
          this.log.info({
            symbol: signal.asset.symbol,
            action: signal.action,
            confidence: confidence.toFixed(2),
            proposer: proposerId.slice(0, 8),
          }, 'Trade executed');
        }
      } else {
        rejected++;
      }
    }

    // 4. Report to CEO
    if (executed > 0 || approvedSignals.length > 0) {
      await this.reportToCeo('performance', `Cycle: ${executed} trades executed, ${rejected} risk-rejected`, {
        executed,
        rejected,
        proposals: verdicts.length,
        approved: approvedSignals.length,
      });
    }

    return { approvedSignals, debateSummary, executed, rejected };
  }

  // ----------------------------------------------------------------
  // Price Updates & Stops
  // ----------------------------------------------------------------

  updatePrices(prices: Map<string, number>): void {
    this.executor.updatePrices(prices);
  }

  async checkStops(prices: Map<string, number>): Promise<void> {
    await this.executor.checkStops(prices);
  }

  getPortfolio() { return this.executor.getPortfolio(); }
  getPortfolioSummary(): string { return this.executor.getSummary(); }

  // ----------------------------------------------------------------
  // Data Requests — ask Research team for data
  // ----------------------------------------------------------------

  async requestData(researchLeadId: AgentId, assets: string[], reason: string): Promise<void> {
    await this.network.unicast(this.leadId, researchLeadId, 'request', {
      type: 'request',
      requestType: 'new-data-source',
      description: `Need market data for: ${assets.join(', ')}`,
      reason,
      data: { assets },
    } satisfies RequestPayload);
  }

  // ----------------------------------------------------------------
  // CEO Directive Handling
  // ----------------------------------------------------------------

  protected handleDirective(directive: DirectivePayload): void {
    switch (directive.directiveType) {
      case 'pause-trading':
        this.paused = true;
        this.log.warn('Trading PAUSED by CEO');
        break;
      case 'resume-trading':
        this.paused = false;
        this.log.info('Trading RESUMED by CEO');
        break;
      case 'adjust-risk':
        // Forward to risk manager
        this.log.info({ params: directive.params }, 'Risk adjustment from CEO');
        break;
      default:
        this.log.debug({ directive: directive.directiveType }, 'Unhandled directive');
    }
  }

  protected handleApproval(approval: ApprovalPayload): void {
    this.log.info({ requestId: approval.requestId.slice(0, 8) }, 'CEO approved our request');
  }

  protected handleQuestion(from: AgentId, payload: QuestionPayload): void {
    // Another team asks us something — e.g., "What positions are open?"
    const portfolio = this.executor.getPortfolio();
    void this.answerAgent(from, payload.threadId, `We have ${portfolio.positions.filter(p => p.status === 'open').length} open positions`, payload.threadId, {
      positions: portfolio.positions.filter(p => p.status === 'open').length,
      pnl: portfolio.totalPnl,
    });
  }
}
