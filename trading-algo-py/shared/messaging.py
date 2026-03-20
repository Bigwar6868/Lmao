"""Message dispatching to multiple channels: Claude, KimiClaw, Ollama.

Ported from trading-algo/src/shared/messaging.ts.

Supports dual-model routing:
  - Claude Code (structured logs -- default)
  - KimiClaw (webhook -> WeChat, Telegram, Discord, WhatsApp)
  - Ollama / open-source LLMs (local API for AI-powered analysis)
"""

from __future__ import annotations

import json
import logging
import os
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Literal

import httpx

from shared.types import Signal, Portfolio, PerformanceMetrics, StrategyDNA
from shared.events import event_bus

log = logging.getLogger(__name__)

# ============================================================
# Message Types
# ============================================================

MessageChannel = Literal["claude", "kimiclaw", "ollama"]

MessageType = Literal["evolution", "signal", "portfolio", "alert", "system"]

MessagePriority = Literal["low", "normal", "high", "critical"]


@dataclass
class MessageTarget:
    channel: MessageChannel
    endpoint: str | None = None
    api_key: str | None = None
    destination: str | None = None
    model: str | None = None
    filter: list[MessageType] | None = None


@dataclass
class TradingMessage:
    id: str
    type: MessageType
    title: str
    body: str
    priority: MessagePriority
    timestamp: int
    metadata: dict[str, Any] = field(default_factory=dict)


# ============================================================
# Message Formatters
# ============================================================

def _generate_id(prefix: str) -> str:
    short = uuid.uuid4().hex[:6]
    return f"{prefix}-{int(time.time() * 1000)}-{short}"


def format_evolution_message(
    *,
    strategy: str,
    generation: int,
    fitness: float,
    previous_fitness: float,
    params: dict[str, float],
    improved: bool,
) -> TradingMessage:
    if previous_fitness > 0:
        improvement = f"{(fitness - previous_fitness) / previous_fitness * 100:.1f}"
    else:
        improvement = "N/A"

    params_summary = "\n".join(
        f"  {k}: {v:.4f}" if isinstance(v, (int, float)) else f"  {k}: {v}"
        for k, v in params.items()
    )

    tag = "[IMPROVED]" if improved else "[STABLE]"

    return TradingMessage(
        id=_generate_id("evo"),
        type="evolution",
        title=f"{tag} Strategy Evolution: {strategy}",
        body="\n".join([
            f"Strategy: {strategy}",
            f"Generation: {generation}",
            f"Fitness: {fitness:.4f} ({f'+{improvement}%' if improved else 'no improvement'})",
            f"Previous Fitness: {previous_fitness:.4f}",
            "",
            "Parameters:",
            params_summary,
        ]),
        priority="high" if improved else "normal",
        timestamp=int(time.time() * 1000),
        metadata={
            "strategy": strategy,
            "generation": generation,
            "fitness": fitness,
            "previous_fitness": previous_fitness,
            "params": params,
            "improved": improved,
        },
    )


def format_signal_message(signal: Signal) -> TradingMessage:
    if signal.confidence > 0.8:
        priority: MessagePriority = "high"
    elif signal.confidence > 0.6:
        priority = "normal"
    else:
        priority = "low"

    indicators_summary = "\n".join(
        f"  {k}: {v:.4f}" if isinstance(v, (int, float)) else f"  {k}: {v}"
        for k, v in signal.indicators.items()
    )

    return TradingMessage(
        id=_generate_id("sig"),
        type="signal",
        title=f"[{signal.action.value}] {signal.asset.symbol} @ {signal.price:.5f}",
        body="\n".join([
            f"Asset: {signal.asset.symbol} ({signal.asset.asset_class.value})",
            f"Action: {signal.action.value}",
            f"Price: {signal.price:.5f}",
            f"Confidence: {signal.confidence * 100:.1f}%",
            f"Strategy: {signal.strategy}",
            f"Timeframe: {signal.timeframe}",
            f"Reason: {signal.reason}",
            "",
            "Indicators:",
            indicators_summary,
        ]),
        priority=priority,
        timestamp=signal.timestamp,
        metadata={"signal": signal.__dict__},
    )


def format_portfolio_message(portfolio: Portfolio) -> TradingMessage:
    open_positions = [p for p in portfolio.positions if p.status.value == "open"]
    if open_positions:
        positions_summary = "\n".join(
            f"  {p.asset.symbol}: {p.side.value} {p.quantity} @ {p.entry_price:.5f}"
            f" (PnL: {p.unrealized_pnl:.2f})"
            for p in open_positions
        )
    else:
        positions_summary = "  (no open positions)"

    return TradingMessage(
        id=_generate_id("port"),
        type="portfolio",
        title="Portfolio Update",
        body="\n".join([
            f"Capital: ${portfolio.capital:.2f}",
            f"Available: ${portfolio.available_capital:.2f}",
            f"Total PnL: ${portfolio.total_pnl:.2f} ({portfolio.total_pnl_pct:.2f}%)",
            f"Max Drawdown: {portfolio.max_drawdown:.2f}%",
            f"Open Positions: {len(open_positions)}",
            "",
            "Positions:",
            positions_summary,
        ]),
        priority="high" if abs(portfolio.total_pnl_pct) > 5 else "normal",
        timestamp=portfolio.last_updated,
        metadata={"portfolio": portfolio.__dict__},
    )


def format_alert_message(
    title: str,
    body: str,
    priority: MessagePriority = "high",
) -> TradingMessage:
    return TradingMessage(
        id=_generate_id("alert"),
        type="alert",
        title=title,
        body=body,
        priority=priority,
        timestamp=int(time.time() * 1000),
        metadata={},
    )


# ============================================================
# Message Dispatcher
# ============================================================

class MessageDispatcher:
    """Dispatches trading messages to configured channels.

    Supports dual-model routing:
      - Claude Code (structured logs -- default)
      - KimiClaw (webhook -> WeChat, Telegram, Discord, WhatsApp)
      - Ollama / open-source LLMs (local API for AI-powered analysis)

    Configure via env vars:
      KIMICLAW_WEBHOOK_URL, KIMICLAW_API_KEY, KIMICLAW_DESTINATION, KIMICLAW_MODEL
      OLLAMA_ENDPOINT (default: http://localhost:11434), OLLAMA_MODEL (default: llama3)
    """

    def __init__(self, targets: list[MessageTarget] | None = None) -> None:
        self._targets: list[MessageTarget] = []
        self._message_history: list[TradingMessage] = []
        self._max_history = 100

        if targets is not None:
            self._targets = list(targets)
        else:
            # Default: Claude Code output
            self._targets.append(MessageTarget(channel="claude"))

            # Auto-detect KimiClaw from env
            kimiclaw_endpoint = (
                os.environ.get("KIMICLAW_WEBHOOK_URL")
                or os.environ.get("KIMICLAW_ENDPOINT")
            )
            if kimiclaw_endpoint:
                self._targets.append(MessageTarget(
                    channel="kimiclaw",
                    endpoint=kimiclaw_endpoint,
                    api_key=os.environ.get("KIMICLAW_API_KEY"),
                    destination=os.environ.get("KIMICLAW_DESTINATION", "telegram"),
                    model=os.environ.get("KIMICLAW_MODEL", "kimi"),
                ))

            # Auto-detect Ollama (local open-source LLM)
            ollama_endpoint = os.environ.get("OLLAMA_ENDPOINT")
            if ollama_endpoint:
                self._targets.append(MessageTarget(
                    channel="ollama",
                    endpoint=ollama_endpoint,
                    model=os.environ.get("OLLAMA_MODEL", "llama3"),
                    # Ollama only gets evolution + alert + portfolio messages by default
                    filter=["evolution", "alert", "portfolio"],
                ))

        channels = [
            f"{t.channel}({t.model})" if t.model else t.channel
            for t in self._targets
        ]
        log.info("MessageDispatcher initialized: channels=%s", channels)

    def add_target(self, target: MessageTarget) -> None:
        self._targets.append(target)
        log.info("Message target added: channel=%s model=%s", target.channel, target.model)

    def remove_target(self, channel: MessageChannel) -> None:
        self._targets = [t for t in self._targets if t.channel != channel]

    def get_targets(self) -> list[MessageTarget]:
        return list(self._targets)

    async def send(self, message: TradingMessage) -> None:
        """Send a message to all configured targets.

        Each target can filter by message type.
        """
        self._message_history.append(message)
        if len(self._message_history) > self._max_history:
            self._message_history = self._message_history[-self._max_history :]

        for target in self._targets:
            # Check filter -- skip if target doesn't want this message type
            if target.filter and message.type not in target.filter:
                continue

            try:
                if target.channel == "claude":
                    self._send_to_claude(message)
                elif target.channel == "kimiclaw":
                    await self._send_to_kimiclaw(message, target)
                elif target.channel == "ollama":
                    await self._send_to_ollama(message, target)
            except Exception:
                log.error(
                    "Failed to send message to channel=%s",
                    target.channel,
                    exc_info=True,
                )

    def _send_to_claude(self, message: TradingMessage) -> None:
        """Send to Claude Code (structured log output)."""
        log_fn = (
            log.warning
            if message.priority in ("critical", "high")
            else log.info
        )
        log_fn(
            "[MSG] %s\n%s",
            message.title,
            message.body,
            extra={"messageType": message.type, "priority": message.priority},
        )

    async def _send_to_kimiclaw(
        self, message: TradingMessage, target: MessageTarget,
    ) -> None:
        """Send to KimiClaw via webhook/API.

        KimiClaw routes messages to WeChat, Telegram, Discord, WhatsApp, etc.
        """
        if not target.endpoint:
            log.warning("KimiClaw endpoint not configured -- skipping")
            return

        payload = {
            "message": f"**{message.title}**\n\n{message.body}",
            "destination": target.destination or "telegram",
            "model": target.model or "kimi",
            "priority": message.priority,
            "structured": {
                "id": message.id,
                "type": message.type,
                "title": message.title,
                "body": message.body,
                "metadata": message.metadata,
                "timestamp": message.timestamp,
            },
        }

        await self._post_webhook(target, payload, "KimiClaw")

    async def _send_to_ollama(
        self, message: TradingMessage, target: MessageTarget,
    ) -> None:
        """Send to a local Ollama instance for AI-powered analysis.

        The open-source LLM can analyze evolution results, suggest parameter
        tweaks, or provide a second opinion on trading signals.
        """
        if not target.endpoint:
            log.warning("Ollama endpoint not configured -- skipping")
            return

        system_prompt = (
            "You are a quantitative trading analyst. Analyze the following "
            "trading system update and provide brief, actionable insights. "
            "Focus on risk, opportunity, and what to monitor next."
        )

        payload = {
            "model": target.model or "llama3",
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"{message.title}\n\n{message.body}"},
            ],
            "stream": False,
        }

        endpoint = target.endpoint.rstrip("/") + "/api/chat"

        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    endpoint,
                    json=payload,
                    timeout=30.0,  # LLM inference can be slow
                )

            if response.status_code == 200:
                result = response.json()
                analysis = result.get("message", {}).get("content", "")
                if analysis:
                    log.info(
                        "[Ollama/%s] %s",
                        target.model,
                        analysis,
                        extra={
                            "model": target.model,
                            "messageType": message.type,
                            "analysis": analysis[:200],
                        },
                    )
            else:
                log.warning(
                    "Ollama returned non-OK status: %d endpoint=%s",
                    response.status_code,
                    endpoint,
                )
        except Exception:
            log.error("Ollama request failed: endpoint=%s", endpoint, exc_info=True)

    async def _post_webhook(
        self,
        target: MessageTarget,
        payload: dict[str, Any],
        label: str,
    ) -> None:
        """Generic webhook POST helper."""
        headers: dict[str, str] = {"Content-Type": "application/json"}
        if target.api_key:
            headers["Authorization"] = f"Bearer {target.api_key}"

        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    target.endpoint,
                    json=payload,
                    headers=headers,
                    timeout=5.0,
                )

            if response.status_code >= 400:
                log.warning(
                    "%s webhook returned non-OK status: %d endpoint=%s",
                    label,
                    response.status_code,
                    target.endpoint,
                )
            else:
                log.debug("Message sent to %s endpoint=%s", label, target.endpoint)
        except Exception:
            log.error(
                "%s webhook failed: endpoint=%s", label, target.endpoint, exc_info=True,
            )

    def get_history(self, limit: int = 20) -> list[TradingMessage]:
        """Get recent message history."""
        return self._message_history[-limit:]


# ============================================================
# Singleton + Event Wiring
# ============================================================

message_dispatcher = MessageDispatcher()


def wire_messaging_events() -> None:
    """Wire up event bus to automatically dispatch messages for key events.

    Call this once during system initialization.
    """

    def _on_evolution_improvement(data: Any, source: str = "") -> None:
        msg = format_evolution_message(
            strategy=data.get("strategy", ""),
            generation=data.get("generation", 0),
            fitness=data.get("fitness", 0.0),
            previous_fitness=0.0,
            params=data.get("params", {}),
            improved=True,
        )
        # fire-and-forget: use asyncio if available
        import asyncio

        try:
            loop = asyncio.get_running_loop()
            loop.create_task(message_dispatcher.send(msg))
        except RuntimeError:
            asyncio.run(message_dispatcher.send(msg))

    def _on_signal_generated(data: Any, source: str = "") -> None:
        signal: Signal = data
        # Only dispatch high-confidence signals to avoid noise
        if signal.confidence < 0.6:
            return
        msg = format_signal_message(signal)
        import asyncio

        try:
            loop = asyncio.get_running_loop()
            loop.create_task(message_dispatcher.send(msg))
        except RuntimeError:
            asyncio.run(message_dispatcher.send(msg))

    def _on_risk_alert(data: Any, source: str = "") -> None:
        msg = format_alert_message(
            title=data.get("title", "Risk Alert") if isinstance(data, dict) else "Risk Alert",
            body=data.get("message", json.dumps(data)) if isinstance(data, dict) else str(data),
            priority="critical",
        )
        import asyncio

        try:
            loop = asyncio.get_running_loop()
            loop.create_task(message_dispatcher.send(msg))
        except RuntimeError:
            asyncio.run(message_dispatcher.send(msg))

    event_bus.on("evolution:improvement", _on_evolution_improvement)
    event_bus.on("signal:generated", _on_signal_generated)
    event_bus.on("risk:alert", _on_risk_alert)

    log.info("Messaging events wired to EventBus")
