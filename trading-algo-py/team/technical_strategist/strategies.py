"""Four trading strategies: momentum, mean-reversion, breakout, multi-indicator.

Improvements over v1:
- Momentum: added ADX trend-strength filter + SMA200 trend direction filter
- Mean-reversion: added mean-reversion confirmation (RSI divergence check)
- Breakout: replaced volume check with ATR expansion for forex compatibility
- Multi-indicator: lowered threshold from 0.55→0.35 to actually generate signals,
  added trend alignment bonus for confluence
"""

from __future__ import annotations

import time
import uuid
import logging
from abc import ABC, abstractmethod

from shared.types import (
    AssetInfo, Candle, MarketData, Signal, SignalAction,
    StrategyConfig, StrategyDNA,
)
from shared.indicators import (
    sma, ema, rsi, macd, atr, bollinger_bands, stochastic,
    detect_swing_points, detect_fair_value_gaps, detect_liquidity_sweeps,
    detect_displacement, detect_market_structure, detect_order_blocks,
    premium_discount_zone, is_in_ote_zone,
)

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

    def _trend_direction(self, candles: list[Candle], period: int = 50) -> float | None:
        """Return trend direction: >0 = uptrend, <0 = downtrend, None = insufficient data."""
        sma_vals = sma(candles, period)
        if sma_vals[-1] is None:
            return None
        return candles[-1].close - sma_vals[-1]

    def _calc_adx(self, candles: list[Candle], period: int = 14) -> float | None:
        """Simplified ADX — measures trend strength (0-100)."""
        if len(candles) < period * 2 + 1:
            return None

        plus_dm_list = []
        minus_dm_list = []
        tr_list = []

        for j in range(1, len(candles)):
            h = candles[j].high
            l = candles[j].low
            ph = candles[j - 1].high
            pl = candles[j - 1].low
            pc = candles[j - 1].close

            plus_dm = max(h - ph, 0) if (h - ph) > (pl - l) else 0
            minus_dm = max(pl - l, 0) if (pl - l) > (h - ph) else 0
            tr = max(h - l, abs(h - pc), abs(l - pc))

            plus_dm_list.append(plus_dm)
            minus_dm_list.append(minus_dm)
            tr_list.append(tr)

        if len(tr_list) < period:
            return None

        # Smoothed averages
        smoothed_plus = sum(plus_dm_list[:period])
        smoothed_minus = sum(minus_dm_list[:period])
        smoothed_tr = sum(tr_list[:period])

        dx_vals = []
        for j in range(period, len(tr_list)):
            smoothed_plus = smoothed_plus - smoothed_plus / period + plus_dm_list[j]
            smoothed_minus = smoothed_minus - smoothed_minus / period + minus_dm_list[j]
            smoothed_tr = smoothed_tr - smoothed_tr / period + tr_list[j]

            if smoothed_tr == 0:
                continue
            plus_di = 100 * smoothed_plus / smoothed_tr
            minus_di = 100 * smoothed_minus / smoothed_tr
            di_sum = plus_di + minus_di
            if di_sum == 0:
                continue
            dx = 100 * abs(plus_di - minus_di) / di_sum
            dx_vals.append(dx)

        if len(dx_vals) < period:
            return None

        adx = sum(dx_vals[-period:]) / period
        return adx


class MomentumStrategy(BaseStrategy):
    """Momentum strategy using EMA crossovers + RSI + ADX trend filter.

    v2 improvements:
    - ADX filter: only trade when ADX > 20 (trending market)
    - SMA50 trend alignment: buy only in uptrend, sell only in downtrend
    - Higher base confidence requirement
    """

    def get_default_dna(self) -> StrategyDNA:
        return StrategyDNA(
            id=str(uuid.uuid4())[:8],
            name="momentum",
            params={"fast_ema": 12, "slow_ema": 26, "rsi_period": 14,
                    "rsi_overbought": 70, "rsi_oversold": 30,
                    "adx_threshold": 20, "trend_period": 50,
                    "min_confidence": 0.5},
        )

    def analyze(self, data: MarketData) -> list[Signal]:
        candles = data.candles
        if len(candles) < 55:
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

        # Trend filters
        adx = self._calc_adx(candles, 14)
        adx_threshold = p.get("adx_threshold", 20)
        trend = self._trend_direction(candles, int(p.get("trend_period", 50)))

        indicators = {
            "fast_ema": fast[i], "slow_ema": slow[i], "rsi": rsi_vals[i],
            "adx": adx or 0, "trend": trend or 0,
        }

        # Skip if market is not trending (ADX too low)
        if adx is not None and adx < adx_threshold:
            return [self._make_signal(
                data.asset, SignalAction.HOLD, 0.2, candles[i].close,
                data.timeframe, indicators, f"Weak trend (ADX={adx:.1f})",
            )]

        # Bullish crossover — only if price above SMA50 (uptrend)
        if fast[i - 1] <= slow[i - 1] and fast[i] > slow[i]:
            if rsi_vals[i] < p.get("rsi_overbought", 70):
                if trend is not None and trend <= 0:
                    return [self._make_signal(
                        data.asset, SignalAction.HOLD, 0.3, candles[i].close,
                        data.timeframe, indicators, "Bullish crossover against downtrend — skipped",
                    )]
                conf = 0.6 + (fast[i] - slow[i]) / slow[i] * 10
                # ADX strength bonus
                if adx and adx > 30:
                    conf += 0.1
                return [self._make_signal(
                    data.asset, SignalAction.BUY, conf, candles[i].close,
                    data.timeframe, indicators, "EMA bullish crossover, trend-aligned + ADX confirmation",
                )]

        # Bearish crossover — only if price below SMA50 (downtrend)
        if fast[i - 1] >= slow[i - 1] and fast[i] < slow[i]:
            if rsi_vals[i] > p.get("rsi_oversold", 30):
                if trend is not None and trend >= 0:
                    return [self._make_signal(
                        data.asset, SignalAction.HOLD, 0.3, candles[i].close,
                        data.timeframe, indicators, "Bearish crossover against uptrend — skipped",
                    )]
                conf = 0.6 + (slow[i] - fast[i]) / slow[i] * 10
                if adx and adx > 30:
                    conf += 0.1
                return [self._make_signal(
                    data.asset, SignalAction.SELL, conf, candles[i].close,
                    data.timeframe, indicators, "EMA bearish crossover, trend-aligned + ADX confirmation",
                )]

        return [self._make_signal(
            data.asset, SignalAction.HOLD, 0.3, candles[i].close,
            data.timeframe, indicators, "No momentum signal",
        )]


class MeanReversionStrategy(BaseStrategy):
    """Mean reversion using Bollinger Bands + RSI extremes.

    v2 improvements:
    - Added RSI divergence check (price makes new low but RSI doesn't)
    - Tighter entry: requires RSI < 25 / > 75 (was 30/70) for stronger extremes
    - Only trades when BB width is wide enough (avoids choppy markets)
    """

    def get_default_dna(self) -> StrategyDNA:
        return StrategyDNA(
            id=str(uuid.uuid4())[:8],
            name="mean-reversion",
            params={"bb_period": 20, "bb_std": 2.0, "rsi_period": 14,
                    "rsi_oversold": 25, "rsi_overbought": 75,
                    "min_bb_width_pct": 0.5},
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
        bb_width = upper[i] - lower[i]
        bb_width_pct = (bb_width / middle[i] * 100) if middle[i] else 0
        min_width = p.get("min_bb_width_pct", 0.5)

        indicators = {
            "bb_upper": upper[i], "bb_middle": middle[i], "bb_lower": lower[i],
            "rsi": rsi_vals[i], "price": price, "bb_width_pct": bb_width_pct,
        }

        # Skip if BB is too narrow (choppy/ranging — no reversion opportunity)
        if bb_width_pct < min_width:
            return [self._make_signal(
                data.asset, SignalAction.HOLD, 0.2, price,
                data.timeframe, indicators, f"BB too narrow ({bb_width_pct:.2f}%) — no reversion setup",
            )]

        # RSI divergence check: price at new 5-bar low but RSI is higher
        rsi_divergence_bull = False
        rsi_divergence_bear = False
        if len(candles) > 5 and rsi_vals[i - 5] is not None:
            if price < min(c.close for c in candles[i - 5:i]) and rsi_vals[i] > rsi_vals[i - 5]:
                rsi_divergence_bull = True
            if price > max(c.close for c in candles[i - 5:i]) and rsi_vals[i] < rsi_vals[i - 5]:
                rsi_divergence_bear = True

        # Price below lower band + RSI oversold = buy
        if price <= lower[i] and rsi_vals[i] < p.get("rsi_oversold", 25):
            dist = (lower[i] - price) / bb_width if bb_width > 0 else 0
            conf = 0.55 + dist * 2
            if rsi_divergence_bull:
                conf += 0.15  # Divergence bonus
                indicators["rsi_divergence"] = 1.0
            return [self._make_signal(
                data.asset, SignalAction.BUY, conf, price,
                data.timeframe, indicators,
                "Price below lower BB + RSI oversold" + (" + bullish divergence" if rsi_divergence_bull else ""),
            )]

        # Price above upper band + RSI overbought = sell
        if price >= upper[i] and rsi_vals[i] > p.get("rsi_overbought", 75):
            dist = (price - upper[i]) / bb_width if bb_width > 0 else 0
            conf = 0.55 + dist * 2
            if rsi_divergence_bear:
                conf += 0.15
                indicators["rsi_divergence"] = -1.0
            return [self._make_signal(
                data.asset, SignalAction.SELL, conf, price,
                data.timeframe, indicators,
                "Price above upper BB + RSI overbought" + (" + bearish divergence" if rsi_divergence_bear else ""),
            )]

        return [self._make_signal(
            data.asset, SignalAction.HOLD, 0.3, price,
            data.timeframe, indicators, "Price within Bollinger Bands",
        )]


class BreakoutStrategy(BaseStrategy):
    """Breakout strategy using price channels + ATR expansion confirmation.

    v2 improvements:
    - Replaced volume check with ATR expansion (works for forex where volume=0)
    - ATR must be expanding (current ATR > 1.2x avg ATR of lookback) to confirm breakout
    - Added close-based channel (not just high/low) to reduce whipsaws
    """

    def get_default_dna(self) -> StrategyDNA:
        return StrategyDNA(
            id=str(uuid.uuid4())[:8],
            name="breakout",
            params={"lookback": 20, "atr_period": 14, "atr_multiplier": 1.5,
                    "atr_expansion": 1.2, "volume_threshold": 1.5},
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
        # Also use close-based channel (more conservative)
        highest_close = max(c.close for c in window)
        lowest_close = min(c.close for c in window)
        price = candles[i].close

        atr_vals = atr(candles, int(self.dna.params.get("atr_period", 14)))
        atr_val = atr_vals[i]

        # ATR expansion check: current ATR vs average ATR over lookback
        atr_expansion_ok = True
        atr_expansion = self.dna.params.get("atr_expansion", 1.2)
        recent_atrs = [atr_vals[j] for j in range(i - lookback, i) if atr_vals[j] is not None]
        avg_atr = sum(recent_atrs) / len(recent_atrs) if recent_atrs else None
        atr_ratio = (atr_val / avg_atr) if (atr_val and avg_atr) else 1.0
        if atr_ratio < atr_expansion:
            atr_expansion_ok = False

        # Volume check (still used for crypto)
        avg_vol = sum(c.volume for c in window) / len(window) if window[0].volume > 0 else 0
        cur_vol = candles[i].volume
        vol_ratio = cur_vol / avg_vol if avg_vol > 0 else 1.0

        indicators = {
            "channel_high": highest, "channel_low": lowest,
            "atr": atr_val or 0, "atr_ratio": atr_ratio,
            "volume_ratio": vol_ratio,
        }

        atr_mult = self.dna.params.get("atr_multiplier", 1.5)
        vol_thresh = self.dna.params.get("volume_threshold", 1.5)

        # For forex, use ATR expansion; for crypto, use volume OR ATR expansion
        has_volume = avg_vol > 0
        vol_ok = vol_ratio >= vol_thresh if has_volume else True
        confirmed = atr_expansion_ok or (has_volume and vol_ok)

        # Bullish breakout — price closes above channel high
        if price > highest_close and atr_val:
            if confirmed:
                breakout_strength = (price - highest) / (atr_val * atr_mult) if atr_val else 0
                conf = 0.55 + min(breakout_strength, 0.35)
                if atr_expansion_ok:
                    conf += 0.05  # ATR expansion bonus
                return [self._make_signal(
                    data.asset, SignalAction.BUY, conf, price,
                    data.timeframe, indicators,
                    f"Bullish breakout above {lookback}-period high (ATR ratio={atr_ratio:.2f})",
                )]

        # Bearish breakout — price closes below channel low
        if price < lowest_close and atr_val:
            if confirmed:
                breakout_strength = (lowest - price) / (atr_val * atr_mult) if atr_val else 0
                conf = 0.55 + min(breakout_strength, 0.35)
                if atr_expansion_ok:
                    conf += 0.05
                return [self._make_signal(
                    data.asset, SignalAction.SELL, conf, price,
                    data.timeframe, indicators,
                    f"Bearish breakout below {lookback}-period low (ATR ratio={atr_ratio:.2f})",
                )]

        return [self._make_signal(
            data.asset, SignalAction.HOLD, 0.2, price,
            data.timeframe, indicators, "No breakout detected",
        )]


class MultiIndicatorStrategy(BaseStrategy):
    """Combines multiple indicators with weighted voting.

    v2 improvements:
    - Lowered threshold from 0.55 to 0.35 (was too strict, generating almost no trades)
    - Added trend alignment bonus: +0.15 if SMA50 agrees with signal direction
    - Smoother RSI scoring (linear instead of hard thresholds)
    """

    def get_default_dna(self) -> StrategyDNA:
        return StrategyDNA(
            id=str(uuid.uuid4())[:8],
            name="multi-indicator",
            params={
                "ema_fast": 9, "ema_slow": 21,
                "rsi_period": 14, "macd_fast": 12, "macd_slow": 26, "macd_signal": 9,
                "stoch_k": 14, "stoch_d": 3,
                "w_ema": 0.25, "w_rsi": 0.25, "w_macd": 0.25, "w_stoch": 0.25,
                "threshold": 0.35,
                "trend_period": 50,
            },
        )

    def analyze(self, data: MarketData) -> list[Signal]:
        candles = data.candles
        if len(candles) < 55:
            return []

        p = self.dna.params
        i = len(candles) - 1

        # EMA crossover signal (with momentum: how far apart they are)
        fast_ema = ema(candles, int(p.get("ema_fast", 9)))
        slow_ema = ema(candles, int(p.get("ema_slow", 21)))
        ema_score = 0.0
        if fast_ema[i] and slow_ema[i] and slow_ema[i] != 0:
            gap = (fast_ema[i] - slow_ema[i]) / slow_ema[i]
            ema_score = max(min(gap * 100, 1.0), -1.0)  # Smooth score, capped at +/-1

        # RSI signal (smooth linear scoring)
        rsi_vals = rsi(candles, int(p.get("rsi_period", 14)))
        rsi_score = 0.0
        if rsi_vals[i] is not None:
            # Linear: RSI 0→+1, RSI 50→0, RSI 100→-1
            rsi_score = (50 - rsi_vals[i]) / 50

        # MACD signal (use histogram magnitude)
        macd_line, signal_line, histogram = macd(
            candles, int(p.get("macd_fast", 12)), int(p.get("macd_slow", 26)), int(p.get("macd_signal", 9)),
        )
        macd_score = 0.0
        if histogram[i] is not None:
            # Normalize by price for comparability
            price = candles[i].close
            macd_score = max(min(histogram[i] / (price * 0.001), 1.0), -1.0) if price else 0

        # Stochastic signal (smooth)
        k_vals, d_vals = stochastic(candles, int(p.get("stoch_k", 14)), int(p.get("stoch_d", 3)))
        stoch_score = 0.0
        if k_vals[i] is not None:
            # Linear: %K 0→+1, %K 50→0, %K 100→-1
            stoch_score = (50 - k_vals[i]) / 50

        # Weighted vote
        w = {
            "ema": p.get("w_ema", 0.25), "rsi": p.get("w_rsi", 0.25),
            "macd": p.get("w_macd", 0.25), "stoch": p.get("w_stoch", 0.25),
        }
        total = (
            ema_score * w["ema"] + rsi_score * w["rsi"] +
            macd_score * w["macd"] + stoch_score * w["stoch"]
        )

        # Trend alignment bonus
        trend = self._trend_direction(candles, int(p.get("trend_period", 50)))
        trend_bonus = 0.0
        if trend is not None:
            if (total > 0 and trend > 0) or (total < 0 and trend < 0):
                trend_bonus = 0.15  # Signal agrees with trend
            elif (total > 0 and trend < 0) or (total < 0 and trend > 0):
                trend_bonus = -0.1  # Signal against trend — penalize

        adjusted_total = total + (trend_bonus if total > 0 else -trend_bonus if total < 0 else 0)

        indicators = {
            "ema_score": ema_score, "rsi_score": rsi_score,
            "macd_score": macd_score, "stoch_score": stoch_score,
            "composite": total, "adjusted_composite": adjusted_total,
            "trend_bonus": trend_bonus,
            "rsi": rsi_vals[i] or 0, "stoch_k": k_vals[i] or 0,
        }

        threshold = p.get("threshold", 0.35)
        price = candles[i].close

        if adjusted_total >= threshold:
            return [self._make_signal(
                data.asset, SignalAction.BUY, abs(adjusted_total), price,
                data.timeframe, indicators,
                f"Multi-indicator bullish (score={adjusted_total:.2f}, trend={'aligned' if trend_bonus > 0 else 'neutral'})",
            )]
        elif adjusted_total <= -threshold:
            return [self._make_signal(
                data.asset, SignalAction.SELL, abs(adjusted_total), price,
                data.timeframe, indicators,
                f"Multi-indicator bearish (score={adjusted_total:.2f}, trend={'aligned' if trend_bonus > 0 else 'neutral'})",
            )]

        return [self._make_signal(
            data.asset, SignalAction.HOLD, 0.3, price,
            data.timeframe, indicators, f"Multi-indicator neutral (score={adjusted_total:.2f})",
        )]


class SMCStrategy(BaseStrategy):
    """Smart Money Concepts / ICT strategy.

    Implements the core ICT 2022 model:
    1. Detect market structure (BOS/CHoCH) for trend bias
    2. Identify liquidity sweeps (stop hunts)
    3. Confirm with displacement (strong institutional candle)
    4. Enter on retracement to FVG or order block
    5. Use premium/discount + OTE zone for entry filtering
    6. Target opposing liquidity pool

    Codable ICT concepts used:
    - Market structure (BOS/CHoCH) for trend direction
    - Fair Value Gaps for entry zones
    - Liquidity sweeps for manipulation detection
    - Displacement for institutional confirmation
    - Order blocks as confluence entry zones
    - Premium/discount zones for directional bias
    - OTE (62%-79% retracement) for optimal entries
    """

    def get_default_dna(self) -> StrategyDNA:
        return StrategyDNA(
            id=str(uuid.uuid4())[:8],
            name="smc",
            params={
                "swing_lookback": 5,
                "atr_period": 14,
                "displacement_threshold": 1.5,
                "min_reversal_pct": 0.3,
                "fvg_recency": 20,        # only consider FVGs from last N candles
                "ob_recency": 20,         # only consider OBs from last N candles
                "structure_weight": 0.25,  # weight for market structure confluence
                "fvg_weight": 0.30,       # weight for FVG entry
                "sweep_weight": 0.25,     # weight for liquidity sweep
                "pd_weight": 0.20,        # weight for premium/discount zone
                "min_confidence": 0.45,
            },
        )

    def analyze(self, data: MarketData) -> list[Signal]:
        candles = data.candles
        if len(candles) < 60:
            return []

        p = self.dna.params
        i = len(candles) - 1
        price = candles[i].close
        swing_lb = int(p.get("swing_lookback", 5))
        atr_period = int(p.get("atr_period", 14))
        disp_threshold = p.get("displacement_threshold", 1.5)

        # --- 1. Market Structure ---
        structure_breaks = detect_market_structure(candles, swing_lb, atr_period)
        latest_break = structure_breaks[-1] if structure_breaks else None
        structure_bias = 0.0  # positive = bullish, negative = bearish
        has_choch = False

        if latest_break:
            # Recency: only consider breaks in last 30 candles
            if i - latest_break.index <= 30:
                structure_bias = 1.0 if latest_break.is_bullish else -1.0
                has_choch = latest_break.is_choch
                # Displacement-confirmed structure shift is stronger
                if latest_break.displacement > 1.0:
                    structure_bias *= 1.0 + min(latest_break.displacement - 1.0, 1.0) * 0.5

        # --- 2. Liquidity Sweeps ---
        sweeps = detect_liquidity_sweeps(candles, swing_lb, p.get("min_reversal_pct", 0.3))
        recent_sweep = None
        sweep_score = 0.0

        for s in reversed(sweeps):
            if i - s.index <= 10:  # only last 10 candles
                recent_sweep = s
                # Sell-side sweep (below lows) = bullish setup
                # Buy-side sweep (above highs) = bearish setup
                sweep_score = -1.0 if s.is_buy_side else 1.0
                sweep_score *= min(s.reversal_strength * 100, 2.0)
                break

        # --- 3. Displacement ---
        displacements = detect_displacement(candles, atr_period, disp_threshold)
        recent_displacement = None
        for d_idx, d_strength, d_bull in reversed(displacements):
            if i - d_idx <= 5:
                recent_displacement = (d_idx, d_strength, d_bull)
                break

        # --- 4. Fair Value Gaps ---
        fvgs = detect_fair_value_gaps(candles)
        fvg_recency = int(p.get("fvg_recency", 20))
        fvg_score = 0.0
        active_fvg = None

        for fvg in reversed(fvgs):
            if i - fvg.index > fvg_recency:
                break
            # Check if current price is inside or touching the FVG
            if fvg.bottom <= price <= fvg.top:
                active_fvg = fvg
                if fvg.is_bullish:
                    # Price retracing into bullish FVG = buy opportunity
                    fvg_score = 1.0
                    # Bonus if price is near CE (consequent encroachment)
                    ce_distance = abs(price - fvg.ce) / (fvg.top - fvg.bottom) if fvg.top != fvg.bottom else 0
                    if ce_distance < 0.3:
                        fvg_score += 0.3  # Near CE = stronger
                else:
                    # Price retracing into bearish FVG = sell opportunity
                    fvg_score = -1.0
                    ce_distance = abs(price - fvg.ce) / (fvg.top - fvg.bottom) if fvg.top != fvg.bottom else 0
                    if ce_distance < 0.3:
                        fvg_score -= 0.3
                break

        # --- 5. Order Blocks ---
        obs = detect_order_blocks(candles, swing_lb, atr_period, disp_threshold)
        ob_recency = int(p.get("ob_recency", 20))
        ob_confluence = False

        for ob in reversed(obs):
            if i - ob.index > ob_recency:
                break
            # Price touching an order block
            if ob.low <= price <= ob.high:
                if ob.is_bullish and fvg_score > 0:
                    ob_confluence = True  # Bullish OB + bullish FVG = strong confluence
                elif not ob.is_bullish and fvg_score < 0:
                    ob_confluence = True
                break

        # --- 6. Premium / Discount Zone ---
        swings = detect_swing_points(candles, swing_lb)
        pd_score = 0.0
        in_ote = False

        recent_highs = [s for s in swings if s.is_high and i - s.index <= 50]
        recent_lows = [s for s in swings if not s.is_high and i - s.index <= 50]

        if recent_highs and recent_lows:
            swing_high = max(s.price for s in recent_highs)
            swing_low = min(s.price for s in recent_lows)
            eq, is_discount, zone_pct = premium_discount_zone(swing_high, swing_low, price)

            if is_discount:
                pd_score = zone_pct  # deeper discount = stronger buy signal
            else:
                pd_score = -zone_pct  # deeper premium = stronger sell signal

            # OTE check
            if structure_bias > 0:
                in_ote = is_in_ote_zone(swing_high, swing_low, price, is_bullish=True)
            elif structure_bias < 0:
                in_ote = is_in_ote_zone(swing_high, swing_low, price, is_bullish=False)

        # --- 7. Composite Signal ---
        w_struct = p.get("structure_weight", 0.25)
        w_fvg = p.get("fvg_weight", 0.30)
        w_sweep = p.get("sweep_weight", 0.25)
        w_pd = p.get("pd_weight", 0.20)

        composite = (
            structure_bias * w_struct +
            fvg_score * w_fvg +
            sweep_score * w_sweep +
            pd_score * w_pd
        )

        # Confluence bonuses
        if ob_confluence:
            composite *= 1.2  # OB + FVG overlap (Unicorn setup)
        if in_ote:
            composite *= 1.15  # Price in OTE zone
        if has_choch and recent_displacement:
            composite *= 1.1  # CHoCH + displacement = MSS confirmation
        if recent_sweep and recent_displacement:
            # Sweep followed by displacement = classic ICT setup
            _, d_strength, d_bull = recent_displacement
            if (not recent_sweep.is_buy_side and d_bull) or (recent_sweep.is_buy_side and not d_bull):
                composite *= 1.15

        indicators = {
            "structure_bias": structure_bias,
            "fvg_score": fvg_score,
            "sweep_score": sweep_score,
            "pd_score": pd_score,
            "composite": composite,
            "has_choch": 1.0 if has_choch else 0.0,
            "ob_confluence": 1.0 if ob_confluence else 0.0,
            "in_ote": 1.0 if in_ote else 0.0,
            "has_displacement": 1.0 if recent_displacement else 0.0,
            "has_sweep": 1.0 if recent_sweep else 0.0,
        }

        min_conf = p.get("min_confidence", 0.45)

        if composite >= min_conf:
            reasons = []
            if structure_bias > 0:
                reasons.append("bullish structure" + (" CHoCH" if has_choch else " BOS"))
            if fvg_score > 0:
                reasons.append("bullish FVG entry")
            if sweep_score > 0:
                reasons.append("sell-side sweep")
            if pd_score > 0:
                reasons.append("discount zone")
            if in_ote:
                reasons.append("OTE zone")
            if ob_confluence:
                reasons.append("OB confluence")
            return [self._make_signal(
                data.asset, SignalAction.BUY, min(abs(composite), 1.0), price,
                data.timeframe, indicators,
                "SMC bullish: " + ", ".join(reasons) if reasons else "SMC bullish confluence",
            )]

        elif composite <= -min_conf:
            reasons = []
            if structure_bias < 0:
                reasons.append("bearish structure" + (" CHoCH" if has_choch else " BOS"))
            if fvg_score < 0:
                reasons.append("bearish FVG entry")
            if sweep_score < 0:
                reasons.append("buy-side sweep")
            if pd_score < 0:
                reasons.append("premium zone")
            if in_ote:
                reasons.append("OTE zone")
            if ob_confluence:
                reasons.append("OB confluence")
            return [self._make_signal(
                data.asset, SignalAction.SELL, min(abs(composite), 1.0), price,
                data.timeframe, indicators,
                "SMC bearish: " + ", ".join(reasons) if reasons else "SMC bearish confluence",
            )]

        return [self._make_signal(
            data.asset, SignalAction.HOLD, 0.2, price,
            data.timeframe, indicators,
            f"SMC no confluence (score={composite:.2f})",
        )]


# ============================================================
# Strategy Factory
# ============================================================

ALL_STRATEGIES: dict[str, type[BaseStrategy]] = {
    "momentum": MomentumStrategy,
    "mean-reversion": MeanReversionStrategy,
    "breakout": BreakoutStrategy,
    "multi-indicator": MultiIndicatorStrategy,
    "smc": SMCStrategy,
}


def create_strategy(name: str, dna: StrategyDNA | None = None) -> BaseStrategy:
    cls = ALL_STRATEGIES.get(name)
    if cls is None:
        raise ValueError(f"Unknown strategy: {name}")
    config = StrategyConfig(name=name, enabled=True)
    return cls(config, dna)


def get_all_strategies() -> list[BaseStrategy]:
    return [create_strategy(name) for name in ALL_STRATEGIES]
