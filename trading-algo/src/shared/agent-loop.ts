// ============================================================
// AgentLoop — Autonomous 24/7 event-driven agent lifecycle
//
// Each agent runs an independent loop:
//   1. Process messages from its queue
//   2. Execute scheduled tasks (periodic checks)
//   3. Go idle when nothing to do
//   4. Proactively explore data when idle (with cooldown)
//
// All state transitions are visible through the feedback system.
// ============================================================

import type { AgentId, AgentMessage, TeamId } from './agent-types.js';
import type { AgentBrain, BrainContext, ThoughtChain } from './agent-brain.js';

/** Agent loop states */
export type AgentState =
  | 'running'     // actively processing
  | 'thinking'    // reasoning about a decision
  | 'idle'        // no work to do, waiting for messages
  | 'exploring'   // proactively exploring data
  | 'sleeping'    // paused by CEO or cooldown
  | 'stopped';    // permanently stopped

/** A task the agent can execute */
export interface AgentTask {
  id: string;
  name: string;
  description: string;
  execute: () => Promise<void>;
  intervalMs?: number;      // if set, runs periodically
  lastRunAt?: number;
}

/** Callback for state changes and feedback */
export interface AgentFeedbackHandler {
  onStateChange: (agentId: AgentId, name: string, from: AgentState, to: AgentState) => void;
  onThinking: (agentId: AgentId, name: string, chain: ThoughtChain) => void;
  onAction: (agentId: AgentId, name: string, action: string, detail?: string) => void;
  onIdle: (agentId: AgentId, name: string) => void;
  onError: (agentId: AgentId, name: string, error: string) => void;
}

/** Configuration for the agent loop */
export interface AgentLoopConfig {
  tickIntervalMs: number;      // how often the loop ticks (default 1000ms)
  idleCooldownMs: number;      // min time between idle exploration (default 30s)
  maxQueueSize: number;        // max pending messages (default 100)
  exploreProbability: number;  // chance of exploring when idle (0-1, default 0.3)
}

const DEFAULT_CONFIG: AgentLoopConfig = {
  tickIntervalMs: 1_000,
  idleCooldownMs: 30_000,
  maxQueueSize: 100,
  exploreProbability: 0.3,
};

/**
 * AgentLoop — autonomous event-driven lifecycle for an agent.
 *
 * Attach to any team or agent. Processes messages, runs scheduled
 * tasks, and proactively explores when idle.
 */
export class AgentLoop {
  readonly agentId: AgentId;
  readonly name: string;
  readonly teamId: TeamId;
  private brain: AgentBrain;
  private config: AgentLoopConfig;

  // State
  private state: AgentState = 'stopped';
  private messageQueue: AgentMessage[] = [];
  private scheduledTasks: AgentTask[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastExploreAt = 0;
  private tickCount = 0;
  private processedCount = 0;
  private idleSince = 0;

  // Handlers
  private messageHandler: ((msg: AgentMessage) => Promise<void>) | null = null;
  private exploreHandler: ((brain: AgentBrain, ctx: BrainContext) => Promise<void>) | null = null;
  private contextProvider: (() => BrainContext) | null = null;
  private feedback: AgentFeedbackHandler | null = null;

  constructor(
    agentId: AgentId,
    name: string,
    teamId: TeamId,
    brain: AgentBrain,
    config?: Partial<AgentLoopConfig>,
  ) {
    this.agentId = agentId;
    this.name = name;
    this.teamId = teamId;
    this.brain = brain;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ----------------------------------------------------------------
  // Setup
  // ----------------------------------------------------------------

  /** Set handler for incoming messages */
  onMessage(handler: (msg: AgentMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  /** Set handler for idle exploration */
  onExplore(handler: (brain: AgentBrain, ctx: BrainContext) => Promise<void>): void {
    this.exploreHandler = handler;
  }

  /** Set provider for current brain context */
  setContextProvider(provider: () => BrainContext): void {
    this.contextProvider = provider;
  }

  /** Set feedback handler for state/action reporting */
  setFeedback(handler: AgentFeedbackHandler): void {
    this.feedback = handler;
  }

  /** Add a scheduled task */
  addTask(task: AgentTask): void {
    this.scheduledTasks.push(task);
  }

  // ----------------------------------------------------------------
  // Lifecycle
  // ----------------------------------------------------------------

  /** Start the autonomous loop */
  start(): void {
    if (this.state === 'running' || this.state === 'idle' || this.state === 'thinking') return;

    this.setState('running');
    this.timer = setInterval(() => this.tick(), this.config.tickIntervalMs);
  }

  /** Stop the loop */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.setState('stopped');
  }

  /** Pause (sleep) — CEO directive or cooldown */
  sleep(reason?: string): void {
    this.setState('sleeping');
    this.feedback?.onAction(this.agentId, this.name, 'sleep', reason ?? 'Paused');
  }

  /** Wake from sleep */
  wake(): void {
    if (this.state === 'sleeping') {
      this.setState('running');
      this.feedback?.onAction(this.agentId, this.name, 'wake', 'Resumed');
    }
  }

  /** Enqueue a message for processing */
  enqueue(msg: AgentMessage): void {
    if (this.messageQueue.length >= this.config.maxQueueSize) {
      // Drop oldest
      this.messageQueue.shift();
    }
    this.messageQueue.push(msg);

    // Wake up if idle
    if (this.state === 'idle') {
      this.setState('running');
    }
  }

  // ----------------------------------------------------------------
  // Core tick
  // ----------------------------------------------------------------

  private async tick(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'sleeping') return;

    this.tickCount++;

    try {
      // 1. Process pending messages
      if (this.messageQueue.length > 0) {
        this.setState('running');
        await this.processMessages();
        return;
      }

      // 2. Run scheduled tasks
      const dueTask = this.getNextDueTask();
      if (dueTask) {
        this.setState('running');
        this.feedback?.onAction(this.agentId, this.name, 'task', dueTask.name);
        await dueTask.execute();
        dueTask.lastRunAt = Date.now();
        return;
      }

      // 3. Proactive exploration when idle
      if (this.shouldExplore()) {
        this.setState('exploring');
        await this.explore();
        return;
      }

      // 4. Nothing to do — go idle
      if (this.state !== 'idle') {
        this.setState('idle');
        this.idleSince = Date.now();
        this.feedback?.onIdle(this.agentId, this.name);
      }
    } catch (err) {
      this.feedback?.onError(this.agentId, this.name, (err as Error).message);
      // Don't crash the loop — keep going
    }
  }

  private async processMessages(): Promise<void> {
    // Process up to 5 messages per tick to avoid blocking
    const batch = this.messageQueue.splice(0, 5);
    for (const msg of batch) {
      if (this.messageHandler) {
        this.feedback?.onAction(this.agentId, this.name, 'message', `Processing ${msg.type} from ${msg.from.slice(0, 8)}`);
        await this.messageHandler(msg);
        this.processedCount++;
      }
    }
  }

  private getNextDueTask(): AgentTask | null {
    const now = Date.now();
    for (const task of this.scheduledTasks) {
      if (!task.intervalMs) continue;
      if (!task.lastRunAt || now - task.lastRunAt >= task.intervalMs) {
        return task;
      }
    }
    return null;
  }

  private shouldExplore(): boolean {
    if (!this.exploreHandler) return false;
    const now = Date.now();
    if (now - this.lastExploreAt < this.config.idleCooldownMs) return false;
    return Math.random() < this.config.exploreProbability;
  }

  private async explore(): Promise<void> {
    const ctx = this.contextProvider?.() ?? {};

    // Use AI-powered thinking if available, else rule-based
    const chain = await this.brain.thinkAsync('What should I do while idle?', ctx);
    this.feedback?.onThinking(this.agentId, this.name, chain);

    if (chain.confidence > 0.3 && this.exploreHandler) {
      this.feedback?.onAction(this.agentId, this.name, 'explore', chain.decision);
      await this.exploreHandler(this.brain, ctx);
    }

    this.lastExploreAt = Date.now();
  }

  // ----------------------------------------------------------------
  // State management
  // ----------------------------------------------------------------

  private setState(newState: AgentState): void {
    if (this.state === newState) return;
    const oldState = this.state;
    this.state = newState;
    this.feedback?.onStateChange(this.agentId, this.name, oldState, newState);
  }

  getState(): AgentState { return this.state; }
  getTickCount(): number { return this.tickCount; }
  getProcessedCount(): number { return this.processedCount; }
  getQueueSize(): number { return this.messageQueue.length; }
  getIdleDuration(): number { return this.state === 'idle' ? Date.now() - this.idleSince : 0; }
  getBrain(): AgentBrain { return this.brain; }

  /** Summary for diagnostics */
  getStatus(): Record<string, unknown> {
    return {
      agentId: this.agentId,
      name: this.name,
      team: this.teamId,
      state: this.state,
      ticks: this.tickCount,
      processed: this.processedCount,
      queueSize: this.messageQueue.length,
      scheduledTasks: this.scheduledTasks.length,
      idleDurationMs: this.getIdleDuration(),
    };
  }
}
