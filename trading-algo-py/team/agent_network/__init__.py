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


@dataclass
class ActiveTrade:
    """Tracks an open trade owned by an agent."""
    position_id: str
    symbol: str
    side: str           # "BUY" or "SELL"
    entry_price: float
    quantity: float
    stop_loss: float
    take_profit: float
    opened_at: int
    strategy: str
    peak_pnl: float = 0.0       # Best unrealized PnL seen
    trough_pnl: float = 0.0     # Worst unrealized PnL seen
    checks: int = 0             # How many times agent has reviewed this trade
    last_action: str = "hold"   # hold, tighten, close


class TradingAgent:
    """Autonomous wrapper around a Strategy with reputation tracking and trade monitoring."""

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

        # Trade monitoring — agent owns its positions
        self._active_trades: dict[str, ActiveTrade] = {}  # position_id → ActiveTrade

        self.network.register(self.id)
        log.info("Agent created: %s (strategy=%s)", self.name, strategy.config.name)

    # --- Trade ownership ---

    def register_trade(self, position_id: str, symbol: str, side: str,
                       entry_price: float, quantity: float,
                       stop_loss: float, take_profit: float, strategy: str) -> None:
        """Register a new trade this agent is responsible for monitoring."""
        self._active_trades[position_id] = ActiveTrade(
            position_id=position_id,
            symbol=symbol,
            side=side,
            entry_price=entry_price,
            quantity=quantity,
            stop_loss=stop_loss,
            take_profit=take_profit,
            opened_at=int(time.time() * 1000),
            strategy=strategy,
        )
        log.debug("Agent %s now monitoring %s %s (id=%s)", self.name, side, symbol, position_id[:8])

    def monitor_trades(self, prices: dict[str, float], market_data_map: dict | None = None) -> list[dict]:
        """Review all active trades — agent decides: hold, tighten stop, or recommend close.

        Returns list of trade actions the agent wants to take:
          {"action": "hold|tighten|close", "position_id": ..., "reason": ..., ...}
        """
        if self.status == "retired":
            return []

        actions = []
        closed_ids = []

        for pos_id, trade in self._active_trades.items():
            price = prices.get(trade.symbol)
            if price is None:
                continue

            trade.checks += 1

            # Calculate unrealized PnL
            if trade.side == "BUY":
                unrealized = (price - trade.entry_price) * trade.quantity
                pnl_pct = ((price - trade.entry_price) / trade.entry_price) * 100
            else:
                unrealized = (trade.entry_price - price) * trade.quantity
                pnl_pct = ((trade.entry_price - price) / trade.entry_price) * 100

            # Track peak/trough
            trade.peak_pnl = max(trade.peak_pnl, unrealized)
            trade.trough_pnl = min(trade.trough_pnl, unrealized)

            # --- Agent decision logic ---
            action = self._decide_trade_action(trade, price, pnl_pct, market_data_map)
            trade.last_action = action["action"]
            actions.append(action)

        # Remove closed trades from monitoring
        for pos_id in closed_ids:
            self._active_trades.pop(pos_id, None)

        return actions

    def _decide_trade_action(self, trade: ActiveTrade, current_price: float,
                             pnl_pct: float, market_data_map: dict | None) -> dict:
        """Agent's trade monitoring decision logic.

        Rules:
        1. If trade gave back >50% of peak profit → recommend tighten stop
        2. If signal has reversed (strategy now says opposite) → recommend close
        3. If trade has been open >100 checks with no progress → recommend close
        4. Otherwise → hold
        """
        result = {
            "action": "hold",
            "position_id": trade.position_id,
            "symbol": trade.symbol,
            "pnl_pct": pnl_pct,
            "checks": trade.checks,
            "reason": "",
        }

        # Rule 0: Max holding time — don't hold a single position too long
        from config.settings import config as _cfg
        max_hold_ms = _cfg.max_hold_hours * 3600 * 1000
        hold_time_ms = int(time.time() * 1000) - trade.opened_at
        if hold_time_ms > max_hold_ms:
            result["action"] = "close"
            hours_held = hold_time_ms / 3_600_000
            result["reason"] = f"Max hold time exceeded: {hours_held:.1f}h > {_cfg.max_hold_hours}h"
            return result

        # Rule 1: Gave back too much profit — tighten stop
        if trade.peak_pnl > 0 and pnl_pct > 0:
            current_unrealized = pnl_pct  # simplified
            peak_pct = (trade.peak_pnl / (trade.entry_price * trade.quantity)) * 100 if trade.quantity > 0 else 0
            if peak_pct > 0.5 and current_unrealized < peak_pct * 0.5:
                result["action"] = "tighten"
                result["reason"] = f"Gave back profit: peak {peak_pct:.2f}% → now {pnl_pct:.2f}%"
                # Suggest new SL at breakeven + small buffer
                pip_val = 0.01 if "JPY" in trade.symbol else 0.0001
                if trade.side == "BUY":
                    result["new_stop_loss"] = trade.entry_price + (3 * pip_val)
                else:
                    result["new_stop_loss"] = trade.entry_price - (3 * pip_val)
                return result

        # Rule 2: Check if strategy signal has reversed
        if market_data_map and trade.symbol in market_data_map:
            try:
                signals = self.strategy.analyze(market_data_map[trade.symbol])
                for s in signals:
                    if s.asset.symbol == trade.symbol and s.action.value != "HOLD":
                        # Signal is opposite to our trade direction
                        if (trade.side == "BUY" and s.action.value == "SELL") or \
                           (trade.side == "SELL" and s.action.value == "BUY"):
                            if s.confidence > 0.5:
                                result["action"] = "close"
                                result["reason"] = f"Signal reversed: {s.action.value} conf={s.confidence:.2f}"
                                return result
            except Exception:
                pass

        # Rule 3: Stale trade — open too long with no progress
        if trade.checks > 50 and abs(pnl_pct) < 0.1:
            result["action"] = "close"
            result["reason"] = f"Stale trade: {trade.checks} checks, PnL {pnl_pct:+.2f}%"
            return result

        # Rule 4: Losing too much
        if pnl_pct < -2.0:
            result["action"] = "close"
            result["reason"] = f"Excessive loss: {pnl_pct:.2f}%"
            return result

        result["reason"] = f"Holding: PnL {pnl_pct:+.2f}% (peak ${trade.peak_pnl:.2f})"
        return result

    def on_trade_closed(self, position_id: str) -> None:
        """Remove a trade from monitoring when it's closed."""
        trade = self._active_trades.pop(position_id, None)
        if trade:
            log.debug("Agent %s trade closed: %s %s (%d checks)",
                      self.name, trade.side, trade.symbol, trade.checks)

    def get_active_trades(self) -> list[ActiveTrade]:
        return list(self._active_trades.values())

    def get_active_trade_count(self) -> int:
        return len(self._active_trades)

    # --- Signal generation ---

    def analyze(self, data: Any, macro: Any = None) -> list:
        """Analyze market data and return signals scaled by reputation."""
        if self.status == "retired":
            return []

        signals = self.strategy.analyze(data)
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
        """Record trade result and update reputation.

        Reward system (asymmetric — winning is rewarded more):
        - Win:  +2 to +10 rep (based on PnL %) + streak bonus
        - Loss: -1 to -6 rep (based on PnL %)
        - Win streak bonus: +1 per consecutive win (up to +5 extra)
        - Loss streak penalty: -1 per consecutive loss (up to -3 extra)
        """
        self.history.recent_results.append(outcome)
        if len(self.history.recent_results) > 50:
            self.history.recent_results.pop(0)

        if outcome.pnl > 0:
            self.history.successful_trades += 1
            self.history.current_streak = max(1, self.history.current_streak + 1)
            self.history.win_streaks = max(self.history.win_streaks, self.history.current_streak)
            # Better rewards: +2 base + up to +8 from PnL%
            base_reward = min(10, 2 + outcome.pnl_pct * 0.8)
            # Win streak bonus: +1 per consecutive win (max +5)
            streak_bonus = min(5, max(0, self.history.current_streak - 1))
            self.reputation = min(100, self.reputation + base_reward + streak_bonus)
        else:
            self.history.failed_trades += 1
            self.history.current_streak = min(-1, self.history.current_streak - 1)
            self.history.loss_streaks = max(self.history.loss_streaks, abs(self.history.current_streak))
            # Gentler penalties: -1 base + up to -5 from PnL%
            base_penalty = min(6, 1 + abs(outcome.pnl_pct) * 0.5)
            # Loss streak extra: -1 per consecutive loss (max -3)
            streak_penalty = min(3, max(0, abs(self.history.current_streak) - 1))
            self.reputation = max(0, self.reputation - base_penalty - streak_penalty)

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
    """Manages agent creation, retirement, evolution, and subagent spawning.

    Each spawned agent gets:
    - A TradingAgent wrapping a strategy
    - An AgentBrain (with LLM provider) for autonomous reasoning
    - An AgentLoop for independent tick-based execution
    """

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
        # Track subagent brains and loops
        self._brains: dict[AgentId, Any] = {}
        self._loops: dict[AgentId, Any] = {}
        self._llm_provider: Any = None

    def set_llm_provider(self, provider: Any) -> None:
        """Set the LLM provider for newly spawned agents."""
        self._llm_provider = provider

    def spawn_agent(
        self,
        strategy_name: str,
        role: str = "trader",
        parent_id: AgentId | None = None,
        dna: Any = None,
    ) -> TradingAgent | None:
        """Spawn a new trading agent with its own brain and loop.

        Returns the agent, or None if at capacity / cooldown.
        """
        now = int(time.time() * 1000)
        if len(self.agents) >= self.max_agents:
            log.warning("Cannot spawn: at max capacity (%d agents)", self.max_agents)
            return None
        if now - self.last_spawn_time < self.spawn_cooldown_ms:
            log.debug("Spawn on cooldown — skipping")
            return None

        # Create strategy instance
        strategy_cls = self.strategies.get(strategy_name)
        if strategy_cls is None:
            # Try importing from the strategy factory
            try:
                from team.technical_strategist.strategies import create_strategy
                strategy = create_strategy(strategy_name)
            except Exception:
                log.error("Unknown strategy for spawn: %s", strategy_name)
                return None
        else:
            from shared.types import StrategyConfig, AssetClass
            config = StrategyConfig(name=strategy_name, enabled=True)
            strategy = strategy_cls(config, dna)

        if dna:
            strategy.dna = dna

        # Create TradingAgent
        agent = TradingAgent(
            strategy=strategy,
            network=self.network,
            parent_id=parent_id,
            generation=getattr(dna, "generation", 0) if dna else 0,
        )
        self.agents[agent.id] = agent

        # Create AgentBrain for autonomous reasoning
        try:
            from shared.agent_brain import AgentBrain, auto_detect_provider
            provider = self._llm_provider or auto_detect_provider()
            brain = AgentBrain(
                agent_id=agent.id,
                role=role,
                name=agent.name,
                llm_provider=provider,
            )
            self._brains[agent.id] = brain
        except Exception as e:
            log.warning("Failed to create brain for %s: %s", agent.name, e)

        # Create AgentLoop for autonomous tick-based execution
        try:
            from shared.agent_loop import AgentLoop
            brain = self._brains.get(agent.id)
            if brain:
                loop = AgentLoop(
                    agent_id=agent.id,
                    name=agent.name,
                    team_id="trading",
                    brain=brain,
                )
                self._loops[agent.id] = loop
        except Exception as e:
            log.warning("Failed to create loop for %s: %s", agent.name, e)

        self.last_spawn_time = now

        # Announce spawn on the network
        self.network.broadcast(agent.id, "spawn", {
            "agent_id": agent.id,
            "agent_name": agent.name,
            "strategy": strategy_name,
            "parent_id": parent_id,
            "role": role,
            "has_brain": agent.id in self._brains,
            "has_loop": agent.id in self._loops,
        })

        log.info(
            "Spawned agent: %s (strategy=%s, role=%s, brain=%s, loop=%s)",
            agent.name, strategy_name, role,
            agent.id in self._brains, agent.id in self._loops,
        )
        return agent

    def retire_agent(self, agent_id: AgentId) -> bool:
        """Retire an agent — stop its loop, remove its brain, unregister."""
        agent = self.agents.pop(agent_id, None)
        if not agent:
            return False

        # Stop loop
        loop = self._loops.pop(agent_id, None)
        if loop and hasattr(loop, "stop"):
            loop.stop()

        # Remove brain
        self._brains.pop(agent_id, None)

        # Unregister from network
        agent.status = "retired"
        self.network.unregister(agent_id)

        self.network.broadcast(agent_id, "retire", {
            "agent_id": agent_id,
            "agent_name": agent.name,
            "reason": "retired by spawner",
            "final_reputation": agent.reputation,
            "total_pnl": agent.history.total_pnl,
        })

        log.info("Retired agent: %s (rep=%.1f, pnl=%.2f)", agent.name, agent.reputation, agent.history.total_pnl)
        return True

    def get_brain(self, agent_id: AgentId) -> Any | None:
        return self._brains.get(agent_id)

    def get_loop(self, agent_id: AgentId) -> Any | None:
        return self._loops.get(agent_id)

    def evaluate(self) -> tuple[list[TradingAgent], list[AgentId]]:
        """Evaluate all agents — retire poor performers, auto-spawn replacements."""
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
            agent = self.agents.get(agent_id)
            strategy_name = agent.strategy.config.name if agent else None
            self.retire_agent(agent_id)

            # Auto-spawn replacement if we have room
            if strategy_name and len(self.agents) < self.max_agents:
                replacement = self.spawn_agent(strategy_name, role="trader")
                if replacement:
                    spawned.append(replacement)
                    log.info("Auto-replaced retired agent with %s", replacement.name)

        return spawned, retired

    async def start_all_loops(self) -> None:
        """Start all agent loops concurrently."""
        import asyncio
        tasks = []
        for agent_id, loop in self._loops.items():
            if hasattr(loop, "start_async"):
                tasks.append(asyncio.create_task(loop.start_async()))
        if tasks:
            log.info("Starting %d agent loops", len(tasks))
            await asyncio.gather(*tasks, return_exceptions=True)

    def stop_all_loops(self) -> None:
        """Stop all running agent loops."""
        for loop in self._loops.values():
            if hasattr(loop, "stop"):
                loop.stop()
        log.info("Stopped %d agent loops", len(self._loops))

    def get_status(self) -> dict:
        """Get spawner status summary."""
        return {
            "total_agents": len(self.agents),
            "max_agents": self.max_agents,
            "agents_with_brains": len(self._brains),
            "agents_with_loops": len(self._loops),
            "active": sum(1 for a in self.agents.values() if a.status == "active"),
            "probation": sum(1 for a in self.agents.values() if a.status == "probation"),
            "llm_provider": getattr(self._llm_provider, "name", "none"),
        }

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
