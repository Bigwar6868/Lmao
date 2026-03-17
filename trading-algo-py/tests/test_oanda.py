"""Tests for OANDA v20 integration (data fetcher + executor)."""

import json
import pytest
from unittest.mock import patch, MagicMock

from shared.types import AssetInfo, AssetClass, Signal, SignalAction, RiskAssessment
from team.market_analyst.oanda import OandaDataFetcher, TIMEFRAME_TO_GRANULARITY
from team.executor.oanda import OandaExecutor, _format_price, _price_precision


# ============================================================
# OandaDataFetcher Tests
# ============================================================

class TestOandaDataFetcher:
    def _make_fetcher(self) -> OandaDataFetcher:
        return OandaDataFetcher(api_token="test-token", account_id="101-001-123", is_live=False)

    def test_instrument_conversion(self):
        f = self._make_fetcher()
        assert f._to_oanda_instrument("EUR/USD") == "EUR_USD"
        assert f._to_oanda_instrument("GBP/JPY") == "GBP_JPY"
        assert f._from_oanda_instrument("EUR_USD") == "EUR/USD"

    def test_timeframe_mapping(self):
        assert TIMEFRAME_TO_GRANULARITY["1m"] == "M1"
        assert TIMEFRAME_TO_GRANULARITY["5m"] == "M5"
        assert TIMEFRAME_TO_GRANULARITY["15m"] == "M15"
        assert TIMEFRAME_TO_GRANULARITY["30m"] == "M30"
        assert TIMEFRAME_TO_GRANULARITY["1h"] == "H1"
        assert TIMEFRAME_TO_GRANULARITY["2h"] == "H2"
        assert TIMEFRAME_TO_GRANULARITY["4h"] == "H4"
        assert TIMEFRAME_TO_GRANULARITY["1d"] == "D"
        assert TIMEFRAME_TO_GRANULARITY["1w"] == "W"

    @patch("team.market_analyst.oanda.requests.Session")
    def test_fetch_candles_success(self, mock_session_cls):
        mock_session = MagicMock()
        mock_session_cls.return_value = mock_session

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "instrument": "EUR_USD",
            "granularity": "H1",
            "candles": [
                {
                    "complete": True,
                    "mid": {"o": "1.08500", "h": "1.08650", "l": "1.08450", "c": "1.08600"},
                    "volume": 1523,
                    "time": "1710676800",
                },
                {
                    "complete": True,
                    "mid": {"o": "1.08600", "h": "1.08700", "l": "1.08500", "c": "1.08550"},
                    "volume": 1100,
                    "time": "1710680400",
                },
                {
                    "complete": False,  # Should be skipped
                    "mid": {"o": "1.08550", "h": "1.08600", "l": "1.08500", "c": "1.08570"},
                    "volume": 200,
                    "time": "1710684000",
                },
            ],
        }
        mock_session.get.return_value = mock_resp

        fetcher = OandaDataFetcher(api_token="test", account_id="101-001-123")
        fetcher._session = mock_session

        candles = fetcher.fetch_candles("EUR/USD", "1h", count=100)

        assert len(candles) == 2  # Incomplete candle skipped
        assert candles[0].open == pytest.approx(1.085)
        assert candles[0].high == pytest.approx(1.0865)
        assert candles[0].low == pytest.approx(1.0845)
        assert candles[0].close == pytest.approx(1.086)
        assert candles[0].volume == 1523
        assert candles[0].timestamp == 1710676800000

    @patch("team.market_analyst.oanda.requests.Session")
    def test_fetch_candles_http_error(self, mock_session_cls):
        mock_session = MagicMock()
        mock_session_cls.return_value = mock_session

        mock_resp = MagicMock()
        mock_resp.raise_for_status.side_effect = Exception("401 Unauthorized")
        mock_session.get.return_value = mock_resp

        fetcher = OandaDataFetcher(api_token="bad-token", account_id="101-001-123")
        fetcher._session = mock_session

        candles = fetcher.fetch_candles("EUR/USD", "1h")
        assert candles == []

    @patch("team.market_analyst.oanda.requests.Session")
    def test_get_prices(self, mock_session_cls):
        mock_session = MagicMock()
        mock_session_cls.return_value = mock_session

        mock_resp = MagicMock()
        mock_resp.json.return_value = {
            "prices": [
                {
                    "instrument": "EUR_USD",
                    "bids": [{"price": "1.08500"}],
                    "asks": [{"price": "1.08520"}],
                    "time": "1710676800",
                    "tradeable": True,
                },
            ]
        }
        mock_session.get.return_value = mock_resp

        fetcher = OandaDataFetcher(api_token="test", account_id="101-001-123")
        fetcher._session = mock_session

        prices = fetcher.get_prices(["EUR/USD"])
        assert "EUR/USD" in prices
        assert prices["EUR/USD"]["bid"] == pytest.approx(1.085)
        assert prices["EUR/USD"]["ask"] == pytest.approx(1.0852)
        assert prices["EUR/USD"]["tradeable"] is True

    @patch("team.market_analyst.oanda.requests.Session")
    def test_get_account_summary(self, mock_session_cls):
        mock_session = MagicMock()
        mock_session_cls.return_value = mock_session

        mock_resp = MagicMock()
        mock_resp.json.return_value = {
            "account": {
                "balance": "50000.00",
                "unrealizedPL": "1234.56",
                "realizedPL": "500.00",
                "marginUsed": "5000.00",
                "marginAvailable": "45000.00",
                "openTradeCount": 3,
                "currency": "USD",
            },
            "lastTransactionID": "6373",
        }
        mock_session.get.return_value = mock_resp

        fetcher = OandaDataFetcher(api_token="test", account_id="101-001-123")
        fetcher._session = mock_session

        summary = fetcher.get_account_summary()
        assert summary["balance"] == pytest.approx(50000.0)
        assert summary["unrealized_pl"] == pytest.approx(1234.56)
        assert summary["open_trade_count"] == 3
        assert summary["currency"] == "USD"
        assert summary["last_transaction_id"] == "6373"

    @patch("team.market_analyst.oanda.requests.Session")
    def test_account_summary_stores_transaction_id(self, mock_session_cls):
        mock_session = MagicMock()
        mock_session_cls.return_value = mock_session

        mock_resp = MagicMock()
        mock_resp.json.return_value = {
            "account": {"balance": "10000.00", "unrealizedPL": "0", "realizedPL": "0",
                        "marginUsed": "0", "marginAvailable": "10000.00",
                        "openTradeCount": 0, "currency": "USD"},
            "lastTransactionID": "42",
        }
        mock_session.get.return_value = mock_resp

        fetcher = OandaDataFetcher(api_token="test", account_id="101-001-123")
        fetcher._session = mock_session

        fetcher.get_account_summary()
        assert fetcher._last_transaction_id == "42"

    @patch("team.market_analyst.oanda.requests.Session")
    def test_poll_account_updates(self, mock_session_cls):
        mock_session = MagicMock()
        mock_session_cls.return_value = mock_session

        mock_resp = MagicMock()
        mock_resp.json.return_value = {
            "changes": {
                "tradesOpened": [{"tradeID": "100"}],
                "tradesClosed": [],
                "tradesReduced": [],
                "ordersCreated": [],
                "ordersCancelled": [],
                "ordersFilled": [],
                "positions": [],
            },
            "state": {
                "unrealizedPL": "50.00",
                "NAV": "10050.00",
                "marginUsed": "500.00",
                "marginAvailable": "9550.00",
                "positionValue": "500.00",
            },
            "lastTransactionID": "43",
        }
        mock_session.get.return_value = mock_resp

        fetcher = OandaDataFetcher(api_token="test", account_id="101-001-123")
        fetcher._session = mock_session
        fetcher._last_transaction_id = "42"

        result = fetcher.poll_account_updates()
        assert result is not None
        assert result["last_transaction_id"] == "43"
        assert len(result["changes"]["trades_opened"]) == 1
        assert result["state"]["nav"] == pytest.approx(10050.0)

    def test_poll_without_transaction_id_returns_none(self):
        fetcher = OandaDataFetcher(api_token="test", account_id="101-001-123")
        assert fetcher.poll_account_updates() is None

    @patch("team.market_analyst.oanda.requests.Session")
    def test_fetch_candles_count_not_set_with_from_and_to(self, mock_session_cls):
        """Per OANDA docs: count must NOT be specified when both from/to are given."""
        mock_session = MagicMock()
        mock_session_cls.return_value = mock_session

        mock_resp = MagicMock()
        mock_resp.json.return_value = {"candles": []}
        mock_session.get.return_value = mock_resp

        fetcher = OandaDataFetcher(api_token="test", account_id="101-001-123")
        fetcher._session = mock_session

        fetcher.fetch_candles("EUR/USD", "1h", from_timestamp=1000000, to_timestamp=2000000)

        call_args = mock_session.get.call_args
        params = call_args.kwargs.get("params") or call_args[1].get("params")
        assert "count" not in params
        assert "from" in params
        assert "to" in params


# ============================================================
# OandaExecutor Tests
# ============================================================

def _make_signal(action=SignalAction.BUY) -> Signal:
    return Signal(
        asset=AssetInfo(symbol="EUR/USD", asset_class=AssetClass.FOREX, base_currency="EUR", quote_currency="USD"),
        action=action, confidence=0.7, price=1.085, timestamp=0,
        strategy="momentum", timeframe="1h",
    )


def _make_risk() -> RiskAssessment:
    return RiskAssessment(
        max_position_size=500, recommended_size=500,
        stop_loss_price=1.080, take_profit_price=1.095,
        risk_reward_ratio=2.0, kelly_fraction=0.1,
        approved=True, reason="OK",
    )


class TestOandaExecutor:
    @patch("team.executor.oanda.requests.Session")
    def test_execute_buy_order(self, mock_session_cls):
        mock_session = MagicMock()
        mock_session_cls.return_value = mock_session

        mock_resp = MagicMock()
        mock_resp.status_code = 201
        mock_resp.json.return_value = {
            "orderCreateTransaction": {"id": "100"},
            "orderFillTransaction": {
                "orderID": "100",
                "price": "1.08520",
                "tradeOpened": {"tradeID": "200", "units": "46082", "price": "1.08520"},
            },
        }
        mock_session.post.return_value = mock_resp

        executor = OandaExecutor(api_token="test", account_id="101-001-123")
        executor._session = mock_session

        order = executor.execute_order(_make_signal(), _make_risk())

        assert order.filled_price == pytest.approx(1.0852)
        assert order.side.value == "buy"
        assert order.broker_order_id == "100"

        # Check the request body
        call_args = mock_session.post.call_args
        body = call_args.kwargs.get("json") or call_args[1].get("json")
        order_req = body["order"]
        assert order_req["type"] == "MARKET"
        assert order_req["instrument"] == "EUR_USD"
        assert int(order_req["units"]) > 0  # Positive = buy
        assert "stopLossOnFill" in order_req
        assert order_req["stopLossOnFill"]["timeInForce"] == "GTC"
        assert "takeProfitOnFill" in order_req
        assert order_req["takeProfitOnFill"]["timeInForce"] == "GTC"

    @patch("team.executor.oanda.requests.Session")
    def test_execute_sell_order(self, mock_session_cls):
        mock_session = MagicMock()
        mock_session_cls.return_value = mock_session

        mock_resp = MagicMock()
        mock_resp.json.return_value = {
            "orderCreateTransaction": {"id": "101"},
            "orderFillTransaction": {
                "orderID": "101",
                "price": "1.08480",
                "tradeOpened": {"tradeID": "201", "units": "-46082"},
            },
        }
        mock_session.post.return_value = mock_resp

        executor = OandaExecutor(api_token="test", account_id="101-001-123")
        executor._session = mock_session

        order = executor.execute_order(_make_signal(SignalAction.SELL), _make_risk())
        assert order.side.value == "sell"

        # Check units are negative for sell
        call_args = mock_session.post.call_args
        body = call_args.kwargs.get("json") or call_args[1].get("json")
        assert int(body["order"]["units"]) < 0

    @patch("team.executor.oanda.requests.Session")
    def test_cancel_order(self, mock_session_cls):
        mock_session = MagicMock()
        mock_session_cls.return_value = mock_session
        mock_session.put.return_value = MagicMock(status_code=200)

        executor = OandaExecutor(api_token="test", account_id="101-001-123")
        executor._session = mock_session

        result = executor.cancel_order("12345")
        assert result is True
        mock_session.put.assert_called_once()

    @patch("team.executor.oanda.requests.Session")
    def test_close_trade(self, mock_session_cls):
        mock_session = MagicMock()
        mock_session_cls.return_value = mock_session
        mock_session.put.return_value = MagicMock(status_code=200)

        executor = OandaExecutor(api_token="test", account_id="101-001-123")
        executor._session = mock_session

        result = executor.close_trade("200", units="ALL")
        assert result is True

    @patch("team.executor.oanda.requests.Session")
    def test_get_open_trades(self, mock_session_cls):
        mock_session = MagicMock()
        mock_session_cls.return_value = mock_session

        mock_resp = MagicMock()
        mock_resp.json.return_value = {
            "trades": [
                {
                    "id": "200",
                    "instrument": "EUR_USD",
                    "currentUnits": "10000",
                    "price": "1.08500",
                    "unrealizedPL": "50.00",
                    "realizedPL": "0.00",
                    "openTime": "2026-03-17T10:00:00Z",
                    "state": "OPEN",
                    "stopLossOrder": {"price": "1.08000"},
                    "takeProfitOrder": {"price": "1.09000"},
                }
            ]
        }
        mock_session.get.return_value = mock_resp

        executor = OandaExecutor(api_token="test", account_id="101-001-123")
        executor._session = mock_session

        trades = executor.get_open_trades()
        assert len(trades) == 1
        assert trades[0]["instrument"] == "EUR/USD"
        assert trades[0]["side"] == "buy"
        assert trades[0]["units"] == 10000
        assert trades[0]["stop_loss"] == pytest.approx(1.08)
        assert trades[0]["take_profit"] == pytest.approx(1.09)

    @patch("team.executor.oanda.requests.Session")
    def test_modify_trade_sl_tp(self, mock_session_cls):
        mock_session = MagicMock()
        mock_session_cls.return_value = mock_session
        mock_session.put.return_value = MagicMock(status_code=200)

        executor = OandaExecutor(api_token="test", account_id="101-001-123")
        executor._session = mock_session

        result = executor.modify_trade_sl_tp("200", stop_loss=1.079, take_profit=1.092)
        assert result is True

        call_args = mock_session.put.call_args
        body = call_args.kwargs.get("json") or call_args[1].get("json")
        assert "stopLoss" in body
        assert "takeProfit" in body

    @patch("team.executor.oanda.time.sleep")
    @patch("team.executor.oanda.requests.Session")
    def test_retry_on_429(self, mock_session_cls, mock_sleep):
        """Test that 429 rate limit triggers retry with backoff."""
        mock_session = MagicMock()
        mock_session_cls.return_value = mock_session

        # First call returns 429, second succeeds
        mock_429 = MagicMock()
        mock_429.status_code = 429

        mock_ok = MagicMock()
        mock_ok.status_code = 201
        mock_ok.json.return_value = {
            "orderCreateTransaction": {"id": "100"},
            "orderFillTransaction": {
                "orderID": "100", "price": "1.08520",
                "tradeOpened": {"tradeID": "200", "units": "46082"},
            },
        }
        mock_session.post.side_effect = [mock_429, mock_ok]

        executor = OandaExecutor(api_token="test", account_id="101-001-123")
        executor._session = mock_session

        order = executor.execute_order(_make_signal(), _make_risk())
        assert order.filled_price == pytest.approx(1.0852)
        assert mock_session.post.call_count == 2
        mock_sleep.assert_called_once_with(1)  # First backoff = 1s

    def test_price_precision(self):
        """Test that price formatting uses correct decimals per instrument."""
        assert _price_precision("EUR_USD") == 5
        assert _price_precision("GBP_USD") == 5
        assert _price_precision("USD_JPY") == 3
        assert _price_precision("EUR_JPY") == 3
        assert _price_precision("GBP_JPY") == 3
        assert _price_precision("XAU_USD") == 2
        assert _price_precision("XAG_USD") == 2

        assert _format_price(1.08523, "EUR_USD") == "1.08523"
        assert _format_price(192.456, "USD_JPY") == "192.456"
        assert _format_price(192.4, "GBP_JPY") == "192.400"
        assert _format_price(2345.67, "XAU_USD") == "2345.67"

    @patch("team.executor.oanda.requests.Session")
    def test_ensure_sl_tp_attaches_missing(self, mock_session_cls):
        """Test that _ensure_sl_tp detects missing SL/TP and attaches them."""
        mock_session = MagicMock()
        mock_session_cls.return_value = mock_session

        # Trade has no SL/TP orders
        mock_get = MagicMock()
        mock_get.json.return_value = {
            "trade": {
                "id": "500",
                "instrument": "EUR_USD",
                "currentUnits": "10000",
                "price": "1.08500",
            }
        }

        mock_put = MagicMock(status_code=200)

        mock_session.get.return_value = mock_get
        mock_session.put.return_value = mock_put

        executor = OandaExecutor(api_token="test", account_id="101-001-123")
        executor._session = mock_session

        executor._ensure_sl_tp("500", "EUR_USD", stop_loss=1.080, take_profit=1.095)

        # Should have called PUT to attach SL/TP
        mock_session.put.assert_called_once()
        call_args = mock_session.put.call_args
        body = call_args.kwargs.get("json") or call_args[1].get("json")
        assert "stopLoss" in body
        assert body["stopLoss"]["price"] == "1.08000"
        assert "takeProfit" in body
        assert body["takeProfit"]["price"] == "1.09500"

    @patch("team.executor.oanda.requests.Session")
    def test_ensure_sl_tp_skips_when_present(self, mock_session_cls):
        """Test that _ensure_sl_tp doesn't modify trade when SL/TP exist."""
        mock_session = MagicMock()
        mock_session_cls.return_value = mock_session

        # Trade already has SL/TP
        mock_get = MagicMock()
        mock_get.json.return_value = {
            "trade": {
                "id": "500",
                "instrument": "EUR_USD",
                "stopLossOrder": {"price": "1.08000"},
                "takeProfitOrder": {"price": "1.09500"},
            }
        }
        mock_session.get.return_value = mock_get

        executor = OandaExecutor(api_token="test", account_id="101-001-123")
        executor._session = mock_session

        executor._ensure_sl_tp("500", "EUR_USD", stop_loss=1.080, take_profit=1.095)

        # Should NOT have called PUT
        mock_session.put.assert_not_called()

    @patch("team.executor.oanda.requests.Session")
    def test_get_portfolio_live(self, mock_session_cls):
        """Test that get_portfolio fetches live data from OANDA."""
        mock_session = MagicMock()
        mock_session_cls.return_value = mock_session

        # Mock account summary response
        mock_summary = MagicMock()
        mock_summary.json.return_value = {
            "account": {
                "balance": "10000.00",
                "unrealizedPL": "50.66",
                "realizedPL": "120.00",
                "NAV": "10170.66",
                "marginUsed": "500.00",
                "marginAvailable": "9670.66",
                "openTradeCount": 2,
                "currency": "GBP",
            }
        }

        # Mock open trades response
        mock_trades = MagicMock()
        mock_trades.json.return_value = {
            "trades": [
                {
                    "id": "301",
                    "instrument": "EUR_USD",
                    "currentUnits": "10000",
                    "price": "1.08500",
                    "unrealizedPL": "30.00",
                    "realizedPL": "0.00",
                    "openTime": "2026-03-17T10:00:00Z",
                },
                {
                    "id": "302",
                    "instrument": "GBP_JPY",
                    "currentUnits": "-5000",
                    "price": "192.50",
                    "unrealizedPL": "20.66",
                    "realizedPL": "0.00",
                    "openTime": "2026-03-17T11:00:00Z",
                },
            ]
        }

        # get_account_balance calls summary, get_open_trades calls openTrades
        mock_session.get.side_effect = [mock_summary, mock_trades]

        executor = OandaExecutor(api_token="test", account_id="101-001-123")
        executor._session = mock_session

        portfolio = executor.get_portfolio()

        assert portfolio.capital == pytest.approx(10170.66)
        assert portfolio.available_capital == pytest.approx(9670.66)
        assert len(portfolio.positions) == 2
        assert portfolio.positions[0].broker_position_id == "301"
        assert portfolio.positions[1].side.value == "sell"
        assert portfolio.total_pnl == pytest.approx(170.66)  # 50.66 + 120.00

    @patch("team.executor.oanda.requests.Session")
    def test_get_summary_live(self, mock_session_cls):
        """Test that get_summary returns live OANDA account string."""
        mock_session = MagicMock()
        mock_session_cls.return_value = mock_session

        mock_resp = MagicMock()
        mock_resp.json.return_value = {
            "account": {
                "balance": "10000.00",
                "unrealizedPL": "0.66",
                "realizedPL": "50.00",
                "NAV": "10050.66",
                "marginUsed": "250.00",
                "marginAvailable": "9800.66",
                "openTradeCount": 3,
                "currency": "GBP",
            }
        }
        mock_session.get.return_value = mock_resp

        executor = OandaExecutor(api_token="test", account_id="101-001-123")
        executor._session = mock_session

        summary = executor.get_summary()
        assert "10050.66" in summary
        assert "GBP" in summary
        assert "0.66" in summary
        assert "Open: 3" in summary
