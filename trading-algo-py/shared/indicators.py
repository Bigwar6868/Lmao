"""Technical indicators computed from candle data."""

from __future__ import annotations

import math
from dataclasses import dataclass
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


# ============================================================
# SMC / ICT Indicators
# ============================================================

@dataclass
class SwingPoint:
    """A detected swing high or low."""
    index: int
    price: float
    is_high: bool  # True = swing high, False = swing low


@dataclass
class FairValueGap:
    """A Fair Value Gap (imbalance zone)."""
    index: int          # index of the middle candle
    top: float          # upper boundary of the gap
    bottom: float       # lower boundary of the gap
    is_bullish: bool    # True = bullish FVG, False = bearish FVG
    ce: float           # consequent encroachment (midpoint)


@dataclass
class MarketStructureBreak:
    """A Break of Structure or Change of Character."""
    index: int
    price: float
    is_bullish: bool    # True = bullish break, False = bearish break
    is_choch: bool      # True = CHoCH (reversal), False = BOS (continuation)
    displacement: float # strength of the move (body size / ATR)


@dataclass
class OrderBlock:
    """An institutional order block zone."""
    index: int
    high: float
    low: float
    is_bullish: bool    # True = bullish OB (last bearish candle before up move)
    midpoint: float


@dataclass
class LiquiditySweep:
    """A liquidity sweep event."""
    index: int
    swept_level: float
    is_buy_side: bool   # True = swept above highs (buy-side), False = swept below lows (sell-side)
    reversal_strength: float  # how strongly price reversed after the sweep


def detect_swing_points(
    candles: list[Candle], lookback: int = 5,
) -> list[SwingPoint]:
    """Detect swing highs and swing lows.

    A swing high is a candle whose high is higher than the highs of
    `lookback` candles on both sides. Vice versa for swing low.
    """
    swings: list[SwingPoint] = []
    if len(candles) < lookback * 2 + 1:
        return swings

    for i in range(lookback, len(candles) - lookback):
        h = candles[i].high
        lo = candles[i].low

        is_swing_high = all(
            candles[i - j].high <= h and candles[i + j].high <= h
            for j in range(1, lookback + 1)
        )
        is_swing_low = all(
            candles[i - j].low >= lo and candles[i + j].low >= lo
            for j in range(1, lookback + 1)
        )

        if is_swing_high:
            swings.append(SwingPoint(index=i, price=h, is_high=True))
        if is_swing_low:
            swings.append(SwingPoint(index=i, price=lo, is_high=False))

    return swings


def detect_fair_value_gaps(candles: list[Candle]) -> list[FairValueGap]:
    """Detect Fair Value Gaps (3-candle imbalances).

    Bullish FVG: candle1.high < candle3.low (gap up)
    Bearish FVG: candle1.low > candle3.high (gap down)
    """
    fvgs: list[FairValueGap] = []
    if len(candles) < 3:
        return fvgs

    for i in range(1, len(candles) - 1):
        c1 = candles[i - 1]
        c3 = candles[i + 1]

        # Bullish FVG: gap between candle 1 high and candle 3 low
        if c1.high < c3.low:
            top = c3.low
            bottom = c1.high
            ce = (top + bottom) / 2
            fvgs.append(FairValueGap(
                index=i, top=top, bottom=bottom,
                is_bullish=True, ce=ce,
            ))

        # Bearish FVG: gap between candle 1 low and candle 3 high
        if c1.low > c3.high:
            top = c1.low
            bottom = c3.high
            ce = (top + bottom) / 2
            fvgs.append(FairValueGap(
                index=i, top=top, bottom=bottom,
                is_bullish=False, ce=ce,
            ))

    return fvgs


def detect_market_structure(
    candles: list[Candle], swing_lookback: int = 5, atr_period: int = 14,
) -> list[MarketStructureBreak]:
    """Detect BOS (Break of Structure) and CHoCH (Change of Character).

    BOS = break in the direction of the current trend (continuation).
    CHoCH = break against the current trend (first reversal signal).
    """
    swings = detect_swing_points(candles, swing_lookback)
    atr_vals = atr(candles, atr_period)
    breaks: list[MarketStructureBreak] = []

    if len(swings) < 3:
        return breaks

    # Track trend: start by looking at first two swing highs/lows
    trend_bullish: bool | None = None

    for idx in range(2, len(swings)):
        prev = swings[idx - 1]
        curr = swings[idx]

        # Determine initial trend from first swings
        if trend_bullish is None:
            if curr.is_high and prev.is_high:
                trend_bullish = curr.price > prev.price
            elif not curr.is_high and not prev.is_high:
                trend_bullish = curr.price > prev.price
            continue

        candle_idx = curr.index
        current_atr = atr_vals[candle_idx] if candle_idx < len(atr_vals) and atr_vals[candle_idx] else None

        # Calculate displacement (body size relative to ATR)
        body = abs(candles[candle_idx].close - candles[candle_idx].open)
        displacement = body / current_atr if current_atr and current_atr > 0 else 0

        # Check for swing high break (bullish break)
        if not curr.is_high and prev.is_high:
            # Price broke above previous swing high?
            for j in range(prev.index + 1, min(curr.index + 1, len(candles))):
                if candles[j].close > prev.price:
                    is_choch = not trend_bullish  # against trend = CHoCH
                    breaks.append(MarketStructureBreak(
                        index=j, price=candles[j].close,
                        is_bullish=True, is_choch=is_choch,
                        displacement=displacement,
                    ))
                    trend_bullish = True
                    break

        # Check for swing low break (bearish break)
        if curr.is_high and not prev.is_high:
            for j in range(prev.index + 1, min(curr.index + 1, len(candles))):
                if candles[j].close < prev.price:
                    is_choch = trend_bullish  # against trend = CHoCH
                    breaks.append(MarketStructureBreak(
                        index=j, price=candles[j].close,
                        is_bullish=False, is_choch=is_choch,
                        displacement=displacement,
                    ))
                    trend_bullish = False
                    break

    return breaks


def detect_order_blocks(
    candles: list[Candle], swing_lookback: int = 5, atr_period: int = 14,
    min_displacement: float = 1.0,
) -> list[OrderBlock]:
    """Detect order blocks — the last opposing candle before a displacement move.

    Bullish OB: last bearish candle before a strong upward move.
    Bearish OB: last bullish candle before a strong downward move.
    Requires displacement (body > min_displacement * ATR).
    """
    atr_vals = atr(candles, atr_period)
    obs: list[OrderBlock] = []

    if len(candles) < atr_period + 5:
        return obs

    for i in range(atr_period + 1, len(candles)):
        current_atr = atr_vals[i]
        if current_atr is None or current_atr == 0:
            continue

        body = abs(candles[i].close - candles[i].open)
        if body < min_displacement * current_atr:
            continue  # No displacement

        is_bullish_candle = candles[i].close > candles[i].open

        if is_bullish_candle:
            # Look back for the last bearish candle = bullish OB
            for j in range(i - 1, max(i - 6, -1), -1):
                if candles[j].close < candles[j].open:
                    obs.append(OrderBlock(
                        index=j,
                        high=candles[j].high,
                        low=candles[j].low,
                        is_bullish=True,
                        midpoint=(candles[j].high + candles[j].low) / 2,
                    ))
                    break
        else:
            # Look back for the last bullish candle = bearish OB
            for j in range(i - 1, max(i - 6, -1), -1):
                if candles[j].close > candles[j].open:
                    obs.append(OrderBlock(
                        index=j,
                        high=candles[j].high,
                        low=candles[j].low,
                        is_bullish=False,
                        midpoint=(candles[j].high + candles[j].low) / 2,
                    ))
                    break

    return obs


def detect_liquidity_sweeps(
    candles: list[Candle], swing_lookback: int = 5, min_reversal_pct: float = 0.3,
) -> list[LiquiditySweep]:
    """Detect liquidity sweeps — price pierces a swing level then reverses.

    Buy-side sweep: price goes above a swing high, then closes back below it.
    Sell-side sweep: price goes below a swing low, then closes back above it.
    """
    swings = detect_swing_points(candles, swing_lookback)
    sweeps: list[LiquiditySweep] = []

    for swing in swings:
        # Look at candles after the swing point
        for i in range(swing.index + swing_lookback, len(candles)):
            if swing.is_high:
                # Buy-side sweep: wick goes above swing high but closes below
                if candles[i].high > swing.price and candles[i].close < swing.price:
                    reversal = (candles[i].high - candles[i].close) / swing.price
                    if reversal >= min_reversal_pct / 100:
                        sweeps.append(LiquiditySweep(
                            index=i,
                            swept_level=swing.price,
                            is_buy_side=True,
                            reversal_strength=reversal,
                        ))
                    break  # Only count first sweep of each level
            else:
                # Sell-side sweep: wick goes below swing low but closes above
                if candles[i].low < swing.price and candles[i].close > swing.price:
                    reversal = (candles[i].close - candles[i].low) / swing.price
                    if reversal >= min_reversal_pct / 100:
                        sweeps.append(LiquiditySweep(
                            index=i,
                            swept_level=swing.price,
                            is_buy_side=False,
                            reversal_strength=reversal,
                        ))
                    break

    return sweeps


def detect_displacement(
    candles: list[Candle], atr_period: int = 14, threshold: float = 1.5,
) -> list[tuple[int, float, bool]]:
    """Detect displacement candles — strong institutional commitment.

    Returns list of (index, strength_ratio, is_bullish) for candles whose
    body size exceeds threshold * ATR.
    """
    atr_vals = atr(candles, atr_period)
    result: list[tuple[int, float, bool]] = []

    for i in range(atr_period + 1, len(candles)):
        current_atr = atr_vals[i]
        if current_atr is None or current_atr == 0:
            continue

        body = abs(candles[i].close - candles[i].open)
        ratio = body / current_atr
        if ratio >= threshold:
            is_bullish = candles[i].close > candles[i].open
            result.append((i, ratio, is_bullish))

    return result


def premium_discount_zone(
    swing_high: float, swing_low: float, price: float,
) -> tuple[float, bool, float]:
    """Determine if price is in premium or discount zone.

    Returns (equilibrium, is_discount, zone_pct) where:
    - equilibrium = 50% level
    - is_discount = True if price is below equilibrium
    - zone_pct = how far into premium/discount (0.0 = at equilibrium, 1.0 = at extreme)
    """
    rng = swing_high - swing_low
    if rng == 0:
        return price, True, 0.0

    eq = swing_low + rng * 0.5
    is_discount = price < eq
    zone_pct = abs(price - eq) / (rng * 0.5)
    return eq, is_discount, min(zone_pct, 1.0)


def is_in_ote_zone(
    swing_high: float, swing_low: float, price: float, is_bullish: bool,
) -> bool:
    """Check if price is in the Optimal Trade Entry zone (62%-79% retracement).

    For bullish: OTE zone is between 62% and 79% retracement from high to low.
    For bearish: OTE zone is between 62% and 79% retracement from low to high.
    """
    rng = swing_high - swing_low
    if rng == 0:
        return False

    if is_bullish:
        # Retracement from high: price should be between these levels
        ote_top = swing_high - rng * 0.618
        ote_bottom = swing_high - rng * 0.786
        return ote_bottom <= price <= ote_top
    else:
        # Retracement from low: price should be between these levels
        ote_bottom = swing_low + rng * 0.618
        ote_top = swing_low + rng * 0.786
        return ote_bottom <= price <= ote_top


# ============================================================
# ICT Session / Kill Zone / Macro Infrastructure
# ============================================================

@dataclass
class KillZone:
    """Represents a trading session kill zone."""
    name: str
    start_hour: int   # EST hour (0-23)
    start_minute: int
    end_hour: int
    end_minute: int


# ICT Kill Zones (all EST)
ASIAN_SESSION = KillZone("asian", 19, 0, 2, 0)         # 7:00 PM - 2:00 AM EST
LONDON_KILL_ZONE = KillZone("london_kz", 2, 0, 5, 0)   # 2:00 AM - 5:00 AM EST
NY_KILL_ZONE = KillZone("ny_kz", 7, 0, 10, 0)          # 7:00 AM - 10:00 AM EST
NY_PM_SESSION = KillZone("ny_pm", 13, 0, 16, 0)         # 1:00 PM - 4:00 PM EST

# ICT Silver Bullet Windows (all EST)
SILVER_BULLET_LONDON = KillZone("sb_london", 3, 0, 4, 0)    # 3:00 AM - 4:00 AM
SILVER_BULLET_NY_AM = KillZone("sb_ny_am", 10, 0, 11, 0)    # 10:00 AM - 11:00 AM
SILVER_BULLET_NY_PM = KillZone("sb_ny_pm", 14, 0, 15, 0)    # 2:00 PM - 3:00 PM

# ICT Macro Windows (all EST)
MACRO_WINDOWS = [
    KillZone("london_macro_1", 2, 33, 3, 0),
    KillZone("london_macro_2", 4, 3, 4, 30),
    KillZone("ny_am_macro_1", 8, 50, 9, 10),
    KillZone("ny_am_macro_2", 9, 50, 10, 10),
    KillZone("ny_lunch_macro", 11, 50, 12, 10),
    KillZone("ny_pm_macro", 13, 10, 13, 40),
]


def _ts_to_est_hour_minute(ts_ms: int) -> tuple[int, int]:
    """Convert millisecond timestamp to (hour, minute) in EST.

    Note: simplified — assumes UTC-5. In production, use proper timezone handling.
    """
    import time as _time
    utc_secs = ts_ms / 1000
    # EST = UTC - 5
    est_secs = utc_secs - 5 * 3600
    t = _time.gmtime(est_secs)
    return t.tm_hour, t.tm_min


def is_in_kill_zone(ts_ms: int, kz: KillZone) -> bool:
    """Check if a timestamp falls within a kill zone window."""
    h, m = _ts_to_est_hour_minute(ts_ms)
    current = h * 60 + m
    start = kz.start_hour * 60 + kz.start_minute
    end = kz.end_hour * 60 + kz.end_minute

    if start <= end:
        return start <= current < end
    else:
        # Wraps midnight (e.g., Asian session 19:00 -> 02:00)
        return current >= start or current < end


def get_active_kill_zone(ts_ms: int) -> KillZone | None:
    """Return the currently active kill zone, or None."""
    for kz in [LONDON_KILL_ZONE, NY_KILL_ZONE, NY_PM_SESSION, ASIAN_SESSION]:
        if is_in_kill_zone(ts_ms, kz):
            return kz
    return None


def get_active_silver_bullet(ts_ms: int) -> KillZone | None:
    """Return the currently active Silver Bullet window, or None."""
    for sb in [SILVER_BULLET_LONDON, SILVER_BULLET_NY_AM, SILVER_BULLET_NY_PM]:
        if is_in_kill_zone(ts_ms, sb):
            return sb
    return None


def is_in_macro_window(ts_ms: int) -> KillZone | None:
    """Return the active macro window, or None."""
    for mw in MACRO_WINDOWS:
        if is_in_kill_zone(ts_ms, mw):
            return mw
    return None


def detect_session_range(
    candles: list[Candle], session: KillZone,
) -> tuple[float, float] | None:
    """Find the high/low of candles that fall within a session window.

    Returns (session_high, session_low) or None if no candles in session.
    """
    highs: list[float] = []
    lows: list[float] = []
    for c in candles:
        if is_in_kill_zone(c.timestamp, session):
            highs.append(c.high)
            lows.append(c.low)
    if not highs:
        return None
    return max(highs), min(lows)


def get_previous_day_hl(candles: list[Candle]) -> tuple[float, float] | None:
    """Get the previous day's high and low from candle data.

    Groups candles by UTC day, returns the HL of the second-to-last day.
    """
    if len(candles) < 2:
        return None

    import time as _time
    days: dict[int, list[Candle]] = {}
    for c in candles:
        day = int(c.timestamp / 1000 // 86400)
        days.setdefault(day, []).append(c)

    sorted_days = sorted(days.keys())
    if len(sorted_days) < 2:
        return None

    prev_candles = days[sorted_days[-2]]
    return max(c.high for c in prev_candles), min(c.low for c in prev_candles)


# ============================================================
# Breaker Blocks
# ============================================================

@dataclass
class BreakerBlock:
    """A failed order block that has flipped role.

    When a bullish OB is broken to the downside, it becomes a bearish breaker.
    When a bearish OB is broken to the upside, it becomes a bullish breaker.
    """
    index: int          # index where the OB was invalidated (broken)
    high: float
    low: float
    is_bullish: bool    # True = bullish breaker (old bearish OB broken upward)
    midpoint: float
    original_ob_index: int  # index of the original order block


def detect_breaker_blocks(
    candles: list[Candle], swing_lookback: int = 5, atr_period: int = 14,
    min_displacement: float = 1.0,
) -> list[BreakerBlock]:
    """Detect breaker blocks — failed order blocks that flip their role.

    A bullish breaker forms when price breaks ABOVE a bearish OB.
    A bearish breaker forms when price breaks BELOW a bullish OB.
    """
    obs = detect_order_blocks(candles, swing_lookback, atr_period, min_displacement)
    breakers: list[BreakerBlock] = []

    for ob in obs:
        # Look for candles after the OB that break through it
        for i in range(ob.index + 1, len(candles)):
            if ob.is_bullish:
                # Bullish OB broken to the downside → bearish breaker
                if candles[i].close < ob.low:
                    breakers.append(BreakerBlock(
                        index=i,
                        high=ob.high,
                        low=ob.low,
                        is_bullish=False,  # flipped
                        midpoint=ob.midpoint,
                        original_ob_index=ob.index,
                    ))
                    break
            else:
                # Bearish OB broken to the upside → bullish breaker
                if candles[i].close > ob.high:
                    breakers.append(BreakerBlock(
                        index=i,
                        high=ob.high,
                        low=ob.low,
                        is_bullish=True,  # flipped
                        midpoint=ob.midpoint,
                        original_ob_index=ob.index,
                    ))
                    break

    return breakers


# ============================================================
# Unicorn Zone (FVG + Breaker Block Overlap)
# ============================================================

@dataclass
class UnicornZone:
    """Highest-confluence ICT entry — FVG overlapping a Breaker Block."""
    fvg: FairValueGap
    breaker: BreakerBlock
    overlap_top: float
    overlap_bottom: float
    is_bullish: bool


def detect_unicorn_zones(
    candles: list[Candle], swing_lookback: int = 5, atr_period: int = 14,
    min_displacement: float = 1.0,
) -> list[UnicornZone]:
    """Detect Unicorn zones — areas where an FVG overlaps a Breaker Block.

    This is the highest-confluence ICT entry pattern.
    """
    fvgs = detect_fair_value_gaps(candles)
    breakers = detect_breaker_blocks(candles, swing_lookback, atr_period, min_displacement)
    zones: list[UnicornZone] = []

    for breaker in breakers:
        for fvg in fvgs:
            # Must be same direction
            if fvg.is_bullish != breaker.is_bullish:
                continue
            # FVG must form at or after breaker formation
            if fvg.index < breaker.index:
                continue
            # Check for overlap
            overlap_top = min(fvg.top, breaker.high)
            overlap_bottom = max(fvg.bottom, breaker.low)
            if overlap_top > overlap_bottom:
                zones.append(UnicornZone(
                    fvg=fvg,
                    breaker=breaker,
                    overlap_top=overlap_top,
                    overlap_bottom=overlap_bottom,
                    is_bullish=fvg.is_bullish,
                ))

    return zones


# ============================================================
# Power of 3 / AMD Session Phase Detection
# ============================================================

class SessionPhase:
    """Identifies which Power of 3 phase the market is in."""
    ACCUMULATION = "accumulation"   # Asian session — range building
    MANIPULATION = "manipulation"   # London open — fake-out / sweep
    DISTRIBUTION = "distribution"   # NY session — the real move


def detect_po3_phase(ts_ms: int) -> str:
    """Determine which Power of 3 phase based on time."""
    h, m = _ts_to_est_hour_minute(ts_ms)
    current = h * 60 + m

    # Asian session (accumulation): 7:00 PM - 2:00 AM EST
    asian_start = 19 * 60
    asian_end = 2 * 60
    if current >= asian_start or current < asian_end:
        return SessionPhase.ACCUMULATION

    # London kill zone (manipulation): 2:00 AM - 5:00 AM EST
    if 2 * 60 <= current < 5 * 60:
        return SessionPhase.MANIPULATION

    # NY session (distribution): 7:00 AM - 2:00 PM EST
    if 7 * 60 <= current < 14 * 60:
        return SessionPhase.DISTRIBUTION

    # Transition zones — treat as manipulation/distribution respectively
    if 5 * 60 <= current < 7 * 60:
        return SessionPhase.MANIPULATION
    return SessionPhase.DISTRIBUTION


def detect_po3_setup(
    candles: list[Candle], swing_lookback: int = 5,
) -> dict:
    """Detect Power of 3 / AMD setup components.

    Returns a dict with:
    - accumulation_range: (high, low) of Asian session range
    - manipulation_sweep: direction of the manipulation phase sweep
    - distribution_bias: expected direction of the real move
    - phase: current session phase
    """
    result: dict = {
        "accumulation_range": None,
        "manipulation_sweep": None,
        "distribution_bias": None,
        "phase": None,
    }

    if not candles:
        return result

    # Determine current phase from latest candle
    result["phase"] = detect_po3_phase(candles[-1].timestamp)

    # Find accumulation (Asian) range
    asian_range = detect_session_range(candles, ASIAN_SESSION)
    if asian_range:
        result["accumulation_range"] = asian_range
        asian_high, asian_low = asian_range

        # Check for manipulation sweep during London KZ
        london_candles = [c for c in candles if is_in_kill_zone(c.timestamp, LONDON_KILL_ZONE)]
        if london_candles:
            london_high = max(c.high for c in london_candles)
            london_low = min(c.low for c in london_candles)

            # Bullish manipulation: price sweeps below Asian low
            if london_low < asian_low:
                result["manipulation_sweep"] = "bearish_fakeout"
                result["distribution_bias"] = "bullish"
            # Bearish manipulation: price sweeps above Asian high
            elif london_high > asian_high:
                result["manipulation_sweep"] = "bullish_fakeout"
                result["distribution_bias"] = "bearish"

    return result
