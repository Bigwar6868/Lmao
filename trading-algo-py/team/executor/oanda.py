"""OANDA v20 live executor — executes trades via OANDA REST API.

Follows OANDA best practices:
- Persistent HTTP connections via requests.Session
- Rate limit handling with retry on HTTP 429
- timeInForce set on stopLossOnFill / takeProfitOnFill
- Positive units = buy, negative units = sell
"""

from __future__ import annotations

import logging
import time
import uuid

import requests

from shared.types import (
    Signal, SignalAction, RiskAssessment, Order, Position, Portfolio,
    Side, OrderType, OrderStatus, PositionStatus,
    AssetInfo, AssetClass,
)
from shared.events import event_bus
from config.settings import config

log = logging.getLogger(__name__)

PRACTICE_URL = "https://api-fxpractice.oanda.com"
LIVE_URL = "https://api-fxtrade.oanda.com"

# Retry config for rate-limited requests (HTTP 429)
_MAX_RETRIES = 3
_RETRY_BACKOFF = [1, 2, 4]  # seconds

# OANDA price precision per instrument type.
# JPY pairs use 3 decimals, most forex = 5, metals = 2, indices = 1.
_JPY_PAIRS = {
    "USD_JPY", "EUR_JPY", "GBP_JPY", "AUD_JPY", "NZD_JPY",
    "CAD_JPY", "CHF_JPY", "SGD_JPY", "HKD_JPY", "TRY_JPY",
}


def _price_precision(instrument: str) -> int:
    """Return the decimal precision OANDA expects for an instrument's price."""
    if instrument in _JPY_PAIRS:
        return 3
    if instrument.startswith(("XAU", "XAG")):
        return 2
    if instrument.startswith(("XPT", "XPD")):
        return 1
    # Default forex precision
    return 5


def _format_price(price: float, instrument: str) -> str:
    """Format a price string with the correct precision for OANDA."""
    prec = _price_precision(instrument)
    return f"{price:.{prec}f}"


class OandaExecutor:
    """Executes real trades via OANDA v20 REST API."""

    def __init__(
        self,
        api_token: str | None = None,
        account_id: str | None = None,
        is_live: bool = False,
    ) -> None:
        self.api_token = api_token or config.oanda_api_token
        self.account_id = account_id or config.oanda_account_id
        self.is_live = is_live or config.oanda_is_live
        self.base_url = LIVE_URL if self.is_live else PRACTICE_URL
        self._session = requests.Session()
        self._session.headers.update({
            "Authorization": f"Bearer {self.api_token}",
            "Content-Type": "application/json",
            "Accept-Datetime-Format": "UNIX",
        })

        log.info("OandaExecutor initialised (live=%s)", self.is_live)

    def _request_with_retry(self, method: str, url: str, **kwargs) -> requests.Response:
        """Make an HTTP request with retry on 429 (rate limited)."""
        for attempt in range(_MAX_RETRIES + 1):
            resp = getattr(self._session, method)(url, **kwargs)
            if resp.status_code != 429:
                return resp
            if attempt < _MAX_RETRIES:
                wait = _RETRY_BACKOFF[attempt]
                log.warning("OANDA rate limited (429), retrying in %ds...", wait)
                time.sleep(wait)
        return resp  # Return last response even if still 429

    def _to_instrument(self, symbol: str) -> str:
        return symbol.replace("/", "_")

    # ------------------------------------------------------------------
    # Order Execution
    # ------------------------------------------------------------------

    def execute_order(self, signal: Signal, risk: RiskAssessment) -> Order:
        """Place an order via OANDA v20 REST API.

        OANDA uses positive units for buy, negative for sell.
        """
        instrument = self._to_instrument(signal.asset.symbol)

        # Calculate units (OANDA uses integer units, not lots)
        quantity = risk.recommended_size / signal.price if signal.price > 0 else 0
        # For forex, units = base currency amount (e.g., 10000 = 0.1 lot)
        units = int(quantity * 100_000)  # Convert to standard forex units
        if signal.action == SignalAction.SELL:
            units = -units

        order_body: dict = {
            "order": {
                "type": "MARKET",
                "instrument": instrument,
                "units": str(units),
                "timeInForce": "FOK",
                "positionFill": "DEFAULT",
            }
        }

        # Add stop loss (timeInForce required per OANDA docs)
        if risk.stop_loss_price > 0:
            order_body["order"]["stopLossOnFill"] = {
                "price": _format_price(risk.stop_loss_price, instrument),
                "timeInForce": "GTC",
            }

        # Add take profit (timeInForce required per OANDA docs)
        if risk.take_profit_price > 0:
            order_body["order"]["takeProfitOnFill"] = {
                "price": _format_price(risk.take_profit_price, instrument),
                "timeInForce": "GTC",
            }

        # Add client extensions for tracking
        order_body["order"]["clientExtensions"] = {
            "comment": f"algo:{signal.strategy}",
            "tag": signal.strategy,
        }

        try:
            resp = self._request_with_retry(
                "post",
                f"{self.base_url}/v3/accounts/{self.account_id}/orders",
                json=order_body,
                timeout=15,
            )
            resp.raise_for_status()
            data = resp.json()

            # Parse response
            fill_tx = data.get("orderFillTransaction", {})
            create_tx = data.get("orderCreateTransaction", {})

            side = Side.BUY if signal.action == SignalAction.BUY else Side.SELL
            filled_price = float(fill_tx.get("price", signal.price))
            trade_opened = fill_tx.get("tradeOpened", {})
            trade_id = trade_opened.get("tradeID", "")

            # Verify SL/TP were attached — OANDA can fill the order but
            # silently reject dependent orders if price precision is wrong.
            has_sl = bool(fill_tx.get("stopLossOnFill") or
                          data.get("relatedTransactionIDs"))
            has_tp = bool(fill_tx.get("takeProfitOnFill") or
                          data.get("relatedTransactionIDs"))

            # If SL/TP were requested but not confirmed, attach them now
            if trade_id:
                sl_ok = not (risk.stop_loss_price > 0)  # not needed = ok
                tp_ok = not (risk.take_profit_price > 0)

                # Check if SL/TP orders exist on the trade
                if risk.stop_loss_price > 0 or risk.take_profit_price > 0:
                    sl_price = risk.stop_loss_price if risk.stop_loss_price > 0 else None
                    tp_price = risk.take_profit_price if risk.take_profit_price > 0 else None
                    # Always try to set SL/TP on the trade as a safety net
                    self._ensure_sl_tp(trade_id, instrument, sl_price, tp_price)

            order = Order(
                id=str(uuid.uuid4())[:8],
                asset=signal.asset,
                side=side,
                type=OrderType.MARKET,
                quantity=abs(units) / 100_000,  # Back to lots-ish
                strategy=signal.strategy,
                price=signal.price,
                status=OrderStatus.FILLED,
                filled_price=filled_price,
                filled_quantity=abs(units) / 100_000,
                created_at=int(time.time() * 1000),
                filled_at=int(time.time() * 1000),
                broker_order_id=str(fill_tx.get("orderID", create_tx.get("id", ""))),
            )

            log.info(
                "OANDA %s %s %d units @ %.5f (trade=%s, SL=%s, TP=%s)",
                signal.action.value, signal.asset.symbol, abs(units),
                filled_price, trade_id,
                _format_price(risk.stop_loss_price, instrument) if risk.stop_loss_price > 0 else "none",
                _format_price(risk.take_profit_price, instrument) if risk.take_profit_price > 0 else "none",
            )
            event_bus.emit("order:filled", order, "OandaExecutor")
            return order

        except requests.exceptions.HTTPError as e:
            error_body = ""
            try:
                error_body = e.response.json().get("errorMessage", str(e))
            except Exception:
                error_body = str(e)
            raise RuntimeError(f"OANDA order failed: {error_body}") from e
        except Exception as e:
            raise RuntimeError(f"OANDA order failed: {e}") from e

    def _ensure_sl_tp(
        self,
        trade_id: str,
        instrument: str,
        stop_loss: float | None,
        take_profit: float | None,
    ) -> None:
        """Verify SL/TP exist on a trade; if not, attach them via modify.

        This is a safety net — stopLossOnFill/takeProfitOnFill should work,
        but OANDA can silently reject them (e.g. wrong price precision).
        """
        try:
            # Check current trade state
            resp = self._session.get(
                f"{self.base_url}/v3/accounts/{self.account_id}/trades/{trade_id}",
                timeout=10,
            )
            resp.raise_for_status()
            trade = resp.json().get("trade", {})

            needs_update = False
            body: dict = {}

            if stop_loss and "stopLossOrder" not in trade:
                body["stopLoss"] = {
                    "price": _format_price(stop_loss, instrument),
                    "timeInForce": "GTC",
                }
                needs_update = True
                log.warning("SL missing on trade %s — attaching SL=%s", trade_id,
                            _format_price(stop_loss, instrument))

            if take_profit and "takeProfitOrder" not in trade:
                body["takeProfit"] = {
                    "price": _format_price(take_profit, instrument),
                    "timeInForce": "GTC",
                }
                needs_update = True
                log.warning("TP missing on trade %s — attaching TP=%s", trade_id,
                            _format_price(take_profit, instrument))

            if needs_update:
                mod_resp = self._session.put(
                    f"{self.base_url}/v3/accounts/{self.account_id}/trades/{trade_id}/orders",
                    json=body,
                    timeout=10,
                )
                mod_resp.raise_for_status()
                log.info("SL/TP attached to trade %s", trade_id)
            else:
                log.info("SL/TP confirmed on trade %s", trade_id)

        except Exception as e:
            log.error("Failed to verify/attach SL/TP on trade %s: %s", trade_id, e)

    # ------------------------------------------------------------------
    # Order Management
    # ------------------------------------------------------------------

    def cancel_order(self, order_id: str) -> bool:
        """Cancel a pending order."""
        try:
            resp = self._session.put(
                f"{self.base_url}/v3/accounts/{self.account_id}/orders/{order_id}/cancel",
                timeout=10,
            )
            resp.raise_for_status()
            log.info("OANDA order %s cancelled", order_id)
            return True
        except Exception as e:
            log.error("OANDA cancel failed for %s: %s", order_id, e)
            return False

    def close_trade(self, trade_id: str, units: str = "ALL") -> bool:
        """Close an open trade (full or partial).

        Args:
            trade_id: OANDA trade ID
            units: Number of units to close, or "ALL"
        """
        try:
            resp = self._session.put(
                f"{self.base_url}/v3/accounts/{self.account_id}/trades/{trade_id}/close",
                json={"units": units},
                timeout=10,
            )
            resp.raise_for_status()
            log.info("OANDA trade %s closed (%s units)", trade_id, units)
            return True
        except Exception as e:
            log.error("OANDA close trade failed for %s: %s", trade_id, e)
            return False

    def close_position(self, instrument: str, side: str = "long") -> bool:
        """Close all trades for an instrument on one side.

        Args:
            instrument: e.g., "EUR/USD"
            side: "long" or "short"
        """
        oanda_inst = self._to_instrument(instrument)
        body = {}
        if side == "long":
            body["longUnits"] = "ALL"
        else:
            body["shortUnits"] = "ALL"

        try:
            resp = self._session.put(
                f"{self.base_url}/v3/accounts/{self.account_id}/positions/{oanda_inst}/close",
                json=body,
                timeout=10,
            )
            resp.raise_for_status()
            log.info("OANDA %s position closed for %s", side, instrument)
            return True
        except Exception as e:
            log.error("OANDA close position failed for %s: %s", instrument, e)
            return False

    # ------------------------------------------------------------------
    # Trade / Position Queries
    # ------------------------------------------------------------------

    def get_open_trades(self) -> list[dict]:
        """Get all open trades."""
        try:
            resp = self._session.get(
                f"{self.base_url}/v3/accounts/{self.account_id}/openTrades",
                timeout=10,
            )
            resp.raise_for_status()
            data = resp.json()
            trades = []
            for t in data.get("trades", []):
                trades.append({
                    "trade_id": t["id"],
                    "instrument": t["instrument"].replace("_", "/"),
                    "units": int(t["currentUnits"]),
                    "side": "buy" if int(t["currentUnits"]) > 0 else "sell",
                    "entry_price": float(t["price"]),
                    "unrealized_pl": float(t.get("unrealizedPL", 0)),
                    "realized_pl": float(t.get("realizedPL", 0)),
                    "open_time": t.get("openTime", ""),
                    "stop_loss": float(t["stopLossOrder"]["price"]) if "stopLossOrder" in t else None,
                    "take_profit": float(t["takeProfitOrder"]["price"]) if "takeProfitOrder" in t else None,
                })
            return trades
        except Exception as e:
            log.error("OANDA get trades failed: %s", e)
            return []

    def get_open_positions(self) -> list[dict]:
        """Get aggregated open positions by instrument."""
        try:
            resp = self._session.get(
                f"{self.base_url}/v3/accounts/{self.account_id}/openPositions",
                timeout=10,
            )
            resp.raise_for_status()
            data = resp.json()
            positions = []
            for p in data.get("positions", []):
                long_units = int(p.get("long", {}).get("units", 0))
                short_units = int(p.get("short", {}).get("units", 0))
                positions.append({
                    "instrument": p["instrument"].replace("_", "/"),
                    "long_units": long_units,
                    "short_units": short_units,
                    "net_units": long_units + short_units,
                    "long_unrealized_pl": float(p.get("long", {}).get("unrealizedPL", 0)),
                    "short_unrealized_pl": float(p.get("short", {}).get("unrealizedPL", 0)),
                    "margin_used": float(p.get("marginUsed", 0)),
                })
            return positions
        except Exception as e:
            log.error("OANDA get positions failed: %s", e)
            return []

    def modify_trade_sl_tp(
        self, trade_id: str,
        stop_loss: float | None = None,
        take_profit: float | None = None,
        instrument: str | None = None,
    ) -> bool:
        """Modify stop loss and take profit for an open trade."""
        # Determine instrument for price precision
        inst = instrument.replace("/", "_") if instrument else ""
        body: dict = {}
        if stop_loss is not None:
            body["stopLoss"] = {"price": _format_price(stop_loss, inst)}
        if take_profit is not None:
            body["takeProfit"] = {"price": _format_price(take_profit, inst)}

        if not body:
            return True

        try:
            resp = self._session.put(
                f"{self.base_url}/v3/accounts/{self.account_id}/trades/{trade_id}/orders",
                json=body,
                timeout=10,
            )
            resp.raise_for_status()
            log.info("OANDA trade %s SL/TP updated", trade_id)
            return True
        except Exception as e:
            log.error("OANDA modify trade failed for %s: %s", trade_id, e)
            return False

    def get_account_balance(self) -> dict:
        """Get account balance and equity."""
        try:
            resp = self._session.get(
                f"{self.base_url}/v3/accounts/{self.account_id}/summary",
                timeout=10,
            )
            resp.raise_for_status()
            acct = resp.json().get("account", {})
            return {
                "balance": float(acct.get("balance", 0)),
                "unrealized_pl": float(acct.get("unrealizedPL", 0)),
                "realized_pl": float(acct.get("realizedPL", 0)),
                "nav": float(acct.get("NAV", 0)),
                "margin_used": float(acct.get("marginUsed", 0)),
                "margin_available": float(acct.get("marginAvailable", 0)),
                "open_trade_count": int(acct.get("openTradeCount", 0)),
                "currency": acct.get("currency", "USD"),
            }
        except Exception as e:
            log.error("OANDA account balance failed: %s", e)
            return {}

    # ------------------------------------------------------------------
    # Portfolio (live from OANDA)
    # ------------------------------------------------------------------

    def get_portfolio(self) -> Portfolio:
        """Build a Portfolio from live OANDA account data.

        Fetches account summary + open trades directly from OANDA
        so P&L reflects real-time values, not cached data.
        """
        acct = self.get_account_balance()
        if not acct:
            raise RuntimeError("OANDA account balance unavailable")

        trades = self.get_open_trades()
        positions: list[Position] = []
        for t in trades:
            side = Side.BUY if t["side"] == "buy" else Side.SELL
            # Build a minimal AssetInfo for the position
            asset = AssetInfo(
                symbol=t["instrument"],
                asset_class=AssetClass.FOREX,
            )
            positions.append(Position(
                id=t["trade_id"],
                asset=asset,
                side=side,
                entry_price=t["entry_price"],
                current_price=t["entry_price"],  # OANDA gives P&L directly
                quantity=abs(t["units"]) / 100_000,
                strategy="-",
                stop_loss=t.get("stop_loss"),
                take_profit=t.get("take_profit"),
                unrealized_pnl=t["unrealized_pl"],
                realized_pnl=t["realized_pl"],
                broker_position_id=t["trade_id"],
            ))

        nav = acct.get("nav", acct.get("balance", 0))
        unrealized = acct.get("unrealized_pl", 0)
        realized = acct.get("realized_pl", 0)
        balance = acct.get("balance", 0)

        return Portfolio(
            capital=nav,
            available_capital=acct.get("margin_available", 0),
            positions=positions,
            total_pnl=unrealized + realized,
            total_pnl_pct=((nav - balance + realized) / balance * 100) if balance else 0,
            max_drawdown=0,  # OANDA doesn't track this server-side
            last_updated=int(time.time() * 1000),
        )

    def get_summary(self) -> str:
        """One-line summary from live OANDA account data."""
        acct = self.get_account_balance()
        if not acct:
            return "OANDA: unavailable"

        nav = acct.get("nav", acct.get("balance", 0))
        unrealized = acct.get("unrealized_pl", 0)
        realized = acct.get("realized_pl", 0)
        currency = acct.get("currency", "GBP")
        open_count = acct.get("open_trade_count", 0)

        return (
            f"OANDA: {currency} {nav:.2f} NAV | "
            f"Unrealised: {currency} {unrealized:.2f} | "
            f"Realised: {currency} {realized:.2f} | "
            f"Open: {open_count} | "
            f"Margin: {currency} {acct.get('margin_used', 0):.2f}"
        )
