"""Four trading strategies: momentum, mean-reversion, breakout, multi-indicator."""

from __future__ import annotations

import time
import uuid
import logging
from abc import ABC, abstractmethod

from shared.types import (
    AssetInfo, Candle, MarketData, Signal, SignalAction,
    StrategyConfig, StrategyDNA,
)
from shared.indicators import sma, ema, rsi, macd, atr, bollinger_bands, stochastic

log = logging.getLogger(__name__)


class BaseStrategy(ABC):
    """Base class for all trading strategies."""

    def __init__(self, config: StrategyConfig, dna: StrategyDNA | None = None) -> None:
        self.config = config
        self.dna = dna or self.get_default_dna()

    @abstractmethod
    def analyze(self, data: MarketData) -> list[Signal]:
        ...

    @abstractmethod
    def get_default_dna(self) -> StrategyDNA:
        ...

    def _make_signal(
        self, asset: AssetInfo, action: SignalAction, confidence: float,
        price: float, timeframe: str, indicators: dict[str, float], reason: str,
    ) -> Signal:
        return Signal(
            asset=asset,
            action=action,
            confidence=min(max(confidence, 0.0), 1.0),
            price=price,
            timestamp=int(time.time() * 1000),
            strategy=self.config.name,
            timeframe=timeframe,
            indicators=indicators,
            reason=reason,
        )


class MomentumStrategy(BaseStrategy):
    """Momentum strategy using EMA crossovers + RSI confirmation."""

    def get_default_dna(self) -> StrategyDNA:
        return StrategyDNA(
            id=str(uuid.uuid4())[:8],
            name="momentum",
            params={"fast_ema": 12, "slow_ema": 26, "rsi_period": 14,
                    "rsi_overbought": 70, "rsi_oversold": 30, "min_confidence": 0.5},
        )

    def analyze(self, data: MarketData) -> list[Signal]:
        candles = data.candles
        if len(candles) < 30:
            return []

        p = self.dna.params
        fast = ema(candles, int(p.get("fast_ema", 12)))
        slow = ema(candles, int(p.get("slow_ema", 26)))
        rsi_vals = rsi(candles, int(p.get("rsi_period", 14)))

        i = len(candles) - 1
        if fast[i] is None or slow[i] is None or rsi_vals[i] is None:
            return []
        if fast[i - 1] is None or slow[i - 1] is None:
            return []

        indicators = {
            "fast_ema": fast[i], "slow_ema": slow[i], "rsi": rsi_vals[i],
        }

        # Bullish crossover
        if fast[i - 1] <= slow[i - 1] and fast[i] > slow[i]:
            if rsi_vals[i] < p.get("rsi_overbought", 70):
                conf = 0.6 + (fast[i] - slow[i]) / slow[i] * 10
                return [self._make_signal(
                    data.asset, SignalAction.BUY, conf, candles[i].close,
                    data.timeframe, indicators, "EMA bullish crossover with RSI confirmation",
                )]

        # Bearish crossover
        if fast[i - 1] >= slow[i - 1] and fast[i] < slow[i]:
            if rsi_vals[i] > p.get("rsi_oversold", 30):
                conf = 0.6 + (slow[i] - fast[i]) / slow[i] * 10
                return [self._make_signal(
                    data.asset, SignalAction.SELL, conf, candles[i].close,
                    data.timeframe, indicators, "EMA bearish crossover with RSI confirmation",
                )]

        return [self._make_signal(
            data.asset, SignalAction.HOLD, 0.3, candles[i].close,
            data.timeframe, indicators, "No momentum signal",
        )]


class MeanReversionStrategy(BaseStrategy):
    """Mean reversion using Bollinger Bands + RSI extremes."""

    def get_default_dna(self) -> StrategyDNA:
        return StrategyDNA(
            id=str(uuid.uuid4())[:8],
            name="mean-reversion",
            params={"bb_period": 20, "bb_std": 2.0, "rsi_period": 14,
                    "rsi_oversold": 30, "rsi_overbought": 70},
        )

    def analyze(self, data: MarketData) -> list[Signal]:
        candles = data.candles
        if len(candles) < 25:
            return []

        p = self.dna.params
        upper, middle, lower = bollinger_bands(candles, int(p.get("bb_period", 20)), p.get("bb_std", 2.0))
        rsi_vals = rsi(candles, int(p.get("rsi_period", 14)))

        i = len(candles) - 1
        if upper[i] is None or lower[i] is None or rsi_vals[i] is None:
            return []

        price = candles[i].close
        indicators = {
            "bb_upper": upper[i], "bb_middle": middle[i], "bb_lower": lower[i],
            "rsi": rsi_vals[i], "price": price,
        }

        # Price below lower band + RSI oversold = buy
        if price <= lower[i] and rsi_vals[i] < p.get("rsi_oversold", 30):
            bb_width = upper[i] - lower[i]
            dist = (lower[i] - price) / bb_width if bb_width > 0 else 0
            conf = 0.55 + dist * 2
            return [self._make_signal(
                data.asset, SignalAction.BUY, conf, price,
                data.timeframe, indicators, "Price below lower BB + RSI oversold",
            )]

        # Price above upper band + RSI overbought = sell
        if price >= upper[i] and rsi_vals[i] > p.get("rsi_overbought", 70):
            bb_width = upper[i] - lower[i]
            dist = (price - upper[i]) / bb_width if bb_width > 0 else 0
            conf = 0.55 + dist * 2
            return [self._make_signal(
                data.asset, SignalAction.SELL, conf, price,
                data.timeframe, indicators, "Price above upper BB + RSI overbought",
            )]

        return [self._make_signal(
            data.asset, SignalAction.HOLD, 0.3, price,
            data.timeframe, indicators, "Price within Bollinger Bands",
        )]


class BreakoutStrategy(BaseStrategy):
    """Breakout strategy using price channels + volume/ATR confirmation."""

    def get_default_dna(self) -> StrategyDNA:
        return StrategyDNA(
            id=str(uuid.uuid4())[:8],
            name="breakout",
            params={"lookback": 20, "atr_period": 14, "atr_multiplier": 1.5,
                    "volume_threshold": 1.5},
        )

    def analyze(self, data: MarketData) -> list[Signal]:
        candles = data.candles
        lookback = int(self.dna.params.get("lookback", 20))
        if len(candles) < lookback + 5:
            return []

        i = len(candles) - 1
        window = candles[i - lookback : i]
        highest = max(c.high for c in window)
        lowest = min(c.low for c in window)
        price = candles[i].close

        atr_vals = atr(candles, int(self.dna.params.get("atr_period", 14)))
        atr_val = atr_vals[i]

        # Volume check (skip for forex where volume = 0)
        avg_vol = sum(c.volume for c in window) / len(window) if window[0].volume > 0 else 0
        cur_vol = candles[i].volume
        vol_ratio = cur_vol / avg_vol if avg_vol > 0 else 1.0

        indicators = {
            "channel_high": highest, "channel_low": lowest,
            "atr": atr_val or 0, "volume_ratio": vol_ratio,
        }

        atr_mult = self.dna.params.get("atr_multiplier", 1.5)
        vol_thresh = self.dna.params.get("volume_threshold", 1.5)

        # Bullish breakout
        if price > highest:
            vol_ok = vol_ratio >= vol_thresh or avg_vol == 0  # Skip vol check for forex
            if atr_val and vol_ok:
                breakout_strength = (price - highest) / (atr_val * atr_mult) if atr_val else 0
                conf = 0.5 + min(breakout_strength, 0.4)
                return [self._make_signal(
                    data.asset, SignalAction.BUY, conf, price,
                    data.timeframe, indicators, f"Bullish breakout above {lookback}-period high",
                )]

        # Bearish breakout
        if price < lowest:
            vol_ok = vol_ratio >= vol_thresh or avg_vol == 0
            if atr_val and vol_ok:
                breakout_strength = (lowest - price) / (atr_val * atr_mult) if atr_val else 0
                conf = 0.5 + min(breakout_strength, 0.4)
                return [self._make_signal(
                    data.asset, SignalAction.SELL, conf, price,
                    data.timeframe, indicators, f"Bearish breakout below {lookback}-period low",
                )]

        return [self._make_signal(
            data.asset, SignalAction.HOLD, 0.2, price,
            data.timeframe, indicators, "No breakout detected",
        )]


class MultiIndicatorStrategy(BaseStrategy):
    """Combines multiple indicators with weighted voting."""

    def get_default_dna(self) -> StrategyDNA:
        return StrategyDNA(
            id=str(uuid.uuid4())[:8],
            name="multi-indicator",
            params={
                "ema_fast": 9, "ema_slow": 21,
                "rsi_period": 14, "macd_fast": 12, "macd_slow": 26, "macd_signal": 9,
                "stoch_k": 14, "stoch_d": 3,
                "w_ema": 0.25, "w_rsi": 0.25, "w_macd": 0.25, "w_stoch": 0.25,
                "threshold": 0.55,
            },
        )

    def analyze(self, data: MarketData) -> list[Signal]:
        candles = data.candles
        if len(candles) < 30:
            return []

        p = self.dna.params
        i = len(candles) - 1

        # EMA crossover signal
        fast_ema = ema(candles, int(p.get("ema_fast", 9)))
        slow_ema = ema(candles, int(p.get("ema_slow", 21)))
        ema_score = 0.0
        if fast_ema[i] and slow_ema[i]:
            ema_score = 1.0 if fast_ema[i] > slow_ema[i] else -1.0

        # RSI signal
        rsi_vals = rsi(candles, int(p.get("rsi_period", 14)))
        rsi_score = 0.0
        if rsi_vals[i] is not None:
            if rsi_vals[i] < 30:
                rsi_score = 1.0
            elif rsi_vals[i] > 70:
                rsi_score = -1.0
            else:
                rsi_score = (50 - rsi_vals[i]) / 50

        # MACD signal
        macd_line, signal_line, histogram = macd(
            candles, int(p.get("macd_fast", 12)), int(p.get("macd_slow", 26)), int(p.get("macd_signal", 9)),
        )
        macd_score = 0.0
        if histogram[i] is not None:
            macd_score = 1.0 if histogram[i] > 0 else -1.0

        # Stochastic signal
        k_vals, d_vals = stochastic(candles, int(p.get("stoch_k", 14)), int(p.get("stoch_d", 3)))
        stoch_score = 0.0
        if k_vals[i] is not None:
            if k_vals[i] < 20:
                stoch_score = 1.0
            elif k_vals[i] > 80:
                stoch_score = -1.0

        # Weighted vote
        w = {
            "ema": p.get("w_ema", 0.25), "rsi": p.get("w_rsi", 0.25),
            "macd": p.get("w_macd", 0.25), "stoch": p.get("w_stoch", 0.25),
        }
        total = (
            ema_score * w["ema"] + rsi_score * w["rsi"] +
            macd_score * w["macd"] + stoch_score * w["stoch"]
        )

        indicators = {
            "ema_score": ema_score, "rsi_score": rsi_score,
            "macd_score": macd_score, "stoch_score": stoch_score,
            "composite": total,
            "rsi": rsi_vals[i] or 0, "stoch_k": k_vals[i] or 0,
        }

        threshold = p.get("threshold", 0.55)
        price = candles[i].close

        if total >= threshold:
            return [self._make_signal(
                data.asset, SignalAction.BUY, abs(total), price,
                data.timeframe, indicators, f"Multi-indicator bullish (score={total:.2f})",
            )]
        elif total <= -threshold:
            return [self._make_signal(
                data.asset, SignalAction.SELL, abs(total), price,
                data.timeframe, indicators, f"Multi-indicator bearish (score={total:.2f})",
            )]

        return [self._make_signal(
            data.asset, SignalAction.HOLD, 0.3, price,
            data.timeframe, indicators, f"Multi-indicator neutral (score={total:.2f})",
        )]


# ============================================================
# Strategy Factory
# ============================================================

ALL_STRATEGIES: dict[str, type[BaseStrategy]] = {
    "momentum": MomentumStrategy,
    "mean-reversion": MeanReversionStrategy,
    "breakout": BreakoutStrategy,
    "multi-indicator": MultiIndicatorStrategy,
}


def create_strategy(name: str, dna: StrategyDNA | None = None) -> BaseStrategy:
    cls = ALL_STRATEGIES.get(name)
    if cls is None:
        raise ValueError(f"Unknown strategy: {name}")
    config = StrategyConfig(name=name, enabled=True)
    return cls(config, dna)


def get_all_strategies() -> list[BaseStrategy]:
    return [create_strategy(name) for name in ALL_STRATEGIES]
