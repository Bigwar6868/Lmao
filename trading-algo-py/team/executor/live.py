"""Live executor — executes trades via IC Markets cTrader Open API."""

from __future__ import annotations

import logging
import time
import uuid
import threading

from twisted.internet import reactor

from ctrader_open_api import Client, Protobuf, TcpProtocol, EndPoints
from ctrader_open_api.messages.OpenApiMessages_pb2 import (
    ProtoOAApplicationAuthReq,
    ProtoOAAccountAuthReq,
    ProtoOANewOrderReq,
    ProtoOACancelOrderReq,
    ProtoOAClosePositionReq,
    ProtoOAReconcileReq,
    ProtoOATraderReq,
    ProtoOAAmendPositionSLTPReq,
)
from ctrader_open_api.messages.OpenApiModelMessages_pb2 import (
    ProtoOAOrderType,
    ProtoOATradeSide,
    ProtoOAOrderStatus,
    ProtoOAPositionStatus,
    ProtoOAExecutionType,
    ProtoOAExecutionEvent,
)

from shared.types import (
    Signal, SignalAction, RiskAssessment, Order, Position, AssetInfo,
    Side, OrderType, OrderStatus,
)
from shared.events import event_bus
from config.settings import config

log = logging.getLogger(__name__)


class LiveExecutor:
    """Executes real trades via IC Markets cTrader Open API."""

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
        self.symbols: dict[str, int] = {}
        self._ready_event = threading.Event()
        self._reactor_thread: threading.Thread | None = None

        log.info("LiveExecutor initialised (live=%s)", self.is_live)

    # ------------------------------------------------------------------
    # Connection (reuses same pattern as data fetcher)
    # ------------------------------------------------------------------

    def connect(self) -> bool:
        """Connect and authenticate."""
        if not self.client_id or not self.access_token:
            log.error("Missing cTrader credentials")
            return False

        host = EndPoints.PROTOBUF_LIVE_HOST if self.is_live else EndPoints.PROTOBUF_DEMO_HOST
        self.client = Client(host, EndPoints.PROTOBUF_PORT, TcpProtocol)

        self.client.setConnectedCallback(self._on_connected)
        self.client.setDisconnectedCallback(self._on_disconnected)
        self.client.setMessageReceivedCallback(self._on_message)

        self._reactor_thread = threading.Thread(target=lambda: reactor.run(installSignalHandlers=False), daemon=True)
        self._reactor_thread.start()
        self.client.startService()

        return self._ready_event.wait(timeout=15)

    def _on_connected(self, client):
        self.connected = True
        req = ProtoOAApplicationAuthReq()
        req.clientId = self.client_id
        req.clientSecret = self.client_secret
        d = client.send(req)
        d.addCallback(lambda _: self._auth_account())

    def _auth_account(self):
        req = ProtoOAAccountAuthReq()
        req.ctidTraderAccountId = self.account_id
        req.accessToken = self.access_token
        d = self.client.send(req)
        d.addCallback(lambda _: self._on_authenticated())

    def _on_authenticated(self):
        self.authenticated = True
        # Load symbols for name->ID resolution
        from ctrader_open_api.messages.OpenApiMessages_pb2 import ProtoOASymbolsListReq
        req = ProtoOASymbolsListReq()
        req.ctidTraderAccountId = self.account_id
        d = self.client.send(req)

        def on_symbols(msg):
            result = Protobuf.extract(msg)
            for sym in result.symbol:
                self.symbols[sym.symbolName] = sym.symbolId
            self._ready_event.set()

        d.addCallback(on_symbols)

    def _on_disconnected(self, client, reason):
        self.connected = False
        self.authenticated = False
        log.warning("cTrader disconnected: %s", reason)

    def _on_message(self, client, message):
        msg = Protobuf.extract(message)
        if isinstance(msg, ProtoOAExecutionEvent):
            event_bus.emit("execution", msg, "LiveExecutor")

    def _resolve_symbol(self, symbol: str) -> int | None:
        for variant in [symbol, symbol.replace("/", ""), symbol.replace("/", ".")]:
            if variant in self.symbols:
                return self.symbols[variant]
        return None

    # ------------------------------------------------------------------
    # Order Execution
    # ------------------------------------------------------------------

    def execute_order(self, signal: Signal, risk: RiskAssessment) -> Order:
        """Place a real order via cTrader."""
        if not self.authenticated:
            raise RuntimeError("Not connected to IC Markets")

        symbol_id = self._resolve_symbol(signal.asset.symbol)
        if symbol_id is None:
            raise ValueError(f"Unknown symbol: {signal.asset.symbol}")

        # Calculate volume in cTrader units (volume in cents: 100 = 0.01 lot)
        quantity = risk.recommended_size / signal.price if signal.price > 0 else 0
        volume_cents = int(quantity * 100_000)  # Convert to cTrader volume

        req = ProtoOANewOrderReq()
        req.ctidTraderAccountId = self.account_id
        req.symbolId = symbol_id
        req.orderType = ProtoOAOrderType.Value("MARKET")
        req.tradeSide = ProtoOATradeSide.Value("BUY" if signal.action == SignalAction.BUY else "SELL")
        req.volume = volume_cents

        if risk.stop_loss_price > 0:
            req.stopLoss = risk.stop_loss_price
        if risk.take_profit_price > 0:
            req.takeProfit = risk.take_profit_price

        req.comment = f"algo:{signal.strategy}"
        req.label = signal.strategy

        result_event = threading.Event()
        order_result: list[Order] = []
        error_result: list[str] = []

        def on_execution(msg):
            result = Protobuf.extract(msg)
            side = Side.BUY if signal.action == SignalAction.BUY else Side.SELL
            order = Order(
                id=str(uuid.uuid4())[:8],
                asset=signal.asset,
                side=side,
                type=OrderType.MARKET,
                quantity=quantity,
                strategy=signal.strategy,
                price=signal.price,
                status=OrderStatus.FILLED,
                filled_price=result.order.executionPrice if result.HasField("order") and result.order.HasField("executionPrice") else signal.price,
                filled_quantity=quantity,
                created_at=int(time.time() * 1000),
                filled_at=int(time.time() * 1000),
                broker_order_id=str(result.order.orderId) if result.HasField("order") else None,
            )
            order_result.append(order)
            result_event.set()

        def on_error(failure):
            error_result.append(str(failure))
            result_event.set()

        d = self.client.send(req, responseTimeoutInSeconds=10)
        d.addCallback(on_execution)
        d.addErrback(on_error)

        result_event.wait(timeout=15)

        if error_result:
            raise RuntimeError(f"Order failed: {error_result[0]}")

        if not order_result:
            raise RuntimeError("Order timed out")

        log.info("LIVE %s %s %.4f @ %.5f",
                 signal.action.value, signal.asset.symbol, quantity, order_result[0].filled_price)
        event_bus.emit("order:filled", order_result[0], "LiveExecutor")
        return order_result[0]

    def cancel_order(self, broker_order_id: str) -> bool:
        """Cancel a pending order."""
        if not self.authenticated:
            return False

        req = ProtoOACancelOrderReq()
        req.ctidTraderAccountId = self.account_id
        req.orderId = int(broker_order_id)

        result_event = threading.Event()
        success = [False]

        def on_ok(_):
            success[0] = True
            result_event.set()

        d = self.client.send(req, responseTimeoutInSeconds=10)
        d.addCallback(on_ok)
        d.addErrback(lambda _: result_event.set())

        result_event.wait(timeout=15)
        return success[0]

    def close_position(self, broker_position_id: str, volume: int) -> bool:
        """Close an open position."""
        if not self.authenticated:
            return False

        req = ProtoOAClosePositionReq()
        req.ctidTraderAccountId = self.account_id
        req.positionId = int(broker_position_id)
        req.volume = volume

        result_event = threading.Event()
        success = [False]

        def on_ok(_):
            success[0] = True
            result_event.set()

        d = self.client.send(req, responseTimeoutInSeconds=10)
        d.addCallback(on_ok)
        d.addErrback(lambda _: result_event.set())

        result_event.wait(timeout=15)
        return success[0]

    def get_account_balance(self) -> dict:
        """Get account balance and equity."""
        if not self.authenticated:
            return {}

        req = ProtoOATraderReq()
        req.ctidTraderAccountId = self.account_id

        result_event = threading.Event()
        info: list[dict] = []

        def on_trader(msg):
            result = Protobuf.extract(msg)
            t = result.trader
            info.append({
                "balance": t.balance / 100,
                "leverage": t.leverageInCents / 100 if t.HasField("leverageInCents") else None,
                "money_digits": t.moneyDigits,
            })
            result_event.set()

        d = self.client.send(req, responseTimeoutInSeconds=10)
        d.addCallback(on_trader)
        d.addErrback(lambda _: result_event.set())

        result_event.wait(timeout=15)
        return info[0] if info else {}

    def disconnect(self) -> None:
        if self.client:
            self.client.stopService()
        self.connected = False
        self.authenticated = False
