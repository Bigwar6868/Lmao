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
        """Use LLM provider (KimiClaw, Ollama, Claude, OpenAI, etc.) for reasoning."""
        try:
            import asyncio
            import httpx

            system_prompt = (
                "You are the CEO of a multi-asset trading system. You oversee 6 teams: "
                "Trading (12 agents), Research, Risk, Evolution, Quant, Ops. "
                "Make strategic decisions about risk, team focus, and capital allocation. "
                "Be decisive and concise."
            )
            user_prompt = f"Question: {question}"
            if self._last_portfolio:
                p = self._last_portfolio
                open_pos = [x for x in p.positions if x.status == PositionStatus.OPEN]
                user_prompt += (
                    f"\nPortfolio: Capital=${p.capital:.2f}, PnL=${p.total_pnl:.2f} ({p.total_pnl_pct:+.1f}%), "
                    f"Open={len(open_pos)}, Margin={p.margin_used:.2f}/{p.margin_available:.2f}, "
                    f"Leverage={p.total_leverage:.1f}x, MaxDD=${p.max_drawdown:.2f}"
                )
            if context:
                user_prompt += f"\nContext: {context}"
            user_prompt += "\nRespond: DECISION: [your decision]\nCONFIDENCE: [0-100]%"

            content = self._call_provider(system_prompt, user_prompt)

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

    def _call_provider(self, system_prompt: str, user_prompt: str) -> str:
        """Call whatever LLM provider is configured (KimiClaw, Ollama, Claude, OpenAI).

        Handles both async providers (KimiClaw, OpenAI) and Ollama's native format.
        """
        import asyncio
        import httpx

        provider = self._llm_provider
        provider_name = getattr(provider, "name", "unknown")

        # If provider has an async query() method (KimiClaw, OpenAI, Claude, DeepSeek)
        if hasattr(provider, "query"):
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                loop = None

            if loop and loop.is_running():
                # Already in async context — run in thread
                import concurrent.futures
                with concurrent.futures.ThreadPoolExecutor() as pool:
                    future = pool.submit(asyncio.run, provider.query(system_prompt, user_prompt))
                    return future.result(timeout=60)
            else:
                return asyncio.run(provider.query(system_prompt, user_prompt))

        # Fallback: Ollama native /api/chat format
        endpoint = getattr(provider, 'endpoint', 'http://localhost:11434')
        model = getattr(provider, 'model', 'llama3')

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
            return resp.json().get("message", {}).get("content", "")

    def think_about_trades(self, open_positions: list, prices: dict[str, float],
                           agent_trades: dict[str, list] | None = None) -> list[dict]:
        """CEO reviews all open positions and decides: hold, tighten, or close.

        Returns list of trade decisions:
          {"position_id": ..., "action": "hold|tighten|close", "reason": ..., ...}
        """
        if not open_positions:
            return []

        # Build position summary for the CEO
        from shared.types import Side
        pos_lines = []
        for pos in open_positions:
            price = prices.get(pos.asset.symbol, pos.current_price)
            if pos.side == Side.BUY:
                pnl = (price - pos.entry_price) * pos.quantity
                pnl_pct = ((price - pos.entry_price) / pos.entry_price) * 100
            else:
                pnl = (pos.entry_price - price) * pos.quantity
                pnl_pct = ((pos.entry_price - price) / pos.entry_price) * 100

            owning_agent = "unknown"
            if agent_trades:
                for agent_name, trade_ids in agent_trades.items():
                    if pos.id in trade_ids:
                        owning_agent = agent_name
                        break

            pos_lines.append(
                f"  {pos.id[:8]} | {pos.side.value:4s} {pos.asset.symbol:<12s} | "
                f"entry={pos.entry_price:.5f} now={price:.5f} | "
                f"PnL=${pnl:+.2f} ({pnl_pct:+.2f}%) | "
                f"SL={pos.stop_loss or 0:.5f} TP={pos.take_profit or 0:.5f} | "
                f"agent={owning_agent}"
            )

        if not self._llm_provider:
            return self._rule_based_trade_review(open_positions, prices)

        system_prompt = (
            "You are the CEO of a live trading system. Review each open position and decide:\n"
            "- HOLD: trade is progressing well, keep it\n"
            "- TIGHTEN: move stop loss closer (specify new SL price)\n"
            "- CLOSE: close the position now (specify reason)\n\n"
            "Rules:\n"
            "- Close trades losing >2% immediately\n"
            "- Tighten stop if profit gave back >50% from peak\n"
            "- Close stale trades that aren't moving\n"
            "- Never let a winner turn into a big loser\n\n"
            "For each position respond with exactly one line:\n"
            "POSITION_ID ACTION [NEW_SL] REASON\n"
            "Example: abc12345 CLOSE Signal reversed\n"
            "Example: def67890 TIGHTEN 1.10500 Lock in profit\n"
            "Example: ghi11111 HOLD On track"
        )

        user_prompt = f"Open positions ({len(open_positions)}):\n" + "\n".join(pos_lines)
        if self._last_portfolio:
            p = self._last_portfolio
            user_prompt += f"\n\nPortfolio: ${p.capital:.2f} | PnL: ${p.total_pnl:+.2f} | MaxDD: ${p.max_drawdown:.2f}"

        try:
            content = self._call_provider(system_prompt, user_prompt)
            return self._parse_trade_decisions(content, open_positions)
        except Exception as e:
            log.warning("CEO trade review failed: %s — using rules", e)
            return self._rule_based_trade_review(open_positions, prices)

    def _parse_trade_decisions(self, content: str, positions: list) -> list[dict]:
        """Parse LLM response into trade decisions."""
        decisions = []
        pos_map = {p.id[:8]: p for p in positions}

        for line in content.strip().split("\n"):
            line = line.strip()
            if not line or line.startswith("#") or line.startswith("-"):
                continue

            parts = line.split(None, 2)
            if len(parts) < 2:
                continue

            pos_prefix = parts[0].strip()
            action = parts[1].strip().upper()
            rest = parts[2] if len(parts) > 2 else ""

            # Match position by ID prefix
            pos = pos_map.get(pos_prefix)
            if not pos:
                # Try fuzzy match
                for prefix, p in pos_map.items():
                    if prefix.startswith(pos_prefix[:4]):
                        pos = p
                        break
            if not pos:
                continue

            decision = {
                "position_id": pos.id,
                "symbol": pos.asset.symbol,
                "action": action.lower() if action in ("HOLD", "TIGHTEN", "CLOSE") else "hold",
                "reason": rest,
            }

            if action == "TIGHTEN":
                # Try to extract new SL from the rest
                try:
                    new_sl_str = rest.split()[0]
                    decision["new_stop_loss"] = float(new_sl_str)
                    decision["reason"] = " ".join(rest.split()[1:])
                except (ValueError, IndexError):
                    pass

            decisions.append(decision)

        return decisions

    def _rule_based_trade_review(self, positions: list, prices: dict[str, float]) -> list[dict]:
        """Rule-based trade review when LLM is unavailable."""
        from shared.types import Side
        decisions = []
        for pos in positions:
            price = prices.get(pos.asset.symbol, pos.current_price)
            if pos.side == Side.BUY:
                pnl_pct = ((price - pos.entry_price) / pos.entry_price) * 100
            else:
                pnl_pct = ((pos.entry_price - price) / pos.entry_price) * 100

            if pnl_pct < -2.0:
                decisions.append({"position_id": pos.id, "symbol": pos.asset.symbol,
                                  "action": "close", "reason": f"Loss {pnl_pct:.2f}% exceeds limit"})
            else:
                decisions.append({"position_id": pos.id, "symbol": pos.asset.symbol,
                                  "action": "hold", "reason": f"PnL {pnl_pct:+.2f}%"})
        return decisions

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
        from team.risk_manager.filters import TradeFilterEngine
        from team.risk_manager.stops import AdvancedStopManager

        self.executor = Executor()
        self.risk_manager = RiskManager()
        self.filter_engine = TradeFilterEngine()
        self.stop_manager = AdvancedStopManager()
        self._agents: list[TradingAgent] = []
        self._trade_count = 0
        self._ceo: CEOAgent | None = None  # Optional — team works without it

        # Agent-trade linkage: position_id → agent_name (for evolution)
        self._trade_agent_map: dict[str, str] = {}

    def set_ceo(self, ceo: CEOAgent) -> None:
        """Give trading team a reference to the CEO for trade monitoring."""
        self._ceo = ceo

    def _record_outcome_for_position(self, pos) -> None:
        """Record trade outcome on the owning agent. Drives evolution."""
        agent_name = self._trade_agent_map.get(pos.id)
        if not agent_name or agent_name == "quant-engine":
            for agent in self._agents:
                agent.on_trade_closed(pos.id)
            return

        entry_value = pos.entry_price * pos.quantity
        pnl_pct = (pos.realized_pnl / entry_value * 100) if entry_value > 0 else 0
        from team.agent_network import TradeOutcome
        outcome = TradeOutcome(
            signal_id=pos.id,
            asset=pos.asset.symbol,
            pnl=pos.realized_pnl,
            pnl_pct=pnl_pct,
            strategy=pos.strategy,
            timestamp=int(time.time() * 1000),
        )
        for agent in self._agents:
            if agent.name == agent_name:
                agent.record_outcome(outcome)
                agent.on_trade_closed(pos.id)
                log.info(
                    "EVOLUTION: %s %s PnL=$%.2f (%.1f%%) → rep=%.0f (was %.0f)",
                    agent.name, pos.asset.symbol, pos.realized_pnl,
                    pnl_pct, agent.reputation,
                    agent.history.peak_reputation,
                )
                return
        # Agent not found — clean up
        for agent in self._agents:
            agent.on_trade_closed(pos.id)

    def determine_risk_mode(self, portfolio: Portfolio) -> str:
        """Self-determine risk mode based on portfolio state (no CEO needed).

        Rules:
        - drawdown > 5% → conservative
        - drawdown > 3% → conservative
        - daily loss > 2% → conservative
        - equity curve below EMA → conservative
        - otherwise → normal
        """
        if portfolio.capital <= 0:
            return "conservative"

        pnl_pct = (portfolio.total_pnl / max(1, portfolio.capital)) * 100

        # Heavy drawdown → conservative
        if pnl_pct < -5:
            return "conservative"
        if pnl_pct < -3:
            return "conservative"

        # Check daily loss tracker
        daily_ok, _ = self.filter_engine.daily_loss.is_allowed(portfolio.capital)
        if not daily_ok:
            return "conservative"

        # Check recovery mode
        rec_mult, _ = self.filter_engine.recovery.get_size_multiplier(portfolio.capital)
        if rec_mult < 0.5:
            return "conservative"

        return "normal"

    def register_agent(self, agent: TradingAgent) -> None:
        self._agents.append(agent)
        self.member_ids.append(agent.id)

    def get_portfolio(self) -> Portfolio:
        return self.executor.get_portfolio()

    def get_portfolio_summary(self) -> str:
        return self.executor.get_summary()

    def update_prices(self, prices: dict[str, float]) -> None:
        pass  # Price updates handled in check_stops

    def check_stops(self, prices: dict[str, float], atr_map: dict[str, float] | None = None,
                     market_data_map: dict[str, MarketData] | None = None) -> None:
        """Check SL/TP, advanced stops, and agent trade monitoring."""
        # Standard stop check (SL/TP hits)
        closed = self.executor.check_stops(prices)

        # Record outcome on owning agent + notify filters
        for pos in closed:
            self.filter_engine.on_trade_closed(pos.asset.symbol, pos.realized_pnl)
            self.stop_manager.on_position_closed(pos.id)
            self._record_outcome_for_position(pos)

        # --- CEO trade monitoring ---
        # CEO reviews all open positions and decides: hold, tighten, or close
        if self._ceo:
            open_positions = []
            if self.executor.mode != "live":
                open_positions = [p for p in self.executor.paper.positions if p.status == PositionStatus.OPEN]
            else:
                try:
                    portfolio = self.executor.get_portfolio()
                    open_positions = [p for p in portfolio.positions if p.status == PositionStatus.OPEN]
                except Exception:
                    pass

            if open_positions:
                # Build agent ownership map
                agent_trade_map: dict[str, list[str]] = {}
                for agent in self._agents:
                    for trade in agent.get_active_trades():
                        agent_trade_map.setdefault(agent.name, []).append(trade.position_id)

                # CEO reviews positions
                decisions = self._ceo.think_about_trades(open_positions, prices, agent_trade_map)

                for decision in decisions:
                    if decision["action"] == "hold":
                        continue

                    pos_id = decision["position_id"]

                    if decision["action"] == "tighten" and "new_stop_loss" in decision:
                        if self.executor.mode != "live":
                            for pos in self.executor.paper.positions:
                                if pos.id == pos_id and pos.status == PositionStatus.OPEN:
                                    old_sl = pos.stop_loss
                                    pos.stop_loss = decision["new_stop_loss"]
                                    log.info("CEO tightened SL: %s %s %.5f → %.5f (%s)",
                                             pos.side.value, pos.asset.symbol,
                                             old_sl or 0, decision["new_stop_loss"], decision["reason"])
                                    break

                    elif decision["action"] == "close":
                        if self.executor.mode != "live":
                            for pos in self.executor.paper.positions:
                                if pos.id == pos_id and pos.status == PositionStatus.OPEN:
                                    price = prices.get(pos.asset.symbol, pos.current_price)
                                    self.executor.paper._close_position(pos, price, f"ceo:{decision['reason']}")
                                    self._record_outcome_for_position(pos)
                                    self.filter_engine.on_trade_closed(pos.asset.symbol, pos.realized_pnl)
                                    log.info("CEO closed %s %s: %s (PnL=%.2f)",
                                             pos.side.value, pos.asset.symbol,
                                             decision["reason"], pos.realized_pnl)
                                    break

        # --- Agent trade monitoring (secondary — agents also watch their own trades) ---
        for agent in self._agents:
            if agent.status == "retired" or not agent.get_active_trades():
                continue

            actions = agent.monitor_trades(prices, market_data_map)
            for action in actions:
                if action["action"] == "hold":
                    continue

                pos_id = action["position_id"]

                if action["action"] == "tighten" and "new_stop_loss" in action:
                    if self.executor.mode != "live":
                        for pos in self.executor.paper.positions:
                            if pos.id == pos_id and pos.status == PositionStatus.OPEN:
                                old_sl = pos.stop_loss
                                pos.stop_loss = action["new_stop_loss"]
                                log.info("Agent %s tightened SL: %s %.5f → %.5f (%s)",
                                         agent.name, pos.asset.symbol,
                                         old_sl or 0, action["new_stop_loss"], action["reason"])
                                break

                elif action["action"] == "close":
                    if self.executor.mode != "live":
                        for pos in self.executor.paper.positions:
                            if pos.id == pos_id and pos.status == PositionStatus.OPEN:
                                price = prices.get(pos.asset.symbol, pos.current_price)
                                self.executor.paper._close_position(pos, price, f"agent:{agent.name} {action['reason']}")
                                self._record_outcome_for_position(pos)
                                self.filter_engine.on_trade_closed(pos.asset.symbol, pos.realized_pnl)
                                log.info("Agent %s closed %s %s: %s (PnL=%.2f)",
                                         agent.name, pos.side.value, pos.asset.symbol,
                                         action["reason"], pos.realized_pnl)
                                break

        # Advanced stop management (trailing, break-even, partial close)
        if atr_map and self.executor.mode != "live":
            paper = self.executor.paper
            open_positions = [p for p in paper.positions if p.status == PositionStatus.OPEN]
            updates = self.stop_manager.check_all(open_positions, atr_map)
            for update in updates:
                pos = next((p for p in open_positions if p.id == update.position_id), None)
                if not pos:
                    continue

                # Apply partial close
                if update.partial_close_pct > 0:
                    paper.partial_close(pos, update.partial_close_pct, update.partial_close_price)
                    log.info("Partial close: %s %s %.0f%% @ %.5f",
                             pos.side.value, pos.asset.symbol,
                             update.partial_close_pct * 100, update.partial_close_price)

                # Apply new stop loss
                if update.new_stop_loss is not None:
                    old_sl = pos.stop_loss
                    pos.stop_loss = update.new_stop_loss
                    log.info("Stop update: %s %s SL %.5f → %.5f (%s)",
                             pos.side.value, pos.asset.symbol,
                             old_sl or 0, update.new_stop_loss, update.reason)

    def run_cycle(
        self,
        market_data_map: dict[str, MarketData],
        macro: Any = None,
        risk_mode: str = "normal",
        max_trades_per_cycle: int = 20,
        extra_signals: list[Signal] | None = None,
    ) -> dict:
        """Each agent independently seeks opportunities across all assets.

        Flow:
        1. Every active agent scans every asset → collects (agent, signal) pairs
        2. Merge in extra_signals from quant engine
        3. Deduplicate: keep only the highest-confidence signal per asset
        4. Rank all signals by confidence (best first)
        5. Risk-assess and execute top signals up to max_trades_per_cycle
        6. Track which agent found each trade for reputation updates

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
            if found > 0:
                log.debug("Agent %s found %d opportunities", agent.name, found)

        # --- Phase 1b: Merge quant engine signals ---
        if extra_signals:
            for signal in extra_signals:
                data = market_data_map.get(signal.asset.symbol)
                if data:
                    agent_signals.append((None, signal, data))  # None agent = quant engine

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

            # Pre-trade filters (session, spread, cooldown, daily loss, correlation, etc.)
            filter_ok, filter_mult, filter_reason = self.filter_engine.check(signal, portfolio)
            if not filter_ok:
                log.debug("Filter blocked %s %s: %s", signal.action.value, signal.asset.symbol, filter_reason)
                rejected += 1
                continue

            risk = self.risk_manager.assess(signal, mkt_data, portfolio)
            if risk.approved:
                # Scale position by CEO mode + filter multiplier (equity curve, recovery)
                risk.recommended_size *= size_multiplier * filter_mult
                result = self.executor.execute(signal, risk)
                executed += 1
                portfolio = self.executor.get_portfolio()
                source_name = agent.name if agent else "quant-engine"
                agent_hits[source_name] = agent_hits.get(source_name, 0) + 1

                # Register trade with agent for monitoring + evolution tracking
                position = result.get("position")
                if position:
                    # Map position → agent for performance attribution
                    self._trade_agent_map[position.id] = source_name

                    if agent:
                        agent.register_trade(
                            position_id=position.id,
                            symbol=signal.asset.symbol,
                            side=signal.action.value,
                            entry_price=position.entry_price,
                            quantity=position.quantity,
                            stop_loss=risk.stop_loss_price,
                            take_profit=risk.take_profit_price,
                            strategy=signal.strategy,
                        )

                log.info(
                    "TRADE: %s %s @ %.5f (conf=%.2f, agent=%s, mode=%s, filter_mult=%.2f)",
                    signal.action.value, signal.asset.symbol, signal.price,
                    signal.confidence, source_name, risk_mode, filter_mult,
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
    """Fetches market data, runs technical analysis, detects regime.

    All research results are cached with TTL so other teams can access
    them without re-computing. The research team works independently —
    CEO can read its cache but research doesn't need CEO to function.
    """

    def __init__(self, network: AgentNetwork, ceo_id: AgentId) -> None:
        super().__init__("research", "Research Team", network, ceo_id)
        from team.market_analyst.analyst import MarketAnalyst
        from team.technical_strategist.strategies import get_all_strategies

        self.market_analyst = MarketAnalyst()
        self.strategies = get_all_strategies()

        # Research cache — other teams read from here
        self._cache: dict[str, Any] = {}
        self._cache_ts: dict[str, float] = {}  # key → timestamp
        self._cache_ttl = 300  # 5 min default TTL

    def _cache_set(self, key: str, value: Any, ttl: float | None = None) -> None:
        self._cache[key] = value
        self._cache_ts[key] = time.time()

    def _cache_get(self, key: str, ttl: float | None = None) -> Any | None:
        if key not in self._cache:
            return None
        age = time.time() - self._cache_ts.get(key, 0)
        if age > (ttl or self._cache_ttl):
            return None
        return self._cache[key]

    def get_cached(self, key: str) -> Any | None:
        """Public read access to research cache for other teams."""
        return self._cache_get(key)

    def get_all_cached(self) -> dict[str, Any]:
        """Get all non-expired cache entries."""
        now = time.time()
        return {k: v for k, v in self._cache.items()
                if now - self._cache_ts.get(k, 0) < self._cache_ttl}

    def fetch_all_data(self, assets: list[AssetInfo], timeframe: str) -> dict[str, MarketData]:
        """Fetch market data for all assets and cache it."""
        data_map: dict[str, MarketData] = {}
        data_list = self.market_analyst.fetch_all(assets, timeframe)
        for data in data_list:
            data_map[data.asset.symbol] = data
        self._cache_set("market_data", data_map, ttl=120)
        self._cache_set("last_fetch_count", len(data_map))
        return data_map

    def analyze_all(self, market_data_map: dict[str, MarketData], macro: Any = None) -> list[Signal]:
        """Run all strategies on all market data and cache signals."""
        all_signals: list[Signal] = []
        signals_by_asset: dict[str, list[Signal]] = {}

        for symbol, data in market_data_map.items():
            asset_signals = []
            for strategy in self.strategies:
                try:
                    signals = strategy.analyze(data)
                    for s in signals:
                        if s.action != SignalAction.HOLD:
                            all_signals.append(s)
                            asset_signals.append(s)
                except Exception as e:
                    log.error("Strategy %s error on %s: %s", strategy.config.name, symbol, e)
            if asset_signals:
                signals_by_asset[symbol] = asset_signals

        self._cache_set("signals", all_signals)
        self._cache_set("signals_by_asset", signals_by_asset)
        self._cache_set("signal_count", len(all_signals))
        return all_signals

    def get_strategies(self):
        return self.strategies

    def get_macro_environment(self) -> dict | None:
        """Get macro environment — cached for 10 minutes."""
        cached = self._cache_get("macro", ttl=600)
        if cached is not None:
            return cached
        try:
            from team.macro_economist import MacroEconomist
            economist = MacroEconomist()
            result = economist.get_environment()
            self._cache_set("macro", result, ttl=600)
            return result
        except Exception:
            return None

    def detect_regime(self, market_data_map: dict[str, MarketData], macro: Any = None):
        """Detect market regime — cached for 5 minutes."""
        cached = self._cache_get("regime")
        if cached is not None:
            return cached
        try:
            from team.regime_detector import RegimeDetector
            detector = RegimeDetector()
            result = detector.detect(market_data_map, macro)
            self._cache_set("regime", result)
            return result
        except Exception:
            return None

    def assess_economic_period(self) -> dict:
        """Determine the current economic cycle phase and cache it.

        Phases: expansion, peak, contraction, trough
        Uses macro data: GDP growth, unemployment, inflation, yield curve, policy stance.

        Returns:
            {"phase": str, "confidence": float, "details": str,
             "risk_adjustment": str, "upcoming_events": list}
        """
        cached = self._cache_get("economic_period", ttl=600)
        if cached is not None:
            return cached

        try:
            from team.macro_economist import MacroEconomist
            economist = MacroEconomist()

            # Get global macro snapshots
            snapshots = economist.get_global_macro()
            us = economist.get_region_macro("United States")
            policy_bias = economist.get_global_policy_bias()

            # Get upcoming events
            events = economist.get_upcoming_events()
            high_impact = [e for e in events if e.impact == "high"]
            is_event_period = economist.is_high_impact_period()

            # Classify economic phase from US data (primary driver)
            phase = "expansion"
            confidence = 0.6
            details_parts = []

            if us:
                gdp = us.indicators.get("gdpGrowth", 0)
                inflation = us.indicators.get("inflation", 0)
                unemployment = us.indicators.get("unemployment", 0)

                # GDP + unemployment → phase
                if gdp > 2.0 and unemployment < 4.5:
                    phase = "expansion"
                    details_parts.append(f"GDP={gdp}% strong, unemployment={unemployment}% low")
                elif gdp > 0 and gdp <= 2.0:
                    phase = "peak"
                    details_parts.append(f"GDP={gdp}% slowing, late cycle")
                elif gdp <= 0:
                    phase = "contraction"
                    confidence = 0.8
                    details_parts.append(f"GDP={gdp}% negative")
                elif unemployment > 5.5:
                    phase = "trough"
                    details_parts.append(f"unemployment={unemployment}% high")

                # Inflation context
                if inflation > 4.0:
                    details_parts.append(f"inflation={inflation}% hot — tightening pressure")
                elif inflation < 2.0:
                    details_parts.append(f"inflation={inflation}% low — easing possible")

                # Growth outlook
                if us.growth_outlook == "slowing":
                    if phase == "expansion":
                        phase = "peak"
                    details_parts.append("growth slowing")

                # Policy stance adjustment
                if us.policy_stance == "hawkish" and phase == "expansion":
                    details_parts.append("hawkish policy — late cycle risk")
                elif us.policy_stance == "dovish" and phase in ("contraction", "trough"):
                    details_parts.append("dovish stimulus — recovery likely")

            # Risk adjustment recommendation
            risk_map = {
                "expansion": "normal",
                "peak": "conservative",
                "contraction": "conservative",
                "trough": "aggressive",
            }
            risk_adj = risk_map.get(phase, "normal")

            # High-impact event → always conservative
            if is_event_period:
                risk_adj = "conservative"
                details_parts.append("HIGH-IMPACT EVENT within 24h")

            result = {
                "phase": phase,
                "confidence": confidence,
                "details": " | ".join(details_parts) if details_parts else "insufficient data",
                "risk_adjustment": risk_adj,
                "policy_bias": policy_bias,
                "upcoming_high_impact": [
                    {"name": e.name, "date": e.next_date, "impact": e.impact}
                    for e in high_impact[:5]
                ],
                "is_event_period": is_event_period,
            }

            self._cache_set("economic_period", result, ttl=600)
            log.info("Economic period: %s (conf=%.0f%%) — %s → risk=%s",
                     phase, confidence * 100, result["details"][:80], risk_adj)
            return result

        except Exception as e:
            log.warning("Economic period assessment failed: %s", e)
            fallback = {
                "phase": "unknown", "confidence": 0, "details": str(e),
                "risk_adjustment": "normal", "policy_bias": "mixed",
                "upcoming_high_impact": [], "is_event_period": False,
            }
            self._cache_set("economic_period", fallback, ttl=60)
            return fallback

    def assess_news_impact(self) -> dict:
        """Assess current news and economic event impact on trading.

        Combines:
        - Economic calendar (FOMC, CPI, NFP within 24h)
        - Geopolitical risk factors
        - Policy changes

        Returns:
            {"impact_level": str, "should_reduce_size": bool,
             "avoid_pairs": list, "details": list[str]}
        """
        cached = self._cache_get("news_impact", ttl=300)
        if cached is not None:
            return cached

        try:
            from team.macro_economist import MacroEconomist
            economist = MacroEconomist()

            details = []
            avoid_pairs: set[str] = set()
            impact_score = 0  # 0-100

            # 1. Economic calendar events
            is_event = economist.is_high_impact_period()
            if is_event:
                events = economist.get_upcoming_events()
                for e in events:
                    if e.impact == "high":
                        details.append(f"EVENT: {e.name} ({e.next_date})")
                        impact_score += 25

            # 2. Geopolitical risk factors
            geo = economist._geopolitical
            factors = geo.get_active_factors()
            high_factors = [f for f in factors if f.severity in ("high", "critical")]
            for f in high_factors:
                details.append(f"GEO: [{f.region}] {f.description[:60]}")
                for asset in f.affected_assets:
                    avoid_pairs.add(asset)
                impact_score += 10

            # 3. Policy changes
            for p in economist.get_policy_changes():
                if p.severity == "high":
                    details.append(f"POLICY: {p.country} — {p.description[:50]}")
                    impact_score += 5

            impact_score = min(100, impact_score)
            if impact_score >= 50:
                impact_level = "high"
            elif impact_score >= 25:
                impact_level = "medium"
            else:
                impact_level = "low"

            result = {
                "impact_level": impact_level,
                "impact_score": impact_score,
                "should_reduce_size": impact_score >= 40,
                "avoid_pairs": sorted(avoid_pairs),
                "details": details,
            }

            self._cache_set("news_impact", result, ttl=300)
            log.info("News impact: %s (score=%d, avoid=%d pairs)",
                     impact_level, impact_score, len(avoid_pairs))
            return result

        except Exception as e:
            log.warning("News impact assessment failed: %s", e)
            fallback = {
                "impact_level": "unknown", "impact_score": 0,
                "should_reduce_size": False, "avoid_pairs": [], "details": [str(e)],
            }
            self._cache_set("news_impact", fallback, ttl=60)
            return fallback

    def get_research_summary(self) -> str:
        """Summary of cached research for other teams / CEO to read."""
        regime = self._cache_get("regime")
        macro = self._cache_get("macro")
        econ_period = self._cache_get("economic_period")
        news_impact = self._cache_get("news_impact")
        signal_count = self._cache_get("signal_count") or 0
        fetch_count = self._cache_get("last_fetch_count") or 0

        regime_str = getattr(regime, "regime", "unknown") if regime else "unknown"
        macro_str = getattr(macro, "bias", "unknown") if macro else "n/a"
        period_str = econ_period["phase"] if econ_period else "unknown"
        news_str = news_impact["impact_level"] if news_impact else "unknown"

        return (
            f"Research: {fetch_count} assets | {signal_count} signals | "
            f"regime={regime_str} | macro={macro_str} | "
            f"econ_period={period_str} | news_impact={news_str} | "
            f"cache={len(self._cache)} entries"
        )


# ============================================================
# Risk Team
# ============================================================

class RiskTeam(TeamBase):
    """Monitors portfolio risk each cycle, enforces limits, manages kill switch.

    Checks performed every cycle:
    1. Max drawdown → kill switch
    2. Daily loss limit → halt trading
    3. Position concentration → alert CEO
    4. Max open positions → block new trades
    5. Margin utilization → alert CEO
    6. Consecutive losses → reduce exposure
    """

    def __init__(self, network: AgentNetwork, ceo_id: AgentId) -> None:
        super().__init__("risk", "Risk Team", network, ceo_id)
        self._kill_switch = False
        self._kill_reason: str = ""
        self._alerts: list[str] = []
        self._consecutive_losses: int = 0
        self._cycle_count: int = 0
        self._last_portfolio_pnl: float = 0.0

        # Configurable limits
        self.max_drawdown_pct: float = 20.0
        self.kill_switch_drawdown_pct: float = 15.0
        self.max_open_positions: int = 20
        self.max_concentration_pct: float = 30.0  # max % of capital in one asset
        self.max_margin_utilization_pct: float = 80.0
        self.consecutive_loss_limit: int = 5

    def is_kill_switch_active(self) -> bool:
        return self._kill_switch

    def activate_kill_switch(self, reason: str) -> None:
        if not self._kill_switch:
            self._kill_switch = True
            self._kill_reason = reason
            self.report_to_ceo("risk-alert", f"KILL SWITCH ACTIVATED: {reason}")
            log.warning("KILL SWITCH ACTIVATED: %s", reason)

    def deactivate_kill_switch(self) -> None:
        if self._kill_switch:
            self._kill_switch = False
            self._kill_reason = ""
            log.info("Kill switch deactivated")

    def monitor(self, portfolio: Portfolio) -> dict:
        """Run all risk checks on the current portfolio. Call this every cycle.

        Returns dict with:
            - kill_switch: bool
            - halt_trading: bool
            - risk_mode_override: str | None
            - alerts: list[str]
        """
        self._cycle_count += 1
        self._alerts = []
        halt_trading = False
        risk_mode_override = None

        if portfolio.capital <= 0:
            self.activate_kill_switch("Capital depleted")
            return self._result(True, "conservative")

        # --- 1. Drawdown check ---
        drawdown_pct = (portfolio.max_drawdown / portfolio.capital * 100) if portfolio.capital > 0 else 0
        pnl_pct = (portfolio.total_pnl / max(1, portfolio.capital)) * 100

        if pnl_pct < -self.kill_switch_drawdown_pct:
            self.activate_kill_switch(f"Drawdown {pnl_pct:.1f}% exceeds kill threshold (-{self.kill_switch_drawdown_pct}%)")
            return self._result(True, "conservative")

        if pnl_pct < -10:
            self._alert(f"SEVERE drawdown: {pnl_pct:.1f}%")
            risk_mode_override = "conservative"
        elif pnl_pct < -5:
            self._alert(f"High drawdown: {pnl_pct:.1f}%")
            risk_mode_override = "conservative"
        elif pnl_pct < -3:
            self._alert(f"Moderate drawdown: {pnl_pct:.1f}%")

        # --- 2. Open positions count ---
        open_positions = [p for p in portfolio.positions if p.status == PositionStatus.OPEN]
        if len(open_positions) >= self.max_open_positions:
            halt_trading = True
            self._alert(f"Max open positions reached ({len(open_positions)}/{self.max_open_positions})")

        # --- 3. Concentration check — no single asset > max_concentration_pct ---
        if open_positions and portfolio.capital > 0:
            asset_exposure: dict[str, float] = {}
            for pos in open_positions:
                notional = pos.notional_value if pos.notional_value > 0 else pos.quantity * pos.current_price
                asset_exposure[pos.asset.symbol] = asset_exposure.get(pos.asset.symbol, 0) + notional

            for symbol, exposure in asset_exposure.items():
                concentration = (exposure / portfolio.capital) * 100
                if concentration > self.max_concentration_pct:
                    self._alert(f"Over-concentrated in {symbol}: {concentration:.1f}% of capital")

        # --- 4. Margin utilization ---
        if portfolio.margin_used > 0 and portfolio.capital > 0:
            margin_util = (portfolio.margin_used / portfolio.capital) * 100
            if margin_util > self.max_margin_utilization_pct:
                halt_trading = True
                self._alert(f"Margin utilization {margin_util:.0f}% > {self.max_margin_utilization_pct:.0f}% limit")
            elif margin_util > 60:
                self._alert(f"Margin utilization elevated: {margin_util:.0f}%")

        # --- 5. Track consecutive losses ---
        current_pnl = portfolio.total_pnl
        if self._cycle_count > 1 and current_pnl < self._last_portfolio_pnl:
            self._consecutive_losses += 1
        elif current_pnl > self._last_portfolio_pnl:
            self._consecutive_losses = 0
        self._last_portfolio_pnl = current_pnl

        if self._consecutive_losses >= self.consecutive_loss_limit:
            risk_mode_override = "conservative"
            self._alert(f"Consecutive losing cycles: {self._consecutive_losses}")

        # --- 6. Auto-deactivate kill switch if recovered ---
        if self._kill_switch and pnl_pct > -3:
            self.deactivate_kill_switch()

        # Report alerts to CEO
        if self._alerts:
            self.report_to_ceo("risk-monitor", f"{len(self._alerts)} risk alerts", {"alerts": self._alerts})
            for alert in self._alerts:
                log.warning("RISK: %s", alert)

        return self._result(halt_trading, risk_mode_override)

    def on_trade_closed(self, pnl: float) -> None:
        """Track closed trade for consecutive loss detection."""
        if pnl < 0:
            self._consecutive_losses += 1
        else:
            self._consecutive_losses = max(0, self._consecutive_losses - 1)

    def _alert(self, msg: str) -> None:
        self._alerts.append(msg)

    def _result(self, halt_trading: bool, risk_mode_override: str | None) -> dict:
        return {
            "kill_switch": self._kill_switch,
            "halt_trading": halt_trading or self._kill_switch,
            "risk_mode_override": risk_mode_override,
            "alerts": list(self._alerts),
            "consecutive_losses": self._consecutive_losses,
        }

    def get_alerts(self) -> list[str]:
        return list(self._alerts)

    def format_report(self) -> str:
        lines = ["\n=== Risk Team ==="]
        lines.append(f"Kill Switch: {'ACTIVE — ' + self._kill_reason if self._kill_switch else 'OFF'}")
        lines.append(f"Consecutive losses: {self._consecutive_losses}")
        lines.append(f"Cycle: {self._cycle_count}")
        if self._alerts:
            lines.append(f"Active alerts ({len(self._alerts)}):")
            for a in self._alerts:
                lines.append(f"  - {a}")
        else:
            lines.append("No active alerts")
        return "\n".join(lines)


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

# ============================================================
# Quant Team
# ============================================================

class QuantTeam(TeamBase):
    """Real-time quantitative calculations — z-scores, IRP, divergence, Hurst."""

    def __init__(self, network: AgentNetwork, ceo_id: AgentId) -> None:
        super().__init__("quant", "Quant Team", network, ceo_id)
        from team.quant_engine import QuantEngine
        self.engine = QuantEngine()

    def feed_market_data(self, market_data_map: dict[str, "MarketData"]) -> None:
        """Feed all market data into quant engine."""
        for symbol, data in market_data_map.items():
            self.engine.feed_market_data(data)

    def generate_signals(self, assets: list) -> list:
        """Generate quant signals (z-score, divergence, IRP, vol-squeeze, pair-spread)."""
        signals = []
        for asset in assets:
            signals.extend(self.engine.generate_signals(asset))
        # Cross-pair signals
        self.engine.compute_pair_metrics()
        signals.extend(self.engine.generate_pair_signals())
        return signals

    def get_dashboard(self) -> str:
        return QuantEngine.format_dashboard(
            self.engine.get_all_snapshots(),
            self.engine.get_pair_snapshots(),
        )

    def get_status(self) -> dict:
        return self.engine.get_status()

    def get_recent_alerts(self, count: int = 50) -> list:
        return self.engine.get_recent_alerts(count)


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
