"""OANDA v20 REST API data fetcher.

Fetches historical OHLCV candles and real-time pricing from OANDA's v20 API.
Supports both practice (demo) and live environments.

Best practices per https://developer.oanda.com/rest-live-v20/best-practices/:
- Uses persistent HTTP connections via requests.Session (Keep-Alive by default in HTTP/1.1)
- Respects rate limits: 120 req/s REST, max 2 new connections/s
- Uses TransactionID-based account polling for state updates
- count is NOT set when both from/to timestamps are specified
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Callable

import requests

from shared.types import Candle
from config.settings import config

log = logging.getLogger(__name__)

# OANDA v20 base URLs
PRACTICE_URL = "https://api-fxpractice.oanda.com"
LIVE_URL = "https://api-fxtrade.oanda.com"

# Map system timeframes to OANDA granularity
# Full list: S5, S10, S15, S30, M1, M2, M4, M5, M10, M15, M30, H1, H2, H3, H4, H6, H8, D, W, M
TIMEFRAME_TO_GRANULARITY: dict[str, str] = {
    "1m": "M1",
    "5m": "M5",
    "15m": "M15",
    "30m": "M30",
    "1h": "H1",
    "2h": "H2",
    "4h": "H4",
    "1d": "D",
    "1w": "W",
}

# Max 100 requests per second on persistent connections (best practices)
_RATE_LIMIT_INTERVAL = 1.0 / 100


class OandaDataFetcher:
    """Fetches market data from OANDA v20 REST API."""

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
        self._instruments_cache: dict[str, str] = {}  # EUR/USD -> EUR_USD
        self._last_request_time = 0.0
        self._rate_lock = threading.Lock()
        self._last_transaction_id: str | None = None  # For account state polling

        log.info("OandaDataFetcher initialised (live=%s)", self.is_live)

    def _throttle(self) -> None:
        """Rate-limit requests to stay within OANDA's 100 req/s on persistent connections."""
        with self._rate_lock:
            now = time.monotonic()
            elapsed = now - self._last_request_time
            if elapsed < _RATE_LIMIT_INTERVAL:
                time.sleep(_RATE_LIMIT_INTERVAL - elapsed)
            self._last_request_time = time.monotonic()

    # ------------------------------------------------------------------
    # Symbol Resolution
    # ------------------------------------------------------------------

    def _to_oanda_instrument(self, symbol: str) -> str:
        """Convert symbol format to OANDA format: EUR/USD -> EUR_USD."""
        return symbol.replace("/", "_")

    def _from_oanda_instrument(self, instrument: str) -> str:
        """Convert OANDA format back: EUR_USD -> EUR/USD."""
        return instrument.replace("_", "/")

    def get_instruments(self) -> list[dict]:
        """Get list of tradeable instruments from OANDA."""
        self._throttle()
        try:
            resp = self._session.get(
                f"{self.base_url}/v3/accounts/{self.account_id}/instruments",
                timeout=config.network_timeout_s,
            )
            resp.raise_for_status()
            data = resp.json()
            instruments = data.get("instruments", [])
            # Cache for lookup
            for inst in instruments:
                name = inst["name"]
                display = inst.get("displayName", name)
                self._instruments_cache[self._from_oanda_instrument(name)] = name
            log.info("Loaded %d OANDA instruments", len(instruments))
            return instruments
        except Exception as e:
            log.error("Failed to fetch OANDA instruments: %s", e)
            return []

    # ------------------------------------------------------------------
    # Historical Data
    # ------------------------------------------------------------------

    def fetch_candles(
        self,
        symbol: str,
        timeframe: str = "1h",
        count: int = 300,
        from_timestamp: int | None = None,
        to_timestamp: int | None = None,
    ) -> list[Candle]:
        """Fetch historical OHLCV candles from OANDA.

        Args:
            symbol: Instrument name, e.g., "EUR/USD"
            timeframe: One of 1m, 5m, 15m, 1h, 4h, 1d, 1w
            count: Number of candles (max 5000)
            from_timestamp: Start time in ms
            to_timestamp: End time in ms

        Returns:
            List of Candle objects sorted by timestamp ascending.
        """
        instrument = self._to_oanda_instrument(symbol)
        granularity = TIMEFRAME_TO_GRANULARITY.get(timeframe, "H1")

        params: dict = {
            "granularity": granularity,
            "price": "M",  # Midpoint
            "dailyAlignment": 17,  # 5pm New York (OANDA default)
            "alignmentTimezone": "America/New_York",
        }

        if from_timestamp and to_timestamp:
            # Per OANDA docs: count must NOT be set when both from/to are specified
            params["from"] = str(from_timestamp / 1000)
            params["to"] = str(to_timestamp / 1000)
        elif from_timestamp:
            params["from"] = str(from_timestamp / 1000)
            params["count"] = min(count, 5000)
        else:
            params["count"] = min(count, 5000)

        self._throttle()
        try:
            resp = self._session.get(
                f"{self.base_url}/v3/instruments/{instrument}/candles",
                params=params,
                timeout=config.network_timeout_s,
            )
            resp.raise_for_status()
            data = resp.json()

            candles: list[Candle] = []
            for bar in data.get("candles", []):
                if not bar.get("complete", True):
                    continue  # Skip incomplete candles

                mid = bar.get("mid", {})
                ts = bar.get("time", "0")

                candles.append(Candle(
                    timestamp=int(float(ts) * 1000),  # UNIX seconds -> ms
                    open=float(mid.get("o", 0)),
                    high=float(mid.get("h", 0)),
                    low=float(mid.get("l", 0)),
                    close=float(mid.get("c", 0)),
                    volume=int(bar.get("volume", 0)),
                ))

            candles.sort(key=lambda c: c.timestamp)
            log.info("Fetched %d candles for %s (%s) from OANDA", len(candles), symbol, timeframe)
            return candles

        except requests.exceptions.HTTPError as e:
            log.error("OANDA candles HTTP error for %s: %s", symbol, e)
            return []
        except Exception as e:
            log.error("OANDA candles failed for %s: %s", symbol, e)
            return []

    # ------------------------------------------------------------------
    # Real-time Pricing
    # ------------------------------------------------------------------

    def get_prices(self, symbols: list[str]) -> dict[str, dict]:
        """Get current bid/ask prices for instruments.

        Args:
            symbols: List of symbols, e.g., ["EUR/USD", "GBP/USD"]

        Returns:
            Dict of {symbol: {"bid": float, "ask": float, "time": int}}
        """
        instruments = ",".join(self._to_oanda_instrument(s) for s in symbols)

        self._throttle()
        try:
            resp = self._session.get(
                f"{self.base_url}/v3/accounts/{self.account_id}/pricing",
                params={"instruments": instruments},
                timeout=config.network_timeout_s,
            )
            resp.raise_for_status()
            data = resp.json()

            prices: dict[str, dict] = {}
            for price in data.get("prices", []):
                sym = self._from_oanda_instrument(price["instrument"])
                prices[sym] = {
                    "bid": float(price.get("bids", [{}])[0].get("price", 0)) if price.get("bids") else 0,
                    "ask": float(price.get("asks", [{}])[0].get("price", 0)) if price.get("asks") else 0,
                    "time": int(float(price.get("time", 0)) * 1000),
                    "tradeable": price.get("tradeable", False),
                }

            return prices

        except Exception as e:
            log.error("OANDA pricing failed: %s", e)
            return {}

    def get_account_summary(self) -> dict:
        """Get account summary (balance, equity, margin).

        Per OANDA best practices, this captures the lastTransactionID
        for subsequent poll_account_updates() calls.
        """
        self._throttle()
        try:
            resp = self._session.get(
                f"{self.base_url}/v3/accounts/{self.account_id}/summary",
                timeout=config.network_timeout_s,
            )
            resp.raise_for_status()
            data = resp.json()
            acct = data.get("account", {})

            # Store TransactionID for polling (per OANDA best practices)
            self._last_transaction_id = data.get("lastTransactionID")

            return {
                "balance": float(acct.get("balance", 0)),
                "unrealized_pl": float(acct.get("unrealizedPL", 0)),
                "realized_pl": float(acct.get("realizedPL", 0)),
                "margin_used": float(acct.get("marginUsed", 0)),
                "margin_available": float(acct.get("marginAvailable", 0)),
                "open_trade_count": int(acct.get("openTradeCount", 0)),
                "currency": acct.get("currency", "USD"),
                "last_transaction_id": self._last_transaction_id,
            }
        except Exception as e:
            log.error("OANDA account summary failed: %s", e)
            return {}

    def poll_account_updates(self) -> dict | None:
        """Poll for account changes since last TransactionID.

        Per OANDA best practices: use an initial get_account_summary() to
        snapshot state, then repeatedly call this to get incremental updates.
        Returns None if no TransactionID is stored yet.
        """
        if not self._last_transaction_id:
            return None

        self._throttle()
        try:
            resp = self._session.get(
                f"{self.base_url}/v3/accounts/{self.account_id}/changes",
                params={"sinceTransactionID": self._last_transaction_id},
                timeout=config.network_timeout_s,
            )
            resp.raise_for_status()
            data = resp.json()

            # Update stored TransactionID
            self._last_transaction_id = data.get("lastTransactionID", self._last_transaction_id)

            changes = data.get("changes", {})
            state = data.get("state", {})

            return {
                "changes": {
                    "orders_created": changes.get("ordersCreated", []),
                    "orders_cancelled": changes.get("ordersCancelled", []),
                    "orders_filled": changes.get("ordersFilled", []),
                    "trades_opened": changes.get("tradesOpened", []),
                    "trades_closed": changes.get("tradesClosed", []),
                    "trades_reduced": changes.get("tradesReduced", []),
                    "positions": changes.get("positions", []),
                },
                "state": {
                    "unrealized_pl": float(state.get("unrealizedPL", 0)),
                    "nav": float(state.get("NAV", 0)),
                    "margin_used": float(state.get("marginUsed", 0)),
                    "margin_available": float(state.get("marginAvailable", 0)),
                    "position_value": float(state.get("positionValue", 0)),
                },
                "last_transaction_id": self._last_transaction_id,
            }
        except Exception as e:
            log.error("OANDA poll updates failed: %s", e)
            return None
