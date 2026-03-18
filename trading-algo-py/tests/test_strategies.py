"""Tests for trading strategies."""

import pytest
from shared.types import MarketData, SignalAction, AssetInfo, AssetClass
from shared.synthetic import generate_synthetic_candles
from team.technical_strategist.strategies import (
    MomentumStrategy, MeanReversionStrategy, BreakoutStrategy,
    MultiIndicatorStrategy, SMCStrategy, SilverBulletStrategy,
    ICT2022Strategy, create_strategy, get_all_strategies, StrategyConfig,
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


class TestSilverBulletStrategy:
    def test_returns_signals(self):
        data = _make_data(count=200)
        strategy = SilverBulletStrategy(StrategyConfig(name="silver-bullet"))
        signals = strategy.analyze(data)
        assert len(signals) >= 1
        assert signals[0].action in (SignalAction.BUY, SignalAction.SELL, SignalAction.HOLD)
        assert 0 <= signals[0].confidence <= 1.0

    def test_too_few_candles(self):
        data = _make_data(count=20)
        strategy = SilverBulletStrategy(StrategyConfig(name="silver-bullet"))
        signals = strategy.analyze(data)
        assert len(signals) == 0

    def test_has_sb_indicators(self):
        data = _make_data(count=200)
        strategy = SilverBulletStrategy(StrategyConfig(name="silver-bullet"))
        signals = strategy.analyze(data)
        if signals:
            assert "in_sb_window" in signals[0].indicators

    def test_relaxed_window_mode(self):
        """With require_window=0, strategy works without time filtering."""
        from shared.types import StrategyDNA
        dna = StrategyDNA(
            id="test", name="silver-bullet",
            params={
                "swing_lookback": 5, "atr_period": 14,
                "displacement_threshold": 1.5, "min_reversal_pct": 0.3,
                "fvg_recency": 10, "min_confidence": 0.40,
                "require_window": 0.0,
            },
        )
        data = _make_data(count=200)
        strategy = SilverBulletStrategy(StrategyConfig(name="silver-bullet"), dna)
        signals = strategy.analyze(data)
        assert len(signals) >= 1

    def test_forex_pair(self):
        asset = AssetInfo(symbol="EUR/USD", asset_class=AssetClass.FOREX, base_currency="EUR", quote_currency="USD")
        candles = generate_synthetic_candles("EUR/USD", 200)
        data = MarketData(asset=asset, timeframe="1h", candles=candles, last_updated=0)
        strategy = SilverBulletStrategy(StrategyConfig(name="silver-bullet"))
        signals = strategy.analyze(data)
        assert len(signals) >= 1


class TestICT2022Strategy:
    def test_returns_signals(self):
        data = _make_data(count=200)
        strategy = ICT2022Strategy(StrategyConfig(name="ict-2022"))
        signals = strategy.analyze(data)
        assert len(signals) >= 1
        assert signals[0].action in (SignalAction.BUY, SignalAction.SELL, SignalAction.HOLD)
        assert 0 <= signals[0].confidence <= 1.0

    def test_too_few_candles(self):
        data = _make_data(count=20)
        strategy = ICT2022Strategy(StrategyConfig(name="ict-2022"))
        signals = strategy.analyze(data)
        assert len(signals) == 0

    def test_has_phase_indicators(self):
        data = _make_data(count=200)
        strategy = ICT2022Strategy(StrategyConfig(name="ict-2022"))
        signals = strategy.analyze(data)
        if signals:
            assert "phase1_sweep" in signals[0].indicators
            assert "phase2_mss" in signals[0].indicators
            assert "phase3_disp_fvg" in signals[0].indicators
            assert "composite" in signals[0].indicators

    def test_confidence_bounded(self):
        data = _make_data(count=200)
        strategy = ICT2022Strategy(StrategyConfig(name="ict-2022"))
        signals = strategy.analyze(data)
        for s in signals:
            assert 0 <= s.confidence <= 1.0

    def test_forex_pair(self):
        asset = AssetInfo(symbol="GBP/USD", asset_class=AssetClass.FOREX, base_currency="GBP", quote_currency="USD")
        candles = generate_synthetic_candles("GBP/USD", 200)
        data = MarketData(asset=asset, timeframe="1h", candles=candles, last_updated=0)
        strategy = ICT2022Strategy(StrategyConfig(name="ict-2022"))
        signals = strategy.analyze(data)
        assert len(signals) >= 1


class TestSMCv3Enhancements:
    """Test the Power of 3, breaker block, and Unicorn zone enhancements."""

    def test_smc_still_works(self):
        data = _make_data(count=200)
        strategy = SMCStrategy(StrategyConfig(name="smc"))
        signals = strategy.analyze(data)
        assert len(signals) >= 1
        assert "composite" in signals[0].indicators

    def test_has_new_indicators(self):
        data = _make_data(count=200)
        strategy = SMCStrategy(StrategyConfig(name="smc"))
        signals = strategy.analyze(data)
        if signals:
            assert "unicorn_hit" in signals[0].indicators
            assert "breaker_hit" in signals[0].indicators


class TestICTIndicators:
    """Test the new ICT indicator building blocks."""

    def test_breaker_blocks(self):
        from shared.indicators import detect_breaker_blocks
        candles = generate_synthetic_candles("BTC/USDT", 200)
        breakers = detect_breaker_blocks(candles)
        # Should return a list (may be empty depending on synthetic data)
        assert isinstance(breakers, list)

    def test_unicorn_zones(self):
        from shared.indicators import detect_unicorn_zones
        candles = generate_synthetic_candles("BTC/USDT", 200)
        zones = detect_unicorn_zones(candles)
        assert isinstance(zones, list)

    def test_kill_zone_detection(self):
        from shared.indicators import is_in_kill_zone, LONDON_KILL_ZONE
        # 3:00 AM EST = 8:00 AM UTC = ts for that time
        # Simulate: Jan 1 2026 08:00 UTC (= 3:00 AM EST)
        ts = 1_767_254_400_000  # approximate
        result = is_in_kill_zone(ts, LONDON_KILL_ZONE)
        assert isinstance(result, bool)

    def test_session_phase_detection(self):
        from shared.indicators import detect_po3_phase, SessionPhase
        # Any timestamp should return a valid phase
        phase = detect_po3_phase(1_767_254_400_000)
        assert phase in (SessionPhase.ACCUMULATION, SessionPhase.MANIPULATION, SessionPhase.DISTRIBUTION)

    def test_silver_bullet_window(self):
        from shared.indicators import get_active_silver_bullet
        result = get_active_silver_bullet(1_767_254_400_000)
        # Should return KillZone or None
        assert result is None or hasattr(result, "name")

    def test_previous_day_hl(self):
        from shared.indicators import get_previous_day_hl
        candles = generate_synthetic_candles("EUR/USD", 200)
        result = get_previous_day_hl(candles)
        # May be None if synthetic data doesn't span 2 days
        assert result is None or (isinstance(result, tuple) and len(result) == 2)


class TestFactory:
    def test_create_all(self):
        strategies = get_all_strategies()
        assert len(strategies) == 7

    def test_create_by_name(self):
        s = create_strategy("momentum")
        assert s.config.name == "momentum"

    def test_create_silver_bullet(self):
        s = create_strategy("silver-bullet")
        assert s.config.name == "silver-bullet"

    def test_create_ict_2022(self):
        s = create_strategy("ict-2022")
        assert s.config.name == "ict-2022"

    def test_unknown_strategy(self):
        with pytest.raises(ValueError):
            create_strategy("nonexistent")
