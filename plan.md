# CEO-Agent Architecture Redesign

## Vision
Replace the current fixed orchestrator with a **CEO agent** that commands all decisions. Agents are autonomous, can discuss freely with each other, and report to the CEO. No fixed assets, strategies, or agent limits — everything is dynamic and CEO-directed.

## Current → New Architecture

### Current Problems
1. **Fixed assets** — hardcoded 109 assets in `config/assets.ts`, all always analyzed
2. **Fixed strategies** — 4 strategies hardcoded in `TechnicalStrategist`
3. **Fixed agent count** — `maxAgents: 20`, `minAgents: 2` per strategy
4. **Orchestrator does everything** — `TradingOrchestrator` is a god-class coordinating all modules
5. **Journal bloat** — `TradingJournal` writes thousands of entries nobody reads
6. **Evolution depends on external API** — evolve calls `marketAnalyst.fetchMarketData()` which hits APIs
7. **Agents can only broadcast/unicast** — no real peer discussion, just proposal/doubt/support

### New Architecture

```
                    ┌─────────┐
                    │   CEO   │  ← Makes all strategic decisions
                    └────┬────┘
                         │ directives, approvals, vetoes
            ┌────────────┼────────────────┐
            │            │                │
       ┌────▼───┐  ┌─────▼────┐    ┌──────▼─────┐
       │ Team A │  │ Team B   │    │ Team C     │
       │(crypto)│  │(stocks)  │    │(research)  │
       └────┬───┘  └─────┬────┘    └──────┬─────┘
            │            │                │
     agents talk    agents talk      agents talk
     to each other  to each other    to each other
```

## Phase 1: CEO Agent + Message Bus Redesign

### 1.1 New Message Types
```typescript
// shared/agent-types.ts — new message types
type MessageType =
  // Existing
  | 'proposal' | 'doubt' | 'support' | 'verdict' | 'spawn'
  // CEO directives
  | 'directive'      // CEO tells agents what to do
  | 'approval'       // CEO approves a request
  | 'veto'           // CEO rejects a request
  // Agent → CEO reports
  | 'report'         // Agent reports findings to CEO
  | 'request'        // Agent requests resources (new agent, strategy, data)
  // Peer discussion
  | 'discuss'        // Free-form agent-to-agent discussion
  | 'question'       // Agent asks another agent
  | 'answer'         // Agent answers another agent
  // Internal evolution
  | 'evolve-result'  // Evolution cycle completed, report to CEO
  | 'performance'    // Agent self-reports performance metrics
```

### 1.2 CEO Agent (`src/team/ceo/index.ts`)
```typescript
export class CEOAgent {
  // The CEO decides:
  // - Which assets to focus on (can change dynamically)
  // - Which strategies to deploy
  // - How many agents to spawn
  // - Whether to approve agent requests
  // - When to trigger evolution (internal, no API)
  // - Risk tolerance and capital allocation

  // CEO has access to:
  private governance: GovernanceEngine;
  private agentRegistry: Map<AgentId, AgentProfile>;
  private performanceBoard: Map<AgentId, PerformanceSnapshot>;

  // CEO actions:
  issueDirective(type: DirectiveType, params: DirectiveParams): void;
  approveRequest(requestId: string): void;
  vetoRequest(requestId: string, reason: string): void;
  evaluatePerformance(): CEOReport;
  reallocateResources(): void;
  triggerEvolution(agentId: AgentId): void;
}

interface Directive {
  type: 'focus-assets'       // "Focus on BTC, ETH, NVDA this cycle"
      | 'deploy-strategy'    // "Deploy breakout strategy on crypto"
      | 'spawn-agent'        // "Spawn 3 more momentum agents"
      | 'retire-agent'       // "Retire agent X, poor performance"
      | 'adjust-risk'        // "Reduce position sizes by 30%"
      | 'pause-trading'      // "Stop all trading, market too volatile"
      | 'resume-trading'     // "Resume trading"
      | 'evolve'             // "Evolve strategy X internally"
      | 'research'           // "Research new asset class / strategy"
  params: Record<string, unknown>;
  priority: 'urgent' | 'normal' | 'low';
}
```

### 1.3 Peer Discussion System
```typescript
// Any agent can start a discussion thread with any other agent
interface Discussion {
  threadId: string;
  topic: string;           // "Should we go long on BTC?"
  participants: AgentId[];
  messages: DiscussionMessage[];
  conclusion?: string;
  reportedToCeo: boolean;  // Was the conclusion forwarded to CEO?
}

interface DiscussionMessage {
  from: AgentId;
  content: string;
  data?: Record<string, unknown>;  // Indicator data, analysis, etc.
  timestamp: number;
}
```

## Phase 2: Remove Fixed Constraints

### 2.1 Dynamic Asset Registry (replaces `config/assets.ts`)
```typescript
// CEO controls which assets are active — not hardcoded
export class AssetRegistry {
  private activeAssets = new Map<string, AssetInfo>();

  // CEO can add/remove assets dynamically
  addAsset(asset: AssetInfo): void;
  removeAsset(symbol: string): void;
  getActive(): AssetInfo[];

  // Agents can SUGGEST assets to CEO
  suggestAsset(agentId: AgentId, asset: AssetInfo, reason: string): void;
}
```

### 2.2 Dynamic Strategy Registry (replaces `TechnicalStrategist`)
```typescript
// Strategies are registered dynamically, not hardcoded
export class StrategyRegistry {
  private strategies = new Map<string, Strategy>();

  register(strategy: Strategy): void;
  unregister(name: string): void;
  getActive(): Strategy[];

  // Agents can propose new strategy configurations to CEO
  proposeStrategy(agentId: AgentId, config: StrategyConfig): void;
}
```

### 2.3 No Agent Limits
- Remove `maxAgents` / `minAgents` from config
- CEO decides agent count based on performance and workload
- Agents can request CEO to spawn helpers: "I need a specialist for forex analysis"

## Phase 3: Internal Evolution (No External API)

### 3.1 Evolution Supervisor (replaces external evolve)
```typescript
// Evolution runs entirely internally, supervised by CEO
export class EvolutionSupervisor {
  // Uses existing cached/synthetic data — NEVER calls external APIs
  // CEO triggers evolution, supervisor runs it, reports back

  async evolve(agent: TradingAgent, candles: Candle[]): Promise<EvolutionResult>;

  // Internal meeting: agents discuss evolution results
  async holdEvolutionMeeting(
    results: EvolutionResult[],
    participants: AgentId[]
  ): Promise<MeetingOutcome>;
}

interface MeetingOutcome {
  adaptChanges: boolean;      // CEO decides based on meeting
  changesApproved: StrategyDNA[];
  changesRejected: StrategyDNA[];
  reasoning: string;
}
```

### 3.2 Agent Internal Meetings
```typescript
// Agents can call meetings to discuss findings
interface Meeting {
  id: string;
  calledBy: AgentId;
  topic: string;
  attendees: AgentId[];
  agenda: string[];
  minutes: MeetingMinute[];     // What was discussed
  outcome: MeetingOutcome;
  ceoNotified: boolean;
}
```

## Phase 4: Remove Journal, Simplify Reporting

### 4.1 Remove
- Delete `src/team/self-improver/journal.ts`
- Remove all `journal.record*()` calls from `SelfImprover`
- Remove journal from `save()` and `initialize()`
- Delete `data/results/journal.json`

### 4.2 Replace With
- **CEO Dashboard**: CEO maintains a concise performance board
- **Agent self-reporting**: Each agent tracks its own metrics and reports to CEO on demand
- No persistent journal file — just in-memory performance snapshots

## File Changes Summary

### New Files
| File | Purpose |
|------|---------|
| `src/team/ceo/index.ts` | CEO agent — the decision maker |
| `src/team/ceo/directives.ts` | Directive types and handling |
| `src/team/ceo/dashboard.ts` | CEO's performance dashboard |
| `src/team/ceo/meetings.ts` | Meeting system for agent discussions |
| `src/shared/discussion.ts` | Peer discussion thread system |
| `src/team/asset-registry/index.ts` | Dynamic asset management |
| `src/team/strategy-registry/index.ts` | Dynamic strategy management |
| `src/team/evolution-supervisor/index.ts` | Internal evolution (no API) |

### Modified Files
| File | Change |
|------|--------|
| `src/index.ts` | Replace `TradingOrchestrator` with CEO-driven flow |
| `src/shared/agent-types.ts` | Add new message types |
| `src/team/agent-network/network.ts` | Add discussion/meeting channels |
| `src/team/agent-network/trading-agent.ts` | Add discuss/report/request capabilities |
| `src/team/agent-network/index.ts` | CEO integration, remove fixed limits |
| `src/config/index.ts` | Remove fixed agent limits |
| `src/config/assets.ts` | Keep as defaults, but CEO controls active set |
| `src/scripts/*.ts` | Update to use CEO-driven system |

### Deleted Files
| File | Reason |
|------|--------|
| `src/team/self-improver/journal.ts` | No more journal |

## Implementation Order

1. **Phase 1** — CEO agent + new message types + peer discussion (foundation)
2. **Phase 2** — Dynamic registries, remove fixed constraints
3. **Phase 3** — Internal evolution supervisor + agent meetings
4. **Phase 4** — Remove journal, add CEO dashboard
5. **Tests** — Update existing tests, add CEO agent tests
