"""Technical indicators computed from candle data."""

from __future__ import annotations

import math
from shared.types import Candle


def sma(candles: list[Candle], period: int) -> list[float | None]:
    """Simple Moving Average."""
    closes = [c.close for c in candles]
    result: list[float | None] = [None] * len(closes)
    for i in range(period - 1, len(closes)):
        result[i] = sum(closes[i - period + 1 : i + 1]) / period
    return result


def ema(candles: list[Candle], period: int) -> list[float | None]:
    """Exponential Moving Average."""
    closes = [c.close for c in candles]
    result: list[float | None] = [None] * len(closes)
    if len(closes) < period:
        return result

    k = 2 / (period + 1)
    # Seed with SMA
    result[period - 1] = sum(closes[:period]) / period
    for i in range(period, len(closes)):
        prev = result[i - 1]
        if prev is not None:
            result[i] = closes[i] * k + prev * (1 - k)
    return result


def rsi(candles: list[Candle], period: int = 14) -> list[float | None]:
    """Relative Strength Index."""
    closes = [c.close for c in candles]
    result: list[float | None] = [None] * len(closes)
    if len(closes) < period + 1:
        return result

    gains: list[float] = []
    losses: list[float] = []
    for i in range(1, period + 1):
        change = closes[i] - closes[i - 1]
        gains.append(max(change, 0))
        losses.append(max(-change, 0))

    avg_gain = sum(gains) / period
    avg_loss = sum(losses) / period

    if avg_loss == 0:
        result[period] = 100.0
    else:
        rs = avg_gain / avg_loss
        result[period] = 100 - (100 / (1 + rs))

    for i in range(period + 1, len(closes)):
        change = closes[i] - closes[i - 1]
        gain = max(change, 0)
        loss = max(-change, 0)
        avg_gain = (avg_gain * (period - 1) + gain) / period
        avg_loss = (avg_loss * (period - 1) + loss) / period
        if avg_loss == 0:
            result[i] = 100.0
        else:
            rs = avg_gain / avg_loss
            result[i] = 100 - (100 / (1 + rs))

    return result


def macd(
    candles: list[Candle],
    fast: int = 12,
    slow: int = 26,
    signal_period: int = 9,
) -> tuple[list[float | None], list[float | None], list[float | None]]:
    """MACD line, signal line, and histogram."""
    fast_ema = ema(candles, fast)
    slow_ema = ema(candles, slow)

    macd_line: list[float | None] = [None] * len(candles)
    for i in range(len(candles)):
        if fast_ema[i] is not None and slow_ema[i] is not None:
            macd_line[i] = fast_ema[i] - slow_ema[i]

    # Signal line = EMA of MACD line
    signal_line: list[float | None] = [None] * len(candles)
    macd_vals = [v for v in macd_line if v is not None]
    if len(macd_vals) >= signal_period:
        k = 2 / (signal_period + 1)
        start_idx = next(i for i, v in enumerate(macd_line) if v is not None)
        first_valid = [macd_line[i] for i in range(start_idx, start_idx + signal_period)]
        signal_line[start_idx + signal_period - 1] = sum(first_valid) / signal_period
        for i in range(start_idx + signal_period, len(candles)):
            if macd_line[i] is not None and signal_line[i - 1] is not None:
                signal_line[i] = macd_line[i] * k + signal_line[i - 1] * (1 - k)

    histogram: list[float | None] = [None] * len(candles)
    for i in range(len(candles)):
        if macd_line[i] is not None and signal_line[i] is not None:
            histogram[i] = macd_line[i] - signal_line[i]

    return macd_line, signal_line, histogram


def atr(candles: list[Candle], period: int = 14) -> list[float | None]:
    """Average True Range."""
    result: list[float | None] = [None] * len(candles)
    if len(candles) < 2:
        return result

    true_ranges: list[float] = []
    for i in range(1, len(candles)):
        h = candles[i].high
        lo = candles[i].low
        pc = candles[i - 1].close
        tr = max(h - lo, abs(h - pc), abs(lo - pc))
        true_ranges.append(tr)

    if len(true_ranges) < period:
        return result

    # First ATR is SMA of true ranges
    result[period] = sum(true_ranges[:period]) / period
    for i in range(period + 1, len(candles)):
        prev = result[i - 1]
        if prev is not None:
            result[i] = (prev * (period - 1) + true_ranges[i - 1]) / period

    return result


def bollinger_bands(
    candles: list[Candle], period: int = 20, num_std: float = 2.0,
) -> tuple[list[float | None], list[float | None], list[float | None]]:
    """Bollinger Bands (upper, middle, lower)."""
    middle = sma(candles, period)
    closes = [c.close for c in candles]

    upper: list[float | None] = [None] * len(candles)
    lower: list[float | None] = [None] * len(candles)

    for i in range(period - 1, len(candles)):
        if middle[i] is not None:
            window = closes[i - period + 1 : i + 1]
            std = math.sqrt(sum((x - middle[i]) ** 2 for x in window) / period)
            upper[i] = middle[i] + num_std * std
            lower[i] = middle[i] - num_std * std

    return upper, middle, lower


def stochastic(
    candles: list[Candle], k_period: int = 14, d_period: int = 3,
) -> tuple[list[float | None], list[float | None]]:
    """Stochastic Oscillator (%K and %D)."""
    k_vals: list[float | None] = [None] * len(candles)

    for i in range(k_period - 1, len(candles)):
        window = candles[i - k_period + 1 : i + 1]
        highest = max(c.high for c in window)
        lowest = min(c.low for c in window)
        if highest != lowest:
            k_vals[i] = ((candles[i].close - lowest) / (highest - lowest)) * 100
        else:
            k_vals[i] = 50.0

    # %D = SMA of %K
    d_vals: list[float | None] = [None] * len(candles)
    for i in range(len(candles)):
        if i >= k_period - 1 + d_period - 1:
            window = [k_vals[j] for j in range(i - d_period + 1, i + 1) if k_vals[j] is not None]
            if len(window) == d_period:
                d_vals[i] = sum(window) / d_period

    return k_vals, d_vals
