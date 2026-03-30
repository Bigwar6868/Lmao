"""AgentBrain -- AI-powered reasoning engine for the trading system.

Primary: Uses Ollama (local LLM) via httpx for AI-powered thinking.
Fallback: Rule-based structured analysis when LLM is unavailable.

Ported from TypeScript: shared/agent-brain.ts
"""

from __future__ import annotations

import logging
import os
import resource
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

import httpx

from .agent_types import AgentId, AgentMessage, BrainRole, TeamPrompt
from .types import MacroEnvironment, MarketData, Signal

logger = logging.getLogger(__name__)


# ============================================================
# Data Types
# ============================================================

@dataclass
class ThoughtStep:
    """A single step in the agent's reasoning chain."""
    step: str = ""
    observation: str = ""
    conclusion: str = ""
    confidence: float = 0.5


@dataclass
class ThoughtChain:
    """Complete reasoning output from the brain."""
    agent_id: AgentId = ""
    role: str = ""
    question: str = ""
    steps: list[ThoughtStep] = field(default_factory=list)
    decision: str = ""
    reasoning: str = ""
    confidence: float = 0.5
    timestamp: int = 0
    duration_ms: int = 0
    used_ai: bool = False
    llm_provider: str | None = None


@dataclass
class BrainContext:
    """Context provided to the brain for reasoning."""
    mission: str | None = None
    prompt: TeamPrompt | None = None
    market_data: dict[str, MarketData] | None = None
    macro: MacroEnvironment | None = None
    signals: list[Signal] | None = None
    recent_messages: list[AgentMessage] | None = None
    portfolio: PortfolioContext | None = None
    custom_data: dict[str, Any] | None = None


@dataclass
class PortfolioContext:
    """Portfolio subset passed to the brain."""
    capital: float = 0.0
    total_pnl: float = 0.0
    open_positions: int = 0
    win_rate: float = 0.0


# ============================================================
# Role-specific system prompts
# ============================================================

ROLE_SYSTEM_PROMPTS: dict[BrainRole, str] = {
    "ceo": (
        "You are the CEO of a multi-asset trading system. You oversee 5 teams: "
        "Trading, Research, Risk, Evolution, and Ops.\n"
        "Your job is to make strategic decisions: when to pause trading, which teams "
        "need attention, whether to increase/decrease risk exposure.\n"
        "Think in terms of system health, macro risk, team performance, and capital preservation.\n"
        "Always be decisive. If risk is elevated, say so clearly."
    ),
    "trader": (
        "You are a trading agent in a multi-asset algorithmic trading system.\n"
        "You analyze signals, market volatility, and portfolio state to decide what to trade and when.\n"
        "Think in terms of signal strength, conviction, risk/reward, position sizing, and market conditions.\n"
        "Be specific about which assets look promising and why. Flag divergences between strategies."
    ),
    "researcher": (
        "You are the head of research for a multi-asset trading system covering crypto, stocks, and forex.\n"
        "You analyze market data freshness, macro conditions, cross-asset correlations, and regime transitions.\n"
        "Think like a quant researcher: look for convergence across strategies, unusual volume, correlation breakdowns."
    ),
    "risk-manager": (
        "You are the risk manager for a multi-asset trading system.\n"
        "Your PRIMARY job is capital preservation. Monitor drawdowns, position concentration, macro risk, "
        "and stop losses.\n"
        "Be conservative and paranoid. If drawdown exceeds 5%, recommend immediate action. Never downplay risk."
    ),
    "evolutionist": (
        "You are the evolution strategist for a multi-asset trading system.\n"
        "You analyze strategy performance, decay detection, parameter drift, and diversity.\n"
        "Think in terms of win rates, Sharpe ratios, overfitting risk, and genetic algorithm parameters."
    ),
    "ops": (
        "You are the operations manager for a multi-asset trading system.\n"
        "Monitor system health: memory usage, data source availability, API rate limits, cache integrity.\n"
        "Flag any operational issues immediately."
    ),
}


# ============================================================
# LLM Provider
# ============================================================

@runtime_checkable
class LLMProvider(Protocol):
    """Protocol for LLM providers."""
    name: str
    model: str

    async def query(self, system_prompt: str, user_prompt: str) -> str:
        """Send a prompt and return the response text."""
        ...


class OllamaProvider:
    """Ollama LLM provider -- connects to local Ollama instance via httpx."""

    def __init__(
        self,
        endpoint: str | None = None,
        model: str | None = None,
    ) -> None:
        self.endpoint = (
            endpoint
            or os.environ.get("OLLAMA_CEO_ENDPOINT")
            or os.environ.get("OLLAMA_ENDPOINT")
            or "http://localhost:11434"
        ).rstrip("/")
        self.model = (
            model
            or os.environ.get("OLLAMA_CEO_MODEL")
            or os.environ.get("OLLAMA_MODEL")
            or "MiniMax-M1-80k"
        )
        self.name = "ollama"
        logger.info("OllamaProvider configured endpoint=%s model=%s", self.endpoint, self.model)

    async def query(self, system_prompt: str, user_prompt: str) -> str:
        """Query the Ollama API for a chat completion."""
        url = f"{self.endpoint}/api/chat"
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "stream": False,
            "options": {
                "temperature": 0.3,
                "num_predict": 1024,
            },
        }
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(url, json=payload)
            response.raise_for_status()
            result = response.json()
            return result.get("message", {}).get("content", "")


class ClaudeProvider:
    """Anthropic Claude API provider for agent reasoning."""

    def __init__(
        self,
        api_key: str | None = None,
        model: str | None = None,
    ) -> None:
        self.api_key = api_key or os.environ.get("ANTHROPIC_API_KEY", "")
        self.model = model or os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-20250514")
        self.name = "claude"
        self._base_url = "https://api.anthropic.com/v1"
        if self.api_key:
            logger.info("ClaudeProvider configured model=%s", self.model)
        else:
            logger.warning("ClaudeProvider: no ANTHROPIC_API_KEY set")

    async def query(self, system_prompt: str, user_prompt: str) -> str:
        """Query the Anthropic Messages API."""
        if not self.api_key:
            raise RuntimeError("ANTHROPIC_API_KEY not set")
        headers = {
            "x-api-key": self.api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }
        payload = {
            "model": self.model,
            "max_tokens": 1024,
            "system": system_prompt,
            "messages": [{"role": "user", "content": user_prompt}],
            "temperature": 0.3,
        }
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                f"{self._base_url}/messages", headers=headers, json=payload,
            )
            response.raise_for_status()
            result = response.json()
            content_blocks = result.get("content", [])
            return content_blocks[0].get("text", "") if content_blocks else ""


class KimiClawProvider:
    """KimiClaw API provider — routes to Kimi/Moonshot LLM for agent reasoning."""

    def __init__(
        self,
        api_key: str | None = None,
        endpoint: str | None = None,
        model: str | None = None,
    ) -> None:
        self.api_key = (
            api_key
            or os.environ.get("KIMICLAW_API_KEY")
            or os.environ.get("MOONSHOT_API_KEY", "")
        )
        self.endpoint = (
            endpoint
            or os.environ.get("KIMICLAW_LLM_ENDPOINT")
            or os.environ.get("MOONSHOT_ENDPOINT")
            or "https://api.moonshot.cn/v1"
        ).rstrip("/")
        self.model = model or os.environ.get("KIMICLAW_MODEL", "moonshot-v1-8k")
        self.name = "kimiclaw"
        if self.api_key:
            logger.info("KimiClawProvider configured endpoint=%s model=%s", self.endpoint, self.model)
        else:
            logger.warning("KimiClawProvider: no KIMICLAW_API_KEY / MOONSHOT_API_KEY set")

    async def query(self, system_prompt: str, user_prompt: str) -> str:
        """Query KimiClaw/Moonshot chat completions API (OpenAI-compatible)."""
        if not self.api_key:
            raise RuntimeError("KIMICLAW_API_KEY / MOONSHOT_API_KEY not set")
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": 0.3,
            "max_tokens": 1024,
        }
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                f"{self.endpoint}/chat/completions", headers=headers, json=payload,
            )
            response.raise_for_status()
            result = response.json()
            choices = result.get("choices", [])
            return choices[0].get("message", {}).get("content", "") if choices else ""


class OpenAICompatibleProvider:
    """Generic OpenAI-compatible API provider (DeepSeek, Groq, Together, etc.)."""

    def __init__(
        self,
        api_key: str | None = None,
        endpoint: str | None = None,
        model: str | None = None,
        name: str = "openai-compatible",
    ) -> None:
        self.api_key = api_key or os.environ.get("OPENAI_API_KEY", "")
        self.endpoint = (endpoint or os.environ.get("OPENAI_ENDPOINT", "https://api.openai.com/v1")).rstrip("/")
        self.model = model or os.environ.get("OPENAI_MODEL", "gpt-4o")
        self.name = name
        if self.api_key:
            logger.info("%sProvider configured endpoint=%s model=%s", name, self.endpoint, self.model)

    async def query(self, system_prompt: str, user_prompt: str) -> str:
        """Query any OpenAI-compatible chat completions API."""
        if not self.api_key:
            raise RuntimeError(f"{self.name}: API key not set")
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": 0.3,
            "max_tokens": 1024,
        }
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                f"{self.endpoint}/chat/completions", headers=headers, json=payload,
            )
            response.raise_for_status()
            result = response.json()
            choices = result.get("choices", [])
            return choices[0].get("message", {}).get("content", "") if choices else ""


def auto_detect_provider() -> LLMProvider | None:
    """Auto-detect the best available LLM provider from env vars.

    Priority: Claude API > KimiClaw > Ollama > OpenAI-compatible.
    Returns None if nothing is configured.
    """
    if os.environ.get("ANTHROPIC_API_KEY"):
        return ClaudeProvider()
    if os.environ.get("KIMICLAW_API_KEY") or os.environ.get("MOONSHOT_API_KEY"):
        return KimiClawProvider()
    if os.environ.get("OLLAMA_ENDPOINT") or os.environ.get("OLLAMA_CEO_ENDPOINT"):
        return OllamaProvider()
    if os.environ.get("OPENAI_API_KEY"):
        return OpenAICompatibleProvider()
    # Default: try Ollama on localhost
    return OllamaProvider()


# ============================================================
# Global LLM provider management
# ============================================================

_global_llm_provider: LLMProvider | None = None


def set_global_llm_provider(provider: LLMProvider) -> None:
    """Set the global LLM provider for all AgentBrain instances."""
    global _global_llm_provider
    _global_llm_provider = provider
    logger.info("Global LLM provider set: %s/%s", provider.name, provider.model)


def get_global_llm_provider() -> LLMProvider | None:
    """Get the current global LLM provider."""
    return _global_llm_provider


# ============================================================
# AgentBrain
# ============================================================

class AgentBrain:
    """AI-powered reasoning engine.

    Tries LLM provider first, falls back to rule-based reasoning.
    """

    def __init__(
        self,
        agent_id: AgentId,
        role: BrainRole,
        name: str,
        llm_provider: LLMProvider | None = None,
    ) -> None:
        self.agent_id = agent_id
        self.role = role
        self.name = name
        self._thought_history: list[ThoughtChain] = []
        self._max_history = 50
        self._ai_available = True
        self._ai_fail_count = 0
        self._max_ai_retries = 3
        self._llm_provider = llm_provider

    # ----------------------------------------------------------------
    # Provider management
    # ----------------------------------------------------------------

    def set_llm_provider(self, provider: LLMProvider) -> None:
        """Set or swap the LLM provider at runtime."""
        self._llm_provider = provider
        self._ai_available = True
        self._ai_fail_count = 0
        logger.info("Agent %s: LLM provider set to %s/%s", self.name, provider.name, provider.model)

    def get_llm_provider(self) -> LLMProvider | None:
        """Get the effective LLM provider (instance or global)."""
        return self._llm_provider or _global_llm_provider

    # ----------------------------------------------------------------
    # Thinking
    # ----------------------------------------------------------------

    async def think_async(self, question: str, context: BrainContext) -> ThoughtChain:
        """Think about a question -- tries LLM provider, then rule-based fallback."""
        start = _now_ms()

        provider = self.get_llm_provider()
        if provider and self._ai_available:
            try:
                chain = await self._think_with_llm(provider, question, context, start)
                self._ai_fail_count = 0
                return self._record_chain(chain)
            except Exception as exc:
                self._ai_fail_count += 1
                logger.warning(
                    "Agent %s: LLM provider %s failed (%s), fail_count=%d",
                    self.name, provider.name, exc, self._ai_fail_count,
                )
                if self._ai_fail_count >= self._max_ai_retries:
                    self._ai_available = False
                    logger.warning(
                        "Agent %s: Too many failures, disabling LLM provider",
                        self.name,
                    )

        # Fallback: rule-based
        return self._record_chain(self._think_rule_based(question, context, start))

    def think(self, question: str, context: BrainContext) -> ThoughtChain:
        """Synchronous think -- rule-based only."""
        start = _now_ms()
        return self._record_chain(self._think_rule_based(question, context, start))

    async def assess_async(
        self, question: str, context: BrainContext,
    ) -> tuple[str, float]:
        """Quick async assessment, returns (decision, confidence)."""
        chain = await self.think_async(question, context)
        return chain.decision, chain.confidence

    def assess(self, question: str, context: BrainContext) -> tuple[str, float]:
        """Quick sync assessment, returns (decision, confidence)."""
        chain = self.think(question, context)
        return chain.decision, chain.confidence

    async def decide_idle_action_async(self, context: BrainContext) -> str | None:
        """Decide what to explore when idle (async)."""
        chain = await self.think_async("What should I do while idle?", context)
        return chain.decision if chain.confidence > 0.3 else None

    def decide_idle_action(self, context: BrainContext) -> str | None:
        """Decide what to explore when idle (sync)."""
        chain = self.think("What should I do while idle?", context)
        return chain.decision if chain.confidence > 0.3 else None

    def enable_ai(self) -> None:
        """Re-enable AI after it was disabled due to failures."""
        self._ai_available = True
        self._ai_fail_count = 0
        logger.info("Agent %s: AI re-enabled", self.name)

    def is_ai_available(self) -> bool:
        return self._ai_available

    def get_thought_history(self) -> list[ThoughtChain]:
        return list(self._thought_history)

    def get_last_thought(self) -> ThoughtChain | None:
        return self._thought_history[-1] if self._thought_history else None

    # ----------------------------------------------------------------
    # LLM-powered thinking
    # ----------------------------------------------------------------

    async def _think_with_llm(
        self,
        provider: LLMProvider,
        question: str,
        ctx: BrainContext,
        start: int,
    ) -> ThoughtChain:
        system_prompt = ROLE_SYSTEM_PROMPTS[self.role]
        user_prompt = self.build_prompt(question, ctx)

        logger.info(
            "Agent %s thinking with %s/%s: %s",
            self.name, provider.name, provider.model, question,
        )

        result = await provider.query(system_prompt, user_prompt)
        chain = self.parse_response(question, result, start)
        chain.used_ai = True
        chain.llm_provider = f"{provider.name}/{provider.model}"

        logger.info(
            "Agent %s LLM done: decision=%s confidence=%.2f duration=%dms",
            self.name, chain.decision[:100], chain.confidence, chain.duration_ms,
        )
        return chain

    # ----------------------------------------------------------------
    # Prompt building
    # ----------------------------------------------------------------

    def build_prompt(self, question: str, ctx: BrainContext) -> str:
        """Build a prompt string from context."""
        parts: list[str] = [f"Question: {question}"]

        if ctx.mission:
            parts.append(f"\nMission: {ctx.mission}")

        if ctx.portfolio:
            p = ctx.portfolio
            pnl_pct = (
                f"{(p.total_pnl / p.capital * 100):.1f}" if p.capital > 0 else "0"
            )
            parts.append(
                f"\nPortfolio: Capital=${p.capital:.2f}, PnL=${p.total_pnl:.2f} "
                f"({pnl_pct}%), Open={p.open_positions}, "
                f"WinRate={p.win_rate * 100:.0f}%"
            )

        if ctx.macro:
            parts.append(f"\nMacro: Risk={ctx.macro.risk_level}, Bias={ctx.macro.bias}")

        if ctx.signals:
            buys = sum(1 for s in ctx.signals if s.action.value == "BUY")
            sells = sum(1 for s in ctx.signals if s.action.value == "SELL")
            top3 = sorted(
                [s for s in ctx.signals if s.action.value != "HOLD"],
                key=lambda s: s.confidence,
                reverse=True,
            )[:3]
            top_str = ", ".join(
                f"{s.action.value} {s.asset.symbol} {s.confidence * 100:.0f}%"
                for s in top3
            )
            parts.append(
                f"\nSignals: {len(ctx.signals)} total ({buys} BUY, {sells} SELL). "
                f"Top: {top_str}"
            )

        if ctx.market_data:
            prices: list[str] = []
            for symbol, data in ctx.market_data.items():
                if len(data.candles) >= 2:
                    last = data.candles[-1]
                    prev = data.candles[-2]
                    chg = (last.close - prev.close) / prev.close * 100
                    prices.append(f"{symbol}:${last.close:.2f}({chg:+.2f}%)")
                if len(prices) >= 8:
                    break
            parts.append(f"\nPrices: {', '.join(prices)}")

        parts.append(
            "\nRespond with structured analysis:\n"
            "STEP: [what you're analyzing]\n"
            "OBS: [what you observe]\n"
            "CONCLUDE: [your conclusion]\n"
            "(repeat for each thought)\n"
            "DECISION: [your final decision]\n"
            "CONFIDENCE: [0-100]%"
        )

        return "\n".join(parts)

    # ----------------------------------------------------------------
    # Response parsing
    # ----------------------------------------------------------------

    def parse_response(self, question: str, text: str, start: int) -> ThoughtChain:
        """Parse an LLM response into a ThoughtChain."""
        steps: list[ThoughtStep] = []
        decision = ""
        confidence = 0.5

        lines = [line.strip() for line in text.split("\n") if line.strip()]
        current_step = ""
        current_obs = ""

        for line in lines:
            if line.startswith("STEP:"):
                if current_step and current_obs:
                    steps.append(ThoughtStep(
                        step=current_step, observation=current_obs,
                        conclusion="", confidence=0.5,
                    ))
                current_step = line[len("STEP:"):].strip()
                current_obs = ""
            elif line.startswith("OBS:"):
                current_obs = line[len("OBS:"):].strip()
            elif line.startswith("CONCLUDE:"):
                conclusion = line[len("CONCLUDE:"):].strip()
                if current_step:
                    steps.append(ThoughtStep(
                        step=current_step, observation=current_obs or "See analysis",
                        conclusion=conclusion, confidence=0.7,
                    ))
                    current_step = ""
                    current_obs = ""
            elif line.startswith("DECISION:"):
                decision = line[len("DECISION:"):].strip()
            elif line.startswith("CONFIDENCE:"):
                raw = line[len("CONFIDENCE:"):].strip().replace("%", "")
                try:
                    parsed = int(raw)
                    confidence = max(0.0, min(1.0, parsed / 100))
                except ValueError:
                    pass

        # If parsing produced no structured steps, create one from full text
        if not steps:
            if not decision:
                sentences = [s.strip() for s in text.split(".") if s.strip()]
                decision = sentences[-1] if sentences else text[:200]
            steps.append(ThoughtStep(
                step="AI Analysis", observation=text[:300],
                conclusion=decision, confidence=confidence,
            ))

        if not decision and steps:
            decision = steps[-1].conclusion

        for s in steps:
            if s.confidence == 0.5:
                s.confidence = confidence

        now = _now_ms()
        return ThoughtChain(
            agent_id=self.agent_id,
            role=self.role,
            question=question,
            steps=steps,
            decision=decision or "Continue monitoring",
            reasoning=" -> ".join(s.conclusion for s in steps),
            confidence=confidence,
            timestamp=now,
            duration_ms=now - start,
            used_ai=True,
        )

    # ----------------------------------------------------------------
    # Rule-based fallback
    # ----------------------------------------------------------------

    def _think_rule_based(
        self, question: str, ctx: BrainContext, start: int,
    ) -> ThoughtChain:
        steps: list[ThoughtStep] = []

        role_methods = {
            "ceo": self._think_as_ceo,
            "trader": self._think_as_trader,
            "researcher": self._think_as_researcher,
            "risk-manager": self._think_as_risk_manager,
            "evolutionist": self._think_as_evolutionist,
            "ops": self._think_as_ops,
        }
        method = role_methods.get(self.role)
        if method:
            method(question, ctx, steps)

        avg_confidence = (
            sum(s.confidence for s in steps) / len(steps) if steps else 0.5
        )
        now = _now_ms()
        return ThoughtChain(
            agent_id=self.agent_id,
            role=self.role,
            question=question,
            steps=steps,
            decision=(
                steps[-1].conclusion if steps
                else "No conclusion -- insufficient data"
            ),
            reasoning=" -> ".join(s.conclusion for s in steps),
            confidence=avg_confidence,
            timestamp=now,
            duration_ms=now - start,
            used_ai=False,
        )

    def _record_chain(self, chain: ThoughtChain) -> ThoughtChain:
        self._thought_history.append(chain)
        if len(self._thought_history) > self._max_history:
            self._thought_history.pop(0)
        return chain

    # ----------------------------------------------------------------
    # Role-specific rule-based reasoning
    # ----------------------------------------------------------------

    def _think_as_ceo(
        self, question: str, ctx: BrainContext, steps: list[ThoughtStep],
    ) -> None:
        if ctx.portfolio:
            p = ctx.portfolio
            if p.win_rate > 0.5:
                health = "healthy"
            elif p.win_rate > 0.3:
                health = "underperforming"
            else:
                health = "critical"
            steps.append(ThoughtStep(
                step="Assess system health",
                observation=f"Capital: ${p.capital:.0f}, PnL: ${p.total_pnl:.2f}, Win rate: {p.win_rate * 100:.0f}%",
                conclusion=f"System is {health}",
                confidence=0.8,
            ))
        if ctx.macro:
            risk_ok = ctx.macro.risk_level in ("low", "medium")
            steps.append(ThoughtStep(
                step="Evaluate macro",
                observation=f"Risk: {ctx.macro.risk_level}, Bias: {ctx.macro.bias}",
                conclusion=(
                    "Macro supports trading" if risk_ok
                    else f"Macro risk elevated ({ctx.macro.risk_level}) -- consider reducing exposure"
                ),
                confidence=0.7 if risk_ok else 0.85,
            ))
        idle_conclusion = (
            "Review team prompts. Check for new opportunities."
            if "idle" in question.lower()
            else "Continue current strategy. Monitor for regime changes."
        )
        steps.append(ThoughtStep(
            step="Strategic assessment",
            observation=f"Q: {question}",
            conclusion=idle_conclusion,
            confidence=0.65,
        ))

    def _think_as_trader(
        self, question: str, ctx: BrainContext, steps: list[ThoughtStep],
    ) -> None:
        if ctx.signals:
            high_conf = [
                s for s in ctx.signals
                if s.confidence > 0.7 and s.action.value != "HOLD"
            ]
            if high_conf:
                conclusion = (
                    f"{len(high_conf)} high-conviction opportunities -- "
                    f"prioritize {high_conf[0].asset.symbol}"
                )
                conf = 0.8
            else:
                conclusion = "No strong signals -- stay cautious"
                conf = 0.4
            steps.append(ThoughtStep(
                step="Scan signals",
                observation=f"{len(ctx.signals)} signals, {len(high_conf)} high-confidence",
                conclusion=conclusion,
                confidence=conf,
            ))

        if ctx.market_data:
            vols: list[float] = []
            for data in ctx.market_data.values():
                if len(data.candles) >= 20:
                    closes = [c.close for c in data.candles[-20:]]
                    rets = [
                        abs((closes[i + 1] - closes[i]) / closes[i])
                        for i in range(len(closes) - 1)
                    ]
                    if rets:
                        vols.append(sum(rets) / len(rets))
            avg_vol = sum(vols) / len(vols) if vols else 0.0
            if avg_vol > 0.03:
                vol_conclusion = "High vol -- widen stops"
            elif avg_vol > 0.01:
                vol_conclusion = "Normal vol"
            else:
                vol_conclusion = "Low vol -- look for breakouts"
            steps.append(ThoughtStep(
                step="Assess volatility",
                observation=f"Avg vol: {avg_vol * 100:.2f}%",
                conclusion=vol_conclusion,
                confidence=0.75,
            ))

        if ctx.portfolio:
            p = ctx.portfolio
            steps.append(ThoughtStep(
                step="Portfolio check",
                observation=f"{p.open_positions} open, PnL: ${p.total_pnl:.2f}",
                conclusion=(
                    "Many positions -- avoid adding more"
                    if p.open_positions > 5
                    else "Room for new positions"
                ),
                confidence=0.7,
            ))

    def _think_as_researcher(
        self, question: str, ctx: BrainContext, steps: list[ThoughtStep],
    ) -> None:
        if ctx.market_data:
            stale = 0
            ago = _now_ms() - 3_600_000
            for data in ctx.market_data.values():
                if data.candles and data.candles[-1].timestamp < ago:
                    stale += 1
            total = len(ctx.market_data)
            steps.append(ThoughtStep(
                step="Data freshness",
                observation=f"{total} assets, {stale} stale",
                conclusion=(
                    "Most data stale -- refresh needed"
                    if stale > total / 2
                    else "Data is fresh"
                ),
                confidence=0.8,
            ))

        if ctx.signals:
            cross: dict[str, int] = {}
            for s in ctx.signals:
                cross[s.asset.symbol] = cross.get(s.asset.symbol, 0) + 1
            multi = [sym for sym, c in cross.items() if c >= 2]
            steps.append(ThoughtStep(
                step="Cross-reference signals",
                observation=f"{len(multi)} multi-strategy assets",
                conclusion=(
                    f"Convergence: {', '.join(multi)}" if multi
                    else "No convergence"
                ),
                confidence=0.8 if multi else 0.5,
            ))

        if "idle" in question.lower():
            steps.append(ThoughtStep(
                step="Idle plan",
                observation="No requests",
                conclusion="Check regime transitions. Scan correlations.",
                confidence=0.55,
            ))

    def _think_as_risk_manager(
        self, question: str, ctx: BrainContext, steps: list[ThoughtStep],
    ) -> None:
        if ctx.portfolio:
            p = ctx.portfolio
            pnl_pct = (p.total_pnl / p.capital * 100) if p.capital > 0 else 0.0
            if pnl_pct < -5:
                conclusion = "DANGER: >5% drawdown -- reduce exposure"
                conf = 0.95
            elif pnl_pct < -2:
                conclusion = "Approaching limits -- tighten stops"
                conf = 0.7
            else:
                conclusion = "Risk acceptable"
                conf = 0.7
            steps.append(ThoughtStep(
                step="Portfolio risk",
                observation=f"PnL: {pnl_pct:.2f}%, {p.open_positions} open",
                conclusion=conclusion,
                confidence=conf,
            ))

        if ctx.macro:
            if ctx.macro.risk_level == "extreme":
                conclusion = "EXTREME -- activate kill switch"
            elif ctx.macro.risk_level == "high":
                conclusion = "HIGH -- reduce 50%"
            else:
                conclusion = "Acceptable"
            steps.append(ThoughtStep(
                step="Macro risk",
                observation=f"Risk: {ctx.macro.risk_level}",
                conclusion=conclusion,
                confidence=0.85,
            ))

    def _think_as_evolutionist(
        self, question: str, ctx: BrainContext, steps: list[ThoughtStep],
    ) -> None:
        if ctx.portfolio:
            p = ctx.portfolio
            if p.win_rate < 0.4:
                conclusion = "Underperforming -- evolve now"
            elif p.win_rate > 0.6:
                conclusion = "Strong -- preserve top, mutate bottom"
            else:
                conclusion = "Average -- standard cycle"
            steps.append(ThoughtStep(
                step="Strategy effectiveness",
                observation=f"Win: {p.win_rate * 100:.0f}%, PnL: ${p.total_pnl:.2f}",
                conclusion=conclusion,
                confidence=0.75,
            ))

        if ctx.signals:
            strats = set(s.strategy for s in ctx.signals)
            steps.append(ThoughtStep(
                step="Strategy diversity",
                observation=f"{len(strats)} strategies",
                conclusion=(
                    "Low diversity -- spawn variants"
                    if len(strats) < 3
                    else "Good diversity"
                ),
                confidence=0.7,
            ))

    def _think_as_ops(
        self, question: str, ctx: BrainContext, steps: list[ThoughtStep],
    ) -> None:
        # Memory usage (Linux)
        try:
            mem_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
        except Exception:
            mem_mb = 0.0
        uptime_min = time.monotonic() / 60

        mem_high = mem_mb > 500
        steps.append(ThoughtStep(
            step="System resources",
            observation=f"Memory: {mem_mb:.0f}MB, Uptime: {uptime_min:.0f}min",
            conclusion="Memory high -- prune cache" if mem_high else "Resources normal",
            confidence=0.9,
        ))

        if ctx.market_data:
            empty = sum(
                1 for d in ctx.market_data.values() if not d.candles
            )
            steps.append(ThoughtStep(
                step="Data sources",
                observation=f"{len(ctx.market_data)} sources, {empty} empty",
                conclusion=(
                    f"{empty} failing -- investigate" if empty > 0
                    else "All operational"
                ),
                confidence=0.85,
            ))


# ============================================================
# Helpers
# ============================================================

def _now_ms() -> int:
    """Current time in milliseconds."""
    return int(time.time() * 1000)
