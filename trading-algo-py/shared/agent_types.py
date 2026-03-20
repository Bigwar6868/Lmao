"""Multi-agent system types for the trading algorithm.

Ported from TypeScript: shared/agent-types.ts
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from .types import PerformanceMetrics, StrategyDNA

# ============================================================
# Type Aliases
# ============================================================

AgentId = str
"""Unique agent identifier."""

TeamId = Literal["ceo", "trading", "research", "risk", "evolution", "ops"]
"""Team identifiers."""

AgentStatus = Literal["active", "probation", "retired", "spawning"]
"""Agent lifecycle status."""

AgentRole = Literal["ceo", "team-lead", "member"]
"""Agent role within a team."""

MessageType = Literal[
    "performance",
    "alert",
    "spawn",
    "retire",
    "directive",
    "approval",
    "veto",
    "report",
    "request",
    "discuss",
    "question",
    "answer",
]
"""Message types for inter-agent communication."""

DirectiveType = Literal[
    "set-prompt",
    "focus-assets",
    "deploy-strategy",
    "spawn-agent",
    "retire-agent",
    "adjust-risk",
    "pause-trading",
    "resume-trading",
    "evolve",
    "research",
    "rebalance",
]
"""CEO directive types."""

RequestType = Literal[
    "spawn-agent",
    "new-strategy",
    "new-data-source",
    "new-asset",
    "increase-risk",
    "decrease-risk",
    "evolution",
    "retire-agent",
]
"""Request types agents can send to the CEO."""

BrainRole = Literal[
    "ceo",
    "trader",
    "researcher",
    "risk-manager",
    "evolutionist",
    "ops",
]
"""Brain role determines reasoning style."""


# ============================================================
# Message Payloads
# ============================================================

@dataclass
class PerformanceBroadcast:
    """Agent performance broadcast."""
    type: Literal["performance"] = "performance"
    metrics: PerformanceMetrics = field(default_factory=PerformanceMetrics)
    recent_win_rate: float = 0.0
    recent_sharpe: float = 0.0
    reputation: float = 0.0
    generation: int = 0


@dataclass
class AlertPayload:
    """Alert raised by an agent."""
    type: Literal["alert"] = "alert"
    severity: Literal["info", "warning", "critical"] = "info"
    message: str = ""
    data: dict[str, Any] = field(default_factory=dict)


@dataclass
class SpawnPayload:
    """System spawns a new agent."""
    type: Literal["spawn"] = "spawn"
    parent_id: AgentId = ""
    reason: str = ""
    dna: StrategyDNA | None = None


@dataclass
class RetirePayload:
    """System retires an agent."""
    type: Literal["retire"] = "retire"
    reason: str = ""
    final_metrics: PerformanceMetrics | None = None


@dataclass
class DirectivePayload:
    """CEO directive to a team or agent."""
    type: Literal["directive"] = "directive"
    directive_type: DirectiveType = "focus-assets"
    target_team: TeamId = "trading"
    target_agent: AgentId | None = None
    params: dict[str, Any] = field(default_factory=dict)
    priority: Literal["urgent", "normal", "low"] = "normal"
    reason: str = ""


@dataclass
class ApprovalPayload:
    """CEO approves a request."""
    type: Literal["approval"] = "approval"
    request_id: str = ""
    reason: str = ""


@dataclass
class VetoPayload:
    """CEO rejects a request."""
    type: Literal["veto"] = "veto"
    request_id: str = ""
    reason: str = ""


@dataclass
class ReportPayload:
    """Agent reports findings upward."""
    type: Literal["report"] = "report"
    report_type: Literal[
        "performance", "analysis", "opportunity",
        "risk-alert", "status", "meeting-outcome",
    ] = "status"
    summary: str = ""
    data: dict[str, Any] = field(default_factory=dict)


@dataclass
class RequestPayload:
    """Agent requests resources from the CEO."""
    type: Literal["request"] = "request"
    request_type: RequestType = "spawn-agent"
    description: str = ""
    reason: str = ""
    data: dict[str, Any] = field(default_factory=dict)


@dataclass
class DiscussPayload:
    """Free-form discussion message."""
    type: Literal["discuss"] = "discuss"
    thread_id: str = ""
    topic: str = ""
    content: str = ""
    data: dict[str, Any] = field(default_factory=dict)


@dataclass
class QuestionPayload:
    """Agent asks another agent."""
    type: Literal["question"] = "question"
    thread_id: str = ""
    question: str = ""
    context: dict[str, Any] = field(default_factory=dict)


@dataclass
class AnswerPayload:
    """Agent answers another agent."""
    type: Literal["answer"] = "answer"
    thread_id: str = ""
    question_id: str = ""
    answer: str = ""
    data: dict[str, Any] = field(default_factory=dict)


# Union of all payload types
AgentMessagePayload = (
    PerformanceBroadcast
    | AlertPayload
    | SpawnPayload
    | RetirePayload
    | DirectivePayload
    | ApprovalPayload
    | VetoPayload
    | ReportPayload
    | RequestPayload
    | DiscussPayload
    | QuestionPayload
    | AnswerPayload
)


# ============================================================
# Agent Message
# ============================================================

@dataclass
class AgentMessage:
    """A message exchanged between agents."""
    id: str
    type: MessageType
    from_id: AgentId
    to_id: AgentId | Literal["all"]
    timestamp: int
    payload: AgentMessagePayload
    reply_to: str | None = None


# ============================================================
# Agent Profile & Performance
# ============================================================

@dataclass
class TradeOutcome:
    """Outcome of a single trade for tracking."""
    proposal_id: str = ""
    asset: str = ""
    action: Literal["BUY", "SELL"] = "BUY"
    entry_price: float = 0.0
    exit_price: float = 0.0
    pnl: float = 0.0
    pnl_pct: float = 0.0
    timestamp: int = 0


@dataclass
class AgentPerformanceHistory:
    """Rolling performance history for an agent."""
    total_signals: int = 0
    successful_trades: int = 0
    failed_trades: int = 0
    total_pnl: float = 0.0
    recent_results: list[TradeOutcome] = field(default_factory=list)
    win_streaks: int = 0
    loss_streaks: int = 0
    current_streak: int = 0
    peak_reputation: float = 0.0
    last_evaluated_at: int = 0


@dataclass
class AgentProfile:
    """Complete agent profile with identity, performance, and reputation."""
    id: AgentId = ""
    name: str = ""
    strategy: str = ""
    dna: StrategyDNA | None = None
    status: AgentStatus = "active"
    reputation: float = 0.0
    created_at: int = 0
    parent_id: AgentId | None = None
    generation: int = 0
    metrics: AgentPerformanceHistory = field(default_factory=AgentPerformanceHistory)


@dataclass
class AgentSwarmConfig:
    """Spawn / evolution configuration."""
    max_agents: int = 20
    min_agents: int = 2
    probation_threshold: float = 30.0
    retire_threshold: float = 10.0
    spawn_cooldown_ms: int = 60_000
    evaluation_window_size: int = 20


# ============================================================
# Team Structure
# ============================================================

@dataclass
class TeamConfig:
    """Configuration for a team."""
    id: TeamId = "trading"
    name: str = ""
    lead_id: AgentId | None = None
    member_ids: list[AgentId] = field(default_factory=list)
    description: str = ""


@dataclass
class TeamPrompt:
    """Team prompt/mission -- CEO assigns objectives to each team."""
    team_id: TeamId = "trading"
    mission: str = ""
    objectives: list[str] = field(default_factory=list)
    constraints: list[str] = field(default_factory=list)
    focus: dict[str, Any] | None = None
    issued_at: int = 0
    updated_at: int = 0


# ============================================================
# Discussion Threads
# ============================================================

@dataclass
class DiscussionThread:
    """A discussion thread between agents."""
    id: str = ""
    topic: str = ""
    started_by: AgentId = ""
    participants: set[AgentId] = field(default_factory=set)
    messages: list[AgentMessage] = field(default_factory=list)
    conclusion: str | None = None
    reported_to_ceo: bool = False
    created_at: int = 0
    closed_at: int | None = None


# ============================================================
# CEO Dashboard
# ============================================================

@dataclass
class CEODashboard:
    """CEO's view of system state."""
    teams: list[TeamConfig] = field(default_factory=list)
    active_assets: list[str] = field(default_factory=list)
    active_strategies: list[str] = field(default_factory=list)
    total_agents: int = 0
    total_capital: float = 0.0
    daily_pnl: float = 0.0
    open_positions: int = 0
    pending_requests: list[RequestPayload] = field(default_factory=list)
    system_health: float = 0.0
    last_cycle_at: int = 0
