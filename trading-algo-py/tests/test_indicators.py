"""Tests for technical indicators."""

import pytest
from shared.types import Candle
from shared.indicators import sma, ema, rsi, macd, atr, bollinger_bands, stochastic
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
