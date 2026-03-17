"""Trade executor — routes orders to paper, OANDA, or IC Markets engine."""

from __future__ import annotations

import logging

from shared.types import Signal, RiskAssessment, Order, Portfolio
from team.executor.paper import PaperTrader
from config.settings import config

log = logging.getLogger(__name__)


class Executor:
    """Routes trades to paper or live execution engine.

    Live broker selection:
    - TRADING_BROKER=oanda -> OANDA v20 REST API
    - TRADING_BROKER=icmarkets -> IC Markets cTrader Open API
    - Default: auto-detect based on available credentials
    """

    def __init__(self) -> None:
        self.mode = config.trading_mode  # "paper" or "live"
        self.paper = PaperTrader(initial_capital=config.initial_capital)
        self._live = None  # Lazy-init

        log.info("Executor initialised (mode=%s)", self.mode)

    def _get_live(self):
        """Lazy-initialise live executor based on broker config."""
        if self._live is not None:
            return self._live

        broker = getattr(config, "trading_broker", "auto")

        if broker == "oanda" or (broker == "auto" and config.has_oanda_credentials):
            from team.executor.oanda import OandaExecutor
            self._live = OandaExecutor()
            log.info("Live executor: OANDA")
        elif broker == "icmarkets" or (broker == "auto" and config.has_ctrader_credentials):
            from team.executor.live import LiveExecutor
            self._live = LiveExecutor()
            if not self._live.connect():
                raise RuntimeError("Failed to connect to IC Markets")
            log.info("Live executor: IC Markets")
        else:
            raise RuntimeError(
                "No live broker credentials configured. "
                "Set OANDA_API_TOKEN + OANDA_ACCOUNT_ID or "
                "CTRADER_CLIENT_ID + CTRADER_CLIENT_SECRET + CTRADER_ACCESS_TOKEN + CTRADER_ACCOUNT_ID"
            )

        return self._live

    def execute(self, signal: Signal, risk: RiskAssessment) -> dict:
        """Execute a trade via the configured engine."""
        if self.mode == "live":
            executor = self._get_live()
            order = executor.execute_order(signal, risk)
            return {"success": True, "order": order}

        return self.paper.execute_trade(signal, risk)

    def update_prices(self, prices: dict[str, float]) -> None:
        # In live mode OANDA tracks prices server-side; no local update needed
        if self.mode != "live":
            self.paper.update_prices(prices)

    def check_stops(self, prices: dict[str, float]) -> list:
        # In live mode OANDA handles SL/TP server-side via stopLossOnFill/takeProfitOnFill
        if self.mode == "live":
            return []
        return self.paper.check_stops(prices)

    def get_portfolio(self) -> Portfolio:
        """Get portfolio — live from OANDA or local paper trader."""
        if self.mode == "live":
            try:
                return self._get_live().get_portfolio()
            except Exception as e:
                log.error("Live portfolio fetch failed, falling back to paper: %s", e)
        return self.paper.get_portfolio()

    def get_order_history(self) -> list[Order]:
        return self.paper.get_order_history()

    def get_summary(self) -> str:
        """Get summary — live from OANDA or local paper trader."""
        if self.mode == "live":
            try:
                return self._get_live().get_summary()
            except Exception as e:
                log.error("Live summary failed, falling back to paper: %s", e)
        return self.paper.get_summary()
