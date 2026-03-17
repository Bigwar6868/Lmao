"""Trade executor — routes orders to paper or live engine."""

from __future__ import annotations

import logging

from shared.types import Signal, RiskAssessment, Order, Portfolio
from team.executor.paper import PaperTrader
from config.settings import config

log = logging.getLogger(__name__)


class Executor:
    """Routes trades to paper or live execution engine."""

    def __init__(self) -> None:
        self.mode = config.trading_mode
        self.paper = PaperTrader(initial_capital=config.initial_capital)
        self._live = None  # Lazy-init

        log.info("Executor initialised (mode=%s)", self.mode)

    def _get_live(self):
        """Lazy-initialise live executor."""
        if self._live is None:
            from team.executor.live import LiveExecutor
            self._live = LiveExecutor()
            if not self._live.connect():
                raise RuntimeError("Failed to connect to IC Markets")
        return self._live

    def execute(self, signal: Signal, risk: RiskAssessment) -> dict:
        """Execute a trade via the configured engine."""
        if self.mode == "live":
            executor = self._get_live()
            order = executor.execute_order(signal, risk)
            return {"success": True, "order": order}

        return self.paper.execute_trade(signal, risk)

    def update_prices(self, prices: dict[str, float]) -> None:
        self.paper.update_prices(prices)

    def check_stops(self, prices: dict[str, float]) -> list:
        return self.paper.check_stops(prices)

    def get_portfolio(self) -> Portfolio:
        return self.paper.get_portfolio()

    def get_order_history(self) -> list[Order]:
        return self.paper.get_order_history()

    def get_summary(self) -> str:
        return self.paper.get_summary()
