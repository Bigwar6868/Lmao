import { describe, it, expect, vi } from 'vitest';
import { AgentNetwork } from '../src/team/agent-network/network.js';
import { EventBus } from '../src/shared/events.js';

// ---- AgentNetwork ----

describe('AgentNetwork', () => {
  describe('registration', () => {
    it('should register agents', () => {
      const network = new AgentNetwork();
      network.register('agent-1');
      network.register('agent-2');
      expect(network.agentCount).toBe(2);
    });

    it('should unregister agents', () => {
      const network = new AgentNetwork();
      network.register('agent-1');
      network.register('agent-2');
      network.unregister('agent-1');
      expect(network.agentCount).toBe(1);
    });

    it('should list agent IDs', () => {
      const network = new AgentNetwork();
      network.register('alpha');
      network.register('beta');
      const ids = network.getAgentIds();
      expect(ids).toContain('alpha');
      expect(ids).toContain('beta');
    });
  });

  describe('messaging', () => {
    it('should deliver broadcast messages to subscribers', async () => {
      const network = new AgentNetwork();
      network.register('sender');
      network.register('receiver');

      const received: string[] = [];
      network.on('receiver', 'alert', (msg) => {
        received.push(msg.from);
      });

      await network.broadcast('sender', 'alert', {
        type: 'alert',
        severity: 'info',
        message: 'test signal',
        data: {},
      });

      expect(received).toContain('sender');
    });

    it('should not deliver to sender', async () => {
      const network = new AgentNetwork();
      network.register('agent-1');

      let selfReceived = false;
      network.on('agent-1', 'alert', () => {
        selfReceived = true;
      });

      await network.broadcast('agent-1', 'alert', {
        type: 'alert',
        severity: 'info',
        message: 'test',
        data: {},
      });

      expect(selfReceived).toBe(false);
    });

    it('should deliver unicast only to target', async () => {
      const network = new AgentNetwork();
      network.register('sender');
      network.register('target');
      network.register('other');

      let targetReceived = false;
      let otherReceived = false;

      network.on('target', 'report', () => { targetReceived = true; });
      network.on('other', 'report', () => { otherReceived = true; });

      await network.unicast('sender', 'target', 'report', {
        type: 'report',
        reportType: 'analysis',
        summary: 'test report',
        data: {},
      });

      expect(targetReceived).toBe(true);
      expect(otherReceived).toBe(false);
    });

    it('should deliver to global handlers', async () => {
      const network = new AgentNetwork();
      network.register('sender');
      network.register('listener');

      let globalReceived = false;
      network.onAll('listener', () => {
        globalReceived = true;
      });

      await network.broadcast('sender', 'alert', {
        type: 'alert',
        severity: 'warning',
        message: 'test',
        data: {},
      });

      expect(globalReceived).toBe(true);
    });

    it('should store messages in log', async () => {
      const network = new AgentNetwork();
      network.register('agent-1');

      await network.broadcast('agent-1', 'alert', {
        type: 'alert',
        severity: 'info',
        message: 'test signal',
        data: {},
      });

      const recent = network.getRecentMessages(10);
      expect(recent.length).toBeGreaterThan(0);
      expect(recent[0].from).toBe('agent-1');
    });

    it('should retrieve recent messages', async () => {
      const network = new AgentNetwork();
      network.register('agent-a');
      network.register('agent-b');

      await network.broadcast('agent-a', 'alert', {
        type: 'alert',
        severity: 'info',
        message: 'first',
        data: {},
      });

      await network.broadcast('agent-b', 'report', {
        type: 'report',
        reportType: 'status',
        summary: 'second',
        data: {},
      });

      const msgs = network.getRecentMessages(10);
      expect(msgs.length).toBe(2);
      expect(msgs[0].from).toBe('agent-a');
      expect(msgs[1].from).toBe('agent-b');
    });
  });
});

// ---- EventBus ----

describe('EventBus', () => {
  it('should deliver events to handlers', async () => {
    const bus = new EventBus();
    let received = false;

    bus.on('market:data', () => { received = true; });
    await bus.emit('market:data', { test: true }, 'test');

    expect(received).toBe(true);
  });

  it('should support multiple handlers for same event', async () => {
    const bus = new EventBus();
    let count = 0;

    bus.on('signal:generated', () => { count++; });
    bus.on('signal:generated', () => { count++; });
    await bus.emit('signal:generated', {}, 'test');

    expect(count).toBe(2);
  });

  it('should not deliver to unsubscribed handlers', async () => {
    const bus = new EventBus();
    let count = 0;

    const unsub = bus.on('order:filled', () => { count++; });
    unsub(); // Unsubscribe
    await bus.emit('order:filled', {}, 'test');

    expect(count).toBe(0);
  });

  it('should deliver to onAll handlers for any event', async () => {
    const bus = new EventBus();
    const events: string[] = [];

    bus.onAll((event) => { events.push(event.type); });
    await bus.emit('market:data', {}, 'test');
    await bus.emit('signal:generated', {}, 'test');

    expect(events).toContain('market:data');
    expect(events).toContain('signal:generated');
  });

  it('should clear all handlers', async () => {
    const bus = new EventBus();
    let count = 0;

    bus.on('market:data', () => { count++; });
    bus.onAll(() => { count++; });
    bus.clear();

    await bus.emit('market:data', {}, 'test');
    expect(count).toBe(0);
  });

  it('should include correct event metadata', async () => {
    const bus = new EventBus();
    let capturedEvent: any = null;

    bus.on('risk:alert', (event) => { capturedEvent = event; });
    await bus.emit('risk:alert', { level: 'high' }, 'risk-manager');

    expect(capturedEvent).not.toBeNull();
    expect(capturedEvent.type).toBe('risk:alert');
    expect(capturedEvent.source).toBe('risk-manager');
    expect(capturedEvent.data.level).toBe('high');
    expect(capturedEvent.timestamp).toBeDefined();
  });
});
