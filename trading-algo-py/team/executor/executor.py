"""Trade executor — routes orders to paper, OANDA, or IC Markets engine."""

from __future__ import annotations

import logging

from shared.types import Signal, RiskAssessment, Order, Portfolio, AssetClass
from team.executor.paper import PaperTrader
from team.risk_manager.journal import TradeJournal, ExecutionQualityMonitor
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

        # Trade journal and execution quality monitoring
        self.journal = TradeJournal()
        self.quality_monitor = ExecutionQualityMonitor()

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
        """Execute a trade via the configured engine.

        Routing:
        - OANDA: only forex pairs (OANDA doesn't support crypto)
        - Crypto: always paper trade (no live crypto exchange connected)
        - Falls back to paper if live execution fails
        """
        result = None

        if self.mode == "live":
            # OANDA only supports forex — route crypto to paper
            is_forex = signal.asset.asset_class == AssetClass.FOREX
            broker = getattr(config, "trading_broker", "auto")
            is_oanda = broker == "oanda" or (broker == "auto" and getattr(config, "has_oanda_credentials", False))

            if is_oanda and not is_forex:
                log.debug("Crypto %s → paper (OANDA forex only)", signal.asset.symbol)
                result = self.paper.execute_trade(signal, risk)
            else:
                try:
                    executor = self._get_live()
                    order = executor.execute_order(signal, risk)
                    result = {"success": True, "order": order, "broker": "live"}
                except Exception as e:
                    log.warning("Live execution failed (%s), falling back to paper: %s",
                                signal.asset.symbol, e)
                    result = self.paper.execute_trade(signal, risk)
        else:
            result = self.paper.execute_trade(signal, risk)

        # --- Journal & execution quality logging ---
        if result and result.get("success"):
            order = result.get("order")
            position = result.get("position")
            fill_price = getattr(order, "filled_price", signal.price) if order else signal.price

            # Record execution quality (slippage)
            slippage = self.quality_monitor.record_fill(
                requested_price=signal.price,
                filled_price=fill_price,
                symbol=signal.asset.symbol,
            )

            # Log to trade journal
            self.journal.log_entry(
                symbol=signal.asset.symbol,
                side=signal.action.value,
                quantity=getattr(order, "quantity", 0) if order else 0,
                price=fill_price,
                stop_loss=risk.stop_loss_price,
                take_profit=risk.take_profit_price,
                leverage=getattr(position, "leverage", 1) if position else 1,
                margin=getattr(position, "margin_required", 0) if position else 0,
                notional=getattr(position, "notional_value", 0) if position else 0,
                strategy=signal.strategy,
                agent=signal.reason.split("agent=")[-1].split(")")[0] if "agent=" in signal.reason else "",
                confidence=signal.confidence,
                slippage_pips=slippage,
                trade_id=getattr(position, "id", "") if position else "",
            )
        elif result and not result.get("success"):
            self.quality_monitor.record_failure()

        return result

    def update_prices(self, prices: dict[str, float]) -> None:
        # In live mode OANDA tracks prices server-side; no local update needed
        if self.mode != "live":
            self.paper.update_prices(prices)

    def check_stops(self, prices: dict[str, float]) -> list:
        # In live mode OANDA handles SL/TP server-side via stopLossOnFill/takeProfitOnFill
        if self.mode == "live":
            return []
        closed = self.paper.check_stops(prices)

        # Log closed positions to journal
        for pos in closed:
            entry_value = pos.entry_price * pos.quantity
            pnl_pct = (pos.realized_pnl / entry_value * 100) if entry_value > 0 else 0
            self.journal.log_exit(
                symbol=pos.asset.symbol,
                side=pos.side.value,
                quantity=pos.quantity,
                price=pos.current_price,
                pnl=pos.realized_pnl,
                pnl_pct=pnl_pct,
                exit_reason="stop_loss" if pos.stop_loss and (
                    (pos.side.value == "BUY" and pos.current_price <= pos.stop_loss) or
                    (pos.side.value == "SELL" and pos.current_price >= pos.stop_loss)
                ) else "take_profit",
                strategy=pos.strategy,
                trade_id=pos.id,
            )

        return closed

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
