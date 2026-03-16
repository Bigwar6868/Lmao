// ============================================================
// AgentBrain — Structured reasoning engine for autonomous agents
//
// No external API calls. Each agent "thinks" using structured
// analysis steps based on its role and available data.
// All reasoning is visible in the console via live feed.
// ============================================================

import type { Signal, MarketData, MacroEnvironment, Candle } from './types.js';
import type { AgentId, TeamId, TeamPrompt, AgentMessage } from './agent-types.js';
import { mean, stdDev } from './utils.js';

/** A single step in the agent's reasoning chain */
export interface ThoughtStep {
  step: string;          // what the agent is considering
  observation: string;   // what it observed
  conclusion: string;    // what it concluded
  confidence: number;    // 0-1 how sure
}

/** Complete reasoning output from the brain */
export interface ThoughtChain {
  agentId: AgentId;
  role: string;
  question: string;      // what was the agent thinking about
  steps: ThoughtStep[];
  decision: string;      // final decision
  reasoning: string;     // summary reasoning
  confidence: number;    // overall confidence 0-1
  timestamp: number;
  durationMs: number;
}

/** Context provided to the brain for reasoning */
export interface BrainContext {
  mission?: string;
  prompt?: TeamPrompt | null;
  marketData?: Map<string, MarketData>;
  macro?: MacroEnvironment;
  signals?: Signal[];
  recentMessages?: AgentMessage[];
  portfolio?: {
    capital: number;
    totalPnl: number;
    openPositions: number;
    winRate: number;
  };
  customData?: Record<string, unknown>;
}

/** Brain role determines reasoning style */
export type BrainRole =
  | 'ceo'             // strategic, high-level
  | 'trader'          // signal-focused, execution-oriented
  | 'researcher'      // data-driven, exploratory
  | 'risk-manager'    // conservative, protective
  | 'evolutionist'    // optimization-focused
  | 'ops'             // monitoring, health-focused

/**
 * AgentBrain — structured reasoning engine.
 *
 * Each agent has a brain that processes context and produces
 * a chain of thought with observable steps. No LLM calls —
 * uses rule-based structured analysis tailored to role.
 */
export class AgentBrain {
  readonly agentId: AgentId;
  readonly role: BrainRole;
  readonly name: string;
  private thoughtHistory: ThoughtChain[] = [];
  private readonly maxHistory = 50;

  constructor(agentId: AgentId, role: BrainRole, name: string) {
    this.agentId = agentId;
    this.role = role;
    this.name = name;
  }

  /**
   * Think about a question given context.
   * Returns a full thought chain with observable steps.
   */
  think(question: string, context: BrainContext): ThoughtChain {
    const start = Date.now();
    const steps: ThoughtStep[] = [];

    // Route to role-specific reasoning
    switch (this.role) {
      case 'ceo':
        this.thinkAsCeo(question, context, steps);
        break;
      case 'trader':
        this.thinkAsTrader(question, context, steps);
        break;
      case 'researcher':
        this.thinkAsResearcher(question, context, steps);
        break;
      case 'risk-manager':
        this.thinkAsRiskManager(question, context, steps);
        break;
      case 'evolutionist':
        this.thinkAsEvolutionist(question, context, steps);
        break;
      case 'ops':
        this.thinkAsOps(question, context, steps);
        break;
    }

    // Synthesize final decision
    const avgConfidence = steps.length > 0
      ? steps.reduce((sum, s) => sum + s.confidence, 0) / steps.length
      : 0.5;

    const decision = steps.length > 0
      ? steps[steps.length - 1].conclusion
      : 'No conclusion reached — insufficient data';

    const reasoning = steps.map(s => s.conclusion).join(' → ');

    const chain: ThoughtChain = {
      agentId: this.agentId,
      role: this.role,
      question,
      steps,
      decision,
      reasoning,
      confidence: avgConfidence,
      timestamp: Date.now(),
      durationMs: Date.now() - start,
    };

    // Store in history
    this.thoughtHistory.push(chain);
    if (this.thoughtHistory.length > this.maxHistory) {
      this.thoughtHistory.shift();
    }

    return chain;
  }

  /**
   * Quick assessment — returns just a decision string.
   * Useful for simple yes/no or action decisions.
   */
  assess(question: string, context: BrainContext): { decision: string; confidence: number } {
    const chain = this.think(question, context);
    return { decision: chain.decision, confidence: chain.confidence };
  }

  /**
   * Decide what to explore next when idle.
   * Returns a task description or null if nothing to do.
   */
  decideIdleAction(context: BrainContext): string | null {
    const chain = this.think('What should I do while idle?', context);
    return chain.confidence > 0.3 ? chain.decision : null;
  }

  getThoughtHistory(): ThoughtChain[] {
    return [...this.thoughtHistory];
  }

  getLastThought(): ThoughtChain | undefined {
    return this.thoughtHistory[this.thoughtHistory.length - 1];
  }

  // ================================================================
  // Role-specific reasoning engines
  // ================================================================

  private thinkAsCeo(question: string, ctx: BrainContext, steps: ThoughtStep[]): void {
    // Step 1: Assess system state
    if (ctx.portfolio) {
      const health = ctx.portfolio.winRate > 0.5 ? 'healthy' : ctx.portfolio.winRate > 0.3 ? 'underperforming' : 'critical';
      steps.push({
        step: 'Assess system health',
        observation: `Capital: $${ctx.portfolio.capital.toFixed(0)}, PnL: $${ctx.portfolio.totalPnl.toFixed(2)}, Win rate: ${(ctx.portfolio.winRate * 100).toFixed(0)}%, Open: ${ctx.portfolio.openPositions}`,
        conclusion: `System is ${health}`,
        confidence: 0.8,
      });
    }

    // Step 2: Check macro conditions
    if (ctx.macro) {
      const riskOk = ctx.macro.riskLevel === 'low' || ctx.macro.riskLevel === 'medium';
      const vixIndicator = ctx.macro.indicators?.find(i => i.name === 'VIX');
      steps.push({
        step: 'Evaluate macro environment',
        observation: `Risk level: ${ctx.macro.riskLevel}, Bias: ${ctx.macro.bias}, VIX: ${vixIndicator?.value ?? 'N/A'}`,
        conclusion: riskOk
          ? 'Macro conditions support trading — maintain current exposure'
          : `Macro risk elevated (${ctx.macro.riskLevel}) — consider reducing exposure`,
        confidence: riskOk ? 0.7 : 0.85,
      });
    }

    // Step 3: Review team performance
    if (ctx.recentMessages?.length) {
      const alerts = ctx.recentMessages.filter(m => m.type === 'alert' || (m.type === 'report' && (m.payload as unknown as Record<string, unknown>).reportType === 'risk-alert'));
      const reports = ctx.recentMessages.filter(m => m.type === 'report');
      steps.push({
        step: 'Review team communications',
        observation: `${reports.length} reports received, ${alerts.length} alerts`,
        conclusion: alerts.length > 0
          ? `${alerts.length} alerts require attention — prioritize risk management`
          : 'Teams operating normally — no intervention needed',
        confidence: 0.75,
      });
    }

    // Step 4: Strategic decision
    if (question.toLowerCase().includes('idle')) {
      steps.push({
        step: 'Plan idle activity',
        observation: 'No immediate decisions required',
        conclusion: 'Review team prompts and adjust if underperforming. Check for new opportunities.',
        confidence: 0.6,
      });
    } else {
      steps.push({
        step: 'Strategic assessment',
        observation: `Question: ${question}`,
        conclusion: 'Continue current strategy. Monitor for regime changes.',
        confidence: 0.65,
      });
    }
  }

  private thinkAsTrader(question: string, ctx: BrainContext, steps: ThoughtStep[]): void {
    // Step 1: Scan signals
    if (ctx.signals?.length) {
      const buys = ctx.signals.filter(s => s.action === 'BUY');
      const sells = ctx.signals.filter(s => s.action === 'SELL');
      const highConf = ctx.signals.filter(s => s.confidence > 0.7 && s.action !== 'HOLD');

      steps.push({
        step: 'Scan trading signals',
        observation: `${ctx.signals.length} signals: ${buys.length} BUY, ${sells.length} SELL, ${highConf.length} high-confidence`,
        conclusion: highConf.length > 0
          ? `${highConf.length} high-conviction opportunities found — prioritize ${highConf[0].asset.symbol}`
          : 'No strong signals — stay cautious',
        confidence: highConf.length > 0 ? 0.8 : 0.4,
      });
    }

    // Step 2: Check market conditions
    if (ctx.marketData?.size) {
      const volatilities: number[] = [];
      for (const [, data] of ctx.marketData) {
        if (data.candles.length >= 20) {
          const closes = data.candles.slice(-20).map(c => c.close);
          const rets = closes.slice(1).map((c, i) => Math.abs((c - closes[i]) / closes[i]));
          volatilities.push(mean(rets));
        }
      }
      const avgVol = mean(volatilities);
      steps.push({
        step: 'Assess market volatility',
        observation: `Average volatility across ${ctx.marketData.size} assets: ${(avgVol * 100).toFixed(2)}%`,
        conclusion: avgVol > 0.03
          ? 'High volatility — widen stops, reduce position sizes'
          : avgVol > 0.01
            ? 'Normal volatility — standard parameters'
            : 'Low volatility — tighten stops, look for breakouts',
        confidence: 0.75,
      });
    }

    // Step 3: Portfolio check
    if (ctx.portfolio) {
      steps.push({
        step: 'Check portfolio state',
        observation: `${ctx.portfolio.openPositions} open positions, PnL: $${ctx.portfolio.totalPnl.toFixed(2)}`,
        conclusion: ctx.portfolio.openPositions > 5
          ? 'Many positions open — avoid adding more without strong conviction'
          : 'Room for new positions',
        confidence: 0.7,
      });
    }

    // Step 4: Idle action
    if (question.toLowerCase().includes('idle')) {
      steps.push({
        step: 'Plan idle activity',
        observation: 'No active trading cycle',
        conclusion: 'Scan for divergences between strategies. Review recent trade outcomes. Look for emerging patterns.',
        confidence: 0.5,
      });
    }
  }

  private thinkAsResearcher(question: string, ctx: BrainContext, steps: ThoughtStep[]): void {
    // Step 1: Data freshness
    if (ctx.marketData?.size) {
      let staleCount = 0;
      const oneHourAgo = Date.now() - 3_600_000;
      for (const [, data] of ctx.marketData) {
        const lastCandle = data.candles[data.candles.length - 1];
        if (lastCandle && lastCandle.timestamp < oneHourAgo) staleCount++;
      }
      steps.push({
        step: 'Check data freshness',
        observation: `${ctx.marketData.size} assets tracked, ${staleCount} with stale data (>1h old)`,
        conclusion: staleCount > ctx.marketData.size / 2
          ? 'Most data is stale — refresh needed'
          : 'Data is reasonably fresh',
        confidence: 0.8,
      });
    }

    // Step 2: Macro analysis
    if (ctx.macro) {
      steps.push({
        step: 'Analyze macro environment',
        observation: `Risk: ${ctx.macro.riskLevel}, Bias: ${ctx.macro.bias}`,
        conclusion: ctx.macro.riskLevel === 'high' || ctx.macro.riskLevel === 'extreme'
          ? 'Elevated macro risk — alert trading team to be cautious'
          : `Market bias: ${ctx.macro.bias} — research supports continued activity`,
        confidence: 0.7,
      });
    }

    // Step 3: Opportunity scan
    if (ctx.signals?.length) {
      const crossAssetSignals = new Map<string, number>();
      for (const sig of ctx.signals) {
        const count = crossAssetSignals.get(sig.asset.symbol) ?? 0;
        crossAssetSignals.set(sig.asset.symbol, count + 1);
      }
      const multiSignalAssets = [...crossAssetSignals.entries()].filter(([, count]) => count >= 2);
      steps.push({
        step: 'Cross-reference signals across strategies',
        observation: `${multiSignalAssets.length} assets have signals from multiple strategies`,
        conclusion: multiSignalAssets.length > 0
          ? `Convergence found: ${multiSignalAssets.map(([s]) => s).join(', ')} — high-probability setups`
          : 'No multi-strategy convergence — individual signals may be noise',
        confidence: multiSignalAssets.length > 0 ? 0.8 : 0.5,
      });
    }

    // Step 4: Idle exploration
    if (question.toLowerCase().includes('idle')) {
      steps.push({
        step: 'Plan research exploration',
        observation: 'No active data requests',
        conclusion: 'Explore correlation shifts between asset classes. Check for regime transitions. Scan for unusual volume patterns.',
        confidence: 0.55,
      });
    }
  }

  private thinkAsRiskManager(question: string, ctx: BrainContext, steps: ThoughtStep[]): void {
    // Step 1: Portfolio risk
    if (ctx.portfolio) {
      const pnlPct = ctx.portfolio.capital > 0 ? (ctx.portfolio.totalPnl / ctx.portfolio.capital) * 100 : 0;
      const dangerZone = pnlPct < -5;
      steps.push({
        step: 'Assess portfolio risk',
        observation: `PnL: ${pnlPct.toFixed(2)}% of capital, ${ctx.portfolio.openPositions} open positions`,
        conclusion: dangerZone
          ? 'DANGER: Drawdown exceeds 5% — recommend reducing exposure immediately'
          : pnlPct < -2
            ? 'Drawdown approaching limits — tighten stops on all positions'
            : 'Portfolio risk within acceptable bounds',
        confidence: dangerZone ? 0.95 : 0.7,
      });
    }

    // Step 2: Macro risk
    if (ctx.macro) {
      steps.push({
        step: 'Evaluate macro risk factors',
        observation: `Risk level: ${ctx.macro.riskLevel}, VIX proxy: ${ctx.macro.indicators?.find(i => i.name === 'VIX')?.value ?? 'N/A'}`,
        conclusion: ctx.macro.riskLevel === 'extreme'
          ? 'EXTREME risk — recommend kill switch activation'
          : ctx.macro.riskLevel === 'high'
            ? 'HIGH risk — reduce position sizes by 50%'
            : 'Macro risk acceptable',
        confidence: 0.85,
      });
    }

    // Step 3: Concentration check
    if (ctx.portfolio && ctx.portfolio.openPositions > 3) {
      steps.push({
        step: 'Check position concentration',
        observation: `${ctx.portfolio.openPositions} open positions`,
        conclusion: ctx.portfolio.openPositions > 8
          ? 'Too many positions — risk of correlated drawdown. Recommend closing weakest.'
          : 'Position count acceptable',
        confidence: 0.7,
      });
    }

    // Step 4: Idle monitoring
    if (question.toLowerCase().includes('idle')) {
      steps.push({
        step: 'Plan idle risk monitoring',
        observation: 'No active risk events',
        conclusion: 'Monitor for flash crash signals. Check cross-asset correlations. Verify stop losses are current.',
        confidence: 0.6,
      });
    }
  }

  private thinkAsEvolutionist(question: string, ctx: BrainContext, steps: ThoughtStep[]): void {
    // Step 1: Strategy performance
    if (ctx.portfolio) {
      steps.push({
        step: 'Evaluate strategy effectiveness',
        observation: `Win rate: ${(ctx.portfolio.winRate * 100).toFixed(0)}%, Total PnL: $${ctx.portfolio.totalPnl.toFixed(2)}`,
        conclusion: ctx.portfolio.winRate < 0.4
          ? 'Strategies underperforming — evolution needed. Increase mutation rate.'
          : ctx.portfolio.winRate > 0.6
            ? 'Strategies performing well — preserve top performers, mutate bottom 30%'
            : 'Average performance — continue standard evolution cycle',
        confidence: 0.75,
      });
    }

    // Step 2: Signal diversity
    if (ctx.signals?.length) {
      const strategies = new Set(ctx.signals.map(s => s.strategy));
      const signalsByStrategy = new Map<string, number>();
      for (const sig of ctx.signals) {
        signalsByStrategy.set(sig.strategy, (signalsByStrategy.get(sig.strategy) ?? 0) + 1);
      }
      steps.push({
        step: 'Assess strategy diversity',
        observation: `${strategies.size} active strategies generating signals`,
        conclusion: strategies.size < 3
          ? 'Low strategy diversity — consider spawning new strategy variants'
          : 'Good strategy diversity maintained',
        confidence: 0.7,
      });
    }

    // Step 3: Idle exploration
    if (question.toLowerCase().includes('idle')) {
      steps.push({
        step: 'Plan evolution activity',
        observation: 'No active evolution cycle',
        conclusion: 'Run background backtest on recent data. Check for parameter drift. Test new indicator combinations.',
        confidence: 0.5,
      });
    }
  }

  private thinkAsOps(question: string, ctx: BrainContext, steps: ThoughtStep[]): void {
    // Step 1: System health
    steps.push({
      step: 'Check system resources',
      observation: `Memory: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0)}MB, Uptime: ${(process.uptime() / 60).toFixed(0)}min`,
      conclusion: process.memoryUsage().heapUsed > 500 * 1024 * 1024
        ? 'Memory usage high — consider garbage collection or cache pruning'
        : 'System resources within normal range',
      confidence: 0.9,
    });

    // Step 2: Data source health
    if (ctx.marketData?.size) {
      const emptyData = [...ctx.marketData.values()].filter(d => d.candles.length === 0);
      steps.push({
        step: 'Check data source availability',
        observation: `${ctx.marketData.size} data sources, ${emptyData.length} returning empty data`,
        conclusion: emptyData.length > 0
          ? `${emptyData.length} data sources failing — investigate and report to CEO`
          : 'All data sources operational',
        confidence: 0.85,
      });
    }

    // Step 3: Idle monitoring
    if (question.toLowerCase().includes('idle')) {
      steps.push({
        step: 'Plan monitoring activity',
        observation: 'No active alerts',
        conclusion: 'Run diagnostic check. Verify cache integrity. Monitor API rate limits.',
        confidence: 0.5,
      });
    }
  }
}
