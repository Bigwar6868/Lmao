"""OANDA v20 REST API data fetcher.

Fetches historical OHLCV candles and real-time pricing from OANDA's v20 API.
Supports both practice (demo) and live environments.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from typing import Callable

import requests

from shared.types import Candle
from config.settings import config

log = logging.getLogger(__name__)

# OANDA v20 base URLs
PRACTICE_URL = "https://api-fxpractice.oanda.com"
LIVE_URL = "https://api-fxtrade.oanda.com"

# Map system timeframes to OANDA granularity
TIMEFRAME_TO_GRANULARITY: dict[str, str] = {
    "1m": "M1",
    "5m": "M5",
    "15m": "M15",
    "1h": "H1",
    "4h": "H4",
    "1d": "D",
    "1w": "W",
}


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

        log.info("OandaDataFetcher initialised (live=%s)", self.is_live)

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
        }

        if from_timestamp and to_timestamp:
            # OANDA expects seconds as UNIX timestamp strings
            params["from"] = str(from_timestamp / 1000)
            params["to"] = str(to_timestamp / 1000)
        else:
            params["count"] = min(count, 5000)

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
        """Get account summary (balance, equity, margin)."""
        try:
            resp = self._session.get(
                f"{self.base_url}/v3/accounts/{self.account_id}/summary",
                timeout=config.network_timeout_s,
            )
            resp.raise_for_status()
            data = resp.json()
            acct = data.get("account", {})
            return {
                "balance": float(acct.get("balance", 0)),
                "unrealized_pl": float(acct.get("unrealizedPL", 0)),
                "realized_pl": float(acct.get("realizedPL", 0)),
                "margin_used": float(acct.get("marginUsed", 0)),
                "margin_available": float(acct.get("marginAvailable", 0)),
                "open_trade_count": int(acct.get("openTradeCount", 0)),
                "currency": acct.get("currency", "USD"),
            }
        except Exception as e:
            log.error("OANDA account summary failed: %s", e)
            return {}
