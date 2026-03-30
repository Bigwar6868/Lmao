"""Trade Journal + Execution Quality Monitor.

  1. Trade Journal — persistent CSV log of every trade
  2. Execution Quality — slippage tracking, fill rate, spread at entry
  3. Post-Trade Reviewer — syncs closed trades and updates agent performance
"""

from __future__ import annotations

import csv
import logging
import os
import time
from dataclasses import dataclass, field
from pathlib import Path

from shared.types import (
    Position, Portfolio, PositionStatus, Side,
)
from config.settings import config

log = logging.getLogger(__name__)


# ============================================================
# Trade Journal (CSV)
# ============================================================

class TradeJournal:
    """Persistent CSV trade log for every entry and exit."""

    HEADERS = [
        "timestamp", "action", "symbol", "side", "quantity", "price",
        "stop_loss", "take_profit", "leverage", "margin", "notional",
        "strategy", "agent", "confidence", "risk_mode",
        "pnl", "pnl_pct", "exit_reason", "session", "spread_pips",
        "slippage_pips", "trade_id",
    ]

    def __init__(self, data_dir: str | Path | None = None) -> None:
        base = Path(data_dir) if data_dir else Path(config.data_dir)
        self._dir = base / "journal"
        self._dir.mkdir(parents=True, exist_ok=True)
        self._path = self._dir / "trades.csv"
        self._init_file()

        log.info("TradeJournal: %s", self._path)

    def _init_file(self) -> None:
        if not self._path.exists():
            with open(self._path, "w", newline="") as f:
                writer = csv.writer(f)
                writer.writerow(self.HEADERS)

    def log_entry(
        self,
        symbol: str, side: str, quantity: float, price: float,
        stop_loss: float = 0, take_profit: float = 0,
        leverage: float = 1, margin: float = 0, notional: float = 0,
        strategy: str = "", agent: str = "", confidence: float = 0,
        risk_mode: str = "normal", session: str = "", spread_pips: float = 0,
        slippage_pips: float = 0, trade_id: str = "",
    ) -> None:
        self._write_row(
            action="OPEN", symbol=symbol, side=side, quantity=quantity,
            price=price, stop_loss=stop_loss, take_profit=take_profit,
            leverage=leverage, margin=margin, notional=notional,
            strategy=strategy, agent=agent, confidence=confidence,
            risk_mode=risk_mode, session=session, spread_pips=spread_pips,
            slippage_pips=slippage_pips, trade_id=trade_id,
        )

    def log_exit(
        self,
        symbol: str, side: str, quantity: float, price: float,
        pnl: float = 0, pnl_pct: float = 0, exit_reason: str = "",
        strategy: str = "", agent: str = "", trade_id: str = "",
    ) -> None:
        self._write_row(
            action="CLOSE", symbol=symbol, side=side, quantity=quantity,
            price=price, pnl=pnl, pnl_pct=pnl_pct, exit_reason=exit_reason,
            strategy=strategy, agent=agent, trade_id=trade_id,
        )

    def _write_row(self, **kwargs) -> None:
        row = {h: kwargs.get(h, "") for h in self.HEADERS}
        row["timestamp"] = int(time.time())
        try:
            with open(self._path, "a", newline="") as f:
                writer = csv.DictWriter(f, fieldnames=self.HEADERS)
                writer.writerow(row)
        except Exception as e:
            log.error("Journal write failed: %s", e)

    def get_recent(self, count: int = 50) -> list[dict]:
        """Read last N entries from journal."""
        try:
            with open(self._path, "r") as f:
                reader = csv.DictReader(f)
                rows = list(reader)
            return rows[-count:]
        except Exception:
            return []

    def get_stats(self) -> dict:
        """Compute trade statistics from journal."""
        rows = self.get_recent(1000)
        closes = [r for r in rows if r.get("action") == "CLOSE"]
        if not closes:
            return {"total": 0, "wins": 0, "losses": 0, "win_rate": 0, "total_pnl": 0}

        wins = sum(1 for r in closes if float(r.get("pnl", 0)) > 0)
        losses = sum(1 for r in closes if float(r.get("pnl", 0)) <= 0)
        total_pnl = sum(float(r.get("pnl", 0)) for r in closes)

        return {
            "total": len(closes),
            "wins": wins,
            "losses": losses,
            "win_rate": wins / len(closes) if closes else 0,
            "total_pnl": total_pnl,
        }


# ============================================================
# Execution Quality Monitor
# ============================================================

@dataclass
class ExecutionMetrics:
    """Tracks execution quality over time."""
    total_trades: int = 0
    total_slippage_pips: float = 0.0
    avg_slippage_pips: float = 0.0
    max_slippage_pips: float = 0.0
    total_spread_cost_pips: float = 0.0
    avg_spread_pips: float = 0.0
    fill_rate: float = 1.0       # successful / attempted
    attempted: int = 0
    failed: int = 0


class ExecutionQualityMonitor:
    """Monitors slippage, spread cost, and fill quality."""

    def __init__(self) -> None:
        self._metrics = ExecutionMetrics()
        self._slippage_history: list[float] = []
        self._spread_history: list[float] = []

    def record_fill(
        self,
        requested_price: float,
        filled_price: float,
        spread_pips: float = 0,
        symbol: str = "",
    ) -> float:
        """Record a fill and return slippage in pips."""
        pip = 0.01 if "JPY" in symbol else 0.0001
        slippage = abs(filled_price - requested_price) / pip

        self._metrics.total_trades += 1
        self._metrics.attempted += 1
        self._metrics.total_slippage_pips += slippage
        self._metrics.avg_slippage_pips = (
            self._metrics.total_slippage_pips / self._metrics.total_trades
        )
        self._metrics.max_slippage_pips = max(self._metrics.max_slippage_pips, slippage)

        self._slippage_history.append(slippage)
        if len(self._slippage_history) > 500:
            self._slippage_history = self._slippage_history[-500:]

        if spread_pips > 0:
            self._metrics.total_spread_cost_pips += spread_pips
            self._spread_history.append(spread_pips)
            if len(self._spread_history) > 500:
                self._spread_history = self._spread_history[-500:]
            self._metrics.avg_spread_pips = (
                self._metrics.total_spread_cost_pips / self._metrics.total_trades
            )

        self._metrics.fill_rate = (
            (self._metrics.attempted - self._metrics.failed) / self._metrics.attempted
            if self._metrics.attempted > 0 else 1.0
        )

        if slippage > 5:
            log.warning("High slippage: %s %.1f pips (requested=%.5f filled=%.5f)",
                        symbol, slippage, requested_price, filled_price)

        return slippage

    def record_failure(self) -> None:
        self._metrics.attempted += 1
        self._metrics.failed += 1
        self._metrics.fill_rate = (
            (self._metrics.attempted - self._metrics.failed) / self._metrics.attempted
        )

    def get_metrics(self) -> ExecutionMetrics:
        return self._metrics

    def format_report(self) -> str:
        m = self._metrics
        return (
            f"Execution: {m.total_trades} fills | "
            f"avg_slip={m.avg_slippage_pips:.1f}pip | "
            f"max_slip={m.max_slippage_pips:.1f}pip | "
            f"avg_spread={m.avg_spread_pips:.1f}pip | "
            f"fill_rate={m.fill_rate:.0%} ({m.failed} failed)"
        )


# ============================================================
# Post-Trade Reviewer
# ============================================================

class PostTradeReviewer:
    """Syncs closed trades from OANDA and updates agent performance.

    Bridges the gap between:
    - OANDA closing trades (SL/TP hits) → system doesn't know
    - Agent performance tracking (record_outcome never called)
    """

    def __init__(self) -> None:
        self._known_trade_ids: set[str] = set()  # Trade IDs we've already processed
        self._agent_trade_map: dict[str, str] = {}  # trade_id → agent_name

    def register_trade(self, trade_id: str, agent_name: str) -> None:
        """Register a trade so we can attribute it to an agent when it closes."""
        self._agent_trade_map[trade_id] = agent_name
        self._known_trade_ids.add(trade_id)

    def sync_closed_trades(self, executor) -> list[dict]:
        """Fetch closed trades from OANDA that we don't know about.

        Calls OANDA transaction API to find ORDER_FILL events
        for trades we opened but haven't seen close.
        """
        closed = []
        try:
            live = executor._get_live()
            if not hasattr(live, '_session') or not hasattr(live, 'account_id'):
                return []

            # Fetch recent transactions
            resp = live._session.get(
                f"{live.base_url}/v3/accounts/{live.account_id}/transactions",
                params={"type": "ORDER_FILL", "count": 100},
                timeout=10,
            )
            resp.raise_for_status()
            data = resp.json()

            for txn in data.get("transactions", []):
                trade_id = txn.get("tradesClosed", [{}])[0].get("tradeID", "") if txn.get("tradesClosed") else ""
                if not trade_id or trade_id in self._known_trade_ids:
                    continue

                # This is a trade close we haven't seen
                instrument = txn.get("instrument", "").replace("_", "/")
                pnl = float(txn.get("pl", 0))
                units = int(txn.get("units", 0))
                price = float(txn.get("price", 0))
                reason = txn.get("reason", "")
                time_str = txn.get("time", "")

                self._known_trade_ids.add(trade_id)
                closed.append({
                    "trade_id": trade_id,
                    "instrument": instrument,
                    "pnl": pnl,
                    "units": units,
                    "price": price,
                    "reason": reason,
                    "time": time_str,
                    "agent": self._agent_trade_map.get(trade_id, "unknown"),
                })

                log.info(
                    "Synced closed trade: %s %s PnL=%.2f (%s) agent=%s",
                    instrument, trade_id, pnl, reason,
                    self._agent_trade_map.get(trade_id, "unknown"),
                )

        except Exception as e:
            log.debug("Transaction sync failed (expected in cloud/paper): %s", e)

        return closed

    def sync_paper_closed(self, paper_trader) -> list[dict]:
        """Sync closed trades from paper trader."""
        closed = []
        for pos in paper_trader.closed_positions:
            if pos.id in self._known_trade_ids:
                continue
            self._known_trade_ids.add(pos.id)

            entry_value = pos.entry_price * pos.quantity
            pnl_pct = (pos.realized_pnl / entry_value * 100) if entry_value > 0 else 0

            closed.append({
                "trade_id": pos.id,
                "instrument": pos.asset.symbol,
                "pnl": pos.realized_pnl,
                "pnl_pct": pnl_pct,
                "price": pos.current_price,
                "reason": "paper_close",
                "agent": self._agent_trade_map.get(pos.id, "unknown"),
                "strategy": pos.strategy,
            })

        return closed

    def update_agent_performance(self, closed_trades: list[dict], spawner) -> int:
        """Update agent reputation based on closed trade outcomes.

        Returns number of agents updated.
        """
        from team.agent_network import TradeOutcome

        updated = 0
        for trade in closed_trades:
            agent_name = trade.get("agent", "unknown")
            if agent_name == "unknown" or agent_name == "quant-engine":
                continue

            # Find the agent
            agent = None
            for a in spawner.agents.values():
                if a.name == agent_name:
                    agent = a
                    break

            if agent is None:
                continue

            outcome = TradeOutcome(
                signal_id=trade.get("trade_id", ""),
                asset=trade.get("instrument", ""),
                pnl=trade.get("pnl", 0),
                pnl_pct=trade.get("pnl_pct", 0),
                strategy=trade.get("strategy", agent.strategy.config.name),
                timestamp=int(time.time() * 1000),
            )
            agent.record_outcome(outcome)
            updated += 1

            log.info(
                "Agent %s updated: %s PnL=$%.2f → reputation=%.0f",
                agent_name, trade["instrument"], trade["pnl"], agent.reputation,
            )

        return updated
