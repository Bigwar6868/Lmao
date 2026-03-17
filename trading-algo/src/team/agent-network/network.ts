// ============================================================
// AgentNetwork — message bus for inter-agent communication
// ============================================================

import type {
  AgentId,
  AgentMessage,
  AgentMessagePayload,
  MessageType,
} from '../../shared/agent-types.js';
import { generateId, withTimeout } from '../../shared/utils.js';
import { createModuleLogger } from '../../shared/logger.js';
import { config } from '../../config/index.js';

const log = createModuleLogger('agent-network');

type MessageHandler = (message: AgentMessage) => void | Promise<void>;

/**
 * Central message bus that routes messages between trading agents.
 * Agents subscribe to message types and broadcast/unicast messages.
 */
export class AgentNetwork {
  /** All registered agents */
  private agents = new Set<AgentId>();
  /** Handlers subscribed to specific message types */
  private typeHandlers = new Map<MessageType, Map<AgentId, MessageHandler>>();
  /** Handlers for all messages (global listeners) */
  private globalHandlers = new Map<AgentId, MessageHandler>();
  /** Message history for replay/audit */
  private messageLog: AgentMessage[] = [];
  /** Max log size */
  private maxLogSize = 5000;

  /** Register an agent on the network */
  register(agentId: AgentId): void {
    this.agents.add(agentId);
    log.debug({ agentId }, 'Agent registered on network');
  }

  /** Remove an agent from the network */
  unregister(agentId: AgentId): void {
    this.agents.delete(agentId);
    // Clean up handlers
    for (const handlers of this.typeHandlers.values()) {
      handlers.delete(agentId);
    }
    this.globalHandlers.delete(agentId);
    log.debug({ agentId }, 'Agent unregistered from network');
  }

  /** Subscribe to a specific message type */
  on(agentId: AgentId, type: MessageType, handler: MessageHandler): void {
    if (!this.typeHandlers.has(type)) {
      this.typeHandlers.set(type, new Map());
    }
    this.typeHandlers.get(type)!.set(agentId, handler);
  }

  /** Subscribe to ALL messages */
  onAll(agentId: AgentId, handler: MessageHandler): void {
    this.globalHandlers.set(agentId, handler);
  }

  /** Send a message (broadcast or unicast) */
  async send(message: AgentMessage): Promise<void> {
    // Log the message
    this.messageLog.push(message);
    if (this.messageLog.length > this.maxLogSize) {
      this.messageLog = this.messageLog.slice(-this.maxLogSize / 2);
    }

    log.debug({
      type: message.type,
      from: message.from,
      to: message.to,
    }, 'Message sent');

    const promises: Promise<void>[] = [];
    const timeout = config.networkMessageTimeoutMs;

    // Deliver to type-specific handlers
    const handlers = this.typeHandlers.get(message.type);
    if (handlers) {
      for (const [agentId, handler] of handlers) {
        // Don't deliver to sender, and respect unicast targeting
        if (agentId === message.from) continue;
        if (message.to !== 'all' && message.to !== agentId) continue;

        try {
          const result = handler(message);
          if (result instanceof Promise) {
            promises.push(
              withTimeout(result, timeout, `handler:${message.type}:${agentId.slice(0, 8)}`)
                .catch(err => { log.warn({ err: (err as Error).message, agentId: agentId.slice(0, 8), type: message.type }, 'Message handler timed out'); }),
            );
          }
        } catch (err) {
          log.warn({ err: (err as Error).message, agentId: agentId.slice(0, 8) }, 'Message handler threw synchronously');
        }
      }
    }

    // Deliver to global handlers
    for (const [agentId, handler] of this.globalHandlers) {
      if (agentId === message.from) continue;
      if (message.to !== 'all' && message.to !== agentId) continue;

      try {
        const result = handler(message);
        if (result instanceof Promise) {
          promises.push(
            withTimeout(result, timeout, `global:${agentId.slice(0, 8)}`)
              .catch(err => { log.warn({ err: (err as Error).message, agentId: agentId.slice(0, 8) }, 'Global handler timed out'); }),
          );
        }
      } catch (err) {
        log.warn({ err: (err as Error).message, agentId: agentId.slice(0, 8) }, 'Global handler threw synchronously');
      }
    }

    await Promise.allSettled(promises);
  }

  /** Convenience: create and send a message */
  async broadcast(
    from: AgentId,
    type: MessageType,
    payload: AgentMessagePayload,
    replyTo?: string,
  ): Promise<AgentMessage> {
    const message: AgentMessage = {
      id: generateId(),
      type,
      from,
      to: 'all',
      timestamp: Date.now(),
      payload,
      replyTo,
    };
    await this.send(message);
    return message;
  }

  /** Send to a specific agent */
  async unicast(
    from: AgentId,
    to: AgentId,
    type: MessageType,
    payload: AgentMessagePayload,
    replyTo?: string,
  ): Promise<AgentMessage> {
    const message: AgentMessage = {
      id: generateId(),
      type,
      from,
      to,
      timestamp: Date.now(),
      payload,
      replyTo,
    };
    await this.send(message);
    return message;
  }

  /** Get recent messages */
  getRecentMessages(count = 50): AgentMessage[] {
    return this.messageLog.slice(-count);
  }

  /** How many agents are registered */
  get agentCount(): number {
    return this.agents.size;
  }

  /** List all registered agent IDs */
  getAgentIds(): AgentId[] {
    return [...this.agents];
  }
}
