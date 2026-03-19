// ============================================================
// AgentBrain — AI-powered reasoning engine using Claude Agent SDK
//
// Primary: Uses @anthropic-ai/claude-agent-sdk to spawn
//          Claude Code sub-agents that think for each team.
// Fallback: Rule-based structured analysis when unavailable.
// All reasoning is visible in the console via live feed.
// ============================================================

import { createModuleLogger } from './logger.js';
import type { Signal, MarketData, MacroEnvironment } from './types.js';
import type { AgentId, TeamPrompt, AgentMessage } from './agent-types.js';

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
  usedAI: boolean;       // whether Claude Code was used or fallback
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

/** Role-specific system prompts for Claude Code sub-agents */
const ROLE_SYSTEM_PROMPTS: Record<BrainRole, string> = {
  ceo: `You are the CEO of a multi-asset trading system. You oversee 5 teams: Trading, Research, Risk, Evolution, and Ops.
Your job is to make strategic decisions: when to pause trading, which teams need attention, whether to increase/decrease risk exposure.
Think in terms of system health, macro risk, team performance, and capital preservation.
Always be decisive. If risk is elevated, say so clearly.`,

  trader: `You are a trading agent in a multi-asset algorithmic trading system.
You analyze signals, market volatility, and portfolio state to decide what to trade and when.
Think in terms of signal strength, conviction, risk/reward, position sizing, and market conditions.
Be specific about which assets look promising and why. Flag divergences between strategies.`,

  researcher: `You are the head of research for a multi-asset trading system covering crypto, stocks, and forex.
You analyze market data freshness, macro conditions, cross-asset correlations, and regime transitions.
Think like a quant researcher: look for convergence across strategies, unusual volume, correlation breakdowns.`,

  'risk-manager': `You are the risk manager for a multi-asset trading system.
Your PRIMARY job is capital preservation. Monitor drawdowns, position concentration, macro risk, and stop losses.
Be conservative and paranoid. If drawdown exceeds 5%, recommend immediate action. Never downplay risk.`,

  evolutionist: `You are the evolution strategist for a multi-asset trading system.
You analyze strategy performance, decay detection, parameter drift, and diversity.
Think in terms of win rates, Sharpe ratios, overfitting risk, and genetic algorithm parameters.`,

  ops: `You are the operations manager for a multi-asset trading system.
Monitor system health: memory usage, data source availability, API rate limits, cache integrity.
Flag any operational issues immediately.`,
};

// ============================================================
// LLM Provider — supports Claude Agent SDK or Ollama (local LLMs)
// ============================================================

export interface LLMProvider {
  name: string;
  model: string;
  query(systemPrompt: string, userPrompt: string): Promise<string>;
}

/** Ollama LLM provider — connects to local Ollama instance */
export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama';
  readonly model: string;
  private endpoint: string;

  constructor(
    endpoint = process.env.OLLAMA_CEO_ENDPOINT ?? process.env.OLLAMA_ENDPOINT ?? 'http://localhost:11434',
    model = process.env.OLLAMA_CEO_MODEL ?? process.env.OLLAMA_MODEL ?? 'MiniMax-M1-80k',
  ) {
    this.endpoint = endpoint.replace(/\/$/, '');
    this.model = model;
    log.info({ endpoint: this.endpoint, model: this.model }, 'OllamaProvider configured');
  }

  async query(systemPrompt: string, userPrompt: string): Promise<string> {
    const url = `${this.endpoint}/api/chat`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        stream: false,
        options: {
          temperature: 0.3, // Low temperature for consistent CEO decisions
          num_predict: 1024,
        },
      }),
      signal: AbortSignal.timeout(60_000), // 60s for local LLM inference
    });

    if (!response.ok) {
      throw new Error(`Ollama returned ${response.status}: ${await response.text()}`);
    }

    const result = await response.json() as { message?: { content?: string } };
    return result.message?.content ?? '';
  }
}

// Lazy-loaded query function from Claude Agent SDK
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let queryFn: ((...args: any[]) => AsyncIterable<any>) | null = null;
let sdkLoadAttempted = false;

async function getQueryFn() {
  if (queryFn) return queryFn;
  if (sdkLoadAttempted) return null;
  sdkLoadAttempted = true;
  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    queryFn = sdk.query;
    log.info('Claude Agent SDK loaded — agents will think with Claude');
    return queryFn;
  } catch (err) {
    log.warn({ error: (err as Error).message }, 'Claude Agent SDK not available — using rule-based fallback');
    return null;
  }
}

/** Global LLM provider override — set this to use Ollama instead of Claude SDK */
let globalLlmProvider: LLMProvider | null = null;

export function setGlobalLLMProvider(provider: LLMProvider): void {
  globalLlmProvider = provider;
  log.info({ provider: provider.name, model: provider.model }, 'Global LLM provider set');
}

export function getGlobalLLMProvider(): LLMProvider | null {
  return globalLlmProvider;
}

/**
 * AgentBrain — AI-powered reasoning engine using Claude Agent SDK.
 *
 * Uses the @anthropic-ai/claude-agent-sdk to spawn Claude Code
 * sub-agents that think for each team. Falls back to rule-based
 * reasoning when the SDK is unavailable.
 */
export class AgentBrain {
  readonly agentId: AgentId;
  readonly role: BrainRole;
  readonly name: string;
  private thoughtHistory: ThoughtChain[] = [];
  private readonly maxHistory = 50;
  private aiAvailable = true;
  private aiFailCount = 0;
  private readonly maxAiRetries = 3;
  private llmProvider: LLMProvider | null;

  constructor(agentId: AgentId, role: BrainRole, name: string, llmProvider?: LLMProvider) {
    this.agentId = agentId;
    this.role = role;
    this.name = name;
    this.llmProvider = llmProvider ?? null;
  }

  /** Set or swap the LLM provider at runtime */
  setLLMProvider(provider: LLMProvider): void {
    this.llmProvider = provider;
    this.aiAvailable = true;
    this.aiFailCount = 0;
    log.info({ agent: this.name, provider: provider.name, model: provider.model }, 'LLM provider set');
  }

  getLLMProvider(): LLMProvider | null {
    return this.llmProvider ?? globalLlmProvider;
  }

  /**
   * Think about a question given context — uses Claude Code if available.
   */
  async thinkAsync(question: string, context: BrainContext): Promise<ThoughtChain> {
    const start = Date.now();

    // Priority 1: Dedicated LLM provider (e.g. Ollama with MiniMax M2.7)
    const provider = this.getLLMProvider();
    if (provider && this.aiAvailable) {
      try {
        const chain = await this.thinkWithLLMProvider(provider, question, context, start);
        this.aiFailCount = 0;
        return this.recordChain(chain);
      } catch (err) {
        this.aiFailCount++;
        log.warn({ agent: this.name, provider: provider.name, error: (err as Error).message, failCount: this.aiFailCount }, 'LLM provider thinking failed');
        if (this.aiFailCount >= this.maxAiRetries) {
          this.aiAvailable = false;
          log.warn({ agent: this.name, provider: provider.name }, 'Too many failures — disabling LLM provider, using rule-based only');
        }
      }
    }

    // Priority 2: Claude Code sub-agent
    if (this.aiAvailable && !provider) {
      try {
        const chain = await this.thinkWithClaudeCode(question, context, start);
        this.aiFailCount = 0;
        return this.recordChain(chain);
      } catch (err) {
        this.aiFailCount++;
        log.warn({ agent: this.name, error: (err as Error).message, failCount: this.aiFailCount }, 'Claude Code thinking failed — using fallback');
        if (this.aiFailCount >= this.maxAiRetries) {
          this.aiAvailable = false;
          log.warn({ agent: this.name }, 'Too many failures — disabling Claude Code, using rule-based only');
        }
      }
    }

    // Fallback: rule-based
    return this.recordChain(this.thinkRuleBased(question, context, start));
  }

  /**
   * Synchronous think — uses rule-based only (for backwards compat).
   */
  think(question: string, context: BrainContext): ThoughtChain {
    const start = Date.now();
    return this.recordChain(this.thinkRuleBased(question, context, start));
  }

  /** Quick assessment — async, uses Claude Code if available */
  async assessAsync(question: string, context: BrainContext): Promise<{ decision: string; confidence: number }> {
    const chain = await this.thinkAsync(question, context);
    return { decision: chain.decision, confidence: chain.confidence };
  }

  /** Quick assessment — sync, rule-based only */
  assess(question: string, context: BrainContext): { decision: string; confidence: number } {
    const chain = this.think(question, context);
    return { decision: chain.decision, confidence: chain.confidence };
  }

  /** Decide what to explore when idle — async */
  async decideIdleActionAsync(context: BrainContext): Promise<string | null> {
    const chain = await this.thinkAsync('What should I do while idle?', context);
    return chain.confidence > 0.3 ? chain.decision : null;
  }

  /** Decide what to explore when idle — sync */
  decideIdleAction(context: BrainContext): string | null {
    const chain = this.think('What should I do while idle?', context);
    return chain.confidence > 0.3 ? chain.decision : null;
  }

  /** Re-enable Claude Code after it was disabled */
  enableAI(): void {
    this.aiAvailable = true;
    this.aiFailCount = 0;
    log.info({ agent: this.name }, 'Claude Code re-enabled');
  }

  isAIAvailable(): boolean { return this.aiAvailable; }

  getThoughtHistory(): ThoughtChain[] {
    return [...this.thoughtHistory];
  }

  getLastThought(): ThoughtChain | undefined {
    return this.thoughtHistory[this.thoughtHistory.length - 1];
  }

  // ================================================================
  // Ollama / External LLM Provider Thinking
  // ================================================================

  private async thinkWithLLMProvider(provider: LLMProvider, question: string, ctx: BrainContext, start: number): Promise<ThoughtChain> {
    const systemPrompt = ROLE_SYSTEM_PROMPTS[this.role];
    const userPrompt = this.buildPrompt(question, ctx);

    log.info({ agent: this.name, provider: provider.name, model: provider.model, question }, 'Thinking with LLM provider...');

    const result = await provider.query(systemPrompt, userPrompt);

    const chain = this.parseResponse(question, result, start);
    // Mark that we used AI (external LLM, not Claude SDK)
    chain.usedAI = true;
    (chain as ThoughtChain & { llmProvider?: string }).llmProvider = `${provider.name}/${provider.model}`;

    log.info({
      agent: this.name,
      provider: `${provider.name}/${provider.model}`,
      decision: chain.decision.slice(0, 100),
      confidence: chain.confidence,
      durationMs: chain.durationMs,
    }, 'LLM thinking complete');

    return chain;
  }

  // ================================================================
  // Claude Code Agent SDK Thinking
  // ================================================================

  private async thinkWithClaudeCode(question: string, ctx: BrainContext, start: number): Promise<ThoughtChain> {
    const query = await getQueryFn();
    if (!query) {
      throw new Error('Claude Code Agent SDK not loaded');
    }

    const systemPrompt = ROLE_SYSTEM_PROMPTS[this.role];
    const userPrompt = this.buildPrompt(question, ctx);

    let result = '';

    // Spawn a Claude Code sub-agent with no tools (pure thinking)
    for await (const message of query({
      prompt: userPrompt,
      options: {
        systemPrompt,
        maxTurns: 1,           // single turn — just think and respond
        allowedTools: [],      // no tools — pure reasoning
      },
    })) {
      if ('result' in message) {
        result = message.result;
      }
    }

    return this.parseResponse(question, result, start);
  }

  /** Build a prompt from context */
  private buildPrompt(question: string, ctx: BrainContext): string {
    const parts: string[] = [];

    parts.push(`Question: ${question}`);

    if (ctx.mission) {
      parts.push(`\nMission: ${ctx.mission}`);
    }

    if (ctx.portfolio) {
      parts.push(`\nPortfolio: Capital=$${ctx.portfolio.capital.toFixed(2)}, PnL=$${ctx.portfolio.totalPnl.toFixed(2)} (${ctx.portfolio.capital > 0 ? ((ctx.portfolio.totalPnl / ctx.portfolio.capital) * 100).toFixed(1) : 0}%), Open=${ctx.portfolio.openPositions}, WinRate=${(ctx.portfolio.winRate * 100).toFixed(0)}%`);
    }

    if (ctx.macro) {
      parts.push(`\nMacro: Risk=${ctx.macro.riskLevel}, Bias=${ctx.macro.bias}`);
    }

    if (ctx.signals?.length) {
      const buys = ctx.signals.filter(s => s.action === 'BUY').length;
      const sells = ctx.signals.filter(s => s.action === 'SELL').length;
      const top3 = [...ctx.signals]
        .filter(s => s.action !== 'HOLD')
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 3);
      parts.push(`\nSignals: ${ctx.signals.length} total (${buys} BUY, ${sells} SELL). Top: ${top3.map(s => `${s.action} ${s.asset.symbol} ${(s.confidence * 100).toFixed(0)}%`).join(', ')}`);
    }

    if (ctx.marketData?.size) {
      const prices: string[] = [];
      for (const [symbol, data] of ctx.marketData) {
        if (data.candles.length >= 2) {
          const last = data.candles[data.candles.length - 1];
          const prev = data.candles[data.candles.length - 2];
          const chg = ((last.close - prev.close) / prev.close * 100).toFixed(2);
          prices.push(`${symbol}:$${last.close.toFixed(2)}(${chg}%)`);
        }
        if (prices.length >= 8) break;
      }
      parts.push(`\nPrices: ${prices.join(', ')}`);
    }

    parts.push(`\nRespond with structured analysis:
STEP: [what you're analyzing]
OBS: [what you observe]
CONCLUDE: [your conclusion]
(repeat for each thought)
DECISION: [your final decision]
CONFIDENCE: [0-100]%`);

    return parts.join('\n');
  }

  /** Parse Claude Code's response into a ThoughtChain */
  private parseResponse(question: string, text: string, start: number): ThoughtChain {
    const steps: ThoughtStep[] = [];
    let decision = '';
    let confidence = 0.5;

    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    let currentStep = '';
    let currentObs = '';

    for (const line of lines) {
      if (line.startsWith('STEP:')) {
        if (currentStep && currentObs) {
          steps.push({ step: currentStep, observation: currentObs, conclusion: '', confidence: 0.5 });
        }
        currentStep = line.replace('STEP:', '').trim();
        currentObs = '';
      } else if (line.startsWith('OBS:')) {
        currentObs = line.replace('OBS:', '').trim();
      } else if (line.startsWith('CONCLUDE:')) {
        const conclusion = line.replace('CONCLUDE:', '').trim();
        if (currentStep) {
          steps.push({ step: currentStep, observation: currentObs || 'See analysis', conclusion, confidence: 0.7 });
          currentStep = '';
          currentObs = '';
        }
      } else if (line.startsWith('DECISION:')) {
        decision = line.replace('DECISION:', '').trim();
      } else if (line.startsWith('CONFIDENCE:')) {
        const parsed = parseInt(line.replace('CONFIDENCE:', '').trim().replace('%', ''), 10);
        if (!isNaN(parsed)) confidence = Math.min(1, Math.max(0, parsed / 100));
      }
    }

    // If parsing didn't produce structured steps, create one from the full text
    if (steps.length === 0) {
      if (!decision) {
        const sentences = text.split('.').filter(Boolean);
        decision = sentences[sentences.length - 1]?.trim() ?? text.slice(0, 200);
      }
      steps.push({ step: 'AI Analysis', observation: text.slice(0, 300), conclusion: decision, confidence });
    }

    if (!decision && steps.length > 0) {
      decision = steps[steps.length - 1].conclusion;
    }

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
  // Rule-based Fallback
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

    return {
      agentId: this.agentId,
      role: this.role,
      question,
      steps,
      decision: steps.length > 0 ? steps[steps.length - 1].conclusion : 'No conclusion — insufficient data',
      reasoning: steps.map(s => s.conclusion).join(' → '),
      confidence: avgConfidence,
      timestamp: Date.now(),
      durationMs: Date.now() - start,
      usedAI: false,
    };
  }

  private recordChain(chain: ThoughtChain): ThoughtChain {
    this.thoughtHistory.push(chain);
    if (this.thoughtHistory.length > this.maxHistory) this.thoughtHistory.shift();
    return chain;
  }

  // ================================================================
  // Rule-based reasoning per role (fallback)
  // ================================================================

  private thinkAsCeo(question: string, ctx: BrainContext, steps: ThoughtStep[]): void {
    if (ctx.portfolio) {
      const health = ctx.portfolio.winRate > 0.5 ? 'healthy' : ctx.portfolio.winRate > 0.3 ? 'underperforming' : 'critical';
      steps.push({ step: 'Assess system health', observation: `Capital: $${ctx.portfolio.capital.toFixed(0)}, PnL: $${ctx.portfolio.totalPnl.toFixed(2)}, Win rate: ${(ctx.portfolio.winRate * 100).toFixed(0)}%`, conclusion: `System is ${health}`, confidence: 0.8 });
    }
    if (ctx.macro) {
      const riskOk = ctx.macro.riskLevel === 'low' || ctx.macro.riskLevel === 'medium';
      steps.push({ step: 'Evaluate macro', observation: `Risk: ${ctx.macro.riskLevel}, Bias: ${ctx.macro.bias}`, conclusion: riskOk ? 'Macro supports trading' : `Macro risk elevated (${ctx.macro.riskLevel}) — consider reducing exposure`, confidence: riskOk ? 0.7 : 0.85 });
    }
    steps.push({ step: 'Strategic assessment', observation: `Q: ${question}`, conclusion: question.toLowerCase().includes('idle') ? 'Review team prompts. Check for new opportunities.' : 'Continue current strategy. Monitor for regime changes.', confidence: 0.65 });
  }

  private thinkAsTrader(question: string, ctx: BrainContext, steps: ThoughtStep[]): void {
    if (ctx.signals?.length) {
      const highConf = ctx.signals.filter(s => s.confidence > 0.7 && s.action !== 'HOLD');
      steps.push({ step: 'Scan signals', observation: `${ctx.signals.length} signals, ${highConf.length} high-confidence`, conclusion: highConf.length > 0 ? `${highConf.length} high-conviction opportunities — prioritize ${highConf[0].asset.symbol}` : 'No strong signals — stay cautious', confidence: highConf.length > 0 ? 0.8 : 0.4 });
    }
    if (ctx.marketData?.size) {
      const vols: number[] = [];
      for (const [, data] of ctx.marketData) {
        if (data.candles.length >= 20) {
          const closes = data.candles.slice(-20).map(c => c.close);
          const rets = closes.slice(1).map((c, i) => Math.abs((c - closes[i]) / closes[i]));
          vols.push(rets.length > 0 ? rets.reduce((a, b) => a + b, 0) / rets.length : 0);
        }
      }
      const avgVol = vols.length > 0 ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;
      steps.push({ step: 'Assess volatility', observation: `Avg vol: ${(avgVol * 100).toFixed(2)}%`, conclusion: avgVol > 0.03 ? 'High vol — widen stops' : avgVol > 0.01 ? 'Normal vol' : 'Low vol — look for breakouts', confidence: 0.75 });
    }
    if (ctx.portfolio) {
      steps.push({ step: 'Portfolio check', observation: `${ctx.portfolio.openPositions} open, PnL: $${ctx.portfolio.totalPnl.toFixed(2)}`, conclusion: ctx.portfolio.openPositions > 5 ? 'Many positions — avoid adding more' : 'Room for new positions', confidence: 0.7 });
    }
  }

  private thinkAsResearcher(question: string, ctx: BrainContext, steps: ThoughtStep[]): void {
    if (ctx.marketData?.size) {
      let stale = 0;
      const ago = Date.now() - 3_600_000;
      for (const [, d] of ctx.marketData) { if (d.candles[d.candles.length - 1]?.timestamp < ago) stale++; }
      steps.push({ step: 'Data freshness', observation: `${ctx.marketData.size} assets, ${stale} stale`, conclusion: stale > ctx.marketData.size / 2 ? 'Most data stale — refresh needed' : 'Data is fresh', confidence: 0.8 });
    }
    if (ctx.signals?.length) {
      const cross = new Map<string, number>();
      for (const s of ctx.signals) cross.set(s.asset.symbol, (cross.get(s.asset.symbol) ?? 0) + 1);
      const multi = [...cross.entries()].filter(([, c]) => c >= 2);
      steps.push({ step: 'Cross-reference signals', observation: `${multi.length} multi-strategy assets`, conclusion: multi.length > 0 ? `Convergence: ${multi.map(([s]) => s).join(', ')}` : 'No convergence', confidence: multi.length > 0 ? 0.8 : 0.5 });
    }
    if (question.toLowerCase().includes('idle')) {
      steps.push({ step: 'Idle plan', observation: 'No requests', conclusion: 'Check regime transitions. Scan correlations.', confidence: 0.55 });
    }
  }

  private thinkAsRiskManager(question: string, ctx: BrainContext, steps: ThoughtStep[]): void {
    if (ctx.portfolio) {
      const pnlPct = ctx.portfolio.capital > 0 ? (ctx.portfolio.totalPnl / ctx.portfolio.capital) * 100 : 0;
      steps.push({ step: 'Portfolio risk', observation: `PnL: ${pnlPct.toFixed(2)}%, ${ctx.portfolio.openPositions} open`, conclusion: pnlPct < -5 ? 'DANGER: >5% drawdown — reduce exposure' : pnlPct < -2 ? 'Approaching limits — tighten stops' : 'Risk acceptable', confidence: pnlPct < -5 ? 0.95 : 0.7 });
    }
    if (ctx.macro) {
      steps.push({ step: 'Macro risk', observation: `Risk: ${ctx.macro.riskLevel}`, conclusion: ctx.macro.riskLevel === 'extreme' ? 'EXTREME — activate kill switch' : ctx.macro.riskLevel === 'high' ? 'HIGH — reduce 50%' : 'Acceptable', confidence: 0.85 });
    }
  }

  private thinkAsEvolutionist(question: string, ctx: BrainContext, steps: ThoughtStep[]): void {
    if (ctx.portfolio) {
      steps.push({ step: 'Strategy effectiveness', observation: `Win: ${(ctx.portfolio.winRate * 100).toFixed(0)}%, PnL: $${ctx.portfolio.totalPnl.toFixed(2)}`, conclusion: ctx.portfolio.winRate < 0.4 ? 'Underperforming — evolve now' : ctx.portfolio.winRate > 0.6 ? 'Strong — preserve top, mutate bottom' : 'Average — standard cycle', confidence: 0.75 });
    }
    if (ctx.signals?.length) {
      const strats = new Set(ctx.signals.map(s => s.strategy));
      steps.push({ step: 'Strategy diversity', observation: `${strats.size} strategies`, conclusion: strats.size < 3 ? 'Low diversity — spawn variants' : 'Good diversity', confidence: 0.7 });
    }
  }

  private thinkAsOps(question: string, ctx: BrainContext, steps: ThoughtStep[]): void {
    steps.push({ step: 'System resources', observation: `Memory: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0)}MB, Uptime: ${(process.uptime() / 60).toFixed(0)}min`, conclusion: process.memoryUsage().heapUsed > 500 * 1024 * 1024 ? 'Memory high — prune cache' : 'Resources normal', confidence: 0.9 });
    if (ctx.marketData?.size) {
      const empty = [...ctx.marketData.values()].filter(d => d.candles.length === 0).length;
      steps.push({ step: 'Data sources', observation: `${ctx.marketData.size} sources, ${empty} empty`, conclusion: empty > 0 ? `${empty} failing — investigate` : 'All operational', confidence: 0.85 });
    }
  }
}
