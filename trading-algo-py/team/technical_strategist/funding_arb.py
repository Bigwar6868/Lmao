"""Funding Rate Arbitrage strategy for crypto perpetual futures.

Simulates funding rate from price momentum and volatility. High positive
funding (overleveraged longs) signals SHORT; high negative funding
(overleveraged shorts) signals LONG.
"""

from __future__ import annotations

import logging
import math
import time
import uuid

from shared.types import (
    AssetInfo, Candle, MarketData, Signal, SignalAction,
    StrategyConfig, StrategyDNA,
)
from shared.indicators import sma, ema, atr, rsi, bollinger_bands

log = logging.getLogger(__name__)


# ============================================================
# Helpers
# ============================================================


def estimate_funding_rate(candles: list[Candle]) -> float:
    """Estimate implied funding rate from price dynamics.

    The funding rate is approximated by combining:
    1. Price premium/discount relative to a slow moving average (basis proxy).
    2. Short-term momentum (fast vs slow EMA spread).
    3. Volatility scaling — high volatility amplifies the estimate.

    Returns a value in percentage terms (e.g., 0.08 means 0.08%).
    Positive = longs pay shorts (market overleveraged long).
    Negative = shorts pay longs (market overleveraged short).
    """
    n = len(candles)
    if n < 50:
        return 0.0

    closes = [c.close for c in candles]

    # 1. Basis proxy: close vs SMA-50 as percentage
    sma_50 = sma(candles, 50)
    if sma_50[-1] is None or sma_50[-1] == 0:
        return 0.0
    basis = (closes[-1] - sma_50[-1]) / sma_50[-1]

    # 2. Momentum spread: EMA-8 vs EMA-21
    ema_8 = ema(candles, 8)
    ema_21 = ema(candles, 21)
    if ema_8[-1] is None or ema_21[-1] is None or ema_21[-1] == 0:
        return 0.0
    momentum_spread = (ema_8[-1] - ema_21[-1]) / ema_21[-1]

    # 3. Volatility scaling: ATR / close
    atr_vals = atr(candles, 14)
    if atr_vals[-1] is None or closes[-1] == 0:
        vol_scale = 1.0
    else:
        vol_pct = atr_vals[-1] / closes[-1]
        # Scale: low vol (< 1%) dampens, high vol (> 3%) amplifies
        vol_scale = max(0.5, min(2.0, vol_pct / 0.02))

    # Combine components into estimated funding rate (in %)
    # Weights: basis dominates, momentum adds directionality
    raw_rate = (basis * 0.6 + momentum_spread * 0.4) * 100.0 * vol_scale

    # Clamp to realistic range (-0.5% to 0.5%)
    return max(-0.5, min(0.5, raw_rate))


def _funding_rate_consistency(candles: list[Candle], lookback: int = 8) -> float:
    """Measure how consistently the funding rate has been in one direction.

    Computes the funding rate estimate for trailing sub-windows and returns
    the fraction (0-1) that agree with the current direction.
    """
    n = len(candles)
    if n < 50 + lookback:
        return 0.0

    current_rate = estimate_funding_rate(candles)
    if abs(current_rate) < 1e-8:
        return 0.0

    current_sign = 1 if current_rate > 0 else -1
    agree_count = 0

    for offset in range(1, lookback + 1):
        sub_candles = candles[: n - offset]
        if len(sub_candles) < 50:
            break
        rate = estimate_funding_rate(sub_candles)
        if (rate > 0 and current_sign > 0) or (rate < 0 and current_sign < 0):
            agree_count += 1

    return agree_count / lookback


# ============================================================
# Strategy
# ============================================================


class FundingArbStrategy:
    """Funding Rate Arbitrage strategy.

    Generates signals when the estimated funding rate exceeds a threshold,
    indicating overleveraged positioning in perpetual futures.

    - High positive funding (> threshold) -> SHORT signal
    - High negative funding (< -threshold) -> LONG signal
    """

    DEFAULT_THRESHOLD = 0.05  # 0.05% funding rate threshold
    DEFAULT_MAX_THRESHOLD = 0.30  # rates above this are extreme

    def __init__(
        self,
        config: StrategyConfig,
        dna: StrategyDNA | None = None,
    ) -> None:
        self.config = config
        self.dna = dna or self._get_default_dna()
        self._threshold = self.dna.params.get("funding_threshold", self.DEFAULT_THRESHOLD)
        self._max_threshold = self.dna.params.get("max_threshold", self.DEFAULT_MAX_THRESHOLD)

    def analyze(self, data: MarketData) -> list[Signal]:
        """Analyze market data and generate funding arbitrage signals.

        Args:
            data: Market data including candles.

        Returns:
            List of signals (at most one per call).
        """
        candles = data.candles
        if len(candles) < 50:
            log.debug("FundingArb: not enough candles (%d < 50)", len(candles))
            return []

        funding_rate = estimate_funding_rate(candles)
        abs_rate = abs(funding_rate)

        if abs_rate < self._threshold:
            log.debug("FundingArb: funding rate %.4f%% below threshold", funding_rate)
            return []

        # Direction: positive funding -> SHORT, negative -> LONG
        if funding_rate > 0:
            action = SignalAction.SELL
            reason = (
                f"High positive funding rate ({funding_rate:.4f}%) indicates "
                f"overleveraged longs — shorting for mean reversion"
            )
        else:
            action = SignalAction.BUY
            reason = (
                f"High negative funding rate ({funding_rate:.4f}%) indicates "
                f"overleveraged shorts — longing for mean reversion"
            )

        # Confidence: based on magnitude and consistency
        magnitude_score = min(abs_rate / self._max_threshold, 1.0)
        consistency = _funding_rate_consistency(candles)
        confidence = 0.4 * magnitude_score + 0.4 * consistency + 0.2

        # Clamp confidence
        confidence = max(0.1, min(0.95, confidence))

        # Supporting indicators
        rsi_vals = rsi(candles, 14)
        current_rsi = rsi_vals[-1] if rsi_vals[-1] is not None else 50.0
        atr_vals = atr(candles, 14)
        current_atr = atr_vals[-1] if atr_vals[-1] is not None else 0.0

        # RSI confluence bonus: overbought + short signal or oversold + long signal
        if action == SignalAction.SELL and current_rsi > 70:
            confidence = min(0.95, confidence + 0.05)
            reason += f" | RSI overbought ({current_rsi:.1f})"
        elif action == SignalAction.BUY and current_rsi < 30:
            confidence = min(0.95, confidence + 0.05)
            reason += f" | RSI oversold ({current_rsi:.1f})"

        signal = Signal(
            asset=data.asset,
            action=action,
            confidence=confidence,
            price=candles[-1].close,
            timestamp=int(time.time() * 1000),
            strategy=self.config.name,
            timeframe=data.timeframe,
            indicators={
                "funding_rate": funding_rate,
                "funding_magnitude": magnitude_score,
                "funding_consistency": consistency,
                "rsi": current_rsi,
                "atr": current_atr,
            },
            reason=reason,
        )

        log.info(
            "FundingArb signal: %s %s @ %.4f (confidence=%.3f, funding=%.4f%%)",
            action.value, data.asset.symbol, candles[-1].close,
            confidence, funding_rate,
        )
        return [signal]

    @staticmethod
    def _get_default_dna() -> StrategyDNA:
        return StrategyDNA(
            id="funding-arb-default",
            name="funding_arb",
            generation=0,
            params={
                "funding_threshold": FundingArbStrategy.DEFAULT_THRESHOLD,
                "max_threshold": FundingArbStrategy.DEFAULT_MAX_THRESHOLD,
            },
        )
