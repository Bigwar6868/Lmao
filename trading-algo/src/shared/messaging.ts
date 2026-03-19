import type { Signal, StrategyDNA, PerformanceMetrics, Portfolio } from './types.js';
import { createModuleLogger } from './logger.js';
import { eventBus } from './events.js';

const log = createModuleLogger('messaging');

// ============================================================
// Message Types
// ============================================================

export type MessageChannel = 'claude' | 'kimiclaw' | 'ollama';

export interface MessageTarget {
  channel: MessageChannel;
  /** Webhook URL or API endpoint (KimiClaw webhook, Ollama API, etc.) */
  endpoint?: string;
  /** API key for authentication */
  apiKey?: string;
  /** KimiClaw destination (e.g. 'telegram', 'discord', 'whatsapp', 'wechat') */
  destination?: string;
  /** Model ID for LLM-backed channels (e.g. 'kimi', 'llama3', 'mistral', 'qwen') */
  model?: string;
  /** Message types this target should receive (undefined = all) */
  filter?: TradingMessage['type'][];
}

export type MessagePriority = 'low' | 'normal' | 'high' | 'critical';

export interface TradingMessage {
  id: string;
  type: 'evolution' | 'signal' | 'portfolio' | 'alert' | 'system';
  title: string;
  body: string;
  priority: MessagePriority;
  timestamp: number;
  metadata: Record<string, unknown>;
}

// ============================================================
// Message Formatters
// ============================================================

export function formatEvolutionMessage(data: {
  strategy: string;
  generation: number;
  fitness: number;
  previousFitness: number;
  params: Record<string, number>;
  improved: boolean;
}): TradingMessage {
  const improvement = data.previousFitness > 0
    ? ((data.fitness - data.previousFitness) / data.previousFitness * 100).toFixed(1)
    : 'N/A';

  const paramsSummary = Object.entries(data.params)
    .map(([k, v]) => `  ${k}: ${typeof v === 'number' ? v.toFixed(4) : v}`)
    .join('\n');

  const emoji = data.improved ? '[IMPROVED]' : '[STABLE]';

  return {
    id: `evo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: 'evolution',
    title: `${emoji} Strategy Evolution: ${data.strategy}`,
    body: [
      `Strategy: ${data.strategy}`,
      `Generation: ${data.generation}`,
      `Fitness: ${data.fitness.toFixed(4)} (${data.improved ? `+${improvement}%` : 'no improvement'})`,
      `Previous Fitness: ${data.previousFitness.toFixed(4)}`,
      '',
      'Parameters:',
      paramsSummary,
    ].join('\n'),
    priority: data.improved ? 'high' : 'normal',
    timestamp: Date.now(),
    metadata: { ...data },
  };
}

export function formatSignalMessage(signal: Signal): TradingMessage {
  const priority: MessagePriority = signal.confidence > 0.8 ? 'high'
    : signal.confidence > 0.6 ? 'normal' : 'low';

  const indicatorsSummary = Object.entries(signal.indicators)
    .map(([k, v]) => `  ${k}: ${typeof v === 'number' ? v.toFixed(4) : v}`)
    .join('\n');

  return {
    id: `sig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: 'signal',
    title: `[${signal.action}] ${signal.asset.symbol} @ ${signal.price.toFixed(5)}`,
    body: [
      `Asset: ${signal.asset.symbol} (${signal.asset.assetClass})`,
      `Action: ${signal.action}`,
      `Price: ${signal.price.toFixed(5)}`,
      `Confidence: ${(signal.confidence * 100).toFixed(1)}%`,
      `Strategy: ${signal.strategy}`,
      `Timeframe: ${signal.timeframe}`,
      `Reason: ${signal.reason}`,
      '',
      'Indicators:',
      indicatorsSummary,
    ].join('\n'),
    priority,
    timestamp: signal.timestamp,
    metadata: { signal },
  };
}

export function formatPortfolioMessage(portfolio: Portfolio): TradingMessage {
  const positionsSummary = portfolio.positions
    .filter(p => p.status === 'open')
    .map(p => `  ${p.asset.symbol}: ${p.side} ${p.quantity} @ ${p.entryPrice.toFixed(5)} (PnL: ${p.unrealizedPnl.toFixed(2)})`)
    .join('\n') || '  (no open positions)';

  return {
    id: `port-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: 'portfolio',
    title: `Portfolio Update`,
    body: [
      `Capital: $${portfolio.capital.toFixed(2)}`,
      `Available: $${portfolio.availableCapital.toFixed(2)}`,
      `Total PnL: $${portfolio.totalPnl.toFixed(2)} (${portfolio.totalPnlPct.toFixed(2)}%)`,
      `Max Drawdown: ${portfolio.maxDrawdown.toFixed(2)}%`,
      `Open Positions: ${portfolio.positions.filter(p => p.status === 'open').length}`,
      '',
      'Positions:',
      positionsSummary,
    ].join('\n'),
    priority: Math.abs(portfolio.totalPnlPct) > 5 ? 'high' : 'normal',
    timestamp: portfolio.lastUpdated,
    metadata: { portfolio },
  };
}

export function formatAlertMessage(
  title: string,
  body: string,
  priority: MessagePriority = 'high',
): TradingMessage {
  return {
    id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: 'alert',
    title,
    body,
    priority,
    timestamp: Date.now(),
    metadata: {},
  };
}

// ============================================================
// Message Dispatcher
// ============================================================

/**
 * Dispatches trading messages to configured channels.
 *
 * Supports dual-model routing:
 *   - Claude Code (structured logs — default)
 *   - KimiClaw (webhook → WeChat, Telegram, Discord, WhatsApp)
 *   - Ollama / open-source LLMs (local API for AI-powered analysis)
 *
 * You can run TWO models simultaneously, e.g.:
 *   - KimiClaw (Kimi model) for signal notifications → WeChat
 *   - Ollama (Llama/Mistral) for evolution analysis → local
 *
 * Configure via env vars:
 *   KIMICLAW_WEBHOOK_URL, KIMICLAW_API_KEY, KIMICLAW_DESTINATION, KIMICLAW_MODEL
 *   OLLAMA_ENDPOINT (default: http://localhost:11434), OLLAMA_MODEL (default: llama3)
 */
export class MessageDispatcher {
  private targets: MessageTarget[] = [];
  private messageHistory: TradingMessage[] = [];
  private maxHistory = 100;

  constructor(targets?: MessageTarget[]) {
    if (targets) {
      this.targets = targets;
    } else {
      // Default: Claude Code output
      this.targets = [{ channel: 'claude' }];

      // Auto-detect KimiClaw from env
      const kimiclawEndpoint = process.env.KIMICLAW_WEBHOOK_URL ?? process.env.KIMICLAW_ENDPOINT;
      if (kimiclawEndpoint) {
        this.targets.push({
          channel: 'kimiclaw',
          endpoint: kimiclawEndpoint,
          apiKey: process.env.KIMICLAW_API_KEY,
          destination: process.env.KIMICLAW_DESTINATION ?? 'telegram',
          model: process.env.KIMICLAW_MODEL ?? 'kimi',
        });
      }

      // Auto-detect Ollama (local open-source LLM)
      const ollamaEndpoint = process.env.OLLAMA_ENDPOINT;
      if (ollamaEndpoint) {
        this.targets.push({
          channel: 'ollama',
          endpoint: ollamaEndpoint,
          model: process.env.OLLAMA_MODEL ?? 'llama3',
          // Ollama only gets evolution + alert messages by default (analysis role)
          filter: ['evolution', 'alert', 'portfolio'],
        });
      }
    }

    log.info({
      channels: this.targets.map(t => `${t.channel}${t.model ? `(${t.model})` : ''}`),
    }, 'MessageDispatcher initialized');
  }

  addTarget(target: MessageTarget): void {
    this.targets.push(target);
    log.info({ channel: target.channel, model: target.model }, 'Message target added');
  }

  removeTarget(channel: MessageChannel): void {
    this.targets = this.targets.filter(t => t.channel !== channel);
  }

  getTargets(): MessageTarget[] {
    return [...this.targets];
  }

  /**
   * Send a message to all configured targets.
   * Each target can filter by message type.
   */
  async send(message: TradingMessage): Promise<void> {
    this.messageHistory.push(message);
    if (this.messageHistory.length > this.maxHistory) {
      this.messageHistory = this.messageHistory.slice(-this.maxHistory);
    }

    for (const target of this.targets) {
      // Check filter — skip if target doesn't want this message type
      if (target.filter && !target.filter.includes(message.type)) continue;

      try {
        switch (target.channel) {
          case 'claude':
            this.sendToClaude(message);
            break;
          case 'kimiclaw':
            await this.sendToKimiClaw(message, target);
            break;
          case 'ollama':
            await this.sendToOllama(message, target);
            break;
        }
      } catch (err) {
        log.error({ channel: target.channel, error: err }, 'Failed to send message');
      }
    }
  }

  /**
   * Send to Claude Code (structured log output).
   */
  private sendToClaude(message: TradingMessage): void {
    const logFn = message.priority === 'critical' || message.priority === 'high'
      ? log.warn.bind(log) : log.info.bind(log);

    logFn({
      messageType: message.type,
      title: message.title,
      priority: message.priority,
    }, `[MSG] ${message.title}\n${message.body}`);
  }

  /**
   * Send to KimiClaw via webhook/API.
   * KimiClaw routes messages to WeChat, Telegram, Discord, WhatsApp, etc.
   */
  private async sendToKimiClaw(message: TradingMessage, target: MessageTarget): Promise<void> {
    if (!target.endpoint) {
      log.warn('KimiClaw endpoint not configured — skipping');
      return;
    }

    const payload = {
      // KimiClaw standard fields
      message: `**${message.title}**\n\n${message.body}`,
      destination: target.destination ?? 'telegram',
      model: target.model ?? 'kimi',
      priority: message.priority,
      // Structured data for KimiClaw agents to process
      structured: {
        id: message.id,
        type: message.type,
        title: message.title,
        body: message.body,
        metadata: message.metadata,
        timestamp: message.timestamp,
      },
    };

    await this.postWebhook(target, payload, 'KimiClaw');
  }

  /**
   * Send to a local Ollama instance for AI-powered analysis.
   * The open-source LLM can analyze evolution results, suggest parameter
   * tweaks, or provide a second opinion on trading signals.
   */
  private async sendToOllama(message: TradingMessage, target: MessageTarget): Promise<void> {
    if (!target.endpoint) {
      log.warn('Ollama endpoint not configured — skipping');
      return;
    }

    const systemPrompt = 'You are a quantitative trading analyst. Analyze the following trading system update and provide brief, actionable insights. Focus on risk, opportunity, and what to monitor next.';

    const payload = {
      model: target.model ?? 'llama3',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `${message.title}\n\n${message.body}` },
      ],
      stream: false,
    };

    const endpoint = `${target.endpoint.replace(/\/$/, '')}/api/chat`;

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000), // LLM inference can be slow
      });

      if (response.ok) {
        const result = await response.json() as { message?: { content?: string } };
        const analysis = result.message?.content;
        if (analysis) {
          log.info({
            model: target.model,
            messageType: message.type,
            analysis: analysis.slice(0, 200),
          }, `[Ollama/${target.model}] ${analysis}`);
        }
      } else {
        log.warn({ status: response.status, endpoint }, 'Ollama returned non-OK status');
      }
    } catch (err) {
      log.error({ error: err, endpoint }, 'Ollama request failed');
    }
  }

  /**
   * Generic webhook POST helper.
   */
  private async postWebhook(
    target: MessageTarget,
    payload: Record<string, unknown>,
    label: string,
  ): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (target.apiKey) {
      headers['Authorization'] = `Bearer ${target.apiKey}`;
    }

    try {
      const response = await fetch(target.endpoint!, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        log.warn({ status: response.status, endpoint: target.endpoint }, `${label} webhook returned non-OK status`);
      } else {
        log.debug({ endpoint: target.endpoint }, `Message sent to ${label}`);
      }
    } catch (err) {
      log.error({ error: err, endpoint: target.endpoint }, `${label} webhook failed`);
    }
  }

  /**
   * Get recent message history.
   */
  getHistory(limit = 20): TradingMessage[] {
    return this.messageHistory.slice(-limit);
  }
}

// ============================================================
// Singleton + Event Wiring
// ============================================================

/** Global message dispatcher instance */
export const messageDispatcher = new MessageDispatcher();

/**
 * Wire up event bus to automatically dispatch messages for key events.
 * Call this once during system initialization.
 */
export function wireMessagingEvents(): void {
  eventBus.on('evolution:improvement', (event) => {
    const data = event.data as {
      strategy: string;
      generation: number;
      fitness: number;
      params: Record<string, number>;
    };
    const msg = formatEvolutionMessage({
      ...data,
      previousFitness: 0,
      improved: true,
    });
    messageDispatcher.send(msg);
  });

  eventBus.on('signal:generated', (event) => {
    const signal = event.data as Signal;
    // Only dispatch high-confidence signals to avoid noise
    if (signal.confidence >= 0.6) {
      const msg = formatSignalMessage(signal);
      messageDispatcher.send(msg);
    }
  });

  eventBus.on('risk:alert', (event) => {
    const data = event.data as { title: string; message: string };
    const msg = formatAlertMessage(
      data.title ?? 'Risk Alert',
      data.message ?? JSON.stringify(data),
      'critical',
    );
    messageDispatcher.send(msg);
  });

  log.info('Messaging events wired to EventBus');
}
