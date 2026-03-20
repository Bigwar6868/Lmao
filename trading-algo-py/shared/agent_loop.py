"""AgentLoop -- Autonomous 24/7 event-driven agent lifecycle.

Each agent runs an independent loop:
  1. Process messages from its queue
  2. Execute scheduled tasks (periodic checks)
  3. Go idle when nothing to do
  4. Proactively explore data when idle (with cooldown)

Ported from TypeScript: shared/agent-loop.ts
"""

from __future__ import annotations

import asyncio
import logging
import random
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Awaitable, Callable

from .agent_brain import AgentBrain, BrainContext, ThoughtChain
from .agent_types import AgentId, AgentMessage, TeamId

logger = logging.getLogger(__name__)


# ============================================================
# Types
# ============================================================

class AgentLoopState(str, Enum):
    """Agent loop states."""
    RUNNING = "running"
    THINKING = "thinking"
    IDLE = "idle"
    EXPLORING = "exploring"
    SLEEPING = "sleeping"
    STOPPED = "stopped"


@dataclass
class AgentTask:
    """A task the agent can execute."""
    id: str
    name: str
    description: str
    execute: Callable[[], Awaitable[None]]
    interval_ms: int | None = None
    last_run_at: int | None = None


@dataclass
class AgentFeedbackHandler:
    """Callbacks for state changes and feedback."""
    on_state_change: Callable[[AgentId, str, AgentLoopState, AgentLoopState], None] | None = None
    on_thinking: Callable[[AgentId, str, ThoughtChain], None] | None = None
    on_action: Callable[[AgentId, str, str, str | None], None] | None = None
    on_idle: Callable[[AgentId, str], None] | None = None
    on_error: Callable[[AgentId, str, str], None] | None = None


@dataclass
class AgentLoopConfig:
    """Configuration for the agent loop."""
    tick_interval_ms: int = 1_000
    idle_cooldown_ms: int = 30_000
    max_queue_size: int = 100
    explore_probability: float = 0.3


# ============================================================
# AgentLoop
# ============================================================

class AgentLoop:
    """Autonomous event-driven lifecycle for an agent.

    Attach to any team or agent. Processes messages, runs scheduled
    tasks, and proactively explores when idle.
    """

    def __init__(
        self,
        agent_id: AgentId,
        name: str,
        team_id: TeamId,
        brain: AgentBrain,
        config: AgentLoopConfig | None = None,
    ) -> None:
        self.agent_id = agent_id
        self.name = name
        self.team_id = team_id
        self._brain = brain
        self._config = config or AgentLoopConfig()

        # State
        self._state = AgentLoopState.STOPPED
        self._message_queue: list[AgentMessage] = []
        self._scheduled_tasks: list[AgentTask] = []
        self._task: asyncio.Task[None] | None = None
        self._last_explore_at: int = 0
        self._tick_count: int = 0
        self._processed_count: int = 0
        self._idle_since: int = 0

        # Handlers
        self._message_handler: Callable[[AgentMessage], Awaitable[None]] | None = None
        self._explore_handler: Callable[[AgentBrain, BrainContext], Awaitable[None]] | None = None
        self._context_provider: Callable[[], BrainContext] | None = None
        self._feedback: AgentFeedbackHandler | None = None

    # ----------------------------------------------------------------
    # Setup
    # ----------------------------------------------------------------

    def on_message(self, handler: Callable[[AgentMessage], Awaitable[None]]) -> None:
        """Set handler for incoming messages."""
        self._message_handler = handler

    def on_explore(
        self, handler: Callable[[AgentBrain, BrainContext], Awaitable[None]],
    ) -> None:
        """Set handler for idle exploration."""
        self._explore_handler = handler

    def set_context_provider(self, provider: Callable[[], BrainContext]) -> None:
        """Set provider for current brain context."""
        self._context_provider = provider

    def set_feedback(self, handler: AgentFeedbackHandler) -> None:
        """Set feedback handler for state/action reporting."""
        self._feedback = handler

    def add_task(self, task: AgentTask) -> None:
        """Add a scheduled task."""
        self._scheduled_tasks.append(task)

    # ----------------------------------------------------------------
    # Lifecycle
    # ----------------------------------------------------------------

    def start(self) -> None:
        """Start the autonomous loop."""
        if self._state in (
            AgentLoopState.RUNNING,
            AgentLoopState.IDLE,
            AgentLoopState.THINKING,
        ):
            return

        self._set_state(AgentLoopState.RUNNING)
        self._task = asyncio.ensure_future(self._run_loop())

    def stop(self) -> None:
        """Stop the loop."""
        if self._task and not self._task.done():
            self._task.cancel()
            self._task = None
        self._set_state(AgentLoopState.STOPPED)

    def sleep(self, reason: str | None = None) -> None:
        """Pause (sleep) -- CEO directive or cooldown."""
        self._set_state(AgentLoopState.SLEEPING)
        if self._feedback and self._feedback.on_action:
            self._feedback.on_action(
                self.agent_id, self.name, "sleep", reason or "Paused",
            )

    def wake(self) -> None:
        """Wake from sleep."""
        if self._state == AgentLoopState.SLEEPING:
            self._set_state(AgentLoopState.RUNNING)
            if self._feedback and self._feedback.on_action:
                self._feedback.on_action(
                    self.agent_id, self.name, "wake", "Resumed",
                )

    def enqueue(self, msg: AgentMessage) -> None:
        """Enqueue a message for processing."""
        if len(self._message_queue) >= self._config.max_queue_size:
            self._message_queue.pop(0)
        self._message_queue.append(msg)

        # Wake up if idle
        if self._state == AgentLoopState.IDLE:
            self._set_state(AgentLoopState.RUNNING)

    # ----------------------------------------------------------------
    # Core loop
    # ----------------------------------------------------------------

    async def _run_loop(self) -> None:
        """Main loop -- ticks at configured interval."""
        try:
            while self._state not in (AgentLoopState.STOPPED,):
                await self._tick()
                await asyncio.sleep(self._config.tick_interval_ms / 1000)
        except asyncio.CancelledError:
            pass

    async def _tick(self) -> None:
        """Single tick of the agent loop."""
        if self._state in (AgentLoopState.STOPPED, AgentLoopState.SLEEPING):
            return

        self._tick_count += 1

        try:
            # 1. Process pending messages
            if self._message_queue:
                self._set_state(AgentLoopState.RUNNING)
                await self._process_messages()
                return

            # 2. Run scheduled tasks
            due_task = self._get_next_due_task()
            if due_task:
                self._set_state(AgentLoopState.RUNNING)
                if self._feedback and self._feedback.on_action:
                    self._feedback.on_action(
                        self.agent_id, self.name, "task", due_task.name,
                    )
                await due_task.execute()
                due_task.last_run_at = _now_ms()
                return

            # 3. Proactive exploration when idle
            if self._should_explore():
                self._set_state(AgentLoopState.EXPLORING)
                await self._explore()
                return

            # 4. Nothing to do -- go idle
            if self._state != AgentLoopState.IDLE:
                self._set_state(AgentLoopState.IDLE)
                self._idle_since = _now_ms()
                if self._feedback and self._feedback.on_idle:
                    self._feedback.on_idle(self.agent_id, self.name)

        except Exception as exc:
            if self._feedback and self._feedback.on_error:
                self._feedback.on_error(self.agent_id, self.name, str(exc))
            # Don't crash the loop -- keep going

    async def _process_messages(self) -> None:
        """Process up to 5 messages per tick."""
        batch = self._message_queue[:5]
        self._message_queue = self._message_queue[5:]

        for msg in batch:
            if self._message_handler:
                if self._feedback and self._feedback.on_action:
                    self._feedback.on_action(
                        self.agent_id,
                        self.name,
                        "message",
                        f"Processing {msg.type} from {msg.from_id[:8]}",
                    )
                await self._message_handler(msg)
                self._processed_count += 1

    def _get_next_due_task(self) -> AgentTask | None:
        """Find the next scheduled task that is due."""
        now = _now_ms()
        for task in self._scheduled_tasks:
            if task.interval_ms is None:
                continue
            if task.last_run_at is None or now - task.last_run_at >= task.interval_ms:
                return task
        return None

    def _should_explore(self) -> bool:
        """Check if the agent should explore."""
        if not self._explore_handler:
            return False
        now = _now_ms()
        if now - self._last_explore_at < self._config.idle_cooldown_ms:
            return False
        return random.random() < self._config.explore_probability

    async def _explore(self) -> None:
        """Perform idle exploration using the brain."""
        ctx = self._context_provider() if self._context_provider else BrainContext()

        chain = await self._brain.think_async("What should I do while idle?", ctx)
        if self._feedback and self._feedback.on_thinking:
            self._feedback.on_thinking(self.agent_id, self.name, chain)

        if chain.confidence > 0.3 and self._explore_handler:
            if self._feedback and self._feedback.on_action:
                self._feedback.on_action(
                    self.agent_id, self.name, "explore", chain.decision,
                )
            await self._explore_handler(self._brain, ctx)

        self._last_explore_at = _now_ms()

    # ----------------------------------------------------------------
    # State management
    # ----------------------------------------------------------------

    def _set_state(self, new_state: AgentLoopState) -> None:
        if self._state == new_state:
            return
        old_state = self._state
        self._state = new_state
        if self._feedback and self._feedback.on_state_change:
            self._feedback.on_state_change(
                self.agent_id, self.name, old_state, new_state,
            )

    def get_state(self) -> AgentLoopState:
        return self._state

    def get_tick_count(self) -> int:
        return self._tick_count

    def get_processed_count(self) -> int:
        return self._processed_count

    def get_queue_size(self) -> int:
        return len(self._message_queue)

    def get_idle_duration(self) -> int:
        """Milliseconds spent idle (0 if not idle)."""
        if self._state == AgentLoopState.IDLE:
            return _now_ms() - self._idle_since
        return 0

    def get_brain(self) -> AgentBrain:
        return self._brain

    def get_status(self) -> dict[str, Any]:
        """Summary for diagnostics."""
        return {
            "agent_id": self.agent_id,
            "name": self.name,
            "team": self.team_id,
            "state": self._state.value,
            "ticks": self._tick_count,
            "processed": self._processed_count,
            "queue_size": len(self._message_queue),
            "scheduled_tasks": len(self._scheduled_tasks),
            "idle_duration_ms": self.get_idle_duration(),
        }


# ============================================================
# Helpers
# ============================================================

def _now_ms() -> int:
    """Current time in milliseconds."""
    return int(time.time() * 1000)
