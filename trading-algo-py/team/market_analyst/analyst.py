"""Market Analyst — coordinates data fetching from IC Markets + fallbacks.

Provides file-based caching and emits events when new data arrives.
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path

from shared.types import AssetInfo, Candle, MarketData
from shared.events import event_bus
from shared.synthetic import generate_synthetic_candles
from config.settings import config

log = logging.getLogger(__name__)


class MarketAnalyst:
    """Fetches and caches market data from brokers or synthetic fallback.

    Data source priority:
    1. OANDA v20 REST API (if credentials configured)
    2. IC Markets cTrader Open API (if credentials configured)
    3. Synthetic data (fallback)
    """

    def __init__(self) -> None:
        self.cache_dir = Path(config.data_dir) / "historical"
        self.cache_dir.mkdir(parents=True, exist_ok=True)

        # Lazy-init OANDA fetcher
        self._oanda = None
        if config.has_oanda_credentials and not config.cloud_mode:
            try:
                from team.market_analyst.oanda import OandaDataFetcher
                self._oanda = OandaDataFetcher()
                log.info("OANDA data fetcher ready")
            except Exception as e:
                log.warning("OANDA init failed: %s", e)

        # Lazy-init IC Markets fetcher
        self._icm = None
        if config.has_ctrader_credentials and not config.cloud_mode:
            try:
                from team.market_analyst.icmarkets import ICMarketsDataFetcher
                self._icm = ICMarketsDataFetcher()
                if not self._icm.connect():
                    log.warning("IC Markets connection failed — using synthetic data")
                    self._icm = None
            except Exception as e:
                log.warning("IC Markets init failed: %s — using synthetic data", e)

        log.info("MarketAnalyst initialised (oanda=%s, icmarkets=%s)", self._oanda is not None, self._icm is not None)

    # ------------------------------------------------------------------
    # Cache
    # ------------------------------------------------------------------

    def _cache_path(self, asset: AssetInfo, timeframe: str) -> Path:
        safe = asset.symbol.replace("/", "_").replace(" ", "_")
        return self.cache_dir / f"{asset.asset_class.value}_{safe}_{timeframe}.json"

    def _read_cache(self, asset: AssetInfo, timeframe: str) -> MarketData | None:
        if not config.cache_enabled:
            return None

        path = self._cache_path(asset, timeframe)
        if not path.exists():
            return None

        try:
            raw = json.loads(path.read_text())
            candles = [Candle(**c) for c in raw["candles"]]
            cached = MarketData(
                asset=asset,
                timeframe=raw["timeframe"],
                candles=candles,
                last_updated=raw["last_updated"],
            )

            age = time.time() * 1000 - cached.last_updated
            if age > config.cache_ttl_ms:
                if config.cloud_mode:
                    log.info("Cloud mode — using stale cache for %s", asset.symbol)
                    return cached
                return None

            log.info("Cache hit for %s %s", asset.symbol, timeframe)
            return cached
        except Exception:
            return None

    def _write_cache(self, data: MarketData) -> None:
        if not config.cache_enabled:
            return

        path = self._cache_path(data.asset, data.timeframe)
        try:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            payload = {
                "timeframe": data.timeframe,
                "last_updated": data.last_updated,
                "candles": [
                    {"timestamp": c.timestamp, "open": c.open, "high": c.high,
                     "low": c.low, "close": c.close, "volume": c.volume}
                    for c in data.candles
                ],
            }
            path.write_text(json.dumps(payload, indent=2))
        except Exception as e:
            log.warning("Failed to write cache: %s", e)

    # ------------------------------------------------------------------
    # Fetching
    # ------------------------------------------------------------------

    def _fetch_from_oanda(self, asset: AssetInfo, timeframe: str) -> list[Candle]:
        """Fetch candles from OANDA v20 REST API."""
        if self._oanda is None:
            return []
        try:
            return self._oanda.fetch_candles(asset.symbol, timeframe)
        except Exception as e:
            log.warning("OANDA fetch failed for %s: %s", asset.symbol, e)
            return []

    def _fetch_from_icmarkets(self, asset: AssetInfo, timeframe: str) -> list[Candle]:
        """Fetch candles from IC Markets via cTrader Open API."""
        if self._icm is None:
            return []
        try:
            return self._icm.fetch_candles(asset.symbol, timeframe)
        except Exception as e:
            log.warning("IC Markets fetch failed for %s: %s", asset.symbol, e)
            return []

    def _fetch_synthetic(self, asset: AssetInfo, timeframe: str) -> list[Candle]:
        """Generate synthetic candles as fallback."""
        interval_map = {
            "1m": 60_000, "5m": 300_000, "15m": 900_000,
            "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000, "1w": 604_800_000,
        }
        interval = interval_map.get(timeframe, 3_600_000)
        vol = 0.005 if asset.asset_class.value == "forex" else 0.02
        return generate_synthetic_candles(asset.symbol, 100, interval_ms=interval, volatility=vol)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def fetch_market_data(self, asset: AssetInfo, timeframe: str) -> MarketData:
        """Fetch market data for a single asset, using cache when available."""
        cached = self._read_cache(asset, timeframe)
        if cached:
            return cached

        log.info("Fetching %s %s (%s)", asset.symbol, timeframe, asset.asset_class.value)

        # Try OANDA first, then IC Markets, fall back to synthetic
        candles = self._fetch_from_oanda(asset, timeframe)
        if not candles:
            candles = self._fetch_from_icmarkets(asset, timeframe)
        if not candles:
            log.info("Using synthetic data for %s", asset.symbol)
            candles = self._fetch_synthetic(asset, timeframe)

        data = MarketData(
            asset=asset,
            timeframe=timeframe,
            candles=candles,
            last_updated=int(time.time() * 1000),
        )

        self._write_cache(data)
        event_bus.emit("market:data", data, "MarketAnalyst")

        log.info("Market data ready: %s %s (%d candles)", asset.symbol, timeframe, len(candles))
        return data

    def fetch_all(self, assets: list[AssetInfo], timeframe: str) -> list[MarketData]:
        """Fetch market data for multiple assets sequentially."""
        results: list[MarketData] = []
        for asset in assets:
            try:
                data = self.fetch_market_data(asset, timeframe)
                results.append(data)
            except Exception as e:
                log.error("Failed to fetch %s: %s", asset.symbol, e)
        return results

    def fetch_live_prices(self, symbols: list[str]) -> dict[str, dict]:
        """Fetch real-time prices directly from OANDA, bypassing cache.

        Returns dict of {symbol: {"bid": float, "ask": float, "mid": float}}.
        Falls back to empty dict if OANDA unavailable.
        """
        if self._oanda is None:
            log.warning("No OANDA fetcher — cannot get live prices")
            return {}
        try:
            prices = self._oanda.get_prices(symbols)
            # Add mid price for convenience
            for sym, data in prices.items():
                data["mid"] = (data["bid"] + data["ask"]) / 2 if data["bid"] and data["ask"] else 0
            return prices
        except Exception as e:
            log.error("Live price fetch failed: %s", e)
            return {}
