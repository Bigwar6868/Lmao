"""Tests for trading strategies."""

import pytest
from shared.types import MarketData, SignalAction, AssetInfo, AssetClass
from shared.synthetic import generate_synthetic_candles
from team.technical_strategist.strategies import (
    MomentumStrategy, MeanReversionStrategy, BreakoutStrategy,
    MultiIndicatorStrategy, SMCStrategy, create_strategy, get_all_strategies, StrategyConfig,
)


def _make_data(symbol: str = "BTC/USDT", count: int = 100) -> MarketData:
    asset = AssetInfo(symbol=symbol, asset_class=AssetClass.CRYPTO, base_currency="BTC", quote_currency="USDT")
    candles = generate_synthetic_candles(symbol, count)
    return MarketData(asset=asset, timeframe="1h", candles=candles, last_updated=0)


class TestMomentumStrategy:
    def test_returns_signals(self):
        data = _make_data()
        strategy = MomentumStrategy(StrategyConfig(name="momentum"))
        signals = strategy.analyze(data)
        assert len(signals) >= 1
        assert signals[0].action in (SignalAction.BUY, SignalAction.SELL, SignalAction.HOLD)
        assert 0 <= signals[0].confidence <= 1.0

    def test_too_few_candles(self):
        data = _make_data(count=10)
        strategy = MomentumStrategy(StrategyConfig(name="momentum"))
        signals = strategy.analyze(data)
        assert len(signals) == 0


class TestMeanReversionStrategy:
    def test_returns_signals(self):
        data = _make_data()
        strategy = MeanReversionStrategy(StrategyConfig(name="mean-reversion"))
        signals = strategy.analyze(data)
        assert len(signals) >= 1

    def test_confidence_bounded(self):
        data = _make_data()
        strategy = MeanReversionStrategy(StrategyConfig(name="mean-reversion"))
        signals = strategy.analyze(data)
        for s in signals:
            assert 0 <= s.confidence <= 1.0


class TestBreakoutStrategy:
    def test_returns_signals(self):
        data = _make_data()
        strategy = BreakoutStrategy(StrategyConfig(name="breakout"))
        signals = strategy.analyze(data)
        assert len(signals) >= 1


class TestMultiIndicatorStrategy:
    def test_returns_signals(self):
        data = _make_data()
        strategy = MultiIndicatorStrategy(StrategyConfig(name="multi-indicator"))
        signals = strategy.analyze(data)
        assert len(signals) >= 1
        assert "composite" in signals[0].indicators


class TestSMCStrategy:
    def test_returns_signals(self):
        data = _make_data(count=200)
        strategy = SMCStrategy(StrategyConfig(name="smc"))
        signals = strategy.analyze(data)
        assert len(signals) >= 1
        assert signals[0].action in (SignalAction.BUY, SignalAction.SELL, SignalAction.HOLD)
        assert 0 <= signals[0].confidence <= 1.0

    def test_too_few_candles(self):
        data = _make_data(count=20)
        strategy = SMCStrategy(StrategyConfig(name="smc"))
        signals = strategy.analyze(data)
        assert len(signals) == 0

    def test_has_smc_indicators(self):
        data = _make_data(count=200)
        strategy = SMCStrategy(StrategyConfig(name="smc"))
        signals = strategy.analyze(data)
        if signals:
            assert "composite" in signals[0].indicators
            assert "structure_bias" in signals[0].indicators
            assert "fvg_score" in signals[0].indicators
            assert "sweep_score" in signals[0].indicators

    def test_confidence_bounded(self):
        data = _make_data(count=200)
        strategy = SMCStrategy(StrategyConfig(name="smc"))
        signals = strategy.analyze(data)
        for s in signals:
            assert 0 <= s.confidence <= 1.0

    def test_forex_pair(self):
        asset = AssetInfo(symbol="EUR/USD", asset_class=AssetClass.FOREX, base_currency="EUR", quote_currency="USD")
        candles = generate_synthetic_candles("EUR/USD", 200)
        data = MarketData(asset=asset, timeframe="1h", candles=candles, last_updated=0)
        strategy = SMCStrategy(StrategyConfig(name="smc"))
        signals = strategy.analyze(data)
        assert len(signals) >= 1


class TestFactory:
    def test_create_all(self):
        strategies = get_all_strategies()
        assert len(strategies) == 5

    def test_create_by_name(self):
        s = create_strategy("momentum")
        assert s.config.name == "momentum"

    def test_unknown_strategy(self):
        with pytest.raises(ValueError):
            create_strategy("nonexistent")
