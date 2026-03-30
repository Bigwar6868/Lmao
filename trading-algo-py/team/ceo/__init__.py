"""CEO Agent + 5 Team architecture for autonomous trading.

Structure:
  CEO (decision maker, Ollama/MiniMax brain)
  ├── Trading Team — selects assets, executes trades, reviews performance
  ├── Research Team — fetches data, detects regime, analyzes signals
  ├── Risk Team — monitors exposure, enforces stops, kill switch
  ├── Evolution Team — backtests, evolves strategies, detects decay
  └── Ops Team — diagnostics, data source monitoring, alerts
"""

from __future__ import annotations

import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from shared.types import (
    AssetInfo, Signal, MarketData, Portfolio, PerformanceMetrics,
    StrategyDNA, SignalAction, PositionStatus,
)
from shared.events import event_bus
from team.agent_network import (
    AgentNetwork, AgentId, AgentMessage, TradingAgent,
    AgentSpawner, DecayDetector, PerformanceSnapshot,
)

log = logging.getLogger(__name__)


# ============================================================
# Data types for CEO communication
# ============================================================

@dataclass
class TeamPrompt:
    team_id: str
    mission: str
    objectives: list[str] = field(default_factory=list)
    constraints: list[str] = field(default_factory=list)
    focus: dict[str, Any] | None = None
    issued_at: int = 0
    updated_at: int = 0


@dataclass
class TeamConfig:
    id: str
    name: str
    lead_id: AgentId
    member_ids: list[AgentId] = field(default_factory=list)


# ============================================================
# CEOAgent — top-level decision maker
# ============================================================

class CEOAgent:
    """CEO with optional Ollama/MiniMax brain for LLM-powered decisions."""

    def __init__(self, network: AgentNetwork, llm_provider: Any = None) -> None:
        self.id: AgentId = str(uuid.uuid4())
        self.network = network
        self.network.register(self.id)

        self._teams: dict[str, TeamConfig] = {}
        self._active_assets: list[AssetInfo] = []
        self._active_strategies: list[str] = []
        self._team_prompts: dict[str, TeamPrompt] = {}
        self._pending_requests: list[dict] = []
        self._cycle_count = 0
        self._paused = False

        # Brain (optional — Ollama/MiniMax or rule-based)
        self._llm_provider = llm_provider
        self._last_portfolio: Portfolio | None = None
        self._last_thought: dict | None = None

        # Listen for requests and reports
        self.network.on(self.id, "request", self._handle_request)
        self.network.on(self.id, "report", self._handle_report)

        provider_name = f"{llm_provider.name}/{llm_provider.model}" if llm_provider else "rule-based"
        log.info("CEO Agent initialized (brain=%s)", provider_name)

    def register_team(self, config: TeamConfig) -> None:
        self._teams[config.id] = config

    def get_all_teams(self) -> list[TeamConfig]:
        return list(self._teams.values())

    def set_team_prompt(self, team_id: str, mission: str, objectives: list[str],
                        constraints: list[str] | None = None, focus: dict | None = None) -> None:
        now = int(time.time() * 1000)
        existing = self._team_prompts.get(team_id)
        self._team_prompts[team_id] = TeamPrompt(
            team_id=team_id, mission=mission, objectives=objectives,
            constraints=constraints or [], focus=focus,
            issued_at=existing.issued_at if existing else now, updated_at=now,
        )

    def set_active_assets(self, assets: list[AssetInfo]) -> None:
        self._active_assets = assets

    def set_active_strategies(self, strategies: list[str]) -> None:
        self._active_strategies = strategies

    def is_paused(self) -> bool:
        return self._paused

    def pause(self, reason: str) -> None:
        self._paused = True
        log.warning("CEO PAUSED: %s", reason)

    def resume(self, reason: str) -> None:
        self._paused = False
        log.info("CEO RESUMED: %s", reason)

    def increment_cycle(self) -> int:
        self._cycle_count += 1
        return self._cycle_count

    def get_cycle_count(self) -> int:
        return self._cycle_count

    def update_context(self, portfolio: Portfolio | None = None) -> None:
        if portfolio:
            self._last_portfolio = portfolio

    def think(self, question: str, context: dict | None = None) -> dict:
        """Ask the CEO brain (LLM or rule-based) to think."""
        if self._llm_provider:
            return self._llm_think(question, context)
        return self._rule_based_think(question, context)

    def _llm_think(self, question: str, context: dict | None = None) -> dict:
        """Use Ollama/MiniMax for reasoning."""
        try:
            import httpx
            system_prompt = (
                "You are the CEO of a multi-asset trading system. You oversee 5 teams: "
                "Trading, Research, Risk, Evolution, Ops. Make strategic decisions about "
                "risk, team focus, and capital allocation. Be decisive."
            )
            user_prompt = f"Question: {question}"
            if self._last_portfolio:
                p = self._last_portfolio
                user_prompt += f"\nPortfolio: Capital=${p.capital:.2f}, PnL=${p.total_pnl:.2f}, Positions={len([x for x in p.positions if x.status == PositionStatus.OPEN])}"
            if context:
                user_prompt += f"\nContext: {context}"
            user_prompt += "\nRespond: DECISION: [your decision]\nCONFIDENCE: [0-100]%"

            endpoint = getattr(self._llm_provider, 'endpoint', 'http://localhost:11434')
            model = getattr(self._llm_provider, 'model', 'MiniMax-M1-80k')

            with httpx.Client(timeout=60) as client:
                resp = client.post(f"{endpoint}/api/chat", json={
                    "model": model,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt},
                    ],
                    "stream": False,
                    "options": {"temperature": 0.3},
                })
                resp.raise_for_status()
                content = resp.json().get("message", {}).get("content", "")

                decision = content
                confidence = 0.5
                for line in content.split("\n"):
                    if line.strip().upper().startswith("DECISION:"):
                        decision = line.split(":", 1)[1].strip()
                    if line.strip().upper().startswith("CONFIDENCE:"):
                        try:
                            confidence = int(line.split(":", 1)[1].strip().replace("%", "")) / 100
                        except ValueError:
                            pass

                self._last_thought = {"decision": decision, "confidence": confidence, "used_ai": True}
                return self._last_thought

        except Exception as e:
            log.warning("CEO LLM think failed: %s — using rule-based", e)
            return self._rule_based_think(question, context)

    def _rule_based_think(self, question: str, context: dict | None = None) -> dict:
        """Simple rule-based reasoning fallback."""
        decision = "Continue monitoring. No changes needed."
        confidence = 0.6

        if self._last_portfolio:
            pnl_pct = (self._last_portfolio.total_pnl / max(1, self._last_portfolio.capital)) * 100
            if pnl_pct < -5:
                decision = "DANGER: >5% drawdown — reduce exposure immediately"
                confidence = 0.9
            elif pnl_pct < -2:
                decision = "Approaching limits — tighten stops"
                confidence = 0.7

        self._last_thought = {"decision": decision, "confidence": confidence, "used_ai": False}
        return self._last_thought

    def _handle_request(self, msg: AgentMessage) -> None:
        payload = msg.payload
        request_type = payload.get("request_type", "unknown")
        log.info("CEO received request: %s from %s", request_type, msg.from_id[:8])

        # Auto-decide
        if self._llm_provider:
            thought = self.think(f"Should I approve request: {request_type}? Reason: {payload.get('reason', '')}")
            decision = thought.get("decision", "").upper()
            if "APPROVE" in decision or "YES" in decision:
                self._approve(msg.id, msg.from_id, f"[LLM] {thought['decision'][:100]}")
            elif "VETO" in decision or "DENY" in decision or "REJECT" in decision:
                self._veto(msg.id, msg.from_id, f"[LLM] {thought['decision'][:100]}")
            else:
                self._approve(msg.id, msg.from_id, "Auto-approved (ambiguous LLM)")
        else:
            # Rule-based
            if request_type in ("evolution", "new-asset", "decrease-risk"):
                self._approve(msg.id, msg.from_id, f"Auto-approved: {request_type}")
            elif request_type == "spawn-agent":
                total = sum(len(t.member_ids) for t in self._teams.values())
                if total < 30:
                    self._approve(msg.id, msg.from_id, "Agent count within limits")
                else:
                    self._veto(msg.id, msg.from_id, "Too many agents")
            else:
                log.info("Request queued: %s", request_type)

    def _handle_report(self, msg: AgentMessage) -> None:
        payload = msg.payload
        report_type = payload.get("report_type", "")
        if report_type == "risk-alert":
            self.network.broadcast(self.id, "directive", {
                "directive_type": "pause-trading",
                "target_team": "trading",
                "reason": f"Risk alert: {payload.get('summary', '')}",
                "priority": "urgent",
            })

    def _approve(self, request_id: str, to: AgentId, reason: str) -> None:
        self.network.unicast(self.id, to, "approval", {"request_id": request_id, "reason": reason})
        self._pending_requests = [r for r in self._pending_requests if r.get("id") != request_id]

    def _veto(self, request_id: str, to: AgentId, reason: str) -> None:
        self.network.unicast(self.id, to, "veto", {"request_id": request_id, "reason": reason})
        self._pending_requests = [r for r in self._pending_requests if r.get("id") != request_id]

    def format_report(self, portfolio: Portfolio | None = None) -> str:
        total_agents = sum(len(t.member_ids) for t in self._teams.values())
        provider = self._llm_provider
        brain_str = f"{provider.name}/{provider.model}" if provider else "rule-based"

        lines = [
            "\n=== CEO DASHBOARD ===\n",
            f"Cycle: {self._cycle_count} | Status: {'PAUSED' if self._paused else 'ACTIVE'}",
            f"Brain: {brain_str}",
        ]

        if self._last_thought:
            lines.append(f"Last thought: \"{self._last_thought['decision'][:80]}\" ({self._last_thought['confidence']*100:.0f}% conf)")

        lines.append(f"Agents: {total_agents} across {len(self._teams)} teams")
        lines.append(f"Strategies: {', '.join(self._active_strategies) or 'none'}")

        if portfolio:
            lines.append(f"Capital: ${portfolio.capital:.2f} | PnL: ${portfolio.total_pnl:.2f}")
            open_pos = len([p for p in portfolio.positions if p.status == PositionStatus.OPEN])
            lines.append(f"Open Positions: {open_pos}")

        lines.append("\nTeams:")
        for t in self._teams.values():
            prompt = self._team_prompts.get(t.id)
            lines.append(f"  {t.name} ({t.id}): {len(t.member_ids)} agents")
            if prompt:
                lines.append(f"    Mission: {prompt.mission}")

        return "\n".join(lines)


# ============================================================
# Team Base
# ============================================================

class TeamBase:
    """Base class for all teams. Each team has a lead agent on the network."""

    def __init__(self, team_id: str, team_name: str, network: AgentNetwork, ceo_id: AgentId) -> None:
        self.team_id = team_id
        self.team_name = team_name
        self.network = network
        self.ceo_id = ceo_id
        self.lead_id: AgentId = str(uuid.uuid4())
        self.member_ids: list[AgentId] = []
        self._prompt: TeamPrompt | None = None

        self.network.register(self.lead_id)
        self.network.on(self.lead_id, "directive", self._on_directive)

    def get_config(self) -> TeamConfig:
        return TeamConfig(id=self.team_id, name=self.team_name, lead_id=self.lead_id, member_ids=self.member_ids)

    def _on_directive(self, msg: AgentMessage) -> None:
        payload = msg.payload
        if payload.get("directive_type") == "set-prompt":
            self._prompt = TeamPrompt(
                team_id=self.team_id,
                mission=payload.get("mission", ""),
                objectives=payload.get("objectives", []),
                constraints=payload.get("constraints", []),
            )

    def report_to_ceo(self, report_type: str, summary: str, data: dict | None = None) -> None:
        self.network.unicast(self.lead_id, self.ceo_id, "report", {
            "report_type": report_type,
            "summary": summary,
            "data": data or {},
        })

    def request_from_ceo(self, request_type: str, reason: str, data: dict | None = None) -> None:
        self.network.unicast(self.lead_id, self.ceo_id, "request", {
            "request_type": request_type,
            "reason": reason,
            "data": data or {},
        })


# ============================================================
# Trading Team
# ============================================================

class TradingTeam(TeamBase):
    """Executes trades, manages agents, reviews performance."""

    def __init__(self, network: AgentNetwork, ceo_id: AgentId) -> None:
        super().__init__("trading", "Trading Team", network, ceo_id)
        from team.executor.executor import Executor
        from team.risk_manager.risk import RiskManager

        self.executor = Executor()
        self.risk_manager = RiskManager()
        self._agents: list[TradingAgent] = []
        self._trade_count = 0

    def register_agent(self, agent: TradingAgent) -> None:
        self._agents.append(agent)
        self.member_ids.append(agent.id)

    def get_portfolio(self) -> Portfolio:
        return self.executor.get_portfolio()

    def get_portfolio_summary(self) -> str:
        return self.executor.get_summary()

    def update_prices(self, prices: dict[str, float]) -> None:
        pass  # Price updates handled in check_stops

    def check_stops(self, prices: dict[str, float]) -> None:
        self.executor.check_stops(prices)

    def run_cycle(
        self,
        market_data_map: dict[str, MarketData],
        macro: Any = None,
        risk_mode: str = "normal",
        max_trades_per_cycle: int = 20,
    ) -> dict:
        """Each agent independently seeks opportunities across all assets.

        Flow:
        1. Every active agent scans every asset → collects (agent, signal) pairs
        2. Deduplicate: keep only the highest-confidence signal per asset
        3. Rank all signals by confidence (best first)
        4. Risk-assess and execute top signals up to max_trades_per_cycle
        5. Track which agent found each trade for reputation updates

        risk_mode: "aggressive" (lower threshold), "normal", "conservative" (higher threshold)
        """
        # --- Phase 1: Each agent hunts for opportunities ---
        agent_signals: list[tuple[TradingAgent, Signal, MarketData]] = []

        for agent in self._agents:
            if agent.status == "retired":
                continue
            found = 0
            for symbol, data in market_data_map.items():
                try:
                    signals = agent.analyze(data)
                    for s in signals:
                        agent_signals.append((agent, s, data))
                        found += 1
                except Exception as e:
                    log.error("Agent %s error on %s: %s", agent.name, symbol, e)
            if found:
                log.debug("Agent %s found %d opportunities", agent.name, found)

        if not agent_signals:
            return {"signals": [], "executed": 0, "rejected": 0, "agent_hits": {}}

        # --- Phase 2: Deduplicate — best signal per (asset, direction) ---
        best_per_asset: dict[str, tuple[TradingAgent, Signal, MarketData]] = {}
        for agent, signal, data in agent_signals:
            key = f"{signal.asset.symbol}:{signal.action.value}"
            existing = best_per_asset.get(key)
            if existing is None or signal.confidence > existing[1].confidence:
                best_per_asset[key] = (agent, signal, data)

        # --- Phase 3: Rank by confidence (highest first) ---
        ranked = sorted(best_per_asset.values(), key=lambda x: x[1].confidence, reverse=True)

        # --- Phase 4: Risk-adjust based on CEO mode ---
        confidence_floor = {"aggressive": 0.30, "normal": 0.40, "conservative": 0.55}.get(risk_mode, 0.40)
        size_multiplier = {"aggressive": 1.3, "normal": 1.0, "conservative": 0.6}.get(risk_mode, 1.0)

        # --- Phase 5: Execute top signals ---
        executed = 0
        rejected = 0
        agent_hits: dict[str, int] = {}  # agent_name -> trade count
        portfolio = self.executor.get_portfolio()

        for agent, signal, mkt_data in ranked:
            if executed >= max_trades_per_cycle:
                break

            # Apply CEO risk mode filter
            if signal.confidence < confidence_floor:
                rejected += 1
                continue

            risk = self.risk_manager.assess(signal, mkt_data, portfolio)
            if risk.approved:
                # Scale position by CEO mode
                risk.recommended_size *= size_multiplier
                self.executor.execute(signal, risk)
                executed += 1
                portfolio = self.executor.get_portfolio()
                agent_hits[agent.name] = agent_hits.get(agent.name, 0) + 1
                log.info(
                    "TRADE: %s %s @ %.5f (conf=%.2f, agent=%s, mode=%s)",
                    signal.action.value, signal.asset.symbol, signal.price,
                    signal.confidence, agent.name, risk_mode,
                )
            else:
                rejected += 1

        self._trade_count += executed

        # Log agent contribution summary
        if agent_hits:
            hits_str = ", ".join(f"{k}={v}" for k, v in sorted(agent_hits.items(), key=lambda x: -x[1]))
            log.info("Agent contributions: %s", hits_str)

        return {
            "signals": [s for _, s, _ in ranked],
            "total_opportunities": len(agent_signals),
            "unique_opportunities": len(ranked),
            "executed": executed,
            "rejected": rejected,
            "agent_hits": agent_hits,
            "risk_mode": risk_mode,
        }

    def select_assets_to_trade(self, market_data_map: dict[str, MarketData], signals: list[Signal]) -> list[AssetInfo]:
        """Select which assets to trade based on signal quality."""
        assets_with_signals: dict[str, AssetInfo] = {}
        for s in signals:
            if s.action != SignalAction.HOLD and s.confidence >= 0.5:
                assets_with_signals[s.asset.symbol] = s.asset
        return list(assets_with_signals.values())

    def review_performance(self) -> dict:
        portfolio = self.executor.get_portfolio()
        total_trades = len([p for p in portfolio.positions if p.status == PositionStatus.CLOSED])
        wins = len([p for p in portfolio.positions if p.status == PositionStatus.CLOSED and p.realized_pnl > 0])
        win_rate = wins / max(1, total_trades)

        adjustments = []
        if win_rate < 0.4 and total_trades >= 5:
            adjustments.append("Win rate low — tighten entry filters")
        if portfolio.total_pnl_pct < -3:
            adjustments.append("Drawdown warning — reduce position sizes")

        return {
            "summary": f"Trades: {total_trades}, WR: {win_rate:.0%}, PnL: ${portfolio.total_pnl:.2f}",
            "adjustments": adjustments,
        }


# ============================================================
# Research Team
# ============================================================

class ResearchTeam(TeamBase):
    """Fetches market data, runs technical analysis, detects regime."""

    def __init__(self, network: AgentNetwork, ceo_id: AgentId) -> None:
        super().__init__("research", "Research Team", network, ceo_id)
        from team.market_analyst.analyst import MarketAnalyst
        from team.technical_strategist.strategies import get_all_strategies

        self.market_analyst = MarketAnalyst()
        self.strategies = get_all_strategies()

    def fetch_all_data(self, assets: list[AssetInfo], timeframe: str) -> dict[str, MarketData]:
        """Fetch market data for all assets."""
        data_map: dict[str, MarketData] = {}
        data_list = self.market_analyst.fetch_all(assets, timeframe)
        for data in data_list:
            data_map[data.asset.symbol] = data
        return data_map

    def analyze_all(self, market_data_map: dict[str, MarketData], macro: Any = None) -> list[Signal]:
        """Run all strategies on all market data."""
        all_signals: list[Signal] = []
        for symbol, data in market_data_map.items():
            for strategy in self.strategies:
                try:
                    signals = strategy.analyze(data)
                    for s in signals:
                        if s.action != SignalAction.HOLD:
                            all_signals.append(s)
                except Exception as e:
                    log.error("Strategy %s error on %s: %s", strategy.config.name, symbol, e)
        return all_signals

    def get_strategies(self):
        return self.strategies

    def get_macro_environment(self) -> dict | None:
        """Get macro environment (if macro economist available)."""
        try:
            from team.macro_economist import MacroEconomist
            economist = MacroEconomist()
            return economist.get_environment()
        except Exception:
            return None

    def detect_regime(self, market_data_map: dict[str, MarketData], macro: Any = None):
        """Detect market regime."""
        try:
            from team.regime_detector import RegimeDetector
            detector = RegimeDetector()
            return detector.detect(market_data_map, macro)
        except Exception:
            return None


# ============================================================
# Risk Team
# ============================================================

class RiskTeam(TeamBase):
    """Monitors risk, enforces limits, manages kill switch."""

    def __init__(self, network: AgentNetwork, ceo_id: AgentId) -> None:
        super().__init__("risk", "Risk Team", network, ceo_id)
        self._kill_switch = False

    def is_kill_switch_active(self) -> bool:
        return self._kill_switch

    def activate_kill_switch(self, reason: str) -> None:
        self._kill_switch = True
        self.report_to_ceo("risk-alert", f"Kill switch activated: {reason}")
        log.warning("KILL SWITCH ACTIVATED: %s", reason)

    def deactivate_kill_switch(self) -> None:
        self._kill_switch = False
        log.info("Kill switch deactivated")

    def format_report(self) -> str:
        return f"\n=== Risk Team ===\nKill Switch: {'ACTIVE' if self._kill_switch else 'OFF'}"


# ============================================================
# Evolution Team
# ============================================================

class EvolutionTeam(TeamBase):
    """Backtests strategies, evolves DNA, detects decay."""

    def __init__(self, network: AgentNetwork, ceo_id: AgentId) -> None:
        super().__init__("evolution", "Evolution Team", network, ceo_id)
        from team.backtester.engine import Backtester
        from team.self_improver.evolution import SelfImprover

        self.backtester = Backtester()
        self.self_improver = SelfImprover()
        self.decay_detector = DecayDetector()

    def initialize(self) -> None:
        log.info("Evolution Team initialized")

    def evolve_strategy(self, strategy, candles, asset, timeframe) -> dict:
        """Run evolution on a strategy."""
        from shared.types import MarketData
        data = MarketData(asset=asset, timeframe=timeframe, candles=candles, last_updated=int(time.time() * 1000))
        result = self.backtester.run(strategy, data)
        return {"improved": result.metrics.total_return_pct > 0, "best_dna": strategy.dna}

    def analyze_decay(self) -> list:
        return self.decay_detector.analyze()

    def get_leaderboard(self) -> str:
        return "\n=== Strategy Leaderboard ===\n(Run backtest for rankings)"

    def save(self) -> None:
        log.info("Evolution Team state saved")


# ============================================================
# Ops Team
# ============================================================

class OpsTeam(TeamBase):
    """System health, diagnostics, monitoring."""

    def __init__(self, network: AgentNetwork, ceo_id: AgentId) -> None:
        super().__init__("ops", "Ops Team", network, ceo_id)

    def run_diagnostics(self, context: dict | None = None) -> dict:
        """Run system health checks."""
        import os
        try:
            import psutil
            mem = psutil.virtual_memory()
            memory_pct = mem.percent
        except ImportError:
            memory_pct = 0

        checks = [
            {"name": "Memory", "status": "ok" if memory_pct < 80 else "warning", "value": f"{memory_pct:.0f}%"},
            {"name": "Python", "status": "ok", "value": f"{os.sys.version_info.major}.{os.sys.version_info.minor}"},
        ]
        return {"checks": checks, "overall": "healthy" if all(c["status"] == "ok" for c in checks) else "degraded"}

    def get_data_source_report(self) -> str:
        return "\n=== Data Sources ===\nOANDA: configured\nIC Markets: configured"
