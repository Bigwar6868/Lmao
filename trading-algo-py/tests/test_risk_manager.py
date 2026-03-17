"""Tests for risk manager."""

import pytest
from shared.types import (
    AssetInfo, AssetClass, MarketData, Signal, SignalAction,
    Portfolio, RiskAssessment,
)
from shared.synthetic import generate_synthetic_candles
from team.risk_manager.risk import RiskManager


def _make_signal(action: SignalAction = SignalAction.BUY, confidence: float = 0.7) -> Signal:
    return Signal(
        asset=AssetInfo(symbol="BTC/USDT", asset_class=AssetClass.CRYPTO),
        action=action,
        confidence=confidence,
        price=65000,
        timestamp=0,
        strategy="test",
        timeframe="1h",
    )


def _make_portfolio(capital: float = 10000) -> Portfolio:
    return Portfolio(capital=capital, available_capital=capital)


def _make_data() -> MarketData:
    candles = generate_synthetic_candles("BTC/USDT", 50)
    return MarketData(
        asset=AssetInfo(symbol="BTC/USDT", asset_class=AssetClass.CRYPTO),
        timeframe="1h", candles=candles, last_updated=0,
    )


class TestRiskManager:
    def test_hold_not_approved(self):
        rm = RiskManager()
        r = rm.assess(_make_signal(SignalAction.HOLD), _make_data(), _make_portfolio())
        assert not r.approved

    def test_buy_approved(self):
        rm = RiskManager()
        r = rm.assess(_make_signal(SignalAction.BUY), _make_data(), _make_portfolio())
        assert r.approved
        assert r.recommended_size > 0
        assert r.stop_loss_price > 0
        assert r.take_profit_price > 0

    def test_sell_approved(self):
        rm = RiskManager()
        r = rm.assess(_make_signal(SignalAction.SELL), _make_data(), _make_portfolio())
        assert r.approved

    def test_low_confidence_rejected(self):
        rm = RiskManager()
        r = rm.assess(_make_signal(confidence=0.2), _make_data(), _make_portfolio())
        assert not r.approved
        assert "confidence" in r.reason.lower()

    def test_drawdown_limit(self):
        rm = RiskManager()
        portfolio = _make_portfolio()
        portfolio.max_drawdown = 2500  # 25% of 10000 > 20% limit
        r = rm.assess(_make_signal(), _make_data(), portfolio)
        assert not r.approved
        assert "drawdown" in r.reason.lower()

    def test_position_size_capped(self):
        rm = RiskManager(max_position_pct=5)
        r = rm.assess(_make_signal(), _make_data(), _make_portfolio())
        assert r.max_position_size <= 500  # 5% of 10000

    def test_buy_stop_loss_below_price(self):
        rm = RiskManager()
        signal = _make_signal(SignalAction.BUY)
        r = rm.assess(signal, _make_data(), _make_portfolio())
        assert r.stop_loss_price < signal.price

    def test_sell_stop_loss_above_price(self):
        rm = RiskManager()
        signal = _make_signal(SignalAction.SELL)
        r = rm.assess(signal, _make_data(), _make_portfolio())
        assert r.stop_loss_price > signal.price
