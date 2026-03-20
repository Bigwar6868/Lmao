"""Market Regime Detector.

Identifies the current market regime by analysing:
1. Trend direction & strength (EMA slope + price vs moving averages)
2. Volatility regime (ATR percentile)
3. Momentum (rate of change + acceleration)
4. Volume patterns (accumulation vs distribution)
5. Macro overlay (VIX, yield curve, Fed stance)

Ported from trading-algo/src/team/regime-detector/index.ts
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Literal

from shared.types import Candle, MacroEnvironment, MarketData

logger = logging.getLogger(__name__)


# ============================================================
# Types
# ============================================================

class MarketRegime(str, Enum):
    TRENDING_BULL = "trending_bull"
    TRENDING_BEAR = "trending_bear"
    RANGE_BOUND = "range_bound"
    HIGH_VOLATILITY = "high_volatility"
    LOW_VOLATILITY = "low_volatility"
    CRISIS = "crisis"
    RECOVERY = "recovery"


VolumeProfile = Literal["increasing", "decreasing", "stable"]


@dataclass
class RegimeAnalysis:
    regime: MarketRegime
    confidence: float                  # 0-1
    trend_strength: float              # -1 (strong bear) to +1 (strong bull)
    volatility_percentile: float       # 0-100
    momentum_score: float              # -1 to +1
    volume_profile: VolumeProfile
    correlation_shift: bool            # True if cross-asset correlations spiking
    details: str
    recommended_strategies: list[str] = field(default_factory=list)
    timestamp: int = 0


# ============================================================
# Helpers
# ============================================================

def _mean(values: list[float]) -> float:
    if not values:
        return 0.0
    return sum(values) / len(values)


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


# ============================================================
# Regime Detector
# ============================================================

class RegimeDetector:
    """Detect the current market regime from price data and optional macro context."""

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def detect(self, candles: list[Candle], macro: MacroEnvironment | None = None) -> RegimeAnalysis:
        """Analyse *candles* and return a :class:`RegimeAnalysis`."""
        if len(candles) < 50:
            return self._default_regime("Insufficient data")

        closes = [c.close for c in candles]
        volumes = [c.volume for c in candles]

        # 1. Trend analysis
        trend_strength = self._calculate_trend_strength(closes)

        # 2. Volatility analysis
        volatility_percentile = self._calculate_volatility_percentile(candles)

        # 3. Momentum
        momentum_score = self._calculate_momentum(closes)

        # 4. Volume profile
        volume_profile = self._analyze_volume_profile(volumes)

        # 5. Correlation shift proxy
        correlation_shift = volatility_percentile > 85

        # 6. Macro overlay
        macro_risk_multiplier = self._get_macro_multiplier(macro)

        # Determine regime
        regime = self._classify_regime(
            trend_strength, volatility_percentile, momentum_score, macro_risk_multiplier,
        )

        confidence = self._calculate_confidence(
            trend_strength, volatility_percentile, momentum_score,
        )

        analysis = RegimeAnalysis(
            regime=regime,
            confidence=confidence,
            trend_strength=trend_strength,
            volatility_percentile=volatility_percentile,
            momentum_score=momentum_score,
            volume_profile=volume_profile,
            correlation_shift=correlation_shift,
            details=self._describe_regime(regime, trend_strength, volatility_percentile),
            recommended_strategies=self._get_recommended_strategies(regime),
            timestamp=int(time.time() * 1000),
        )

        logger.info(
            "Regime detected: regime=%s confidence=%.2f trend=%.2f vol=%.0f",
            regime.value, confidence, trend_strength, volatility_percentile,
        )

        return analysis

    # ------------------------------------------------------------------
    # Trend
    # ------------------------------------------------------------------

    def _calculate_trend_strength(self, closes: list[float]) -> float:
        """Trend strength from -1 (strong bear) to +1 (strong bull).

        Uses EMA slope + price position relative to moving averages.
        """
        length = len(closes)

        ema20 = self._ema(closes, 20)
        ema50 = self._ema(closes, min(50, length - 1))

        current_price = closes[-1]
        ema20_current = ema20[-1]
        ema50_current = ema50[-1]

        above_short = 1.0 if current_price > ema20_current else -1.0
        above_long = 1.0 if current_price > ema50_current else -1.0

        # EMA slope (normalised rate of change over last 10 periods)
        if len(ema20) >= 10:
            ema20_slope = (ema20[-1] - ema20[-10]) / ema20[-10]
        else:
            ema20_slope = 0.0

        ema_alignment = 1.0 if ema20_current > ema50_current else -1.0

        raw = (above_short * 0.2) + (above_long * 0.2) + (ema_alignment * 0.3) + (ema20_slope * 30 * 0.3)
        return _clamp(raw, -1.0, 1.0)

    # ------------------------------------------------------------------
    # Volatility
    # ------------------------------------------------------------------

    def _calculate_volatility_percentile(self, candles: list[Candle]) -> float:
        """Where current ATR sits vs historical ATR distribution (0-100)."""
        atrs = self._rolling_atr(candles, 14)
        if len(atrs) < 20:
            return 50.0

        current_atr = atrs[-1]
        sorted_atrs = sorted(atrs)
        rank = 0
        for i, v in enumerate(sorted_atrs):
            if v >= current_atr:
                rank = i
                break
        else:
            rank = len(sorted_atrs)

        return (rank / len(sorted_atrs)) * 100.0

    # ------------------------------------------------------------------
    # Momentum
    # ------------------------------------------------------------------

    def _calculate_momentum(self, closes: list[float]) -> float:
        """Rate of change + acceleration, returns -1 to +1."""
        length = len(closes)
        if length < 21:
            return 0.0

        roc10 = (closes[-1] - closes[-11]) / closes[-11]
        roc20 = (closes[-1] - closes[-21]) / closes[-21]

        acceleration = roc10 - (roc20 / 2)
        normalised = (roc10 * 10) + (acceleration * 5)
        return _clamp(normalised, -1.0, 1.0)

    # ------------------------------------------------------------------
    # Volume
    # ------------------------------------------------------------------

    def _analyze_volume_profile(self, volumes: list[float]) -> VolumeProfile:
        if len(volumes) < 20:
            return "stable"

        recent = _mean(volumes[-10:])
        older = _mean(volumes[-20:-10])

        change = (recent - older) / (older or 1.0)
        if change > 0.15:
            return "increasing"
        if change < -0.15:
            return "decreasing"
        return "stable"

    # ------------------------------------------------------------------
    # Macro overlay
    # ------------------------------------------------------------------

    def _get_macro_multiplier(self, macro: MacroEnvironment | None) -> float:
        if macro is None:
            return 0.0
        mapping = {
            "extreme": -1.0,
            "high": -0.5,
            "medium": 0.0,
            "low": 0.3,
        }
        return mapping.get(macro.risk_level, 0.0)

    # ------------------------------------------------------------------
    # Classification
    # ------------------------------------------------------------------

    def _classify_regime(
        self,
        trend: float,
        vol_percentile: float,
        momentum: float,
        macro_risk: float,
    ) -> MarketRegime:
        # Crisis: extreme volatility + negative momentum + negative macro
        if vol_percentile > 90 and momentum < -0.3 and macro_risk < -0.3:
            return MarketRegime.CRISIS

        # Recovery: coming off high vol, momentum turning positive
        if 70 < vol_percentile < 90 and momentum > 0.2 and trend > 0:
            return MarketRegime.RECOVERY

        # High volatility
        if vol_percentile > 80:
            return MarketRegime.HIGH_VOLATILITY

        # Low volatility (squeeze)
        if vol_percentile < 20:
            return MarketRegime.LOW_VOLATILITY

        # Trending bull
        if trend > 0.4 and momentum > 0.1:
            return MarketRegime.TRENDING_BULL

        # Trending bear
        if trend < -0.4 and momentum < -0.1:
            return MarketRegime.TRENDING_BEAR

        return MarketRegime.RANGE_BOUND

    # ------------------------------------------------------------------
    # Confidence
    # ------------------------------------------------------------------

    def _calculate_confidence(self, trend: float, vol: float, momentum: float) -> float:
        trend_clarity = abs(trend)
        vol_extreme = abs(vol - 50) / 50
        momentum_clarity = abs(momentum)
        return min(1.0, trend_clarity * 0.4 + vol_extreme * 0.3 + momentum_clarity * 0.3)

    # ------------------------------------------------------------------
    # Description & recommendations
    # ------------------------------------------------------------------

    def _describe_regime(self, regime: MarketRegime, trend: float, vol: float) -> str:
        descriptions: dict[MarketRegime, str] = {
            MarketRegime.TRENDING_BULL: (
                f"Strong uptrend (strength: {abs(trend) * 100:.0f}%). "
                "Momentum strategies favored. Ride the trend with trailing stops."
            ),
            MarketRegime.TRENDING_BEAR: (
                f"Strong downtrend (strength: {abs(trend) * 100:.0f}%). "
                "Defensive posture. Consider shorts or stay cash."
            ),
            MarketRegime.RANGE_BOUND: (
                "Sideways market. Mean-reversion strategies optimal. "
                "Trade the range with tight stops at boundaries."
            ),
            MarketRegime.HIGH_VOLATILITY: (
                f"Elevated volatility ({vol:.0f}th percentile). "
                "Reduce position sizes. Widen stops. Avoid over-leveraging."
            ),
            MarketRegime.LOW_VOLATILITY: (
                f"Volatility compression ({vol:.0f}th percentile). "
                "Breakout imminent. Watch for squeeze resolution with volume confirmation."
            ),
            MarketRegime.CRISIS: (
                "CRISIS MODE. Capital preservation is priority #1. "
                "Reduce all exposure. Move to cash/stablecoins. Wait for stabilization."
            ),
            MarketRegime.RECOVERY: (
                "Recovery phase. Early momentum building. "
                "Gradually increase exposure. Watch for false rallies."
            ),
        }
        return descriptions.get(regime, "Unknown regime")

    def _get_recommended_strategies(self, regime: MarketRegime) -> list[str]:
        mapping: dict[MarketRegime, list[str]] = {
            MarketRegime.TRENDING_BULL: ["momentum", "breakout"],
            MarketRegime.TRENDING_BEAR: ["momentum (short)", "mean-reversion (oversold bounces)"],
            MarketRegime.RANGE_BOUND: ["mean-reversion", "multi-indicator"],
            MarketRegime.HIGH_VOLATILITY: ["mean-reversion (wide bands)", "reduce size"],
            MarketRegime.LOW_VOLATILITY: ["breakout", "squeeze detection"],
            MarketRegime.CRISIS: ["CASH -- no trading", "hedge positions"],
            MarketRegime.RECOVERY: ["momentum (cautious)", "breakout (confirmed volume)"],
        }
        return mapping.get(regime, ["mean-reversion"])

    # ------------------------------------------------------------------
    # Default
    # ------------------------------------------------------------------

    def _default_regime(self, reason: str) -> RegimeAnalysis:
        return RegimeAnalysis(
            regime=MarketRegime.RANGE_BOUND,
            confidence=0.1,
            trend_strength=0.0,
            volatility_percentile=50.0,
            momentum_score=0.0,
            volume_profile="stable",
            correlation_shift=False,
            details=reason,
            recommended_strategies=["mean-reversion"],
            timestamp=int(time.time() * 1000),
        )

    # ------------------------------------------------------------------
    # Internal math helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _ema(data: list[float], period: int) -> list[float]:
        """Compute EMA over *data* with given *period*."""
        if len(data) < period:
            return [data[-1]] if data else [0.0]

        multiplier = 2.0 / (period + 1)
        seed = _mean(data[:period])
        result = [seed]
        for i in range(period, len(data)):
            ema_val = (data[i] - result[-1]) * multiplier + result[-1]
            result.append(ema_val)
        return result

    @staticmethod
    def _rolling_atr(candles: list[Candle], period: int) -> list[float]:
        """Compute rolling ATR from *candles*."""
        trs: list[float] = []
        for i in range(1, len(candles)):
            tr = max(
                candles[i].high - candles[i].low,
                abs(candles[i].high - candles[i - 1].close),
                abs(candles[i].low - candles[i - 1].close),
            )
            trs.append(tr)

        if len(trs) < period:
            return list(trs)

        atr_val = _mean(trs[:period])
        atrs = [atr_val]
        for i in range(period, len(trs)):
            atr_val = (atr_val * (period - 1) + trs[i]) / period
            atrs.append(atr_val)
        return atrs
