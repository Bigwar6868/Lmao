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
    Signal, SignalAction, RiskAssessment, Order, Position,
    Side, OrderType, OrderStatus, PositionStatus,
)
from shared.events import event_bus
from config.settings import config

log = logging.getLogger(__name__)

PRACTICE_URL = "https://api-fxpractice.oanda.com"
LIVE_URL = "https://api-fxtrade.oanda.com"

# Retry config for rate-limited requests (HTTP 429)
_MAX_RETRIES = 3
_RETRY_BACKOFF = [1, 2, 4]  # seconds


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
                "price": f"{risk.stop_loss_price:.5f}",
                "timeInForce": "GTC",
            }

        # Add take profit (timeInForce required per OANDA docs)
        if risk.take_profit_price > 0:
            order_body["order"]["takeProfitOnFill"] = {
                "price": f"{risk.take_profit_price:.5f}",
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
                "OANDA %s %s %d units @ %.5f (trade=%s)",
                signal.action.value, signal.asset.symbol, abs(units),
                filled_price, trade_opened.get("tradeID", ""),
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
    ) -> bool:
        """Modify stop loss and take profit for an open trade."""
        body: dict = {}
        if stop_loss is not None:
            body["stopLoss"] = {"price": f"{stop_loss:.5f}"}
        if take_profit is not None:
            body["takeProfit"] = {"price": f"{take_profit:.5f}"}

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
                "margin_used": float(acct.get("marginUsed", 0)),
                "margin_available": float(acct.get("marginAvailable", 0)),
                "currency": acct.get("currency", "USD"),
            }
        except Exception as e:
            log.error("OANDA account balance failed: %s", e)
            return {}
