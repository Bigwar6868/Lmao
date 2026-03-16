// ============================================================
// AgentBrain — AI-powered reasoning engine for autonomous agents
//
// Primary: Uses Claude API (Anthropic SDK) for real AI thinking.
// Fallback: Rule-based structured analysis when API unavailable.
// All reasoning is visible in the console via live feed.
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import type { Signal, MarketData, MacroEnvironment } from './types.js';
import type { AgentId, TeamPrompt, AgentMessage } from './agent-types.js';
import { createModuleLogger } from './logger.js';

const log = createModuleLogger('agent-brain');

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
  usedAI: boolean;       // whether Claude API was used or fallback
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

/** Role-specific system prompts for Claude */
const ROLE_SYSTEM_PROMPTS: Record<BrainRole, string> = {
  ceo: `You are the CEO of a multi-asset trading system. You oversee 5 teams: Trading, Research, Risk, Evolution, and Ops.
Your job is to make strategic decisions: when to pause trading, which teams need attention, whether to increase/decrease risk exposure.
You think in terms of system health, macro risk, team performance, and capital preservation.
Always be decisive. If risk is elevated, say so clearly. If teams are underperforming, recommend concrete actions.`,

  trader: `You are a trading agent in a multi-asset algorithmic trading system.
You analyze signals, market volatility, and portfolio state to decide what to trade and when.
You think in terms of signal strength, conviction, risk/reward, position sizing, and market conditions.
Be specific about which assets look promising and why. Flag divergences between strategies.
When idle, look for emerging patterns, cross-strategy convergence, and unusual price action.`,

  researcher: `You are the head of research for a multi-asset trading system covering crypto, stocks, and forex.
You analyze market data freshness, macro conditions, cross-asset correlations, and regime transitions.
Your job is to find high-probability setups and warn about regime changes.
Think like a quant researcher: look for convergence across strategies, unusual volume, correlation breakdowns.
When idle, explore data sources proactively — look for regime shifts, new patterns, or stale data.`,

  'risk-manager': `You are the risk manager for a multi-asset trading system.
Your PRIMARY job is capital preservation. You monitor drawdowns, position concentration, macro risk, and stop losses.
Be conservative and paranoid. If drawdown exceeds 5%, recommend immediate action.
If macro risk is high/extreme, recommend reducing exposure or activating the kill switch.
Never downplay risk. Always err on the side of caution.`,

  evolutionist: `You are the evolution strategist for a multi-asset trading system.
You analyze strategy performance, decay detection, parameter drift, and diversity.
Your job is to evolve underperforming strategies and preserve top performers.
Think in terms of win rates, Sharpe ratios, overfitting risk, and genetic algorithm parameters.
When idle, consider which strategies need backtesting and which parameters might need mutation.`,

  ops: `You are the operations manager for a multi-asset trading system.
You monitor system health: memory usage, data source availability, API rate limits, cache integrity.
Flag any operational issues immediately. Track uptime and resource consumption.
When idle, run diagnostic checks and verify all data sources are responding.`,
};

/**
 * AgentBrain — AI-powered reasoning engine.
 *
 * Uses Claude API (Haiku for fast/cheap thinking) to reason through
 * decisions. Falls back to rule-based analysis when API unavailable.
 */
export class AgentBrain {
  readonly agentId: AgentId;
  readonly role: BrainRole;
  readonly name: string;
  private thoughtHistory: ThoughtChain[] = [];
  private readonly maxHistory = 50;
  private client: Anthropic | null = null;
  private aiAvailable = true;
  private aiFailCount = 0;
  private readonly maxAiRetries = 3;
  private readonly aiModel = 'claude-haiku-4-5-20251001'; // fast + cheap for agent thinking

  constructor(agentId: AgentId, role: BrainRole, name: string) {
    this.agentId = agentId;
    this.role = role;
    this.name = name;

    // Initialize Anthropic client — uses ANTHROPIC_API_KEY env var
    try {
      this.client = new Anthropic();
      log.info({ agent: name, role }, 'AgentBrain initialized with Claude API');
    } catch {
      this.client = null;
      this.aiAvailable = false;
      log.warn({ agent: name }, 'Claude API not available — using rule-based fallback');
    }
  }

  /**
   * Think about a question given context.
   * Tries Claude API first, falls back to rule-based.
   */
  async thinkAsync(question: string, context: BrainContext): Promise<ThoughtChain> {
    const start = Date.now();

    // Try AI thinking first
    if (this.aiAvailable && this.client) {
      try {
        const chain = await this.thinkWithClaude(question, context, start);
        this.aiFailCount = 0; // reset on success
        return this.recordChain(chain);
      } catch (err) {
        this.aiFailCount++;
        log.warn({ agent: this.name, error: (err as Error).message, failCount: this.aiFailCount }, 'Claude API call failed — using fallback');
        if (this.aiFailCount >= this.maxAiRetries) {
          this.aiAvailable = false;
          log.warn({ agent: this.name }, 'Too many AI failures — disabling Claude API, using rule-based only');
        }
      }
    }

    // Fallback to rule-based
    return this.recordChain(this.thinkRuleBased(question, context, start));
  }

  /**
   * Synchronous think — uses rule-based only (for backwards compat).
   * Use thinkAsync() for AI-powered thinking.
   */
  think(question: string, context: BrainContext): ThoughtChain {
    const start = Date.now();
    return this.recordChain(this.thinkRuleBased(question, context, start));
  }

  /** Quick assessment — async, uses AI if available */
  async assessAsync(question: string, context: BrainContext): Promise<{ decision: string; confidence: number }> {
    const chain = await this.thinkAsync(question, context);
    return { decision: chain.decision, confidence: chain.confidence };
  }

  /** Quick assessment — sync, rule-based only */
  assess(question: string, context: BrainContext): { decision: string; confidence: number } {
    const chain = this.think(question, context);
    return { decision: chain.decision, confidence: chain.confidence };
  }

  /** Decide what to explore next when idle — async, uses AI */
  async decideIdleActionAsync(context: BrainContext): Promise<string | null> {
    const chain = await this.thinkAsync('What should I do while idle?', context);
    return chain.confidence > 0.3 ? chain.decision : null;
  }

  /** Decide what to explore next when idle — sync, rule-based */
  decideIdleAction(context: BrainContext): string | null {
    const chain = this.think('What should I do while idle?', context);
    return chain.confidence > 0.3 ? chain.decision : null;
  }

  /** Re-enable AI after it was disabled */
  enableAI(): void {
    this.aiAvailable = true;
    this.aiFailCount = 0;
    if (!this.client) {
      try {
        this.client = new Anthropic();
      } catch {
        this.aiAvailable = false;
      }
    }
    log.info({ agent: this.name }, 'AI re-enabled');
  }

  isAIAvailable(): boolean { return this.aiAvailable && this.client !== null; }

  getThoughtHistory(): ThoughtChain[] {
    return [...this.thoughtHistory];
  }

  getLastThought(): ThoughtChain | undefined {
    return this.thoughtHistory[this.thoughtHistory.length - 1];
  }

  // ================================================================
  // Claude API Thinking
  // ================================================================

  private async thinkWithClaude(question: string, ctx: BrainContext, start: number): Promise<ThoughtChain> {
    const systemPrompt = ROLE_SYSTEM_PROMPTS[this.role];
    const userPrompt = this.buildUserPrompt(question, ctx);

    const response = await this.client!.messages.create({
      model: this.aiModel,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    // Parse response into thought chain
    const text = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');

    return this.parseAIResponse(question, text, start);
  }

  /** Build a user prompt from context */
  private buildUserPrompt(question: string, ctx: BrainContext): string {
    const parts: string[] = [];

    parts.push(`Question: ${question}`);

    if (ctx.mission) {
      parts.push(`\nMission: ${ctx.mission}`);
    }

    if (ctx.portfolio) {
      parts.push(`\nPortfolio State:
- Capital: $${ctx.portfolio.capital.toFixed(2)}
- Total PnL: $${ctx.portfolio.totalPnl.toFixed(2)} (${ctx.portfolio.capital > 0 ? ((ctx.portfolio.totalPnl / ctx.portfolio.capital) * 100).toFixed(1) : 0}%)
- Open Positions: ${ctx.portfolio.openPositions}
- Win Rate: ${(ctx.portfolio.winRate * 100).toFixed(0)}%`);
    }

    if (ctx.macro) {
      parts.push(`\nMacro Environment:
- Risk Level: ${ctx.macro.riskLevel}
- Market Bias: ${ctx.macro.bias}
- Indicators: ${ctx.macro.indicators?.map(i => `${i.name}=${i.value}`).join(', ') ?? 'none'}`);
    }

    if (ctx.signals?.length) {
      const buys = ctx.signals.filter(s => s.action === 'BUY');
      const sells = ctx.signals.filter(s => s.action === 'SELL');
      const top5 = [...ctx.signals]
        .filter(s => s.action !== 'HOLD')
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 5);
      parts.push(`\nSignals Summary:
- Total: ${ctx.signals.length} (${buys.length} BUY, ${sells.length} SELL)
- Top signals: ${top5.map(s => `${s.action} ${s.asset.symbol} (${(s.confidence * 100).toFixed(0)}%, ${s.strategy})`).join('; ')}`);
    }

    if (ctx.marketData?.size) {
      const summaries: string[] = [];
      for (const [symbol, data] of ctx.marketData) {
        if (data.candles.length >= 2) {
          const last = data.candles[data.candles.length - 1];
          const prev = data.candles[data.candles.length - 2];
          const change = ((last.close - prev.close) / prev.close * 100).toFixed(2);
          summaries.push(`${symbol}: $${last.close.toFixed(2)} (${change}%)`);
        }
        if (summaries.length >= 10) break; // cap for prompt size
      }
      parts.push(`\nRecent Prices (${ctx.marketData.size} assets):
${summaries.join(', ')}`);
    }

    if (ctx.recentMessages?.length) {
      const recent = ctx.recentMessages.slice(-5);
      parts.push(`\nRecent Messages (last ${recent.length}):
${recent.map(m => `- [${m.type}] from ${m.from.slice(0, 8)}: ${JSON.stringify(m.payload).slice(0, 100)}`).join('\n')}`);
    }

    parts.push(`\nRespond with your analysis. Structure your thinking as:
1. For each observation, state what you see and what it means
2. End with a clear DECISION and your CONFIDENCE (0-100%)
Format: Start each thought with "STEP:", each observation with "OBS:", each conclusion with "CONCLUDE:", and your final answer with "DECISION:" and "CONFIDENCE:"`);

    return parts.join('\n');
  }

  /** Parse Claude's response into a ThoughtChain */
  private parseAIResponse(question: string, text: string, start: number): ThoughtChain {
    const steps: ThoughtStep[] = [];
    let decision = '';
    let confidence = 0.5;

    // Parse structured response
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    let currentStep = '';
    let currentObs = '';

    for (const line of lines) {
      if (line.startsWith('STEP:')) {
        // Save previous step if exists
        if (currentStep && currentObs) {
          steps.push({
            step: currentStep,
            observation: currentObs,
            conclusion: '',
            confidence: 0.5,
          });
        }
        currentStep = line.replace('STEP:', '').trim();
        currentObs = '';
      } else if (line.startsWith('OBS:')) {
        currentObs = line.replace('OBS:', '').trim();
      } else if (line.startsWith('CONCLUDE:')) {
        const conclusion = line.replace('CONCLUDE:', '').trim();
        if (currentStep) {
          steps.push({
            step: currentStep,
            observation: currentObs || 'See analysis',
            conclusion,
            confidence: 0.7,
          });
          currentStep = '';
          currentObs = '';
        }
      } else if (line.startsWith('DECISION:')) {
        decision = line.replace('DECISION:', '').trim();
      } else if (line.startsWith('CONFIDENCE:')) {
        const confStr = line.replace('CONFIDENCE:', '').trim().replace('%', '');
        const parsed = parseInt(confStr, 10);
        if (!isNaN(parsed)) {
          confidence = Math.min(1, Math.max(0, parsed / 100));
        }
      }
    }

    // If parsing didn't extract structured steps, create one step from the full text
    if (steps.length === 0) {
      // Extract decision from end of text if not structured
      if (!decision) {
        const lastSentences = text.split('.').filter(Boolean);
        decision = lastSentences[lastSentences.length - 1]?.trim() ?? text.slice(0, 200);
      }
      steps.push({
        step: 'AI Analysis',
        observation: text.slice(0, 300),
        conclusion: decision,
        confidence,
      });
    }

    if (!decision && steps.length > 0) {
      decision = steps[steps.length - 1].conclusion;
    }

    // Update step confidence values based on overall confidence
    for (const step of steps) {
      if (step.confidence === 0.5) step.confidence = confidence;
    }

    return {
      agentId: this.agentId,
      role: this.role,
      question,
      steps,
      decision: decision || 'Continue monitoring',
      reasoning: steps.map(s => s.conclusion).join(' → '),
      confidence,
      timestamp: Date.now(),
      durationMs: Date.now() - start,
      usedAI: true,
    };
  }

  // ================================================================
  // Rule-based Fallback (when Claude API unavailable)
  // ================================================================

  private thinkRuleBased(question: string, ctx: BrainContext, start: number): ThoughtChain {
    const steps: ThoughtStep[] = [];

    switch (this.role) {
      case 'ceo': this.thinkAsCeo(question, ctx, steps); break;
      case 'trader': this.thinkAsTrader(question, ctx, steps); break;
      case 'researcher': this.thinkAsResearcher(question, ctx, steps); break;
      case 'risk-manager': this.thinkAsRiskManager(question, ctx, steps); break;
      case 'evolutionist': this.thinkAsEvolutionist(question, ctx, steps); break;
      case 'ops': this.thinkAsOps(question, ctx, steps); break;
    }

    const avgConfidence = steps.length > 0
      ? steps.reduce((sum, s) => sum + s.confidence, 0) / steps.length
      : 0.5;

    const decision = steps.length > 0
      ? steps[steps.length - 1].conclusion
      : 'No conclusion reached — insufficient data';

    return {
      agentId: this.agentId,
      role: this.role,
      question,
      steps,
      decision,
      reasoning: steps.map(s => s.conclusion).join(' → '),
      confidence: avgConfidence,
      timestamp: Date.now(),
      durationMs: Date.now() - start,
      usedAI: false,
    };
  }

  private recordChain(chain: ThoughtChain): ThoughtChain {
    this.thoughtHistory.push(chain);
    if (this.thoughtHistory.length > this.maxHistory) {
      this.thoughtHistory.shift();
    }
    return chain;
  }

  // ================================================================
  // Role-specific rule-based reasoning (fallback)
  // ================================================================

  private thinkAsCeo(question: string, ctx: BrainContext, steps: ThoughtStep[]): void {
    if (ctx.portfolio) {
      const health = ctx.portfolio.winRate > 0.5 ? 'healthy' : ctx.portfolio.winRate > 0.3 ? 'underperforming' : 'critical';
      steps.push({
        step: 'Assess system health',
        observation: `Capital: $${ctx.portfolio.capital.toFixed(0)}, PnL: $${ctx.portfolio.totalPnl.toFixed(2)}, Win rate: ${(ctx.portfolio.winRate * 100).toFixed(0)}%, Open: ${ctx.portfolio.openPositions}`,
        conclusion: `System is ${health}`,
        confidence: 0.8,
      });
    }
    if (ctx.macro) {
      const riskOk = ctx.macro.riskLevel === 'low' || ctx.macro.riskLevel === 'medium';
      steps.push({
        step: 'Evaluate macro environment',
        observation: `Risk level: ${ctx.macro.riskLevel}, Bias: ${ctx.macro.bias}`,
        conclusion: riskOk
          ? 'Macro conditions support trading — maintain current exposure'
          : `Macro risk elevated (${ctx.macro.riskLevel}) — consider reducing exposure`,
        confidence: riskOk ? 0.7 : 0.85,
      });
    }
    if (ctx.recentMessages?.length) {
      const alerts = ctx.recentMessages.filter(m => m.type === 'alert' || (m.type === 'report' && (m.payload as unknown as Record<string, unknown>).reportType === 'risk-alert'));
      steps.push({
        step: 'Review team communications',
        observation: `${ctx.recentMessages.length} messages, ${alerts.length} alerts`,
        conclusion: alerts.length > 0
          ? `${alerts.length} alerts require attention — prioritize risk management`
          : 'Teams operating normally — no intervention needed',
        confidence: 0.75,
      });
    }
    steps.push({
      step: 'Strategic assessment',
      observation: `Question: ${question}`,
      conclusion: question.toLowerCase().includes('idle')
        ? 'Review team prompts and adjust if underperforming. Check for new opportunities.'
        : 'Continue current strategy. Monitor for regime changes.',
      confidence: 0.65,
    });
  }

  private thinkAsTrader(question: string, ctx: BrainContext, steps: ThoughtStep[]): void {
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
    if (ctx.marketData?.size) {
      const volatilities: number[] = [];
      for (const [, data] of ctx.marketData) {
        if (data.candles.length >= 20) {
          const closes = data.candles.slice(-20).map(c => c.close);
          const rets = closes.slice(1).map((c, i) => Math.abs((c - closes[i]) / closes[i]));
          const avg = rets.length > 0 ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
          volatilities.push(avg);
        }
      }
      const avgVol = volatilities.length > 0 ? volatilities.reduce((a, b) => a + b, 0) / volatilities.length : 0;
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
    if (question.toLowerCase().includes('idle')) {
      steps.push({
        step: 'Plan idle activity',
        observation: 'No active trading cycle',
        conclusion: 'Scan for divergences between strategies. Review recent trade outcomes.',
        confidence: 0.5,
      });
    }
  }

  private thinkAsResearcher(question: string, ctx: BrainContext, steps: ThoughtStep[]): void {
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
    if (question.toLowerCase().includes('idle')) {
      steps.push({
        step: 'Plan research exploration',
        observation: 'No active data requests',
        conclusion: 'Explore correlation shifts between asset classes. Check for regime transitions.',
        confidence: 0.55,
      });
    }
  }

  private thinkAsRiskManager(question: string, ctx: BrainContext, steps: ThoughtStep[]): void {
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
    if (ctx.macro) {
      const vixIndicator = ctx.macro.indicators?.find(i => i.name === 'VIX');
      steps.push({
        step: 'Evaluate macro risk factors',
        observation: `Risk level: ${ctx.macro.riskLevel}, VIX proxy: ${vixIndicator?.value ?? 'N/A'}`,
        conclusion: ctx.macro.riskLevel === 'extreme'
          ? 'EXTREME risk — recommend kill switch activation'
          : ctx.macro.riskLevel === 'high'
            ? 'HIGH risk — reduce position sizes by 50%'
            : 'Macro risk acceptable',
        confidence: 0.85,
      });
    }
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
    if (ctx.signals?.length) {
      const strategies = new Set(ctx.signals.map(s => s.strategy));
      steps.push({
        step: 'Assess strategy diversity',
        observation: `${strategies.size} active strategies generating signals`,
        conclusion: strategies.size < 3
          ? 'Low strategy diversity — consider spawning new strategy variants'
          : 'Good strategy diversity maintained',
        confidence: 0.7,
      });
    }
    if (question.toLowerCase().includes('idle')) {
      steps.push({
        step: 'Plan evolution activity',
        observation: 'No active evolution cycle',
        conclusion: 'Run background backtest on recent data. Check for parameter drift.',
        confidence: 0.5,
      });
    }
  }

  private thinkAsOps(question: string, ctx: BrainContext, steps: ThoughtStep[]): void {
    steps.push({
      step: 'Check system resources',
      observation: `Memory: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0)}MB, Uptime: ${(process.uptime() / 60).toFixed(0)}min`,
      conclusion: process.memoryUsage().heapUsed > 500 * 1024 * 1024
        ? 'Memory usage high — consider garbage collection or cache pruning'
        : 'System resources within normal range',
      confidence: 0.9,
    });
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
