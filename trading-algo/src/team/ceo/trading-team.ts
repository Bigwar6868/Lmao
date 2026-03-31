// ============================================================
// Trading Team — decides what/when to trade, executes orders,
// reviews and optimizes after every trade
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
import { Executor } from '../executor/index.js';
import { RiskManager } from '../risk-manager/index.js';
import { TeamBase } from './team-base.js';

export class TradingTeam extends TeamBase {
  private agents = new Map<AgentId, TradingAgent>();
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
  }

  protected getDescription(): string {
    return 'Decides what/when to trade, executes orders, reviews and optimizes after every trade';
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
  // Core Trading Cycle — No debate, direct signal → risk → execute
  // ----------------------------------------------------------------

  async runCycle(
    marketDataMap: Map<string, MarketData>,
    macro?: MacroEnvironment,
  ): Promise<{
    signals: Array<{ signal: Signal; agentId: AgentId }>;
    executed: number;
    rejected: number;
    reviewResults: TradeReviewResult[];
  }> {
    if (this.paused) {
      this.log.warn('Trading paused by CEO — skipping cycle');
      return { signals: [], executed: 0, rejected: 0, reviewResults: [] };
    }

    // 1. All agents analyze market data in parallel — collect signals directly
    const activeAgents = [...this.agents.values()].filter(a => a.getStatus() !== 'retired');
    const dataEntries = [...marketDataMap.values()];
    const analyzeTimeout = config.agentAnalyzeTimeoutMs;

    const allSignals: Array<{ signal: Signal; agentId: AgentId }> = [];

    await Promise.allSettled(
      activeAgents.map(async (agent) => {
        for (const data of dataEntries) {
          try {
            const signals = await withTimeout(
              agent.analyze(data, macro),
              analyzeTimeout,
              `agent:${agent.profile.name}:${data.asset.symbol}`,
            );
            for (const signal of signals) {
              allSignals.push({ signal, agentId: agent.id });
            }
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

    // 2. Pick the best signal per asset (highest confidence)
    const bestSignals = this.selectBestSignals(allSignals);

    // 3. Execute through risk manager — no debate gate
    const portfolio = this.executor.getPortfolio();
    let executed = 0;
    let rejected = 0;
    const executedTrades: Array<{ signal: Signal; agentId: AgentId; position?: Position }> = [];

    for (const { signal, agentId } of bestSignals) {
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
            confidence: signal.confidence.toFixed(2),
            agent: agentId.slice(0, 8),
          }, 'Trade executed');

          // Track for post-trade review
          const latestPosition = portfolio.positions[portfolio.positions.length - 1];
          executedTrades.push({ signal, agentId, position: latestPosition });
        }
      } else {
        rejected++;
      }
    }

    // 4. POST-TRADE REVIEW & OPTIMIZE — after every trade, the team reviews
    const reviewResults: TradeReviewResult[] = [];

    // Review all closed positions from this cycle
    const closedThisCycle = portfolio.positions
      .filter(p => p.status === 'closed' && p.closedAt && p.closedAt > Date.now() - 60_000);

    for (const position of closedThisCycle) {
      const review = this.reviewAndOptimize(position, marketDataMap, macro);
      reviewResults.push(review);
    }

    // Also review newly executed trades for immediate strategy feedback
    for (const trade of executedTrades) {
      this.logTradeContext(trade.signal, trade.agentId, marketDataMap, macro);
    }

    // 5. Report to CEO
    if (executed > 0 || bestSignals.length > 0) {
      const optimized = reviewResults.filter(r => r.optimizationApplied).length;
      await this.reportToCeo('performance',
        `Cycle: ${executed} trades executed, ${rejected} risk-rejected, ${reviewResults.length} reviewed, ${optimized} optimized`,
        { executed, rejected, reviews: reviewResults.length, optimized },
      );
    }

    return { signals: bestSignals, executed, rejected, reviewResults };
  }

  // ----------------------------------------------------------------
  // Signal Selection — pick best signal per asset
  // ----------------------------------------------------------------

  private selectBestSignals(
    allSignals: Array<{ signal: Signal; agentId: AgentId }>,
  ): Array<{ signal: Signal; agentId: AgentId }> {
    // Group by asset
    const byAsset = new Map<string, Array<{ signal: Signal; agentId: AgentId }>>();
    for (const entry of allSignals) {
      const key = entry.signal.asset.symbol;
      const list = byAsset.get(key) ?? [];
      list.push(entry);
      byAsset.set(key, list);
    }

    // Pick highest confidence per asset
    const best: Array<{ signal: Signal; agentId: AgentId }> = [];
    for (const [, entries] of byAsset) {
      entries.sort((a, b) => b.signal.confidence - a.signal.confidence);
      const top = entries[0];
      // Only include if confidence meets minimum threshold (matches risk manager MIN_CONFIDENCE)
      if (top.signal.confidence >= 0.55) {
        best.push(top);
      }
    }

    return best;
  }

  // ----------------------------------------------------------------
  // POST-TRADE REVIEW & OPTIMIZE — core new behavior
  // ----------------------------------------------------------------

  /**
   * After every closed trade, review the outcome and optimize the strategy.
   * This replaces the old debate mechanism — the team learns after every trade.
   */
  private reviewAndOptimize(
    position: Position,
    marketDataMap: Map<string, MarketData>,
    macro?: MacroEnvironment,
  ): TradeReviewResult {
    const isWin = position.realizedPnl > 0;
    const pnlPct = position.entryPrice > 0
      ? ((position.currentPrice - position.entryPrice) / position.entryPrice * 100)
      : 0;

    const data = marketDataMap.get(position.asset.symbol);
    const candles = data?.candles ?? [];

    // --- Phase 1: Investigate why the trade won or lost ---
    const reasons = this.investigateTradeReasons(position, candles, macro);

    // --- Phase 2: Update agent reputation based on outcome ---
    const proposerAgent = this.findAgentForStrategy(position.strategy);
    if (proposerAgent) {
      proposerAgent.recordOutcome({
        proposalId: '',
        asset: position.asset.symbol,
        action: position.side === 'buy' ? 'BUY' : 'SELL',
        entryPrice: position.entryPrice,
        exitPrice: position.currentPrice,
        pnl: position.realizedPnl,
        pnlPct,
        timestamp: Date.now(),
      });
    }

    // --- Phase 3: Optimize strategy parameters based on pattern ---
    let optimizationApplied = false;
    const adjustments: string[] = [];

    if (proposerAgent && candles.length >= 20) {
      const optimization = this.deriveOptimization(position, candles, isWin, reasons);
      if (optimization.shouldAdjust) {
        const currentDna = proposerAgent.getDNA();
        const optimizedDna = { ...currentDna };
        optimizedDna.params = { ...currentDna.params };

        for (const adj of optimization.paramAdjustments) {
          if (optimizedDna.params[adj.param] !== undefined) {
            const oldVal = optimizedDna.params[adj.param];
            optimizedDna.params[adj.param] = adj.newValue;
            adjustments.push(`${adj.param}: ${oldVal.toFixed(2)} → ${adj.newValue.toFixed(2)} (${adj.reason})`);
          }
        }

        if (adjustments.length > 0) {
          optimizedDna.generation = currentDna.generation + 1;
          optimizedDna.mutations = [
            ...currentDna.mutations.slice(-5),
            `post-trade-optimize: ${position.asset.symbol} ${isWin ? 'WIN' : 'LOSS'}`,
          ];
          proposerAgent.updateDNA(optimizedDna);
          optimizationApplied = true;

          this.log.info({
            strategy: position.strategy,
            asset: position.asset.symbol,
            outcome: isWin ? 'WIN' : 'LOSS',
            adjustments,
          }, 'Post-trade optimization applied');
        }
      }
    }

    // --- Phase 4: Report significant losses ---
    if (!isWin && Math.abs(position.realizedPnl) > this.executor.getPortfolio().capital * 0.02) {
      void this.reportToCeo('risk-alert',
        `Significant loss on ${position.asset.symbol}: $${position.realizedPnl.toFixed(2)} (${pnlPct.toFixed(1)}%)`,
        {
          symbol: position.asset.symbol,
          strategy: position.strategy,
          pnl: position.realizedPnl,
          reasons,
          adjustments,
        },
      );
    }

    const result: TradeReviewResult = {
      asset: position.asset.symbol,
      strategy: position.strategy,
      outcome: isWin ? 'WIN' : 'LOSS',
      pnl: position.realizedPnl,
      pnlPct,
      reasons,
      optimizationApplied,
      adjustments,
    };

    this.log.info({
      asset: result.asset,
      outcome: result.outcome,
      pnl: result.pnl.toFixed(2),
      optimized: result.optimizationApplied,
      adjustments: result.adjustments.length,
    }, `Trade review: ${result.outcome} on ${result.asset}`);

    return result;
  }

  /**
   * Derive parameter adjustments from the trade outcome and market conditions.
   */
  private deriveOptimization(
    position: Position,
    candles: Candle[],
    isWin: boolean,
    reasons: string[],
  ): { shouldAdjust: boolean; paramAdjustments: Array<{ param: string; newValue: number; reason: string }> } {
    const adjustments: Array<{ param: string; newValue: number; reason: string }> = [];

    const recent = candles.slice(-20);
    const closes = recent.map(c => c.close);
    const returns = closes.slice(1).map((c, i) => Math.abs((c - closes[i]) / closes[i]));
    const avgVol = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;

    const agent = this.findAgentForStrategy(position.strategy);
    if (!agent) return { shouldAdjust: false, paramAdjustments: [] };

    const params = agent.getDNA().params;

    // High volatility + loss → widen stops, reduce sensitivity
    if (!isWin && avgVol > 0.03) {
      if (params['stopLossMultiplier'] !== undefined) {
        adjustments.push({
          param: 'stopLossMultiplier',
          newValue: Math.min(4, params['stopLossMultiplier'] * 1.15),
          reason: 'High volatility caused stop-out — widening stops',
        });
      }
      if (params['confidenceThreshold'] !== undefined) {
        adjustments.push({
          param: 'confidenceThreshold',
          newValue: Math.min(0.8, params['confidenceThreshold'] * 1.05),
          reason: 'Raising confidence threshold in volatile conditions',
        });
      }
    }

    // Traded against trend + loss → adjust trend sensitivity
    if (!isWin && reasons.some(r => r.includes('against the trend'))) {
      if (params['trendWeight'] !== undefined) {
        adjustments.push({
          param: 'trendWeight',
          newValue: Math.min(1, params['trendWeight'] * 1.1),
          reason: 'Lost against trend — increasing trend weight',
        });
      }
      if (params['fastPeriod'] !== undefined && params['slowPeriod'] !== undefined) {
        // Shorten fast EMA to react faster to trend changes
        adjustments.push({
          param: 'fastPeriod',
          newValue: Math.max(3, Math.round(params['fastPeriod'] * 0.9)),
          reason: 'Faster trend detection after counter-trend loss',
        });
      }
    }

    // Consistent wins → slightly tighten take-profit to lock in more gains
    if (isWin && agent.getRecentWinRate() > 0.6) {
      if (params['takeProfitMultiplier'] !== undefined) {
        adjustments.push({
          param: 'takeProfitMultiplier',
          newValue: Math.max(1.2, params['takeProfitMultiplier'] * 0.95),
          reason: 'Strong win rate — tightening take-profit to secure gains',
        });
      }
    }

    // Low volume loss → reduce position sizing sensitivity
    if (!isWin && reasons.some(r => r.includes('Low volume'))) {
      if (params['volumeWeight'] !== undefined) {
        adjustments.push({
          param: 'volumeWeight',
          newValue: Math.min(1, params['volumeWeight'] * 1.2),
          reason: 'Lost in low volume — increasing volume filter weight',
        });
      }
    }

    return {
      shouldAdjust: adjustments.length > 0,
      paramAdjustments: adjustments,
    };
  }

  /**
   * Investigate why a trade won or lost.
   */
  private investigateTradeReasons(
    position: Position,
    candles: Candle[],
    macro?: MacroEnvironment,
  ): string[] {
    const isWin = position.realizedPnl > 0;
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
        if (position.side === 'buy' && trend === 'uptrend') {
          reasons.push('Traded with the trend (long in uptrend)');
        } else if (position.side === 'sell' && trend === 'downtrend') {
          reasons.push('Traded with the trend (short in downtrend)');
        } else {
          reasons.push('Won against the trend — possible mean reversion');
        }
      } else {
        if (position.side === 'buy' && trend === 'downtrend') {
          reasons.push('Traded against the trend (long in downtrend)');
        } else if (position.side === 'sell' && trend === 'uptrend') {
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
      if (!isWin && macro.bias === 'bearish' && position.side === 'buy') {
        reasons.push('Macro bias was bearish but went long — macro headwind');
      }
      if (!isWin && macro.bias === 'bullish' && position.side === 'sell') {
        reasons.push('Macro bias was bullish but went short — macro headwind');
      }
    }

    // Stop loss hit?
    if (!isWin && position.stopLoss) {
      const hitStop = position.side === 'buy'
        ? position.currentPrice <= position.stopLoss
        : position.currentPrice >= position.stopLoss;
      if (hitStop) {
        reasons.push('Stop loss triggered — risk management worked');
      }
    }

    if (reasons.length === 0) {
      reasons.push(isWin ? 'No specific edge identified — may be noise' : 'No clear cause — review strategy parameters');
    }

    return reasons;
  }

  /**
   * Log context for a newly executed trade (for future review when it closes).
   */
  private logTradeContext(
    signal: Signal,
    agentId: AgentId,
    marketDataMap: Map<string, MarketData>,
    macro?: MacroEnvironment,
  ): void {
    const agent = this.agents.get(agentId);
    this.log.info({
      symbol: signal.asset.symbol,
      action: signal.action,
      confidence: signal.confidence.toFixed(2),
      strategy: signal.strategy,
      agent: agent?.name ?? agentId.slice(0, 8),
      reputation: agent?.getReputation() ?? 0,
      macro: macro ? { riskLevel: macro.riskLevel, bias: macro.bias } : undefined,
    }, 'Trade context logged for post-trade review');
  }

  /**
   * Find the first active agent running a specific strategy.
   */
  private findAgentForStrategy(strategyName: string): TradingAgent | undefined {
    for (const [, agent] of this.agents) {
      if (agent.getStatus() === 'retired') continue;
      if (agent.getStrategy().name === strategyName) return agent;
    }
    return undefined;
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

  /** Sync initial capital from OANDA account balance */
  async syncCapitalFromBroker(): Promise<boolean> {
    return this.executor.syncCapitalFromBroker();
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
          c.toLowerCase().includes(data.asset.assetClass) && c.toLowerCase().includes('exclude'),
        );
        if (blocked) continue;
      }

      // Select every asset that has an actionable signal — if a strategy says trade it, we trade it
      const hasSignal = signals.some(s => s.asset.symbol === symbol && s.action !== 'HOLD');
      if (hasSignal) {
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
      if (agentWinRate < 0.2 && agent.getHistory().totalSignals > 10) {
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
  // Format review results for display
  // ----------------------------------------------------------------

  static formatReviewSummary(reviews: TradeReviewResult[]): string {
    if (reviews.length === 0) return '\nNo trade reviews this cycle.';

    const lines: string[] = ['\n=== POST-TRADE REVIEW & OPTIMIZE ===\n'];

    for (const r of reviews) {
      const status = r.outcome === 'WIN' ? 'WIN ' : 'LOSS';
      const optimized = r.optimizationApplied ? '[OPTIMIZED]' : '';
      lines.push(
        `  ${status} | ${r.asset.padEnd(12)} | ${r.strategy.padEnd(20)} | ` +
        `PnL: $${r.pnl.toFixed(2)} (${r.pnlPct.toFixed(1)}%) ${optimized}`,
      );
      for (const reason of r.reasons) {
        lines.push(`       → ${reason}`);
      }
      for (const adj of r.adjustments) {
        lines.push(`       ⚙ ${adj}`);
      }
    }

    const wins = reviews.filter(r => r.outcome === 'WIN').length;
    const optimized = reviews.filter(r => r.optimizationApplied).length;
    lines.push(`\nReviewed: ${reviews.length} | Wins: ${wins} | Losses: ${reviews.length - wins} | Optimized: ${optimized}`);

    return lines.join('\n');
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

// ----------------------------------------------------------------
// Types
// ----------------------------------------------------------------

export interface TradeReviewResult {
  asset: string;
  strategy: string;
  outcome: 'WIN' | 'LOSS';
  pnl: number;
  pnlPct: number;
  reasons: string[];
  optimizationApplied: boolean;
  adjustments: string[];
}
