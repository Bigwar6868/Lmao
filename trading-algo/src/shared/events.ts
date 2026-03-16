import type { EventType, TradingEvent } from './types.js';

type EventHandler<T = unknown> = (event: TradingEvent<T>) => void | Promise<void>;

/**
 * Event bus for inter-module communication.
 * All team members communicate through events, keeping them decoupled.
 */
export class EventBus {
  private handlers = new Map<EventType, Set<EventHandler>>();
  private allHandlers = new Set<EventHandler>();

  on<T = unknown>(type: EventType, handler: EventHandler<T>): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler as EventHandler);
    return () => this.handlers.get(type)?.delete(handler as EventHandler);
  }

  onAll(handler: EventHandler): () => void {
    this.allHandlers.add(handler);
    return () => this.allHandlers.delete(handler);
  }

  async emit<T = unknown>(type: EventType, data: T, source: string): Promise<void> {
    const event: TradingEvent<T> = {
      type,
      data,
      timestamp: Date.now(),
      source,
    };

    const handlers = this.handlers.get(type) ?? new Set();
    const promises: Promise<void>[] = [];

    for (const handler of handlers) {
      const result = handler(event);
      if (result instanceof Promise) promises.push(result);
    }
    for (const handler of this.allHandlers) {
      const result = handler(event);
      if (result instanceof Promise) promises.push(result);
    }

    await Promise.allSettled(promises);
  }

  clear(): void {
    this.handlers.clear();
    this.allHandlers.clear();
  }
}

export const eventBus = new EventBus();
