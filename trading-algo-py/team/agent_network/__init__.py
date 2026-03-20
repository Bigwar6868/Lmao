"""Agent Network — message bus + trading agents for autonomous multi-agent trading."""

from __future__ import annotations

import logging
import time
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Callable

log = logging.getLogger(__name__)

# ============================================================
# Types
# ============================================================

AgentId = str
MessageType = str
MessageHandler = Callable[..., Any]


@dataclass
class AgentMessage:
    id: str
    type: MessageType
    from_id: AgentId
    to: AgentId | str  # agent id or "all"
    timestamp: int
    payload: dict[str, Any]
    reply_to: str | None = None


@dataclass
class TradeOutcome:
    signal_id: str
    asset: str
    pnl: float
    pnl_pct: float
    strategy: str
    timestamp: int = 0


@dataclass
class AgentPerformanceHistory:
    total_signals: int = 0
    successful_trades: int = 0
    failed_trades: int = 0
    total_pnl: float = 0.0
    recent_results: list[TradeOutcome] = field(default_factory=list)
    win_streaks: int = 0
    loss_streaks: int = 0
    current_streak: int = 0
    peak_reputation: float = 65.0
    last_evaluated_at: int = 0


# ============================================================
# AgentNetwork — message bus for inter-agent communication
# ============================================================


class AgentNetwork:
    """Central message bus that routes messages between trading agents."""

    def __init__(self) -> None:
        self._agents: set[AgentId] = set()
        self._type_handlers: dict[MessageType, dict[AgentId, MessageHandler]] = defaultdict(dict)
        self._global_handlers: dict[AgentId, MessageHandler] = {}
        self._message_log: list[AgentMessage] = []
        self._max_log = 5000

    def register(self, agent_id: AgentId) -> None:
        self._agents.add(agent_id)

    def unregister(self, agent_id: AgentId) -> None:
        self._agents.discard(agent_id)
        for handlers in self._type_handlers.values():
            handlers.pop(agent_id, None)
        self._global_handlers.pop(agent_id, None)

    def on(self, agent_id: AgentId, msg_type: MessageType, handler: MessageHandler) -> None:
        self._type_handlers[msg_type][agent_id] = handler

    def on_all(self, agent_id: AgentId, handler: MessageHandler) -> None:
        self._global_handlers[agent_id] = handler

    def send(self, message: AgentMessage) -> None:
        self._message_log.append(message)
        if len(self._message_log) > self._max_log:
            self._message_log = self._message_log[-self._max_log // 2:]

        # Deliver to type-specific handlers
        handlers = self._type_handlers.get(message.type, {})
        for agent_id, handler in handlers.items():
            if agent_id == message.from_id:
                continue
            if message.to != "all" and message.to != agent_id:
                continue
            try:
                handler(message)
            except Exception as e:
                log.warning("Handler error for %s: %s", message.type, e)

        # Deliver to global handlers
        for agent_id, handler in self._global_handlers.items():
            if agent_id == message.from_id:
                continue
            if message.to != "all" and message.to != agent_id:
                continue
            try:
                handler(message)
            except Exception as e:
                log.warning("Global handler error: %s", e)

    def broadcast(
        self,
        from_id: AgentId,
        msg_type: MessageType,
        payload: dict[str, Any],
        reply_to: str | None = None,
    ) -> AgentMessage:
        msg = AgentMessage(
            id=str(uuid.uuid4()),
            type=msg_type,
            from_id=from_id,
            to="all",
            timestamp=int(time.time() * 1000),
            payload=payload,
            reply_to=reply_to,
        )
        self.send(msg)
        return msg

    def unicast(
        self,
        from_id: AgentId,
        to: AgentId,
        msg_type: MessageType,
        payload: dict[str, Any],
        reply_to: str | None = None,
    ) -> AgentMessage:
        msg = AgentMessage(
            id=str(uuid.uuid4()),
            type=msg_type,
            from_id=from_id,
            to=to,
            timestamp=int(time.time() * 1000),
            payload=payload,
            reply_to=reply_to,
        )
        self.send(msg)
        return msg

    def get_recent_messages(self, count: int = 50) -> list[AgentMessage]:
        return self._message_log[-count:]

    @property
    def agent_count(self) -> int:
        return len(self._agents)

    def get_agent_ids(self) -> list[AgentId]:
        return list(self._agents)


# ============================================================
# TradingAgent — autonomous agent wrapping a strategy
# ============================================================


class TradingAgent:
    """Autonomous wrapper around a Strategy with reputation tracking."""

    def __init__(
        self,
        strategy: Any,  # Strategy protocol
        network: AgentNetwork,
        name: str | None = None,
        parent_id: AgentId | None = None,
        generation: int = 0,
        reputation: float = 65.0,
    ) -> None:
        self.id: AgentId = str(uuid.uuid4())
        self.strategy = strategy
        self.network = network
        self.parent_id = parent_id
        self.generation = generation or getattr(strategy.dna, "generation", 0)
        self.name = name or f"{strategy.config.name}-agent-{self.id[:6]}"
        self.reputation = reputation
        self.status: str = "active"  # active, probation, retired
        self.created_at = int(time.time() * 1000)
        self.history = AgentPerformanceHistory(last_evaluated_at=self.created_at)

        self.network.register(self.id)
        log.info("Agent created: %s (strategy=%s)", self.name, strategy.config.name)

    def analyze(self, data: Any, macro: Any = None) -> list:
        """Analyze market data and return signals scaled by reputation."""
        if self.status == "retired":
            return []

        signals = self.strategy.analyze(data, macro)
        result = []
        for signal in signals:
            if signal.action.value == "HOLD":
                continue
            # Scale confidence by reputation
            adjusted = signal.confidence * (self.reputation / 100)
            from copy import copy
            s = copy(signal)
            s.confidence = adjusted
            result.append(s)
            self.history.total_signals += 1

        return result

    def record_outcome(self, outcome: TradeOutcome) -> None:
        """Record trade result and update reputation."""
        self.history.recent_results.append(outcome)
        if len(self.history.recent_results) > 50:
            self.history.recent_results.pop(0)

        if outcome.pnl > 0:
            self.history.successful_trades += 1
            self.history.current_streak = max(1, self.history.current_streak + 1)
            self.history.win_streaks = max(self.history.win_streaks, self.history.current_streak)
            self.reputation = min(100, self.reputation + min(5, outcome.pnl_pct * 0.5))
        else:
            self.history.failed_trades += 1
            self.history.current_streak = min(-1, self.history.current_streak - 1)
            self.history.loss_streaks = max(self.history.loss_streaks, abs(self.history.current_streak))
            self.reputation = max(0, self.reputation - min(8, abs(outcome.pnl_pct) * 0.8))

        self.history.total_pnl += outcome.pnl
        self.history.peak_reputation = max(self.reputation, self.history.peak_reputation)
        self.history.last_evaluated_at = int(time.time() * 1000)

    def get_recent_win_rate(self, window: int = 20) -> float:
        recent = self.history.recent_results[-window:]
        if not recent:
            return 0.5
        return sum(1 for r in recent if r.pnl > 0) / len(recent)

    def evaluate_status(self, probation_threshold: float = 30, retire_threshold: float = 15) -> str:
        if self.status == "retired":
            return "retired"

        if self.reputation < retire_threshold and len(self.history.recent_results) >= 10:
            self.status = "retired"
            self.network.unregister(self.id)
            log.warning("Agent %s retired (reputation=%.1f)", self.name, self.reputation)
        elif self.reputation < probation_threshold:
            self.status = "probation"
        elif self.status == "probation" and self.reputation >= probation_threshold + 10:
            self.status = "active"

        return self.status

    def get_strategy(self):
        return self.strategy

    def update_dna(self, dna) -> None:
        self.strategy.dna = dna
        self.generation = dna.generation


# ============================================================
# AgentSpawner — manages agent lifecycle
# ============================================================


class AgentSpawner:
    """Manages agent creation, retirement, and evolution."""

    def __init__(
        self,
        network: AgentNetwork,
        agents: dict[AgentId, TradingAgent],
        strategies: dict[str, Any],
        max_agents: int = 30,
        probation_threshold: float = 30,
        retire_threshold: float = 15,
    ) -> None:
        self.network = network
        self.agents = agents
        self.strategies = strategies
        self.max_agents = max_agents
        self.probation_threshold = probation_threshold
        self.retire_threshold = retire_threshold
        self.last_spawn_time = 0
        self.spawn_cooldown_ms = 30_000

    def evaluate(self) -> tuple[list[TradingAgent], list[AgentId]]:
        """Evaluate all agents — retire poor performers, spawn if needed."""
        spawned: list[TradingAgent] = []
        retired: list[AgentId] = []

        # Evaluate existing agents
        for agent_id, agent in list(self.agents.items()):
            prev_status = agent.status
            agent.evaluate_status(self.probation_threshold, self.retire_threshold)
            if agent.status == "retired" and prev_status != "retired":
                retired.append(agent_id)

        # Clean retired
        for agent_id in retired:
            self.agents.pop(agent_id, None)

        return spawned, retired

    def evolve_underperformers(self) -> None:
        """Mutate DNA of agents on probation."""
        for agent in self.agents.values():
            if agent.status == "probation":
                dna = agent.get_strategy().dna
                # Simple mutation: nudge params
                import random
                new_params = dict(dna.params)
                for key in new_params:
                    if random.random() < 0.3:
                        new_params[key] *= 1 + random.gauss(0, 0.1)
                from shared.types import StrategyDNA
                new_dna = StrategyDNA(
                    id=str(uuid.uuid4()),
                    name=dna.name,
                    generation=dna.generation + 1,
                    parent_id=dna.id,
                    params=new_params,
                    fitness=0,
                    created_at=int(time.time() * 1000),
                    mutations=["probation_mutation"],
                )
                agent.update_dna(new_dna)
                log.info("Evolved underperformer: %s → gen %d", agent.name, new_dna.generation)


# ============================================================
# DecayDetector — monitors agent performance over time
# ============================================================


@dataclass
class PerformanceSnapshot:
    timestamp: int
    agent_id: AgentId
    strategy: str
    win_rate: float
    sharpe: float
    pnl: float
    reputation: float
    trades_count: int


@dataclass
class DecayResult:
    agent_id: AgentId
    strategy: str
    is_decaying: bool
    trend: float  # negative = decaying
    window_size: int
    message: str


class DecayDetector:
    """Monitors agent performance for decay patterns."""

    def __init__(self, window_size: int = 20) -> None:
        self._snapshots: dict[AgentId, list[PerformanceSnapshot]] = defaultdict(list)
        self.window_size = window_size

    def record(self, snapshot: PerformanceSnapshot) -> None:
        snaps = self._snapshots[snapshot.agent_id]
        snaps.append(snapshot)
        if len(snaps) > self.window_size * 3:
            self._snapshots[snapshot.agent_id] = snaps[-self.window_size * 2:]

    def analyze(self) -> list[DecayResult]:
        results = []
        for agent_id, snaps in self._snapshots.items():
            if len(snaps) < self.window_size:
                continue

            recent = snaps[-self.window_size:]
            older = snaps[-self.window_size * 2:-self.window_size] if len(snaps) >= self.window_size * 2 else snaps[:self.window_size]

            recent_wr = sum(s.win_rate for s in recent) / len(recent) if recent else 0
            older_wr = sum(s.win_rate for s in older) / len(older) if older else 0
            trend = recent_wr - older_wr

            is_decaying = trend < -0.05 and recent_wr < 0.4
            msg = f"Win rate {older_wr:.0%} → {recent_wr:.0%} (trend={trend:+.2f})"

            results.append(DecayResult(
                agent_id=agent_id,
                strategy=recent[-1].strategy if recent else "unknown",
                is_decaying=is_decaying,
                trend=trend,
                window_size=self.window_size,
                message=msg,
            ))

        return results

    @staticmethod
    def format_report(results: list[DecayResult]) -> str:
        lines = ["\n=== Decay Analysis ==="]
        for r in results:
            status = "DECAYING" if r.is_decaying else "OK"
            lines.append(f"  [{status}] {r.strategy}: {r.message}")
        return "\n".join(lines)
