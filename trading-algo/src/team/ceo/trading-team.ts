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
import type { AssetInfo, Signal, MarketData, MacroEnvironment, Candle, Position } from '../../shared/types.js';
import { withTimeout } from '../../shared/utils.js';
import { config } from '../../config/index.js';
import type { AgentBrain, BrainContext } from '../../shared/agent-brain.js';
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

  /**
   * Trading team autonomously decides which assets to trade.
   * Not set by CEO — the team decides based on research data.
   */
  private selectedAssets = new Map<string, AssetInfo>();

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

    // 4. Self-review every executed trade — investigate win/loss reasons
    const closedThisCycle = portfolio.positions
      .filter(p => p.status === 'closed' && p.closedAt && p.closedAt > Date.now() - 60_000);

    for (const position of closedThisCycle) {
      this.investigateTrade(position, marketDataMap, macro);
    }

    // 5. Report to CEO
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
  // Autonomous Asset Selection — Trading Team decides what to trade
  // ----------------------------------------------------------------

  /**
   * Evaluate market data and autonomously select which assets to actively trade.
   * Criteria: sufficient data, reasonable volatility, active signals.
   */
  selectAssetsToTrade(
    marketDataMap: Map<string, MarketData>,
    signals: Signal[],
  ): AssetInfo[] {
    this.selectedAssets.clear();
    const prompt = this.getPrompt();

    for (const [symbol, data] of marketDataMap) {
      // Need at least 20 candles to trade
      if (data.candles.length < 20) continue;

      // Check if CEO prompt restricts asset classes
      if (prompt?.constraints?.length) {
        const blocked = prompt.constraints.some(c =>
          c.toLowerCase().includes(data.asset.class) && c.toLowerCase().includes('exclude'),
        );
        if (blocked) continue;
      }

      // Prefer assets with active signals
      const hasSignal = signals.some(s => s.asset.symbol === symbol && s.action !== 'HOLD');

      // Calculate recent volatility
      const closes = data.candles.slice(-20).map(c => c.close);
      const returns = closes.slice(1).map((c, i) => Math.abs((c - closes[i]) / closes[i]));
      const avgVol = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;

      // Select if: has signal, or decent volatility (tradeable)
      if (hasSignal || avgVol > 0.002) {
        this.selectedAssets.set(symbol, data.asset);
      }
    }

    const selected = [...this.selectedAssets.values()];
    this.log.info({
      selected: selected.length,
      total: marketDataMap.size,
      assets: selected.map(a => a.symbol),
    }, 'Trading team selected assets to trade');

    return selected;
  }

  getSelectedAssets(): AssetInfo[] {
    return [...this.selectedAssets.values()];
  }

  // ----------------------------------------------------------------
  // Self-Review — Trading Team reviews its own performance
  // ----------------------------------------------------------------

  /**
   * Review recent trades and adjust behavior.
   * Called periodically by the 24/7 loop.
   */
  reviewPerformance(): {
    summary: string;
    winRate: number;
    recentPnl: number;
    adjustments: string[];
  } {
    const portfolio = this.executor.getPortfolio();
    const closedPositions = portfolio.positions.filter(p => p.status === 'closed');
    const recentClosed = closedPositions.slice(-20);

    const wins = recentClosed.filter(p => p.realizedPnl > 0).length;
    const winRate = recentClosed.length > 0 ? wins / recentClosed.length : 0;
    const recentPnl = recentClosed.reduce((sum, p) => sum + p.realizedPnl, 0);

    const adjustments: string[] = [];

    // Self-adjustment rules
    if (winRate < 0.3 && recentClosed.length >= 5) {
      adjustments.push('Win rate below 30% — requesting CEO to tighten risk');
      void this.requestFromCeo('decrease-risk', 'Win rate critically low', 'Self-review: win rate < 30%', {
        winRate,
        recentPnl,
      });
    }

    if (recentPnl < -portfolio.capital * 0.05 && recentClosed.length >= 3) {
      adjustments.push('PnL drawdown > 5% of capital — requesting risk reduction');
      void this.requestFromCeo('decrease-risk', 'Drawdown exceeds threshold', 'Self-review: PnL drawdown', {
        drawdown: recentPnl,
        capitalPct: (recentPnl / portfolio.capital * 100).toFixed(2),
      });
    }

    // Report good performance
    if (winRate > 0.6 && recentClosed.length >= 10) {
      adjustments.push('Strong performance — requesting CEO to consider increasing exposure');
      void this.requestFromCeo('increase-risk', 'Strong recent performance', 'Self-review: win rate > 60%', {
        winRate,
        recentPnl,
      });
    }

    // Check agent performance
    for (const [, agent] of this.agents) {
      if (agent.getStatus() === 'retired') continue;
      const agentWinRate = agent.getRecentWinRate();
      if (agentWinRate < 0.2 && agent.getHistory().totalProposals > 10) {
        adjustments.push(`Agent ${agent.profile.name} underperforming (${(agentWinRate * 100).toFixed(0)}% win rate)`);
      }
    }

    const summary = [
      `Trade Review: ${recentClosed.length} recent trades`,
      `Win Rate: ${(winRate * 100).toFixed(1)}%`,
      `Recent PnL: $${recentPnl.toFixed(2)}`,
      `Active Agents: ${[...this.agents.values()].filter(a => a.getStatus() === 'active').length}`,
      adjustments.length > 0 ? `Adjustments: ${adjustments.join('; ')}` : 'No adjustments needed',
    ].join(' | ');

    this.log.info({ winRate, recentPnl, adjustments: adjustments.length }, 'Self-review complete');

    return { summary, winRate, recentPnl, adjustments };
  }

  // ----------------------------------------------------------------
  // Per-Trade Investigation — analyze why each trade won or lost
  // ----------------------------------------------------------------

  private investigateTrade(
    position: Position,
    marketDataMap: Map<string, MarketData>,
    macro?: MacroEnvironment,
  ): void {
    const isWin = position.realizedPnl > 0;
    const pnlPct = position.entryPrice > 0
      ? ((position.currentPrice - position.entryPrice) / position.entryPrice * 100)
      : 0;

    const data = marketDataMap.get(position.asset.symbol);
    const candles = data?.candles ?? [];

    // Investigate market conditions at time of trade
    const reasons: string[] = [];

    if (candles.length >= 20) {
      const recent = candles.slice(-20);
      const closes = recent.map(c => c.close);
      const volumes = recent.map(c => c.volume);

      // Trend analysis
      const sma5 = closes.slice(-5).reduce((a, b) => a + b, 0) / 5;
      const sma20 = closes.reduce((a, b) => a + b, 0) / closes.length;
      const trend = sma5 > sma20 ? 'uptrend' : sma5 < sma20 ? 'downtrend' : 'sideways';

      if (isWin) {
        if (position.side === 'long' && trend === 'uptrend') {
          reasons.push('Traded with the trend (long in uptrend)');
        } else if (position.side === 'short' && trend === 'downtrend') {
          reasons.push('Traded with the trend (short in downtrend)');
        } else {
          reasons.push('Won against the trend — possible mean reversion');
        }
      } else {
        if (position.side === 'long' && trend === 'downtrend') {
          reasons.push('Traded against the trend (long in downtrend)');
        } else if (position.side === 'short' && trend === 'uptrend') {
          reasons.push('Traded against the trend (short in uptrend)');
        }
      }

      // Volume analysis
      const avgVol = volumes.reduce((a, b) => a + b, 0) / volumes.length;
      const latestVol = volumes[volumes.length - 1];
      if (latestVol > avgVol * 2) {
        reasons.push('High volume at time of trade — possible institutional activity');
      } else if (latestVol < avgVol * 0.5) {
        reasons.push('Low volume — thin liquidity may have caused slippage');
      }

      // Volatility
      const returns = closes.slice(1).map((c, i) => Math.abs((c - closes[i]) / closes[i]));
      const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
      if (avgReturn > 0.03) {
        reasons.push('High volatility environment — wider stops may be needed');
      }
    }

    // Macro conditions
    if (macro) {
      if (macro.riskLevel === 'high' || macro.riskLevel === 'extreme') {
        reasons.push(`Macro risk was ${macro.riskLevel} — risk-off conditions`);
      }
      if (!isWin && macro.bias === 'bearish' && position.side === 'long') {
        reasons.push('Macro bias was bearish but went long — macro headwind');
      }
      if (!isWin && macro.bias === 'bullish' && position.side === 'short') {
        reasons.push('Macro bias was bullish but went short — macro headwind');
      }
    }

    // Stop loss hit?
    if (!isWin && position.stopLoss) {
      const hitStop = position.side === 'long'
        ? position.currentPrice <= position.stopLoss
        : position.currentPrice >= position.stopLoss;
      if (hitStop) {
        reasons.push('Stop loss triggered — risk management worked');
      }
    }

    if (reasons.length === 0) {
      reasons.push(isWin ? 'No specific edge identified — may be noise' : 'No clear cause — review strategy parameters');
    }

    this.log.info({
      symbol: position.asset.symbol,
      side: position.side,
      strategy: position.strategy,
      outcome: isWin ? 'WIN' : 'LOSS',
      pnl: position.realizedPnl.toFixed(2),
      pnlPct: pnlPct.toFixed(2),
      reasons,
    }, `Trade investigation: ${isWin ? 'WIN' : 'LOSS'} on ${position.asset.symbol}`);

    // Report significant losses to CEO
    if (!isWin && Math.abs(position.realizedPnl) > this.executor.getPortfolio().capital * 0.02) {
      void this.reportToCeo('risk-alert',
        `Significant loss on ${position.asset.symbol}: $${position.realizedPnl.toFixed(2)} (${pnlPct.toFixed(1)}%)`,
        {
          symbol: position.asset.symbol,
          strategy: position.strategy,
          pnl: position.realizedPnl,
          reasons,
        },
      );
    }
  }

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
  // Brain Context — provides data for autonomous thinking
  // ----------------------------------------------------------------

  /** Latest market data — updated each cycle for brain access */
  private latestMarketData?: Map<string, MarketData>;
  private latestSignals?: Signal[];
  private latestMacro?: MacroEnvironment;

  /** Store context from the last cycle for brain/loop usage */
  updateBrainContext(marketData: Map<string, MarketData>, signals: Signal[], macro?: MacroEnvironment): void {
    this.latestMarketData = marketData;
    this.latestSignals = signals;
    this.latestMacro = macro;
  }

  protected override getBrainContext(): BrainContext {
    const portfolio = this.executor.getPortfolio();
    const closedPositions = portfolio.positions.filter(p => p.status === 'closed');
    const wins = closedPositions.filter(p => p.realizedPnl > 0).length;
    return {
      mission: this.getMission(),
      prompt: this.currentPrompt,
      marketData: this.latestMarketData,
      signals: this.latestSignals,
      macro: this.latestMacro,
      portfolio: {
        capital: portfolio.capital,
        totalPnl: portfolio.totalPnl,
        openPositions: portfolio.positions.filter(p => p.status === 'open').length,
        winRate: closedPositions.length > 0 ? wins / closedPositions.length : 0,
      },
    };
  }

  /** When idle, look for patterns and cross-strategy divergences */
  protected override async handleIdleExplore(brain: AgentBrain, ctx: BrainContext): Promise<void> {
    // Think about what to explore
    const thought = brain.think('Any patterns or divergences worth investigating?', ctx);

    // If we have data, look for cross-strategy agreement
    if (ctx.signals?.length) {
      const byAsset = new Map<string, Signal[]>();
      for (const sig of ctx.signals) {
        if (sig.action === 'HOLD') continue;
        const list = byAsset.get(sig.asset.symbol) ?? [];
        list.push(sig);
        byAsset.set(sig.asset.symbol, list);
      }

      for (const [symbol, sigs] of byAsset) {
        if (sigs.length >= 3) {
          const allBuy = sigs.every(s => s.action === 'BUY');
          const allSell = sigs.every(s => s.action === 'SELL');
          if (allBuy || allSell) {
            await this.startDiscussion(
              'cross-strategy-convergence',
              `${sigs.length} strategies agree on ${allBuy ? 'BUY' : 'SELL'} ${symbol} — high conviction opportunity`,
            );
          }
        }
      }
    }
  }

  // ----------------------------------------------------------------
  // CEO Directive Handling
  // ----------------------------------------------------------------

  protected handleDirective(directive: DirectivePayload): void {
    switch (directive.directiveType) {
      case 'set-prompt':
        this.log.info({ mission: this.currentPrompt?.mission }, 'Trading team received new mission from CEO');
        break;
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
