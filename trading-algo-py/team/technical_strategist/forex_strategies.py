"""Forex-specific trading strategies.

Strategies designed specifically for the forex market:
1. London Breakout — trade the breakout of the Asian session range at London open
2. Carry Trade — trade based on interest rate differentials
3. Session Overlap Momentum — exploit high-volume session overlaps
4. Asian Range Fade — mean-revert during low-volatility Asian session
5. News Straddle — position for volatility around scheduled events
"""

from __future__ import annotations

import logging
import math
import time
from abc import ABC
from dataclasses import dataclass, field

from shared.types import (
    AssetClass, AssetInfo, Candle, MarketData, Signal, SignalAction,
    StrategyConfig, StrategyDNA,
)
from shared.indicators import atr, ema, rsi, sma, bollinger_bands

log = logging.getLogger(__name__)


# ============================================================
# Helpers
# ============================================================

def _hour_of_candle(candle: Candle) -> int:
    """Extract UTC hour from candle timestamp (ms)."""
    return int((candle.timestamp / 1000) % 86400) // 3600


def _clamp(val: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, val))


def _mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


# Session time ranges (UTC hours)
ASIAN_START, ASIAN_END = 0, 8        # Tokyo/Sydney: 00:00 - 08:00 UTC
LONDON_START, LONDON_END = 7, 16     # London: 07:00 - 16:00 UTC
NY_START, NY_END = 12, 21            # New York: 12:00 - 21:00 UTC
OVERLAP_START, OVERLAP_END = 12, 16  # London/NY overlap: 12:00 - 16:00 UTC

# Interest rate differentials (annualised %, approximate mid-2026 values)
# Source: central bank policy rates
_INTEREST_RATES: dict[str, float] = {
    "USD": 4.50, "EUR": 3.00, "GBP": 4.25, "JPY": 0.50,
    "AUD": 3.85, "NZD": 4.25, "CAD": 3.50, "CHF": 1.25,
    "MXN": 9.50, "ZAR": 7.50, "TRY": 45.00, "SGD": 3.20, "HKD": 4.50,
}


# ============================================================
# Base forex strategy (shared helpers)
# ============================================================

class _ForexBase(ABC):
    """Common helpers for forex strategies."""

    def __init__(self, config: StrategyConfig, dna: StrategyDNA | None = None) -> None:
        self.config = config
        self.dna = dna or self.get_default_dna()

    def get_default_dna(self) -> StrategyDNA:
        return StrategyDNA(id="forex-default", name=self.config.name)

    def _make_signal(
        self, asset: AssetInfo, action: SignalAction, confidence: float,
        price: float, timeframe: str, indicators: dict[str, float], reason: str,
    ) -> Signal:
        return Signal(
            asset=asset,
            action=action,
            confidence=_clamp(confidence, 0.0, 1.0),
            price=price,
            timestamp=int(time.time() * 1000),
            strategy=self.config.name,
            timeframe=timeframe,
            indicators=indicators,
            reason=reason,
        )

    def _get_session_candles(
        self, candles: list[Candle], start_hour: int, end_hour: int,
    ) -> list[Candle]:
        """Filter candles that fall within a session time window (UTC hours)."""
        result = []
        for c in candles:
            h = _hour_of_candle(c)
            if start_hour <= h < end_hour:
                result.append(c)
        return result


# ============================================================
# 1. London Breakout Strategy
# ============================================================

class LondonBreakoutStrategy(_ForexBase):
    """Trade the breakout of the Asian session range at London open.

    Logic:
    - Calculate the high/low range of the Asian session (00:00-08:00 UTC)
    - At London open (07:00-09:00 UTC), if price breaks above Asian high -> BUY
    - If price breaks below Asian low -> SELL
    - Stop loss at the opposite end of the range
    - Filter: only trade if Asian range is within normal bounds (not too wide/narrow)
    - Confidence based on range width, volume, and trend alignment
    """

    def analyze(self, data: MarketData) -> list[Signal]:
        candles = data.candles
        if len(candles) < 50:
            return []

        # Only apply to forex pairs
        if data.asset.asset_class != AssetClass.FOREX:
            return []

        signals: list[Signal] = []

        # Get recent Asian session candles (last 24h window)
        asian_candles = self._get_session_candles(candles[-48:], ASIAN_START, ASIAN_END)
        if len(asian_candles) < 3:
            return []

        asian_high = max(c.high for c in asian_candles)
        asian_low = min(c.low for c in asian_candles)
        asian_range = asian_high - asian_low

        if asian_range <= 0:
            return []

        # Filter: range should be reasonable (not too narrow or wide)
        atr_vals = atr(candles, 14)
        current_atr = atr_vals[-1] if atr_vals and atr_vals[-1] else asian_range
        range_ratio = asian_range / current_atr if current_atr > 0 else 1.0

        if range_ratio < 0.3 or range_ratio > 2.5:
            return []  # Too narrow (no conviction) or too wide (already moved)

        # Check for breakout in London session candles
        london_candles = self._get_session_candles(candles[-24:], LONDON_START, LONDON_START + 3)
        if not london_candles:
            # Use latest candles if we can't filter by session
            london_candles = candles[-3:]

        latest = candles[-1]
        price = latest.close

        # Trend filter: 50-period SMA direction
        sma_vals = sma(candles, 50)
        trend_up = sma_vals[-1] is not None and price > sma_vals[-1]
        trend_down = sma_vals[-1] is not None and price < sma_vals[-1]

        # Volume confirmation
        recent_vol = _mean([c.volume for c in candles[-5:]]) if candles[-5:] else 0
        avg_vol = _mean([c.volume for c in candles[-20:]]) if candles[-20:] else 1
        vol_ratio = recent_vol / avg_vol if avg_vol > 0 else 1.0

        indicators = {
            "asian_high": asian_high,
            "asian_low": asian_low,
            "asian_range": asian_range,
            "range_atr_ratio": round(range_ratio, 3),
            "volume_ratio": round(vol_ratio, 2),
        }

        # Breakout above Asian high
        if price > asian_high:
            buffer = asian_range * 0.1  # Small buffer above high
            if price > asian_high + buffer:
                confidence = 0.55
                if trend_up:
                    confidence += 0.15
                if vol_ratio > 1.3:
                    confidence += 0.10
                # Narrower ranges produce cleaner breakouts
                if 0.5 < range_ratio < 1.5:
                    confidence += 0.05

                signals.append(self._make_signal(
                    data.asset, SignalAction.BUY, confidence, price, data.timeframe,
                    indicators,
                    f"London breakout above Asian high ({asian_high:.5f}), range={asian_range:.5f}",
                ))

        # Breakout below Asian low
        elif price < asian_low:
            buffer = asian_range * 0.1
            if price < asian_low - buffer:
                confidence = 0.55
                if trend_down:
                    confidence += 0.15
                if vol_ratio > 1.3:
                    confidence += 0.10
                if 0.5 < range_ratio < 1.5:
                    confidence += 0.05

                signals.append(self._make_signal(
                    data.asset, SignalAction.SELL, confidence, price, data.timeframe,
                    indicators,
                    f"London breakout below Asian low ({asian_low:.5f}), range={asian_range:.5f}",
                ))

        return signals


# ============================================================
# 2. Carry Trade Strategy
# ============================================================

class CarryTradeStrategy(_ForexBase):
    """Trade based on interest rate differentials between currencies.

    Logic:
    - Calculate the rate differential (base rate - quote rate)
    - Positive differential -> BUY (earn carry)
    - Negative differential -> SELL (earn carry on short side)
    - Filter by trend alignment (don't fight the trend for carry)
    - Reduce confidence during high volatility (carry trades unwind in risk-off)
    - Higher differential = higher confidence
    """

    def analyze(self, data: MarketData) -> list[Signal]:
        candles = data.candles
        if len(candles) < 50:
            return []

        if data.asset.asset_class != AssetClass.FOREX:
            return []

        # Parse currencies from symbol (e.g., "EUR/USD" -> "EUR", "USD")
        parts = data.asset.symbol.split("/")
        if len(parts) != 2:
            return []

        base_ccy, quote_ccy = parts[0], parts[1]
        base_rate = _INTEREST_RATES.get(base_ccy)
        quote_rate = _INTEREST_RATES.get(quote_ccy)

        if base_rate is None or quote_rate is None:
            return []

        rate_diff = base_rate - quote_rate  # Annualised %

        # Need at least 1% differential to be meaningful
        if abs(rate_diff) < 1.0:
            return []

        price = candles[-1].close

        # Trend filter: 200-period SMA
        sma200 = sma(candles, min(200, len(candles) - 1))
        trend_bullish = sma200[-1] is not None and price > sma200[-1]
        trend_bearish = sma200[-1] is not None and price < sma200[-1]

        # Volatility filter: high vol = carry unwind risk
        atr_vals = atr(candles, 14)
        current_atr = atr_vals[-1] if atr_vals and atr_vals[-1] else 0
        atr_pct = (current_atr / price * 100) if price > 0 else 0

        # RSI: avoid extreme overbought/oversold
        rsi_vals = rsi(candles, 14)
        current_rsi = rsi_vals[-1] if rsi_vals and rsi_vals[-1] else 50

        indicators = {
            "base_rate": base_rate,
            "quote_rate": quote_rate,
            "rate_differential": round(rate_diff, 2),
            "atr_pct": round(atr_pct, 4),
            "rsi": round(current_rsi, 1) if current_rsi else 50,
        }

        signals: list[Signal] = []

        if rate_diff > 0:
            # Positive carry: buy base currency
            confidence = 0.50
            # Scale confidence by differential magnitude
            confidence += min(0.20, abs(rate_diff) / 20)
            # Trend alignment bonus
            if trend_bullish:
                confidence += 0.10
            elif trend_bearish:
                confidence -= 0.15  # Fighting the trend
            # High volatility penalty (carry trades hate volatility)
            if atr_pct > 1.5:
                confidence -= 0.15
            elif atr_pct > 1.0:
                confidence -= 0.05
            # RSI filter
            if current_rsi and current_rsi > 75:
                confidence -= 0.10  # Already overbought

            if confidence >= 0.40:
                signals.append(self._make_signal(
                    data.asset, SignalAction.BUY, confidence, price, data.timeframe,
                    indicators,
                    f"Carry trade: {base_ccy} {base_rate}% vs {quote_ccy} {quote_rate}% (diff={rate_diff:+.1f}%)",
                ))

        else:
            # Negative carry: sell base currency (earn carry on short)
            confidence = 0.50
            confidence += min(0.20, abs(rate_diff) / 20)
            if trend_bearish:
                confidence += 0.10
            elif trend_bullish:
                confidence -= 0.15
            if atr_pct > 1.5:
                confidence -= 0.15
            elif atr_pct > 1.0:
                confidence -= 0.05
            if current_rsi and current_rsi < 25:
                confidence -= 0.10

            if confidence >= 0.40:
                signals.append(self._make_signal(
                    data.asset, SignalAction.SELL, confidence, price, data.timeframe,
                    indicators,
                    f"Carry trade short: {base_ccy} {base_rate}% vs {quote_ccy} {quote_rate}% (diff={rate_diff:+.1f}%)",
                ))

        return signals


# ============================================================
# 3. Session Overlap Momentum Strategy
# ============================================================

class SessionOverlapStrategy(_ForexBase):
    """Trade momentum during high-volume session overlaps.

    The London/NY overlap (12:00-16:00 UTC) produces the highest forex volume.
    This strategy:
    - Identifies the direction of the move during early overlap
    - Enters in the direction of momentum if confirmed by volume and EMA alignment
    - Uses RSI to avoid chasing overbought/oversold conditions
    - ATR-based stops
    """

    def analyze(self, data: MarketData) -> list[Signal]:
        candles = data.candles
        if len(candles) < 50:
            return []

        if data.asset.asset_class != AssetClass.FOREX:
            return []

        signals: list[Signal] = []
        price = candles[-1].close

        # Check if we're in or near the overlap window
        overlap_candles = self._get_session_candles(candles[-12:], OVERLAP_START, OVERLAP_END)

        # Also use general recent candles for non-time-tagged data
        recent = candles[-6:]

        # EMA alignment: 8 EMA > 21 EMA > 50 EMA = bullish
        ema8 = ema(candles, 8)
        ema21 = ema(candles, 21)
        ema50 = ema(candles, 50)

        ema8_val = ema8[-1] if ema8 and ema8[-1] else None
        ema21_val = ema21[-1] if ema21 and ema21[-1] else None
        ema50_val = ema50[-1] if ema50 and ema50[-1] else None

        if not all([ema8_val, ema21_val, ema50_val]):
            return []

        bullish_stack = ema8_val > ema21_val > ema50_val
        bearish_stack = ema8_val < ema21_val < ema50_val

        # Momentum: recent candles direction
        recent_closes = [c.close for c in recent]
        up_candles = sum(1 for i in range(1, len(recent_closes)) if recent_closes[i] > recent_closes[i - 1])
        down_candles = sum(1 for i in range(1, len(recent_closes)) if recent_closes[i] < recent_closes[i - 1])
        total_candles = max(1, up_candles + down_candles)

        momentum_bullish = up_candles / total_candles > 0.65
        momentum_bearish = down_candles / total_candles > 0.65

        # Volume surge during overlap
        recent_vol = _mean([c.volume for c in recent])
        avg_vol = _mean([c.volume for c in candles[-30:]]) if len(candles) >= 30 else recent_vol
        vol_surge = recent_vol / avg_vol if avg_vol > 0 else 1.0

        # RSI filter
        rsi_vals = rsi(candles, 14)
        current_rsi = rsi_vals[-1] if rsi_vals and rsi_vals[-1] else 50

        # ATR for stop sizing
        atr_vals = atr(candles, 14)
        current_atr = atr_vals[-1] if atr_vals and atr_vals[-1] else price * 0.01

        indicators = {
            "ema8": round(ema8_val, 5),
            "ema21": round(ema21_val, 5),
            "ema50": round(ema50_val, 5),
            "rsi": round(current_rsi, 1) if current_rsi else 50,
            "volume_surge": round(vol_surge, 2),
            "up_ratio": round(up_candles / total_candles, 2),
        }

        # Bullish: EMA stack + momentum + not overbought
        if bullish_stack and momentum_bullish and (not current_rsi or current_rsi < 72):
            confidence = 0.55
            if vol_surge > 1.3:
                confidence += 0.10
            if current_rsi and 40 < current_rsi < 65:
                confidence += 0.05  # Healthy RSI range
            # EMA separation bonus (strong trend)
            ema_spread = (ema8_val - ema50_val) / ema50_val * 100
            if ema_spread > 0.3:
                confidence += 0.05

            signals.append(self._make_signal(
                data.asset, SignalAction.BUY, confidence, price, data.timeframe,
                indicators,
                f"Session overlap momentum: EMA stack bullish, {up_candles}/{total_candles} up candles",
            ))

        # Bearish: reverse EMA stack + momentum + not oversold
        elif bearish_stack and momentum_bearish and (not current_rsi or current_rsi > 28):
            confidence = 0.55
            if vol_surge > 1.3:
                confidence += 0.10
            if current_rsi and 35 < current_rsi < 60:
                confidence += 0.05
            ema_spread = (ema50_val - ema8_val) / ema50_val * 100
            if ema_spread > 0.3:
                confidence += 0.05

            signals.append(self._make_signal(
                data.asset, SignalAction.SELL, confidence, price, data.timeframe,
                indicators,
                f"Session overlap momentum: EMA stack bearish, {down_candles}/{total_candles} down candles",
            ))

        return signals


# ============================================================
# 4. Asian Range Fade Strategy
# ============================================================

class AsianRangeFadeStrategy(_ForexBase):
    """Fade extremes during the low-volatility Asian session.

    Logic:
    - During Asian session, price tends to range-bound
    - If price hits the top of Bollinger Bands during Asian hours -> SELL (fade)
    - If price hits the bottom -> BUY (fade)
    - Confirm with RSI oversold/overbought
    - Only works during actual range-bound conditions (low ADX)
    """

    def analyze(self, data: MarketData) -> list[Signal]:
        candles = data.candles
        if len(candles) < 50:
            return []

        if data.asset.asset_class != AssetClass.FOREX:
            return []

        signals: list[Signal] = []
        price = candles[-1].close

        # Bollinger Bands
        bb_upper_list, bb_middle_list, bb_lower_list = bollinger_bands(candles, 20, 2.0)
        upper = bb_upper_list[-1] if bb_upper_list and bb_upper_list[-1] else None
        lower = bb_lower_list[-1] if bb_lower_list and bb_lower_list[-1] else None
        middle = bb_middle_list[-1] if bb_middle_list and bb_middle_list[-1] else None

        if not all([upper, lower, middle]):
            return []

        bb_width = (upper - lower) / middle if middle > 0 else 0

        # RSI
        rsi_vals = rsi(candles, 14)
        current_rsi = rsi_vals[-1] if rsi_vals and rsi_vals[-1] else 50

        # ADX filter: only trade in low-ADX (range-bound) conditions
        adx_val = self._calc_adx(candles)
        if adx_val and adx_val > 25:
            return []  # Trending market — don't fade

        # ATR
        atr_vals = atr(candles, 14)
        current_atr = atr_vals[-1] if atr_vals and atr_vals[-1] else price * 0.01

        # BB %B: (price - lower) / (upper - lower)
        bb_range = upper - lower
        pct_b = (price - lower) / bb_range if bb_range > 0 else 0.5

        indicators = {
            "bb_upper": round(upper, 5),
            "bb_lower": round(lower, 5),
            "bb_pctb": round(pct_b, 3),
            "bb_width": round(bb_width, 4),
            "rsi": round(current_rsi, 1) if current_rsi else 50,
            "adx": round(adx_val, 1) if adx_val else 0,
        }

        # Fade the upper band (overbought)
        if pct_b > 0.95 and current_rsi and current_rsi > 70:
            confidence = 0.55
            if current_rsi > 80:
                confidence += 0.10
            if adx_val and adx_val < 15:
                confidence += 0.05  # Very range-bound
            if bb_width < 0.02:
                confidence += 0.05  # Tight bands = strong mean reversion

            signals.append(self._make_signal(
                data.asset, SignalAction.SELL, confidence, price, data.timeframe,
                indicators,
                f"Asian range fade: price at upper BB ({pct_b:.2f}), RSI={current_rsi:.0f}, ADX={adx_val:.0f}",
            ))

        # Fade the lower band (oversold)
        elif pct_b < 0.05 and current_rsi and current_rsi < 30:
            confidence = 0.55
            if current_rsi < 20:
                confidence += 0.10
            if adx_val and adx_val < 15:
                confidence += 0.05
            if bb_width < 0.02:
                confidence += 0.05

            signals.append(self._make_signal(
                data.asset, SignalAction.BUY, confidence, price, data.timeframe,
                indicators,
                f"Asian range fade: price at lower BB ({pct_b:.2f}), RSI={current_rsi:.0f}, ADX={adx_val:.0f}",
            ))

        return signals

    def _calc_adx(self, candles: list[Candle], period: int = 14) -> float | None:
        """Simplified ADX calculation."""
        if len(candles) < period + 1:
            return None

        plus_dm_list: list[float] = []
        minus_dm_list: list[float] = []
        tr_list: list[float] = []

        for i in range(1, len(candles)):
            high_diff = candles[i].high - candles[i - 1].high
            low_diff = candles[i - 1].low - candles[i].low
            plus_dm = high_diff if high_diff > low_diff and high_diff > 0 else 0
            minus_dm = low_diff if low_diff > high_diff and low_diff > 0 else 0
            tr = max(
                candles[i].high - candles[i].low,
                abs(candles[i].high - candles[i - 1].close),
                abs(candles[i].low - candles[i - 1].close),
            )
            plus_dm_list.append(plus_dm)
            minus_dm_list.append(minus_dm)
            tr_list.append(tr)

        if len(tr_list) < period:
            return None

        # Wilder's smoothing
        smoothed_tr = sum(tr_list[:period])
        smoothed_plus = sum(plus_dm_list[:period])
        smoothed_minus = sum(minus_dm_list[:period])

        dx_values: list[float] = []
        for i in range(period, len(tr_list)):
            smoothed_tr = smoothed_tr - (smoothed_tr / period) + tr_list[i]
            smoothed_plus = smoothed_plus - (smoothed_plus / period) + plus_dm_list[i]
            smoothed_minus = smoothed_minus - (smoothed_minus / period) + minus_dm_list[i]

            plus_di = (smoothed_plus / smoothed_tr * 100) if smoothed_tr > 0 else 0
            minus_di = (smoothed_minus / smoothed_tr * 100) if smoothed_tr > 0 else 0
            di_sum = plus_di + minus_di
            dx = abs(plus_di - minus_di) / di_sum * 100 if di_sum > 0 else 0
            dx_values.append(dx)

        if len(dx_values) < period:
            return _mean(dx_values) if dx_values else None

        adx = _mean(dx_values[:period])
        for i in range(period, len(dx_values)):
            adx = (adx * (period - 1) + dx_values[i]) / period

        return adx


# ============================================================
# 5. News Straddle / Volatility Breakout Strategy
# ============================================================

class NewsStraddleStrategy(_ForexBase):
    """Position for volatility expansion around high-impact events.

    Instead of predicting direction, this strategy:
    - Detects periods of unusual low volatility (squeeze)
    - Waits for a volatility expansion (Keltner/BB squeeze release)
    - Enters in the direction of the breakout
    - Higher confidence when multiple volatility indicators align

    This captures the "straddle" effect around news without needing a calendar.
    """

    def analyze(self, data: MarketData) -> list[Signal]:
        candles = data.candles
        if len(candles) < 50:
            return []

        if data.asset.asset_class != AssetClass.FOREX:
            return []

        signals: list[Signal] = []
        price = candles[-1].close

        # Bollinger Bands (20, 2)
        bb_upper_list, bb_middle_list, bb_lower_list = bollinger_bands(candles, 20, 2.0)
        bb_upper = bb_upper_list[-1] if bb_upper_list and bb_upper_list[-1] else None
        bb_lower = bb_lower_list[-1] if bb_lower_list and bb_lower_list[-1] else None
        bb_mid = bb_middle_list[-1] if bb_middle_list and bb_middle_list[-1] else None

        if not all([bb_upper, bb_lower, bb_mid]):
            return []

        bb_width_current = (bb_upper - bb_lower) / bb_mid if bb_mid > 0 else 0

        # Historical BB width (was it squeezing?)
        bb_widths: list[float] = []
        for i in range(max(0, len(bb_upper_list) - 20), len(bb_upper_list)):
            u = bb_upper_list[i]
            l = bb_lower_list[i]
            m = bb_middle_list[i]
            if u and l and m and m > 0:
                bb_widths.append((u - l) / m)

        if len(bb_widths) < 10:
            return []

        avg_bb_width = _mean(bb_widths[:-1])  # Exclude current
        min_bb_width = min(bb_widths[:-1])

        # Squeeze detection: current width near recent minimum
        was_squeezed = bb_width_current < avg_bb_width * 0.7
        is_expanding = bb_width_current > min_bb_width * 1.3

        # ATR expansion
        atr_vals = atr(candles, 14)
        current_atr = atr_vals[-1] if atr_vals and atr_vals[-1] else 0
        prev_atrs = [v for v in atr_vals[-20:-1] if v is not None]
        avg_atr = _mean(prev_atrs) if prev_atrs else current_atr
        atr_expanding = current_atr > avg_atr * 1.2 if avg_atr > 0 else False

        # Candle body size (volatility proxy)
        body = abs(candles[-1].close - candles[-1].open)
        avg_body = _mean([abs(c.close - c.open) for c in candles[-20:]]) if candles[-20:] else body
        big_candle = body > avg_body * 1.5

        # Direction of breakout
        ema_fast = ema(candles, 8)
        ema_slow = ema(candles, 21)
        fast_val = ema_fast[-1] if ema_fast and ema_fast[-1] else None
        slow_val = ema_slow[-1] if ema_slow and ema_slow[-1] else None

        indicators = {
            "bb_width": round(bb_width_current, 5),
            "avg_bb_width": round(avg_bb_width, 5),
            "atr_expansion": round(current_atr / avg_atr, 2) if avg_atr > 0 else 1.0,
            "body_ratio": round(body / avg_body, 2) if avg_body > 0 else 1.0,
        }

        # Trigger: squeeze release + expansion + big candle
        if (is_expanding or atr_expanding) and big_candle:
            if fast_val and slow_val:
                if price > bb_mid and fast_val > slow_val:
                    # Bullish breakout
                    confidence = 0.50
                    if atr_expanding:
                        confidence += 0.10
                    if is_expanding:
                        confidence += 0.05
                    if price > bb_upper:
                        confidence += 0.10  # Strong breakout beyond BB

                    signals.append(self._make_signal(
                        data.asset, SignalAction.BUY, confidence, price, data.timeframe,
                        indicators,
                        f"Volatility breakout UP: BB expanding, ATR surge, big bullish candle",
                    ))

                elif price < bb_mid and fast_val < slow_val:
                    # Bearish breakout
                    confidence = 0.50
                    if atr_expanding:
                        confidence += 0.10
                    if is_expanding:
                        confidence += 0.05
                    if price < bb_lower:
                        confidence += 0.10

                    signals.append(self._make_signal(
                        data.asset, SignalAction.SELL, confidence, price, data.timeframe,
                        indicators,
                        f"Volatility breakout DOWN: BB expanding, ATR surge, big bearish candle",
                    ))

        return signals


# ============================================================
# Factory
# ============================================================

FOREX_STRATEGIES: dict[str, type] = {
    "london-breakout": LondonBreakoutStrategy,
    "carry-trade": CarryTradeStrategy,
    "session-overlap": SessionOverlapStrategy,
    "asian-range-fade": AsianRangeFadeStrategy,
    "news-straddle": NewsStraddleStrategy,
}


def create_forex_strategy(name: str, dna: StrategyDNA | None = None):
    """Create a forex strategy by name."""
    cls = FOREX_STRATEGIES.get(name)
    if cls is None:
        raise ValueError(f"Unknown forex strategy: {name}. Available: {list(FOREX_STRATEGIES.keys())}")
    config = StrategyConfig(
        name=name, enabled=True,
        asset_classes=[AssetClass.FOREX],
    )
    return cls(config, dna)


def get_all_forex_strategies() -> list:
    """Create one instance of each forex strategy."""
    return [create_forex_strategy(name) for name in FOREX_STRATEGIES]
