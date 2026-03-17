"""Tests for OANDA v20 integration (data fetcher + executor)."""

import json
import pytest
from unittest.mock import patch, MagicMock

from shared.types import AssetInfo, AssetClass, Signal, SignalAction, RiskAssessment
from team.market_analyst.oanda import OandaDataFetcher, TIMEFRAME_TO_GRANULARITY
from team.executor.oanda import OandaExecutor


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
        assert TIMEFRAME_TO_GRANULARITY["1h"] == "H1"
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
            }
        }
        mock_session.get.return_value = mock_resp

        fetcher = OandaDataFetcher(api_token="test", account_id="101-001-123")
        fetcher._session = mock_session

        summary = fetcher.get_account_summary()
        assert summary["balance"] == pytest.approx(50000.0)
        assert summary["unrealized_pl"] == pytest.approx(1234.56)
        assert summary["open_trade_count"] == 3
        assert summary["currency"] == "USD"


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
        assert "takeProfitOnFill" in order_req

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
