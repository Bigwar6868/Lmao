"""Tests for technical indicators."""

import pytest
from shared.types import Candle
from shared.indicators import (
    sma, ema, rsi, macd, atr, bollinger_bands, stochastic,
    detect_swing_points, detect_fair_value_gaps, detect_liquidity_sweeps,
    detect_displacement, detect_market_structure, detect_order_blocks,
    premium_discount_zone, is_in_ote_zone,
)
from shared.synthetic import generate_synthetic_candles


def _make_candles(prices: list[float]) -> list[Candle]:
    return [Candle(timestamp=i * 1000, open=p, high=p * 1.01, low=p * 0.99, close=p, volume=100) for i, p in enumerate(prices)]


class TestSMA:
    def test_basic(self):
        candles = _make_candles([10, 20, 30, 40, 50])
        result = sma(candles, 3)
        assert result[0] is None
        assert result[1] is None
        assert result[2] == pytest.approx(20.0)
        assert result[3] == pytest.approx(30.0)
        assert result[4] == pytest.approx(40.0)

    def test_period_equals_length(self):
        candles = _make_candles([10, 20, 30])
        result = sma(candles, 3)
        assert result[2] == pytest.approx(20.0)


class TestEMA:
    def test_basic(self):
        candles = _make_candles([10, 20, 30, 40, 50])
        result = ema(candles, 3)
        assert result[0] is None
        assert result[1] is None
        assert result[2] is not None
        assert result[4] is not None

    def test_ema_reacts_faster_than_sma(self):
        prices = [10, 10, 10, 10, 10, 50, 50, 50]
        candles = _make_candles(prices)
        sma_vals = sma(candles, 3)
        ema_vals = ema(candles, 3)
        # After a jump, EMA should be closer to current price than SMA
        assert ema_vals[5] > sma_vals[5]


class TestRSI:
    def test_range(self):
        candles = generate_synthetic_candles("TEST", 50)
        result = rsi(candles, 14)
        for val in result:
            if val is not None:
                assert 0 <= val <= 100

    def test_uptrend_high_rsi(self):
        # Consistent uptrend should give high RSI
        prices = [100 + i * 2 for i in range(30)]
        candles = _make_candles(prices)
        result = rsi(candles, 14)
        assert result[-1] > 70


class TestMACD:
    def test_output_length(self):
        candles = generate_synthetic_candles("TEST", 50)
        macd_line, signal_line, histogram = macd(candles)
        assert len(macd_line) == 50
        assert len(signal_line) == 50
        assert len(histogram) == 50


class TestATR:
    def test_positive_values(self):
        candles = generate_synthetic_candles("TEST", 30)
        result = atr(candles, 14)
        for val in result:
            if val is not None:
                assert val >= 0

    def test_high_volatility(self):
        # High-volatility candles should have higher ATR
        low_vol = _make_candles([100 + i * 0.1 for i in range(20)])
        high_vol = [Candle(timestamp=i * 1000, open=100, high=110, low=90, close=100, volume=100) for i in range(20)]
        atr_low = atr(low_vol, 14)
        atr_high = atr(high_vol, 14)
        low_val = next((v for v in reversed(atr_low) if v is not None), 0)
        high_val = next((v for v in reversed(atr_high) if v is not None), 0)
        assert high_val > low_val


class TestBollingerBands:
    def test_structure(self):
        candles = generate_synthetic_candles("TEST", 30)
        upper, middle, lower = bollinger_bands(candles, 20)
        for i in range(len(candles)):
            if upper[i] is not None:
                assert upper[i] >= middle[i] >= lower[i]


class TestStochastic:
    def test_range(self):
        candles = generate_synthetic_candles("TEST", 30)
        k, d = stochastic(candles, 14, 3)
        for val in k:
            if val is not None:
                assert 0 <= val <= 100


# ============================================================
# SMC / ICT Indicator Tests
# ============================================================


def _make_swing_candles() -> list[Candle]:
    """Create candles with clear swing highs and lows for testing."""
    # Pattern: up, down, up higher, down lower — creates detectable swings
    prices = [
        100, 102, 104, 106, 108,   # up
        106, 104, 102, 100, 98,    # down (swing high at index 4)
        100, 102, 104, 106, 110,   # up higher
        108, 106, 104, 102, 96,    # down (swing high at index 14)
        98, 100, 102, 104, 106,    # up
        104, 102, 100, 98, 94,     # down (swing high at ~24)
    ]
    return [
        Candle(
            timestamp=i * 3600000, open=p - 0.5, high=p + 1,
            low=p - 1, close=p, volume=1000,
        )
        for i, p in enumerate(prices)
    ]


class TestSwingPoints:
    def test_detects_swings(self):
        candles = _make_swing_candles()
        swings = detect_swing_points(candles, lookback=3)
        assert len(swings) > 0
        highs = [s for s in swings if s.is_high]
        lows = [s for s in swings if not s.is_high]
        assert len(highs) >= 1
        assert len(lows) >= 1

    def test_swing_high_is_local_max(self):
        candles = _make_swing_candles()
        swings = detect_swing_points(candles, lookback=3)
        for s in swings:
            if s.is_high:
                assert s.price == candles[s.index].high

    def test_too_few_candles(self):
        candles = _make_swing_candles()[:5]
        swings = detect_swing_points(candles, lookback=5)
        assert len(swings) == 0

    def test_with_synthetic(self):
        candles = generate_synthetic_candles("BTC/USDT", 200)
        swings = detect_swing_points(candles, lookback=5)
        assert len(swings) > 0


class TestFairValueGaps:
    def test_bullish_fvg(self):
        # Create a bullish FVG: candle1.high < candle3.low
        candles = [
            Candle(timestamp=0, open=100, high=102, low=99, close=101, volume=100),
            Candle(timestamp=1, open=103, high=108, low=103, close=107, volume=100),
            Candle(timestamp=2, open=107, high=110, low=105, close=109, volume=100),
        ]
        fvgs = detect_fair_value_gaps(candles)
        bullish = [f for f in fvgs if f.is_bullish]
        assert len(bullish) == 1
        assert bullish[0].bottom == 102  # candle1 high
        assert bullish[0].top == 105     # candle3 low
        assert bullish[0].ce == pytest.approx(103.5)

    def test_bearish_fvg(self):
        # Create a bearish FVG: candle1.low > candle3.high
        candles = [
            Candle(timestamp=0, open=110, high=112, low=108, close=109, volume=100),
            Candle(timestamp=1, open=106, high=107, low=100, close=101, volume=100),
            Candle(timestamp=2, open=101, high=105, low=99, close=100, volume=100),
        ]
        fvgs = detect_fair_value_gaps(candles)
        bearish = [f for f in fvgs if not f.is_bullish]
        assert len(bearish) == 1
        assert bearish[0].top == 108     # candle1 low
        assert bearish[0].bottom == 105  # candle3 high

    def test_no_gap(self):
        # Overlapping wicks — no FVG
        candles = [
            Candle(timestamp=0, open=100, high=105, low=99, close=103, volume=100),
            Candle(timestamp=1, open=103, high=106, low=102, close=105, volume=100),
            Candle(timestamp=2, open=105, high=107, low=104, close=106, volume=100),
        ]
        fvgs = detect_fair_value_gaps(candles)
        assert len(fvgs) == 0

    def test_with_synthetic(self):
        candles = generate_synthetic_candles("ETH/USDT", 200)
        fvgs = detect_fair_value_gaps(candles)
        # Synthetic data may or may not have FVGs — just ensure no crash
        assert isinstance(fvgs, list)


class TestDisplacement:
    def test_detects_large_candles(self):
        candles = generate_synthetic_candles("BTC/USDT", 100)
        disps = detect_displacement(candles, atr_period=14, threshold=1.5)
        # Each displacement should have strength >= threshold
        for idx, strength, is_bull in disps:
            assert strength >= 1.5
            assert isinstance(is_bull, bool)

    def test_no_displacement_in_flat_market(self):
        # Flat market: all candles same size, small bodies
        candles = [
            Candle(timestamp=i * 1000, open=100, high=100.1, low=99.9, close=100, volume=100)
            for i in range(50)
        ]
        disps = detect_displacement(candles, atr_period=14, threshold=1.5)
        assert len(disps) == 0


class TestMarketStructure:
    def test_detects_breaks(self):
        candles = generate_synthetic_candles("BTC/USDT", 200)
        breaks = detect_market_structure(candles, swing_lookback=5, atr_period=14)
        # At least should not crash; in trending data we may get breaks
        assert isinstance(breaks, list)
        for b in breaks:
            assert isinstance(b.is_bullish, bool)
            assert isinstance(b.is_choch, bool)


class TestOrderBlocks:
    def test_detects_obs(self):
        candles = generate_synthetic_candles("BTC/USDT", 200)
        obs = detect_order_blocks(candles, swing_lookback=5, atr_period=14)
        assert isinstance(obs, list)
        for ob in obs:
            assert ob.high >= ob.low
            assert ob.midpoint == pytest.approx((ob.high + ob.low) / 2)


class TestLiquiditySweeps:
    def test_detects_sweeps(self):
        candles = generate_synthetic_candles("BTC/USDT", 200)
        sweeps = detect_liquidity_sweeps(candles, swing_lookback=5)
        assert isinstance(sweeps, list)
        for s in sweeps:
            assert isinstance(s.is_buy_side, bool)
            assert s.reversal_strength > 0


class TestPremiumDiscount:
    def test_discount_zone(self):
        eq, is_disc, pct = premium_discount_zone(200, 100, 120)
        assert eq == 150
        assert is_disc is True
        assert pct == pytest.approx(0.6)  # 30/50

    def test_premium_zone(self):
        eq, is_disc, pct = premium_discount_zone(200, 100, 180)
        assert eq == 150
        assert is_disc is False
        assert pct == pytest.approx(0.6)

    def test_at_equilibrium(self):
        eq, is_disc, pct = premium_discount_zone(200, 100, 150)
        assert pct == pytest.approx(0.0)


class TestOTEZone:
    def test_bullish_ote(self):
        # Bullish OTE: price in 62%-79% retracement from high
        # Range 100-200. 62% retrace = 200 - 100*0.618 = 138.2
        # 79% retrace = 200 - 100*0.786 = 121.4
        assert is_in_ote_zone(200, 100, 130, is_bullish=True) is True
        assert is_in_ote_zone(200, 100, 150, is_bullish=True) is False  # too shallow
        assert is_in_ote_zone(200, 100, 110, is_bullish=True) is False  # too deep

    def test_bearish_ote(self):
        # Bearish OTE: price in 62%-79% retracement from low
        # Range 100-200. 62% retrace from low = 100 + 100*0.618 = 161.8
        # 79% retrace from low = 100 + 100*0.786 = 178.6
        assert is_in_ote_zone(200, 100, 170, is_bullish=False) is True
        assert is_in_ote_zone(200, 100, 150, is_bullish=False) is False  # too shallow
        assert is_in_ote_zone(200, 100, 190, is_bullish=False) is False  # too deep
