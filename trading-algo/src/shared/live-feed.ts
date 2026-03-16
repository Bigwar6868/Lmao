// ============================================================
// Live Feed — Human-readable agent communication display
//
// Hooks into AgentNetwork and prints agent conversations,
// CEO directives, debates, and system events in real-time.
// ============================================================

import type {
  AgentId,
  AgentMessage,
  TradeProposal,
  TradeDoubt,
  TradeSupport,
  TradeCounter,
  DebateVerdict,
  DirectivePayload,
  ApprovalPayload,
  VetoPayload,
  ReportPayload,
  RequestPayload,
  DiscussPayload,
  QuestionPayload,
  AnswerPayload,
  AlertPayload,
} from './agent-types.js';
import type { ThoughtChain } from './agent-brain.js';
import type { AgentState, AgentFeedbackHandler } from './agent-loop.js';
import type { AgentNetwork } from '../team/agent-network/network.js';

// ANSI color codes for terminal
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  // Agent roles
  ceo: '\x1b[33m',        // yellow
  trading: '\x1b[36m',    // cyan
  research: '\x1b[35m',   // magenta
  risk: '\x1b[31m',       // red
  evolution: '\x1b[32m',  // green
  ops: '\x1b[34m',        // blue
  // Message types
  proposal: '\x1b[36m',   // cyan
  doubt: '\x1b[31m',      // red
  support: '\x1b[32m',    // green
  verdict: '\x1b[33m',    // yellow
  directive: '\x1b[33;1m',// bold yellow
  alert: '\x1b[31;1m',    // bold red
  discuss: '\x1b[37m',    // white
  system: '\x1b[90m',     // gray
};

/** Agent name registry — maps IDs to readable names */
const agentNames = new Map<AgentId, string>();

/** Register an agent name for display */
export function registerAgentName(id: AgentId, name: string): void {
  agentNames.set(id, name);
}

/** Get readable name for an agent ID */
function getName(id: AgentId | 'all'): string {
  if (id === 'all') return 'ALL';
  return agentNames.get(id) ?? `agent-${id.slice(0, 6)}`;
}

/** Format timestamp as HH:MM:SS */
function ts(): string {
  const now = new Date();
  return `${C.dim}${now.toTimeString().slice(0, 8)}${C.reset}`;
}

/** Get color for a name based on role hints */
function nameColor(name: string): string {
  const lower = name.toLowerCase();
  if (lower === 'ceo' || lower.includes('ceo')) return C.ceo;
  if (lower.includes('trading') || lower.includes('momentum') || lower.includes('breakout') || lower.includes('mean-rev') || lower.includes('multi-ind')) return C.trading;
  if (lower.includes('research')) return C.research;
  if (lower.includes('risk')) return C.risk;
  if (lower.includes('evolution') || lower.includes('evolve')) return C.evolution;
  if (lower.includes('ops') || lower.includes('diag')) return C.ops;
  return C.discuss;
}

/** Format a single message for display */
function formatMessage(msg: AgentMessage): string | null {
  const from = getName(msg.from);
  const to = getName(msg.to);
  const color = nameColor(from);
  const arrow = msg.to === 'all' ? '>> ALL' : `-> ${to}`;

  switch (msg.type) {
    case 'proposal': {
      const p = msg.payload as TradeProposal;
      return `${ts()} ${C.proposal}[PROPOSAL]${C.reset} ${color}${C.bold}${from}${C.reset} ${arrow}: ` +
        `${C.bold}${p.signal.action} ${p.signal.asset.symbol}${C.reset} ` +
        `(confidence: ${(p.signal.confidence * 100).toFixed(0)}%, conviction: ${(p.conviction * 100).toFixed(0)}%) ` +
        `— "${p.reasoning}"`;
    }

    case 'doubt': {
      const d = msg.payload as TradeDoubt;
      const sev = d.severity === 'veto' ? '!!VETO!!' : d.severity === 'strong' ? '!STRONG' : 'mild';
      return `${ts()} ${C.doubt}[DOUBT ${sev}]${C.reset} ${color}${C.bold}${from}${C.reset} ${arrow}: ` +
        `"${d.reason}" ` +
        `${C.dim}(counter-evidence: ${Object.entries(d.counterEvidence).map(([k, v]) => `${k}=${v}`).join(', ')})${C.reset}`;
    }

    case 'support': {
      const s = msg.payload as TradeSupport;
      return `${ts()} ${C.support}[SUPPORT]${C.reset} ${color}${C.bold}${from}${C.reset} ${arrow}: ` +
        `"${s.reason}" (+${(s.additionalConfidence * 100).toFixed(0)}% confidence)`;
    }

    case 'counter': {
      const c = msg.payload as TradeCounter;
      return `${ts()} ${C.doubt}[COUNTER]${C.reset} ${color}${C.bold}${from}${C.reset} ${arrow}: ` +
        `Proposes ${c.alternativeSignal.action} instead — "${c.reason}"`;
    }

    case 'verdict': {
      const v = msg.payload as DebateVerdict;
      const icon = v.approved ? '✓' : '✗';
      const vColor = v.approved ? C.support : C.doubt;
      return `${ts()} ${C.verdict}[VERDICT]${C.reset} ${vColor}${C.bold}${icon} ${v.approved ? 'APPROVED' : 'REJECTED'}${C.reset} ` +
        `(${(v.finalConfidence * 100).toFixed(0)}% confidence, ` +
        `${v.supporters.length} supporters, ${v.doubters.length} doubters) ` +
        `— ${v.reason}`;
    }

    case 'directive': {
      const d = msg.payload as DirectivePayload;
      return `${ts()} ${C.directive}[CEO DIRECTIVE]${C.reset} ${C.ceo}${C.bold}CEO${C.reset} -> ${d.targetTeam}: ` +
        `${C.bold}${d.directiveType}${C.reset} [${d.priority}] — "${d.reason}"`;
    }

    case 'approval': {
      const a = msg.payload as ApprovalPayload;
      return `${ts()} ${C.support}[APPROVED]${C.reset} ${C.ceo}${C.bold}CEO${C.reset} ${arrow}: ` +
        `"${a.reason}"`;
    }

    case 'veto': {
      const v = msg.payload as VetoPayload;
      return `${ts()} ${C.doubt}[CEO VETO]${C.reset} ${C.ceo}${C.bold}CEO${C.reset} ${arrow}: ` +
        `"${v.reason}"`;
    }

    case 'report': {
      const r = msg.payload as ReportPayload;
      return `${ts()} ${C.system}[REPORT]${C.reset} ${color}${C.bold}${from}${C.reset} -> CEO: ` +
        `[${r.reportType}] ${r.summary}`;
    }

    case 'request': {
      const r = msg.payload as RequestPayload;
      return `${ts()} ${C.discuss}[REQUEST]${C.reset} ${color}${C.bold}${from}${C.reset} -> CEO: ` +
        `${C.bold}${r.requestType}${C.reset} — "${r.description}"`;
    }

    case 'discuss': {
      const d = msg.payload as DiscussPayload;
      return `${ts()} ${C.discuss}[DISCUSS]${C.reset} ${color}${C.bold}${from}${C.reset} ${arrow}: ` +
        `[${d.topic}] ${d.content}`;
    }

    case 'question': {
      const q = msg.payload as QuestionPayload;
      return `${ts()} ${C.discuss}[Q]${C.reset} ${color}${C.bold}${from}${C.reset} ${arrow}: ` +
        `"${q.question}"`;
    }

    case 'answer': {
      const a = msg.payload as AnswerPayload;
      return `${ts()} ${C.discuss}[A]${C.reset} ${color}${C.bold}${from}${C.reset} ${arrow}: ` +
        `"${a.answer}"`;
    }

    case 'alert': {
      const a = msg.payload as AlertPayload;
      return `${ts()} ${C.alert}[ALERT ${a.severity.toUpperCase()}]${C.reset} ${color}${C.bold}${from}${C.reset}: ` +
        `${a.message}`;
    }

    case 'performance': {
      // Too noisy for live feed — skip
      return null;
    }

    case 'spawn': {
      return `${ts()} ${C.system}[SPAWN]${C.reset} New agent spawned by ${color}${from}${C.reset}`;
    }

    case 'retire': {
      return `${ts()} ${C.system}[RETIRE]${C.reset} Agent ${color}${from}${C.reset} retired`;
    }

    default:
      return null;
  }
}

/**
 * Attach the live feed to an AgentNetwork.
 * All messages flowing through the network will be printed
 * to console in a human-readable chat format.
 */
export function attachLiveFeed(network: AgentNetwork): void {
  const feedId = 'live-feed-renderer';
  network.register(feedId);

  // Dedup: track recently printed message IDs to avoid duplicates
  const recentIds = new Set<string>();
  const MAX_RECENT = 500;

  // Listen to ALL message types
  network.onAll(feedId, (msg: AgentMessage) => {
    // Deduplicate — same message may arrive via multiple handlers
    if (recentIds.has(msg.id)) return;
    recentIds.add(msg.id);
    if (recentIds.size > MAX_RECENT) {
      const first = recentIds.values().next().value;
      if (first) recentIds.delete(first);
    }

    const formatted = formatMessage(msg);
    if (formatted) {
      console.log(formatted);
    }
  });
}

/**
 * Print a system-level event (not from an agent).
 */
export function printSystemEvent(event: string): void {
  console.log(`${ts()} ${C.system}[SYSTEM]${C.reset} ${event}`);
}

/**
 * Print a separator line.
 */
export function printSeparator(label?: string): void {
  if (label) {
    console.log(`\n${C.dim}${'─'.repeat(20)} ${label} ${'─'.repeat(20)}${C.reset}`);
  } else {
    console.log(`${C.dim}${'─'.repeat(60)}${C.reset}`);
  }
}

// ============================================================
// Agent Feedback — renders brain thinking, state changes, actions
// ============================================================

// Additional ANSI codes for thinking display
const T = {
  thought: '\x1b[38;5;141m',  // light purple
  step: '\x1b[38;5;245m',     // gray
  explore: '\x1b[38;5;220m',  // gold
  idle: '\x1b[38;5;240m',     // dark gray
  state: '\x1b[38;5;75m',     // light blue
  action: '\x1b[38;5;114m',   // light green
  error: '\x1b[38;5;196m',    // bright red
};

/** State emoji indicators */
const stateIcon: Record<AgentState, string> = {
  running: '>>',
  thinking: '??',
  idle: '..',
  exploring: '~~',
  sleeping: 'zz',
  stopped: 'XX',
};

/**
 * Format a thought chain for display.
 * Shows each reasoning step with observations and conclusions.
 */
function formatThought(name: string, chain: ThoughtChain): string {
  const color = nameColor(name);
  const lines: string[] = [];

  const aiTag = chain.usedAI ? `${C.bold}\x1b[38;5;39m[AI]${C.reset}` : `${C.dim}[RULES]${C.reset}`;
  lines.push(
    `${ts()} ${T.thought}[THINKING]${C.reset} ${aiTag} ${color}${C.bold}${name}${C.reset} ` +
    `${C.dim}(${chain.role})${C.reset}: "${chain.question}" ${C.dim}[${chain.durationMs}ms]${C.reset}`,
  );

  for (const step of chain.steps) {
    lines.push(
      `${' '.repeat(10)}${T.step}├─ ${step.step}${C.reset}`,
    );
    lines.push(
      `${' '.repeat(10)}${T.step}│  ${C.dim}Observed: ${step.observation}${C.reset}`,
    );
    const confBar = '█'.repeat(Math.round(step.confidence * 10)) + '░'.repeat(10 - Math.round(step.confidence * 10));
    lines.push(
      `${' '.repeat(10)}${T.step}│  → ${step.conclusion} ${C.dim}[${confBar} ${(step.confidence * 100).toFixed(0)}%]${C.reset}`,
    );
  }

  lines.push(
    `${' '.repeat(10)}${T.thought}└─ Decision: ${C.bold}${chain.decision}${C.reset} ` +
    `${C.dim}(${(chain.confidence * 100).toFixed(0)}% confident)${C.reset}`,
  );

  return lines.join('\n');
}

/**
 * Create a feedback handler that renders agent activity to the console.
 * Plug this into an AgentLoop to see everything the agent does.
 */
export function createFeedbackHandler(): AgentFeedbackHandler {
  return {
    onStateChange(agentId: AgentId, name: string, from: AgentState, to: AgentState): void {
      const color = nameColor(name);
      const icon = stateIcon[to];
      // Only show meaningful transitions (skip idle→running→idle noise)
      if (from === 'idle' && to === 'running') return; // too noisy
      if (from === 'running' && to === 'idle') {
        console.log(`${ts()} ${T.idle}[${icon}]${C.reset} ${color}${name}${C.reset} ${C.dim}went idle${C.reset}`);
        return;
      }
      console.log(
        `${ts()} ${T.state}[${icon}]${C.reset} ${color}${C.bold}${name}${C.reset} ` +
        `${C.dim}${from}${C.reset} → ${C.bold}${to}${C.reset}`,
      );
    },

    onThinking(agentId: AgentId, name: string, chain: ThoughtChain): void {
      console.log(formatThought(name, chain));
    },

    onAction(agentId: AgentId, name: string, action: string, detail?: string): void {
      const color = nameColor(name);
      const actionMap: Record<string, string> = {
        message: 'MSG',
        task: 'TASK',
        explore: 'EXPLORE',
        sleep: 'SLEEP',
        wake: 'WAKE',
      };
      const tag = actionMap[action] ?? action.toUpperCase();
      const tagColor = action === 'explore' ? T.explore : action === 'sleep' ? T.idle : T.action;
      console.log(
        `${ts()} ${tagColor}[${tag}]${C.reset} ${color}${name}${C.reset}` +
        (detail ? `: ${detail}` : ''),
      );
    },

    onIdle(agentId: AgentId, name: string): void {
      // Handled in onStateChange
    },

    onError(agentId: AgentId, name: string, error: string): void {
      const color = nameColor(name);
      console.log(`${ts()} ${T.error}[ERROR]${C.reset} ${color}${C.bold}${name}${C.reset}: ${error}`);
    },
  };
}

/**
 * Print a standalone thinking summary (for agents without a loop).
 */
export function printThinking(name: string, chain: ThoughtChain): void {
  console.log(formatThought(name, chain));
}

/**
 * Print agent status table (for diagnostics).
 */
export function printAgentStatusTable(
  agents: Array<{ name: string; state: AgentState; ticks: number; processed: number; queueSize: number; idleMs: number }>,
): void {
  console.log(`\n${C.dim}${'─'.repeat(20)} AGENT STATUS ${'─'.repeat(20)}${C.reset}`);
  console.log(
    `${C.dim}${'Agent'.padEnd(25)} ${'State'.padEnd(12)} ${'Ticks'.padStart(8)} ${'Processed'.padStart(10)} ${'Queue'.padStart(6)} ${'Idle'.padStart(8)}${C.reset}`,
  );
  for (const a of agents) {
    const color = nameColor(a.name);
    const icon = stateIcon[a.state];
    const idle = a.idleMs > 0 ? `${(a.idleMs / 1000).toFixed(0)}s` : '-';
    console.log(
      `${color}${a.name.padEnd(25)}${C.reset} ${icon} ${a.state.padEnd(10)} ${String(a.ticks).padStart(8)} ${String(a.processed).padStart(10)} ${String(a.queueSize).padStart(6)} ${idle.padStart(8)}`,
    );
  }
  console.log(`${C.dim}${'─'.repeat(60)}${C.reset}\n`);
}
