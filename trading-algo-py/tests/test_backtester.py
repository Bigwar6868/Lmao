"""Tests for backtester engine."""

import pytest
from shared.types import AssetInfo, AssetClass, MarketData
from shared.synthetic import generate_synthetic_candles
from team.technical_strategist.strategies import create_strategy
from team.backtester.engine import Backtester


def _make_data(count: int = 100) -> MarketData:
    asset = AssetInfo(symbol="EUR/USD", asset_class=AssetClass.FOREX, base_currency="EUR", quote_currency="USD")
    candles = generate_synthetic_candles("EUR/USD", count, volatility=0.005)
    return MarketData(asset=asset, timeframe="1h", candles=candles, last_updated=0)


class TestBacktester:
    def test_runs_momentum(self):
        bt = Backtester()
        strategy = create_strategy("momentum")
        result = bt.run(strategy, _make_data())
        assert result.strategy == "momentum"
        assert result.metrics is not None

    def test_runs_mean_reversion(self):
        bt = Backtester()
        strategy = create_strategy("mean-reversion")
        result = bt.run(strategy, _make_data())
        assert result.strategy == "mean-reversion"

    def test_runs_breakout(self):
        bt = Backtester()
        strategy = create_strategy("breakout")
        result = bt.run(strategy, _make_data())
        assert result.strategy == "breakout"

    def test_runs_multi_indicator(self):
        bt = Backtester()
        strategy = create_strategy("multi-indicator")
        result = bt.run(strategy, _make_data())
        assert result.strategy == "multi-indicator"

    def test_too_few_candles(self):
        bt = Backtester()
        strategy = create_strategy("momentum")
        result = bt.run(strategy, _make_data(count=10))
        assert result.metrics.total_trades == 0

    def test_equity_curve(self):
        bt = Backtester()
        strategy = create_strategy("momentum")
        result = bt.run(strategy, _make_data(count=200))
        assert len(result.equity_curve) > 0

    def test_metrics_consistency(self):
        bt = Backtester()
        strategy = create_strategy("multi-indicator")
        result = bt.run(strategy, _make_data(count=200))
        m = result.metrics
        assert m.winning_trades + m.losing_trades == m.total_trades
        if m.total_trades > 0:
            assert 0 <= m.win_rate <= 1.0
