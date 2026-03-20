"""Multi-Timeframe Strategy.

Ported from trading-algo/src/team/technical-strategist/strategies/multi-timeframe.ts.

Institutional approach: uses a higher timeframe (e.g. 1h) for directional
bias and a lower timeframe (e.g. 5m) for precise entry timing.

Flow:
1. Analyze higher TF candles -> determine trend direction (bullish/bearish/neutral)
2. If directional bias exists, analyze lower TF candles for entry triggers
3. Use higher TF for stop-loss levels, lower TF for entry precision

When called with standard single-TF ``analyze()``, it uses only the
provided data for direction and generates signals at reduced confidence.
For full multi-TF analysis, use ``analyze_multi_timeframe()``.
"""

from __future__ import annotations

import math
import logging
import uuid

from shared.types import (
    AssetInfo,
    Candle,
    MarketData,
    Signal,
    SignalAction,
    StrategyConfig,
    StrategyDNA,
    Timeframe,
)
from shared.indicators import ema, rsi, macd, bollinger_bands, atr
from team.technical_strategist.strategies import BaseStrategy

log = logging.getLogger(__name__)

# Type alias for direction
Direction = str  # "bullish" | "bearish" | "neutral"

# Timeframe pair mapping
_TIMEFRAME_PAIRS: dict[str, tuple[str, str]] = {
    "1m": ("5m", "1m"),
    "5m": ("1h", "5m"),
    "15m": ("1h", "15m"),
    "1h": ("4h", "15m"),
    "4h": ("1d", "1h"),
    "1d": ("1w", "4h"),
    "1w": ("1w", "1d"),
}


class MultiTimeframeStrategy(BaseStrategy):
    """Multi-timeframe strategy using higher TF for bias, lower TF for entry."""

    def get_default_dna(self) -> StrategyDNA:
        return StrategyDNA(
            id=uuid.uuid4().hex[:8],
            name="multi-timeframe",
            params={
                # Higher timeframe (direction) params
                "htf_fast_ema": 9,
                "htf_slow_ema": 21,
                "htf_rsi_period": 14,
                "htf_trend_threshold": 0.002,
                # Lower timeframe (entry) params
                "ltf_fast_ema": 5,
                "ltf_slow_ema": 13,
                "ltf_rsi_period": 14,
                "ltf_rsi_oversold": 35,
                "ltf_rsi_overbought": 65,
                # Entry confirmation
                "pullback_depth": 0.3,
                "breakout_confirm_bars": 2,
                # Risk
                "atr_stop_multiplier": 2.0,
                "atr_take_profit_multiplier": 3.0,
            },
        )

    # ------------------------------------------------------------------
    # Standard single-TF analysis (Strategy interface)
    # ------------------------------------------------------------------

    def analyze(self, data: MarketData) -> list[Signal]:
        """Single-timeframe analysis at reduced confidence (0.7x)."""
        candles = data.candles
        signals: list[Signal] = []

        direction = self._detect_direction(candles)
        if direction == "neutral":
            return signals

        entry = self._find_entry(candles, direction)
        if entry is None:
            return signals

        # Single-TF mode gets 0.7x confidence
        confidence = min(1.0, entry["confidence"] * 0.7)
        if confidence < 0.4:
            return signals

        indicators = dict(entry["indicators"])
        indicators["htf_bias"] = 1.0 if direction == "bullish" else -1.0
        indicators["mode"] = 0.0  # single-TF mode

        signals.append(self._make_signal(
            asset=data.asset,
            action=SignalAction.BUY if direction == "bullish" else SignalAction.SELL,
            confidence=confidence,
            price=entry["price"],
            timeframe=data.timeframe,
            indicators=indicators,
            reason=f"[Single-TF] {direction} bias detected, {entry['reason']}",
        ))
        return signals

    # ------------------------------------------------------------------
    # Full multi-timeframe analysis
    # ------------------------------------------------------------------

    def analyze_multi_timeframe(
        self,
        higher_tf_data: MarketData,
        lower_tf_data: MarketData,
    ) -> list[Signal]:
        """Full multi-timeframe analysis with both higher and lower TF data."""
        signals: list[Signal] = []
        asset = lower_tf_data.asset

        # Step 1: Higher TF directional bias
        direction = self._detect_direction(higher_tf_data.candles)
        if direction == "neutral":
            log.debug("No directional bias on higher TF -- skipping asset=%s", asset.symbol)
            return signals

        # Step 2: Higher TF stop-loss level (ATR-based)
        htf_atr_vals = atr(higher_tf_data.candles, 14)
        htf_last = len(higher_tf_data.candles) - 1
        htf_atr_value = htf_atr_vals[htf_last]
        htf_price = higher_tf_data.candles[htf_last].close

        # Step 3: Lower TF entry trigger
        entry = self._find_entry(lower_tf_data.candles, direction)
        if entry is None:
            log.debug(
                "No entry trigger on lower TF: asset=%s direction=%s",
                asset.symbol, direction,
            )
            return signals

        # Full multi-TF confidence (1.0x multiplier)
        confidence = min(1.0, entry["confidence"])
        if confidence < 0.4:
            return signals

        # Calculate stop/TP from higher TF ATR
        stop_multiplier = self.dna.params.get("atr_stop_multiplier", 2.0)
        tp_multiplier = self.dna.params.get("atr_take_profit_multiplier", 3.0)

        price = entry["price"]
        if htf_atr_value is None or math.isnan(htf_atr_value):
            stop_distance = price * 0.02
            tp_distance = price * 0.03
            safe_htf_atr = 0.0
        else:
            stop_distance = htf_atr_value * stop_multiplier
            tp_distance = htf_atr_value * tp_multiplier
            safe_htf_atr = htf_atr_value

        if direction == "bullish":
            stop_loss = price - stop_distance
            take_profit = price + tp_distance
        else:
            stop_loss = price + stop_distance
            take_profit = price - tp_distance

        risk_reward = tp_distance / stop_distance if stop_distance > 0 else 0.0

        indicators = dict(entry["indicators"])
        indicators.update({
            "htf_bias": 1.0 if direction == "bullish" else -1.0,
            "htf_price": htf_price,
            "htf_atr": safe_htf_atr,
            "stop_loss": stop_loss,
            "take_profit": take_profit,
            "risk_reward": risk_reward,
            "mode": 1.0,  # multi-TF mode
        })

        signals.append(self._make_signal(
            asset=asset,
            action=SignalAction.BUY if direction == "bullish" else SignalAction.SELL,
            confidence=confidence,
            price=price,
            timeframe=lower_tf_data.timeframe,
            indicators=indicators,
            reason=(
                f"[Multi-TF] {higher_tf_data.timeframe} {direction} bias -> "
                f"{lower_tf_data.timeframe} {entry['reason']}. "
                f"SL: {stop_loss:.5f}, TP: {take_profit:.5f}"
            ),
        ))

        log.info(
            "Multi-timeframe signal generated: asset=%s direction=%s "
            "htf=%s ltf=%s confidence=%.3f sl=%.5f tp=%.5f",
            asset.symbol,
            direction,
            higher_tf_data.timeframe,
            lower_tf_data.timeframe,
            confidence,
            stop_loss,
            take_profit,
        )

        return signals

    # ------------------------------------------------------------------
    # Directional bias detection (higher timeframe)
    # ------------------------------------------------------------------

    def _detect_direction(self, candles: list[Candle]) -> Direction:
        p = self.dna.params
        fast_period = int(p.get("htf_fast_ema", 9))
        slow_period = int(p.get("htf_slow_ema", 21))
        rsi_period = int(p.get("htf_rsi_period", 14))
        trend_threshold = p.get("htf_trend_threshold", 0.002)

        min_candles = max(slow_period, rsi_period) + 2
        if len(candles) < min_candles:
            return "neutral"

        fast_ema = ema(candles, fast_period)
        slow_ema = ema(candles, slow_period)
        rsi_vals = rsi(candles, rsi_period)
        macd_line, signal_line, histogram = macd(candles)

        last = len(candles) - 1
        price = candles[last].close

        if (
            fast_ema[last] is None
            or slow_ema[last] is None
            or rsi_vals[last] is None
        ):
            return "neutral"

        # EMA alignment
        ema_sep = (fast_ema[last] - slow_ema[last]) / price

        # Price above/below both EMAs
        price_above_both = price > fast_ema[last] and price > slow_ema[last]
        price_below_both = price < fast_ema[last] and price < slow_ema[last]

        # MACD confirmation
        hist_val = histogram[last]
        macd_bullish = hist_val is not None and not math.isnan(hist_val) and hist_val > 0
        macd_bearish = hist_val is not None and not math.isnan(hist_val) and hist_val < 0

        # RSI confirmation (trending, not exhausted)
        r = rsi_vals[last]
        rsi_bullish = 45 < r < 75
        rsi_bearish = 25 < r < 55

        # Bullish score
        bullish_score = 0
        if ema_sep > trend_threshold:
            bullish_score += 1
        if price_above_both:
            bullish_score += 1
        if macd_bullish:
            bullish_score += 1
        if rsi_bullish:
            bullish_score += 1

        # Bearish score
        bearish_score = 0
        if ema_sep < -trend_threshold:
            bearish_score += 1
        if price_below_both:
            bearish_score += 1
        if macd_bearish:
            bearish_score += 1
        if rsi_bearish:
            bearish_score += 1

        # Need at least 3/4 confirmations
        if bullish_score >= 3 and bullish_score > bearish_score:
            return "bullish"
        if bearish_score >= 3 and bearish_score > bullish_score:
            return "bearish"

        return "neutral"

    # ------------------------------------------------------------------
    # Entry trigger detection (lower timeframe)
    # ------------------------------------------------------------------

    def _find_entry(
        self,
        candles: list[Candle],
        direction: Direction,
    ) -> dict[str, object] | None:
        """Find entry trigger. Returns dict with price, confidence, reason, indicators or None."""
        p = self.dna.params
        fast_period = int(p.get("ltf_fast_ema", 5))
        slow_period = int(p.get("ltf_slow_ema", 13))
        rsi_period = int(p.get("ltf_rsi_period", 14))
        oversold = p.get("ltf_rsi_oversold", 35)
        overbought = p.get("ltf_rsi_overbought", 65)
        pullback_depth = p.get("pullback_depth", 0.3)

        min_candles = max(slow_period, rsi_period) + 5
        if len(candles) < min_candles:
            return None

        fast_ema = ema(candles, fast_period)
        slow_ema = ema(candles, slow_period)
        rsi_vals = rsi(candles, rsi_period)
        bb_upper, bb_middle, bb_lower = bollinger_bands(candles, 20, 2.0)
        atr_vals = atr(candles, 14)

        last = len(candles) - 1
        price = candles[last].close

        if fast_ema[last] is None or slow_ema[last] is None or rsi_vals[last] is None:
            return None

        indicators: dict[str, float] = {
            "ltf_fast_ema": fast_ema[last],
            "ltf_slow_ema": slow_ema[last],
            "ltf_rsi": rsi_vals[last],
            "ltf_atr": atr_vals[last] if atr_vals[last] is not None and not math.isnan(atr_vals[last]) else 0.0,
        }

        # Entry type 1: Pullback to EMA zone
        pullback = self._check_pullback_entry(
            candles, fast_ema, slow_ema, rsi_vals,
            direction, pullback_depth, oversold, overbought,
        )
        if pullback is not None:
            return {
                "price": price,
                "confidence": pullback["confidence"],
                "reason": pullback["reason"],
                "indicators": indicators,
            }

        # Entry type 2: Breakout confirmation (Bollinger Band)
        breakout = self._check_breakout_entry(
            candles, bb_upper, bb_middle, bb_lower, direction,
        )
        if breakout is not None:
            return {
                "price": price,
                "confidence": breakout["confidence"],
                "reason": breakout["reason"],
                "indicators": indicators,
            }

        # Entry type 3: EMA crossover aligned with HTF direction
        crossover = self._check_crossover_entry(
            candles, fast_ema, slow_ema, rsi_vals, direction,
        )
        if crossover is not None:
            return {
                "price": price,
                "confidence": crossover["confidence"],
                "reason": crossover["reason"],
                "indicators": indicators,
            }

        return None

    # ------------------------------------------------------------------
    # Entry type 1: Pullback to EMA zone
    # ------------------------------------------------------------------

    def _check_pullback_entry(
        self,
        candles: list[Candle],
        fast_ema: list[float | None],
        slow_ema: list[float | None],
        rsi_vals: list[float | None],
        direction: Direction,
        pullback_depth: float,
        oversold: float,
        overbought: float,
    ) -> dict[str, object] | None:
        last = len(candles) - 1
        price = candles[last].close
        prev_price = candles[last - 1].close

        ema_zone_width = abs(fast_ema[last] - slow_ema[last])
        price_to_slow = abs(price - slow_ema[last])

        # Price must be within pullback_depth * ema_zone_width of slow EMA
        in_pullback_zone = price_to_slow < ema_zone_width * (1 + pullback_depth)
        if not in_pullback_zone:
            return None

        r = rsi_vals[last]

        if direction == "bullish":
            bouncing = price > prev_price
            rsi_recovering = r > oversold and r < 60
            above_slow = price >= slow_ema[last] * 0.998

            if bouncing and rsi_recovering and above_slow:
                depth_ratio = 1 - (price_to_slow / (ema_zone_width * 2)) if ema_zone_width > 0 else 0.5
                confidence = 0.5 + depth_ratio * 0.3 + (0.1 if r > 45 else 0.0)
                return {
                    "confidence": min(1.0, confidence),
                    "reason": (
                        f"pullback to EMA zone (depth {depth_ratio * 100:.0f}%), "
                        f"RSI recovering at {r:.1f}"
                    ),
                }
        else:
            bouncing = price < prev_price
            rsi_recovering = r < overbought and r > 40
            below_slow = price <= slow_ema[last] * 1.002

            if bouncing and rsi_recovering and below_slow:
                depth_ratio = 1 - (price_to_slow / (ema_zone_width * 2)) if ema_zone_width > 0 else 0.5
                confidence = 0.5 + depth_ratio * 0.3 + (0.1 if r < 55 else 0.0)
                return {
                    "confidence": min(1.0, confidence),
                    "reason": (
                        f"pullback to EMA zone (depth {depth_ratio * 100:.0f}%), "
                        f"RSI recovering at {r:.1f}"
                    ),
                }

        return None

    # ------------------------------------------------------------------
    # Entry type 2: Bollinger Band breakout
    # ------------------------------------------------------------------

    def _check_breakout_entry(
        self,
        candles: list[Candle],
        bb_upper: list[float | None],
        bb_middle: list[float | None],
        bb_lower: list[float | None],
        direction: Direction,
    ) -> dict[str, object] | None:
        last = len(candles) - 1
        price = candles[last].close
        confirm_bars = int(self.dna.params.get("breakout_confirm_bars", 2))

        if bb_upper[last] is None or bb_lower[last] is None:
            return None

        if direction == "bullish" and price > bb_upper[last]:
            confirmed = 0
            for i in range(last - confirm_bars, last):
                if i >= 0 and bb_upper[i] is not None and candles[i].close <= bb_upper[i]:
                    confirmed += 1
            if confirmed >= confirm_bars - 1:
                band_width = bb_upper[last] - bb_middle[last] if bb_middle[last] is not None else 1.0
                overshoot = (price - bb_upper[last]) / band_width if band_width > 0 else 0.0
                return {
                    "confidence": min(1.0, 0.55 + overshoot * 0.2),
                    "reason": f"breakout above upper BB ({overshoot:.2f}x overshoot)",
                }

        if direction == "bearish" and price < bb_lower[last]:
            confirmed = 0
            for i in range(last - confirm_bars, last):
                if i >= 0 and bb_lower[i] is not None and candles[i].close >= bb_lower[i]:
                    confirmed += 1
            if confirmed >= confirm_bars - 1:
                band_width = bb_middle[last] - bb_lower[last] if bb_middle[last] is not None else 1.0
                overshoot = (bb_lower[last] - price) / band_width if band_width > 0 else 0.0
                return {
                    "confidence": min(1.0, 0.55 + overshoot * 0.2),
                    "reason": f"breakdown below lower BB ({overshoot:.2f}x overshoot)",
                }

        return None

    # ------------------------------------------------------------------
    # Entry type 3: EMA crossover
    # ------------------------------------------------------------------

    def _check_crossover_entry(
        self,
        candles: list[Candle],
        fast_ema: list[float | None],
        slow_ema: list[float | None],
        rsi_vals: list[float | None],
        direction: Direction,
    ) -> dict[str, object] | None:
        last = len(candles) - 1
        prev = last - 1

        if fast_ema[prev] is None or slow_ema[prev] is None:
            return None

        bullish_cross = fast_ema[prev] <= slow_ema[prev] and fast_ema[last] > slow_ema[last]
        bearish_cross = fast_ema[prev] >= slow_ema[prev] and fast_ema[last] < slow_ema[last]

        r = rsi_vals[last]

        if direction == "bullish" and bullish_cross and r > 40:
            ema_sep = abs(fast_ema[last] - slow_ema[last]) / candles[last].close
            return {
                "confidence": min(1.0, 0.5 + ema_sep * 15 + 0.1),
                "reason": f"EMA crossover (fast above slow), RSI {r:.1f}",
            }

        if direction == "bearish" and bearish_cross and r < 60:
            ema_sep = abs(fast_ema[last] - slow_ema[last]) / candles[last].close
            return {
                "confidence": min(1.0, 0.5 + ema_sep * 15 + 0.1),
                "reason": f"EMA crossover (fast below slow), RSI {r:.1f}",
            }

        return None

    # ------------------------------------------------------------------
    # Static helper
    # ------------------------------------------------------------------

    @staticmethod
    def get_timeframe_pair(base_timeframe: str) -> tuple[str, str]:
        """Get the recommended (higher, lower) timeframe pair for a given base timeframe."""
        return _TIMEFRAME_PAIRS.get(base_timeframe, ("1h", "5m"))
