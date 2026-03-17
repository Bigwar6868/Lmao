"""IC Markets data fetcher via cTrader Open API.

Connects to cTrader's Protobuf API to fetch historical OHLCV data
and subscribe to real-time tick data for forex/CFD instruments.
"""

from __future__ import annotations

import logging
import time
import threading
from typing import Callable

from twisted.internet import reactor

from ctrader_open_api import Client, Protobuf, TcpProtocol, EndPoints
from ctrader_open_api.messages.OpenApiMessages_pb2 import (
    ProtoOAApplicationAuthReq,
    ProtoOAAccountAuthReq,
    ProtoOASymbolsListReq,
    ProtoOAGetTrendbarsReq,
    ProtoOASubscribeSpotsReq,
    ProtoOAUnsubscribeSpotsReq,
    ProtoOASubscribeLiveTrendbarReq,
)
from ctrader_open_api.messages.OpenApiModelMessages_pb2 import (
    ProtoOASpotEvent,
    ProtoOATrendbarPeriod,
)

from shared.types import Candle
from config.settings import config

log = logging.getLogger(__name__)

# cTrader trendbar period mapping
TIMEFRAME_TO_PERIOD: dict[str, int] = {
    "1m": 1,   # M1
    "5m": 5,   # M5
    "15m": 7,  # M15
    "1h": 9,   # H1
    "4h": 10,  # H4
    "1d": 12,  # D1
    "1w": 13,  # W1
}


class ICMarketsDataFetcher:
    """Fetches market data from IC Markets via cTrader Open API."""

    def __init__(
        self,
        client_id: str | None = None,
        client_secret: str | None = None,
        access_token: str | None = None,
        account_id: str | None = None,
        is_live: bool = False,
    ) -> None:
        self.client_id = client_id or config.ctrader_client_id
        self.client_secret = client_secret or config.ctrader_client_secret
        self.access_token = access_token or config.ctrader_access_token
        self.account_id = int(account_id or config.ctrader_account_id or "0")
        self.is_live = is_live or config.ctrader_is_live

        self.client: Client | None = None
        self.connected = False
        self.authenticated = False
        self.symbols: dict[str, int] = {}  # symbol_name -> symbol_id
        self._tick_callbacks: list[Callable] = []
        self._ready_event = threading.Event()
        self._reactor_thread: threading.Thread | None = None

        log.info("ICMarketsDataFetcher initialised (live=%s)", self.is_live)

    # ------------------------------------------------------------------
    # Connection
    # ------------------------------------------------------------------

    def connect(self) -> bool:
        """Connect and authenticate with cTrader. Blocks until ready."""
        if not self.client_id or not self.access_token:
            log.warning("Missing cTrader credentials — cannot connect")
            return False

        host = EndPoints.PROTOBUF_LIVE_HOST if self.is_live else EndPoints.PROTOBUF_DEMO_HOST
        port = EndPoints.PROTOBUF_PORT

        self.client = Client(host, port, TcpProtocol)
        self.client.setConnectedCallback(self._on_connected)
        self.client.setDisconnectedCallback(self._on_disconnected)
        self.client.setMessageReceivedCallback(self._on_message)

        # Run reactor in background thread
        self._reactor_thread = threading.Thread(target=self._run_reactor, daemon=True)
        self._reactor_thread.start()

        self.client.startService()

        # Wait for authentication to complete (up to 15s)
        if self._ready_event.wait(timeout=15):
            log.info("cTrader connection ready, %d symbols loaded", len(self.symbols))
            return True
        else:
            log.error("cTrader connection timed out")
            return False

    def disconnect(self) -> None:
        """Disconnect from cTrader."""
        if self.client:
            self.client.stopService()
        self.connected = False
        self.authenticated = False

    def _run_reactor(self) -> None:
        """Run Twisted reactor in a background thread."""
        reactor.run(installSignalHandlers=False)

    def _on_connected(self, client: Client) -> None:
        self.connected = True
        log.info("TCP connected to cTrader")

        # Step 1: App auth
        req = ProtoOAApplicationAuthReq()
        req.clientId = self.client_id
        req.clientSecret = self.client_secret
        d = client.send(req)
        d.addCallback(lambda _: self._auth_account())
        d.addErrback(lambda f: log.error("App auth failed: %s", f))

    def _auth_account(self) -> None:
        """Step 2: Account auth."""
        req = ProtoOAAccountAuthReq()
        req.ctidTraderAccountId = self.account_id
        req.accessToken = self.access_token
        d = self.client.send(req)
        d.addCallback(lambda _: self._load_symbols())
        d.addErrback(lambda f: log.error("Account auth failed: %s", f))

    def _load_symbols(self) -> None:
        """Step 3: Load symbol list."""
        self.authenticated = True
        req = ProtoOASymbolsListReq()
        req.ctidTraderAccountId = self.account_id
        d = self.client.send(req)

        def on_symbols(msg):
            result = Protobuf.extract(msg)
            for sym in result.symbol:
                self.symbols[sym.symbolName] = sym.symbolId
            self._ready_event.set()

        d.addCallback(on_symbols)
        d.addErrback(lambda f: log.error("Symbol load failed: %s", f))

    def _on_disconnected(self, client: Client, reason: str) -> None:
        self.connected = False
        self.authenticated = False
        log.warning("cTrader disconnected: %s", reason)

    def _on_message(self, client: Client, message) -> None:
        """Handle incoming messages (ticks, events)."""
        msg = Protobuf.extract(message)
        if isinstance(msg, ProtoOASpotEvent):
            tick = {
                "symbol_id": msg.symbolId,
                "bid": msg.bid if msg.HasField("bid") else None,
                "ask": msg.ask if msg.HasField("ask") else None,
                "timestamp": msg.timestamp if msg.HasField("timestamp") else int(time.time() * 1000),
            }
            for cb in self._tick_callbacks:
                try:
                    cb(tick)
                except Exception as e:
                    log.error("Tick callback error: %s", e)

    # ------------------------------------------------------------------
    # Symbol Resolution
    # ------------------------------------------------------------------

    def resolve_symbol(self, symbol: str) -> int | None:
        """Convert symbol name to cTrader symbol ID.

        Tries: exact match, no-slash (EURUSD), dotted (EUR.USD).
        """
        if symbol in self.symbols:
            return self.symbols[symbol]

        clean = symbol.replace("/", "").replace("_", "").replace(" ", "")
        if clean in self.symbols:
            return self.symbols[clean]

        dotted = symbol.replace("/", ".")
        if dotted in self.symbols:
            return self.symbols[dotted]

        return None

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
        """Fetch historical OHLCV data from cTrader.

        Args:
            symbol: Instrument name, e.g., "EUR/USD" or "EURUSD"
            timeframe: One of 1m, 5m, 15m, 1h, 4h, 1d, 1w
            count: Number of candles to fetch
            from_timestamp: Start time in ms (default: count * interval ago)
            to_timestamp: End time in ms (default: now)

        Returns:
            List of Candle objects sorted by timestamp ascending.
        """
        if not self.authenticated:
            log.warning("Not authenticated — cannot fetch candles")
            return []

        symbol_id = self.resolve_symbol(symbol)
        if symbol_id is None:
            log.warning("Unknown symbol: %s", symbol)
            return []

        period = TIMEFRAME_TO_PERIOD.get(timeframe, 9)

        now_ms = int(time.time() * 1000)
        to_ts = to_timestamp or now_ms

        # Estimate interval in ms for default from_timestamp
        interval_map = {
            "1m": 60_000, "5m": 300_000, "15m": 900_000,
            "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000, "1w": 604_800_000,
        }
        interval = interval_map.get(timeframe, 3_600_000)
        from_ts = from_timestamp or (to_ts - count * interval)

        req = ProtoOAGetTrendbarsReq()
        req.ctidTraderAccountId = self.account_id
        req.symbolId = symbol_id
        req.period = period
        req.fromTimestamp = int(from_ts)
        req.toTimestamp = int(to_ts)
        req.count = count

        result_event = threading.Event()
        candles: list[Candle] = []
        error_msg: list[str] = []

        def on_result(msg):
            result = Protobuf.extract(msg)
            for bar in result.trendbar:
                ts = bar.utcTimestampInMinutes * 60_000 if bar.HasField("utcTimestampInMinutes") else 0
                low = bar.low / 100_000.0
                candles.append(Candle(
                    timestamp=ts,
                    open=(bar.low + bar.deltaOpen) / 100_000.0 if bar.HasField("deltaOpen") else low,
                    high=(bar.low + bar.deltaHigh) / 100_000.0 if bar.HasField("deltaHigh") else low,
                    low=low,
                    close=(bar.low + bar.deltaClose) / 100_000.0 if bar.HasField("deltaClose") else low,
                    volume=bar.volume if bar.HasField("volume") else 0,
                ))
            candles.sort(key=lambda c: c.timestamp)
            result_event.set()

        def on_error(failure):
            error_msg.append(str(failure))
            result_event.set()

        d = self.client.send(req, responseTimeoutInSeconds=15)
        d.addCallback(on_result)
        d.addErrback(on_error)

        result_event.wait(timeout=20)

        if error_msg:
            log.error("Failed to fetch candles for %s: %s", symbol, error_msg[0])
            return []

        log.info("Fetched %d candles for %s (%s)", len(candles), symbol, timeframe)
        return candles

    # ------------------------------------------------------------------
    # Real-time Data
    # ------------------------------------------------------------------

    def subscribe_ticks(self, symbols: list[str], callback: Callable) -> bool:
        """Subscribe to real-time tick data.

        Args:
            symbols: List of symbol names to subscribe to
            callback: Function called with tick data dict

        Returns:
            True if subscription was successful.
        """
        if not self.authenticated:
            return False

        self._tick_callbacks.append(callback)

        symbol_ids = []
        for sym in symbols:
            sid = self.resolve_symbol(sym)
            if sid is None:
                log.warning("Cannot subscribe to unknown symbol: %s", sym)
                continue
            symbol_ids.append(sid)

        if not symbol_ids:
            return False

        req = ProtoOASubscribeSpotsReq()
        req.ctidTraderAccountId = self.account_id
        for sid in symbol_ids:
            req.symbolId.append(sid)
        req.subscribeToSpotTimestamp = True

        self.client.send(req)
        log.info("Subscribed to ticks for %d symbols", len(symbol_ids))
        return True

    def subscribe_live_bars(self, symbol: str, timeframe: str = "1m") -> bool:
        """Subscribe to live trendbar (candle) data."""
        if not self.authenticated:
            return False

        symbol_id = self.resolve_symbol(symbol)
        if symbol_id is None:
            return False

        period = TIMEFRAME_TO_PERIOD.get(timeframe, 1)

        req = ProtoOASubscribeLiveTrendbarReq()
        req.ctidTraderAccountId = self.account_id
        req.symbolId = symbol_id
        req.period = period

        self.client.send(req)
        log.info("Subscribed to live %s bars for %s", timeframe, symbol)
        return True
