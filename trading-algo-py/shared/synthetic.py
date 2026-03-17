"""Synthetic OHLCV data generator for cloud/testing fallback."""

from __future__ import annotations

import random
import time
from shared.types import Candle

# Default base prices for common assets
DEFAULT_PRICES: dict[str, float] = {
    "BTC/USDT": 65000, "ETH/USDT": 3500, "BNB/USDT": 580, "SOL/USDT": 170,
    "XRP/USDT": 0.62, "ADA/USDT": 0.45, "AVAX/USDT": 35, "DOGE/USDT": 0.15,
    "DOT/USDT": 7.5, "MATIC/USDT": 0.85, "LINK/USDT": 14, "UNI/USDT": 9.5,
    "EUR/USD": 1.0850, "GBP/USD": 1.2650, "USD/JPY": 150.50,
    "USD/CHF": 0.8750, "AUD/USD": 0.6550, "USD/CAD": 1.3550,
}


def generate_synthetic_candles(
    symbol: str,
    count: int = 100,
    interval_ms: int = 3_600_000,
    volatility: float = 0.02,
    base_price: float | None = None,
) -> list[Candle]:
    """Generate realistic synthetic OHLCV candles."""
    price = base_price or DEFAULT_PRICES.get(symbol, 100.0)
    now = int(time.time() * 1000)
    start = now - (count * interval_ms)
    candles: list[Candle] = []

    for i in range(count):
        change = random.gauss(0, volatility)
        # Slight upward bias
        change += 0.0001

        o = price
        c = price * (1 + change)

        high_ext = abs(change) * random.uniform(0.5, 2.0)
        low_ext = abs(change) * random.uniform(0.5, 2.0)

        h = max(o, c) * (1 + high_ext)
        lo = min(o, c) * (1 - low_ext)

        vol = random.uniform(100, 10000) if "USD" not in symbol.split("/")[1:] else 0

        candles.append(Candle(
            timestamp=start + i * interval_ms,
            open=round(o, 8),
            high=round(h, 8),
            low=round(lo, 8),
            close=round(c, 8),
            volume=round(vol, 2),
        ))
        price = c

    return candles
