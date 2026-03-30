"""Quant Engine — real-time quantitative calculations running every second.

Computes continuously:
  1. Z-score per forex pair (price deviation from rolling mean)
  2. Cross-pair z-scores (correlated pair spread deviation)
  3. Interest rate parity deviation (fair value vs market)
  4. RSI-price divergence (momentum vs price disagreement)
  5. Volatility percentile (current range vs historical)
  6. Hurst exponent (trending vs mean-reverting detection)

Emits signals to the agent network when thresholds are breached.
"""

from __future__ import annotations

import logging
import math
import time
import asyncio
from dataclasses import dataclass, field
from typing import Any

from shared.types import (
    AssetClass, AssetInfo, Candle, MarketData, Signal, SignalAction,
)
from shared.events import event_bus

log = logging.getLogger(__name__)


# ============================================================
# Data types
# ============================================================

@dataclass
class QuantSnapshot:
    """Real-time quant metrics for one asset."""
    symbol: str
    timestamp: int
    price: float
    z_score: float = 0.0
    z_score_fast: float = 0.0       # Short-window z-score (20-period)
    z_score_slow: float = 0.0       # Long-window z-score (100-period)
    rsi: float = 50.0
    rsi_divergence: float = 0.0     # RSI vs price divergence score
    volatility_pct: float = 0.0     # Current ATR as % of price
    vol_percentile: float = 0.5     # Percentile rank of current vol
    hurst: float = 0.5              # Hurst exponent (>0.5=trending, <0.5=mean-reverting)
    irp_deviation: float = 0.0      # Interest rate parity deviation
    pip_range_percentile: float = 0.5


@dataclass
class PairSnapshot:
    """Real-time quant metrics for a correlated pair."""
    pair_key: str           # e.g. "EUR/USD:GBP/USD"
    symbol_a: str
    symbol_b: str
    timestamp: int
    spread: float = 0.0
    spread_z_score: float = 0.0
    correlation: float = 0.0
    beta: float = 1.0
    half_life: float = 0.0
    signal: str = "neutral"  # "long_a_short_b", "short_a_long_b", "neutral"


@dataclass
class QuantAlert:
    """Alert emitted when a quant threshold is breached."""
    alert_type: str         # "z_score", "divergence", "vol_spike", "pair_spread", "irp"
    symbol: str
    value: float
    threshold: float
    direction: str          # "overbought", "oversold", "expanding", "contracting"
    confidence: float
    timestamp: int
    details: str = ""


# ============================================================
# Interest rate table
# ============================================================

INTEREST_RATES: dict[str, float] = {
    "USD": 4.50, "EUR": 3.00, "GBP": 4.25, "JPY": 0.50,
    "AUD": 3.85, "NZD": 4.25, "CAD": 3.50, "CHF": 1.25,
    "MXN": 9.50, "ZAR": 7.50, "TRY": 45.00, "SGD": 3.20, "HKD": 4.50,
}

# Correlated forex pairs to track spread z-scores
CORRELATED_PAIRS: list[tuple[str, str]] = [
    ("EUR/USD", "GBP/USD"),     # Both vs USD, highly correlated
    ("EUR/USD", "USD/CHF"),     # Inverse correlation
    ("AUD/USD", "NZD/USD"),     # Oceanic pair
    ("USD/JPY", "EUR/JPY"),     # Yen crosses
    ("GBP/USD", "GBP/JPY"),    # GBP crosses
    ("EUR/USD", "EUR/GBP"),     # EUR crosses
    ("USD/CAD", "AUD/USD"),     # Commodity currencies
    ("EUR/USD", "EUR/JPY"),     # EUR crosses
]


# ============================================================
# Helper math
# ============================================================

def _z_score(value: float, mean: float, std: float) -> float:
    if std <= 0:
        return 0.0
    return (value - mean) / std


def _rolling_mean(values: list[float], window: int) -> float:
    if not values:
        return 0.0
    w = values[-window:]
    return sum(w) / len(w)


def _rolling_std(values: list[float], window: int) -> float:
    if len(values) < 2:
        return 0.0
    w = values[-window:]
    mean = sum(w) / len(w)
    var = sum((x - mean) ** 2 for x in w) / len(w)
    return math.sqrt(var)


def _percentile_rank(value: float, history: list[float]) -> float:
    """Rank value within history as a percentile (0.0 to 1.0)."""
    if not history:
        return 0.5
    below = sum(1 for x in history if x < value)
    return below / len(history)


def _rsi(closes: list[float], period: int = 14) -> float:
    """Fast RSI from close prices."""
    if len(closes) < period + 1:
        return 50.0
    gains, losses = 0.0, 0.0
    for i in range(len(closes) - period, len(closes)):
        delta = closes[i] - closes[i - 1]
        if delta > 0:
            gains += delta
        else:
            losses += abs(delta)
    avg_gain = gains / period
    avg_loss = losses / period
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))


def _hurst_exponent(closes: list[float], max_lag: int = 20) -> float:
    """Simplified Hurst exponent estimation via R/S analysis."""
    if len(closes) < max_lag * 2:
        return 0.5
    lags = range(2, max_lag + 1)
    rs_values = []
    for lag in lags:
        chunks = [closes[i:i + lag] for i in range(0, len(closes) - lag, lag)]
        rs_list = []
        for chunk in chunks:
            if len(chunk) < 2:
                continue
            mean = sum(chunk) / len(chunk)
            deviations = [x - mean for x in chunk]
            cumulative = []
            running = 0
            for d in deviations:
                running += d
                cumulative.append(running)
            r = max(cumulative) - min(cumulative)
            s = math.sqrt(sum(d ** 2 for d in deviations) / len(deviations))
            if s > 0:
                rs_list.append(r / s)
        if rs_list:
            rs_values.append((math.log(lag), math.log(sum(rs_list) / len(rs_list))))

    if len(rs_values) < 3:
        return 0.5

    # Linear regression on log-log plot
    n = len(rs_values)
    sum_x = sum(x for x, _ in rs_values)
    sum_y = sum(y for _, y in rs_values)
    sum_xy = sum(x * y for x, y in rs_values)
    sum_x2 = sum(x ** 2 for x, _ in rs_values)
    denom = n * sum_x2 - sum_x ** 2
    if denom == 0:
        return 0.5
    slope = (n * sum_xy - sum_x * sum_y) / denom
    return max(0.0, min(1.0, slope))


def _irp_fair_value(spot: float, base_rate: float, quote_rate: float, days: int = 365) -> float:
    """Interest rate parity forward rate."""
    return spot * ((1 + quote_rate / 100) / (1 + base_rate / 100)) ** (days / 365)


# ============================================================
# QuantEngine — the core calculator
# ============================================================

class QuantEngine:
    """Real-time quant engine computing z-scores, divergences, and more.

    Designed to run every second (or on every price tick).
    Maintains rolling state per asset for efficient incremental updates.
    """

    def __init__(
        self,
        z_fast_window: int = 20,
        z_slow_window: int = 100,
        vol_window: int = 20,
        max_history: int = 500,
    ) -> None:
        self.z_fast_window = z_fast_window
        self.z_slow_window = z_slow_window
        self.vol_window = vol_window
        self.max_history = max_history

        # Per-pair optimized params (loaded from zscore_optimizer results)
        self._pair_params: dict[str, dict] = {}  # symbol → {z_fast, z_slow, entry, exit}
        self._load_optimized_params()

        # Rolling state per asset
        self._closes: dict[str, list[float]] = {}
        self._highs: dict[str, list[float]] = {}
        self._lows: dict[str, list[float]] = {}
        self._atr_history: dict[str, list[float]] = {}
        self._snapshots: dict[str, QuantSnapshot] = {}
        self._pair_snapshots: dict[str, PairSnapshot] = {}
        self._alerts: list[QuantAlert] = []

        # Config (defaults — overridden per pair if optimized)
        self.z_alert_threshold = 2.0        # Alert when |z| > 2
        self.z_trade_threshold = 2.5        # Strong trade signal when |z| > 2.5
        self.divergence_threshold = 0.3     # RSI-price divergence
        self.vol_spike_threshold = 0.9      # 90th percentile vol
        self.pair_z_threshold = 2.0         # Cross-pair z-score alert

        self._tick_count = 0
        self._last_tick = 0

        log.info("QuantEngine initialised (fast=%d, slow=%d, vol=%d, optimized_pairs=%d)",
                 z_fast_window, z_slow_window, vol_window, len(self._pair_params))

    def _load_optimized_params(self) -> None:
        """Load per-pair optimized z-score params from disk (if available)."""
        try:
            from team.quant_engine.zscore_optimizer import ZScoreOptimizer
            optimizer = ZScoreOptimizer()
            params = optimizer.load_params()
            for sym, p in params.items():
                if p.confidence_score >= 0.2:  # Only use if reasonably confident
                    self._pair_params[sym] = {
                        "z_fast": p.z_fast_window,
                        "z_slow": p.z_slow_window,
                        "entry": p.entry_threshold,
                        "exit": p.exit_threshold,
                        "confidence": p.confidence_score,
                        "regime": p.regime,
                    }
            if self._pair_params:
                log.info("Loaded optimized z-score params for %d pairs", len(self._pair_params))
        except Exception as e:
            log.debug("No optimized z-score params available: %s", e)

    def _get_pair_params(self, symbol: str) -> dict:
        """Get z-score params for a symbol (optimized or default)."""
        if symbol in self._pair_params:
            return self._pair_params[symbol]
        return {
            "z_fast": self.z_fast_window,
            "z_slow": self.z_slow_window,
            "entry": self.z_trade_threshold,
            "exit": 0.5,
            "confidence": 0.0,
            "regime": "unknown",
        }

    # ----------------------------------------------------------------
    # Feed price data
    # ----------------------------------------------------------------

    def feed_candle(self, symbol: str, candle: Candle) -> QuantSnapshot:
        """Feed a new candle and recompute all metrics for this asset."""
        # Append to history
        if symbol not in self._closes:
            self._closes[symbol] = []
            self._highs[symbol] = []
            self._lows[symbol] = []
            self._atr_history[symbol] = []

        self._closes[symbol].append(candle.close)
        self._highs[symbol].append(candle.high)
        self._lows[symbol].append(candle.low)

        # Trim history
        if len(self._closes[symbol]) > self.max_history:
            self._closes[symbol] = self._closes[symbol][-self.max_history:]
            self._highs[symbol] = self._highs[symbol][-self.max_history:]
            self._lows[symbol] = self._lows[symbol][-self.max_history:]

        # ATR
        closes = self._closes[symbol]
        highs = self._highs[symbol]
        lows = self._lows[symbol]
        if len(closes) >= 2:
            tr = max(
                highs[-1] - lows[-1],
                abs(highs[-1] - closes[-2]),
                abs(lows[-1] - closes[-2]),
            )
            self._atr_history[symbol].append(tr)
            if len(self._atr_history[symbol]) > self.max_history:
                self._atr_history[symbol] = self._atr_history[symbol][-self.max_history:]

        return self._compute_snapshot(symbol, candle.close, candle.timestamp)

    def feed_market_data(self, data: MarketData) -> QuantSnapshot | None:
        """Feed full MarketData — processes the latest candle."""
        if not data.candles:
            return None
        # Seed history if first time
        symbol = data.asset.symbol
        if symbol not in self._closes:
            for c in data.candles[:-1]:
                self.feed_candle(symbol, c)
        return self.feed_candle(symbol, data.candles[-1])

    def feed_price(self, symbol: str, price: float, high: float | None = None,
                   low: float | None = None, timestamp: int | None = None) -> QuantSnapshot:
        """Feed a raw price tick (for real-time use)."""
        ts = timestamp or int(time.time() * 1000)
        candle = Candle(
            timestamp=ts, open=price, high=high or price,
            low=low or price, close=price, volume=0,
        )
        return self.feed_candle(symbol, candle)

    # ----------------------------------------------------------------
    # Compute
    # ----------------------------------------------------------------

    def _compute_snapshot(self, symbol: str, price: float, timestamp: int) -> QuantSnapshot:
        """Compute all quant metrics for one asset."""
        closes = self._closes.get(symbol, [])
        pp = self._get_pair_params(symbol)
        fast_w = pp["z_fast"]
        slow_w = pp["z_slow"]

        # Z-scores (use per-pair optimized windows)
        z_fast = _z_score(
            price,
            _rolling_mean(closes, fast_w),
            _rolling_std(closes, fast_w),
        ) if len(closes) >= fast_w else 0.0

        z_slow = _z_score(
            price,
            _rolling_mean(closes, slow_w),
            _rolling_std(closes, slow_w),
        ) if len(closes) >= slow_w else 0.0

        # RSI
        rsi_val = _rsi(closes) if len(closes) >= 15 else 50.0

        # RSI-price divergence
        rsi_div = self._rsi_divergence(symbol, closes, rsi_val)

        # Volatility
        atr_hist = self._atr_history.get(symbol, [])
        current_atr = atr_hist[-1] if atr_hist else 0.0
        vol_pct = (current_atr / price * 100) if price > 0 else 0.0
        vol_percentile = _percentile_rank(current_atr, atr_hist[-100:]) if len(atr_hist) >= 10 else 0.5

        # Pip range percentile
        highs = self._highs.get(symbol, [])
        lows = self._lows.get(symbol, [])
        pip_pct = 0.5
        if len(highs) >= 20:
            ranges = [h - l for h, l in zip(highs[-20:], lows[-20:])]
            current_range = highs[-1] - lows[-1]
            pip_pct = _percentile_rank(current_range, ranges)

        # Hurst exponent (recompute every 10 ticks for efficiency)
        hurst = 0.5
        if len(closes) >= 50 and self._tick_count % 10 == 0:
            hurst = _hurst_exponent(closes[-200:])

        # Interest rate parity deviation
        irp_dev = self._irp_deviation(symbol, price)

        snapshot = QuantSnapshot(
            symbol=symbol,
            timestamp=timestamp,
            price=price,
            z_score=(z_fast + z_slow) / 2,
            z_score_fast=z_fast,
            z_score_slow=z_slow,
            rsi=rsi_val,
            rsi_divergence=rsi_div,
            volatility_pct=vol_pct,
            vol_percentile=vol_percentile,
            hurst=hurst,
            irp_deviation=irp_dev,
            pip_range_percentile=pip_pct,
        )
        self._snapshots[symbol] = snapshot
        self._tick_count += 1

        # Check for alerts
        self._check_alerts(snapshot)

        return snapshot

    def _rsi_divergence(self, symbol: str, closes: list[float], current_rsi: float) -> float:
        """Detect RSI vs price divergence.

        Bullish divergence: price making lower lows but RSI making higher lows
        Bearish divergence: price making higher highs but RSI making lower highs
        Returns: -1 to +1 (negative = bearish divergence, positive = bullish)
        """
        if len(closes) < 30:
            return 0.0

        lookback = 20
        recent = closes[-lookback:]
        price_slope = (recent[-1] - recent[0]) / max(abs(recent[0]), 1e-8)

        # Compute RSI history
        rsi_history = []
        for i in range(lookback):
            idx = len(closes) - lookback + i
            if idx >= 15:
                rsi_history.append(_rsi(closes[:idx + 1]))

        if len(rsi_history) < 5:
            return 0.0

        rsi_slope = (rsi_history[-1] - rsi_history[0]) / max(abs(rsi_history[0]), 1e-8)

        # Divergence: price and RSI moving in opposite directions
        if price_slope < 0 and rsi_slope > 0:
            return min(1.0, abs(rsi_slope - price_slope))   # Bullish divergence
        elif price_slope > 0 and rsi_slope < 0:
            return -min(1.0, abs(rsi_slope - price_slope))  # Bearish divergence
        return 0.0

    def _irp_deviation(self, symbol: str, price: float) -> float:
        """Interest rate parity deviation for forex pairs."""
        parts = symbol.split("/")
        if len(parts) != 2:
            return 0.0
        base_rate = INTEREST_RATES.get(parts[0])
        quote_rate = INTEREST_RATES.get(parts[1])
        if base_rate is None or quote_rate is None:
            return 0.0
        fair = _irp_fair_value(price, base_rate, quote_rate)
        if fair == 0:
            return 0.0
        return (price - fair) / fair * 100  # Deviation as percentage

    # ----------------------------------------------------------------
    # Cross-pair calculations
    # ----------------------------------------------------------------

    def compute_pair_metrics(self) -> list[PairSnapshot]:
        """Compute z-scores for all correlated pairs."""
        results = []
        for sym_a, sym_b in CORRELATED_PAIRS:
            closes_a = self._closes.get(sym_a, [])
            closes_b = self._closes.get(sym_b, [])
            if len(closes_a) < 30 or len(closes_b) < 30:
                continue

            min_len = min(len(closes_a), len(closes_b))
            a = closes_a[-min_len:]
            b = closes_b[-min_len:]

            # Beta (OLS slope)
            mean_a = sum(a) / len(a)
            mean_b = sum(b) / len(b)
            cov = sum((a[i] - mean_a) * (b[i] - mean_b) for i in range(len(a))) / len(a)
            var_b = sum((b[i] - mean_b) ** 2 for i in range(len(b))) / len(b)
            beta = cov / var_b if var_b > 0 else 1.0

            # Spread: a - beta * b
            spreads = [a[i] - beta * b[i] for i in range(len(a))]
            spread_mean = sum(spreads) / len(spreads)
            spread_std = math.sqrt(sum((s - spread_mean) ** 2 for s in spreads) / len(spreads))
            current_spread = spreads[-1]
            z = _z_score(current_spread, spread_mean, spread_std)

            # Correlation
            std_a = math.sqrt(sum((x - mean_a) ** 2 for x in a) / len(a))
            std_b = math.sqrt(sum((x - mean_b) ** 2 for x in b) / len(b))
            corr = cov / (std_a * std_b) if std_a > 0 and std_b > 0 else 0.0

            # Half-life of mean reversion
            half_life = 0.0
            if len(spreads) > 2:
                lag_spreads = spreads[:-1]
                current_spreads = spreads[1:]
                if len(lag_spreads) > 1:
                    mean_lag = sum(lag_spreads) / len(lag_spreads)
                    mean_cur = sum(current_spreads) / len(current_spreads)
                    cov_lc = sum((current_spreads[i] - mean_cur) * (lag_spreads[i] - mean_lag)
                                 for i in range(len(lag_spreads))) / len(lag_spreads)
                    var_lag = sum((x - mean_lag) ** 2 for x in lag_spreads) / len(lag_spreads)
                    phi = cov_lc / var_lag if var_lag > 0 else 0.99
                    if 0 < phi < 1:
                        half_life = -math.log(2) / math.log(phi)

            # Signal direction
            sig = "neutral"
            if z < -self.pair_z_threshold:
                sig = "long_a_short_b"
            elif z > self.pair_z_threshold:
                sig = "short_a_long_b"

            pair_key = f"{sym_a}:{sym_b}"
            snap = PairSnapshot(
                pair_key=pair_key,
                symbol_a=sym_a,
                symbol_b=sym_b,
                timestamp=int(time.time() * 1000),
                spread=current_spread,
                spread_z_score=z,
                correlation=corr,
                beta=beta,
                half_life=half_life,
                signal=sig,
            )
            self._pair_snapshots[pair_key] = snap
            results.append(snap)

        return results

    # ----------------------------------------------------------------
    # Alerts
    # ----------------------------------------------------------------

    def _check_alerts(self, snap: QuantSnapshot) -> None:
        """Check thresholds and emit alerts."""
        now = int(time.time() * 1000)

        # Z-score alert
        if abs(snap.z_score) > self.z_alert_threshold:
            direction = "oversold" if snap.z_score < 0 else "overbought"
            self._alerts.append(QuantAlert(
                alert_type="z_score", symbol=snap.symbol,
                value=snap.z_score, threshold=self.z_alert_threshold,
                direction=direction,
                confidence=min(1.0, abs(snap.z_score) / 4),
                timestamp=now,
                details=f"Z={snap.z_score:.2f} (fast={snap.z_score_fast:.2f}, slow={snap.z_score_slow:.2f})",
            ))

        # RSI divergence alert
        if abs(snap.rsi_divergence) > self.divergence_threshold:
            direction = "bullish" if snap.rsi_divergence > 0 else "bearish"
            self._alerts.append(QuantAlert(
                alert_type="divergence", symbol=snap.symbol,
                value=snap.rsi_divergence, threshold=self.divergence_threshold,
                direction=direction,
                confidence=min(1.0, abs(snap.rsi_divergence)),
                timestamp=now,
                details=f"RSI={snap.rsi:.0f}, divergence={snap.rsi_divergence:+.2f}",
            ))

        # Volatility spike
        if snap.vol_percentile > self.vol_spike_threshold:
            self._alerts.append(QuantAlert(
                alert_type="vol_spike", symbol=snap.symbol,
                value=snap.vol_percentile, threshold=self.vol_spike_threshold,
                direction="expanding",
                confidence=snap.vol_percentile,
                timestamp=now,
                details=f"Vol percentile={snap.vol_percentile:.0%}, ATR%={snap.volatility_pct:.3f}%",
            ))

        # Keep alerts manageable
        if len(self._alerts) > 1000:
            self._alerts = self._alerts[-500:]

    # ----------------------------------------------------------------
    # Signal generation
    # ----------------------------------------------------------------

    def generate_signals(self, asset: AssetInfo) -> list[Signal]:
        """Generate trading signals from current quant state.

        Uses per-pair optimized thresholds if available (from zscore_optimizer).
        """
        snap = self._snapshots.get(asset.symbol)
        if not snap:
            return []

        signals = []
        now = int(time.time() * 1000)
        pp = self._get_pair_params(asset.symbol)
        entry_t = pp["entry"]
        exit_t = pp["exit"]
        opt_conf = pp["confidence"]  # Optimizer's confidence in this pair

        # 1. Z-score mean reversion signal (per-pair optimized threshold)
        if abs(snap.z_score) > entry_t and snap.hurst < 0.5:
            # Mean-reverting regime + extreme z-score → fade it
            action = SignalAction.BUY if snap.z_score < 0 else SignalAction.SELL
            conf = min(0.85, abs(snap.z_score) / 4)
            # Boost if both fast and slow agree
            if (snap.z_score_fast < 0 and snap.z_score_slow < 0) or \
               (snap.z_score_fast > 0 and snap.z_score_slow > 0):
                conf += 0.05
            # Boost from optimizer confidence
            if opt_conf > 0.4:
                conf += 0.05
            if opt_conf > 0.6:
                conf += 0.05
            conf = min(0.90, conf)
            signals.append(Signal(
                asset=asset, action=action, confidence=conf, price=snap.price,
                timestamp=now, strategy="quant-z-score", timeframe="tick",
                indicators={"z_score": snap.z_score, "z_fast": snap.z_score_fast,
                             "z_slow": snap.z_score_slow, "hurst": snap.hurst,
                             "entry_threshold": entry_t, "opt_confidence": opt_conf},
                reason=f"Z={snap.z_score:.2f} > {entry_t:.2f} thresh, H={snap.hurst:.2f}, opt_conf={opt_conf:.2f}",
            ))

        # 2. RSI divergence signal
        if abs(snap.rsi_divergence) > self.divergence_threshold:
            action = SignalAction.BUY if snap.rsi_divergence > 0 else SignalAction.SELL
            conf = min(0.75, abs(snap.rsi_divergence) * 0.8)
            signals.append(Signal(
                asset=asset, action=action, confidence=conf, price=snap.price,
                timestamp=now, strategy="quant-divergence", timeframe="tick",
                indicators={"rsi": snap.rsi, "divergence": snap.rsi_divergence},
                reason=f"RSI divergence={snap.rsi_divergence:+.2f}, RSI={snap.rsi:.0f}",
            ))

        # 3. IRP deviation signal (forex only)
        if asset.asset_class == AssetClass.FOREX and abs(snap.irp_deviation) > 1.0:
            # Price deviates >1% from IRP fair value
            action = SignalAction.SELL if snap.irp_deviation > 0 else SignalAction.BUY
            conf = min(0.65, abs(snap.irp_deviation) / 5)
            signals.append(Signal(
                asset=asset, action=action, confidence=conf, price=snap.price,
                timestamp=now, strategy="quant-irp", timeframe="tick",
                indicators={"irp_deviation_pct": snap.irp_deviation},
                reason=f"IRP deviation={snap.irp_deviation:+.2f}% from fair value",
            ))

        # 4. Volatility squeeze breakout (low vol → expansion)
        if snap.vol_percentile < 0.1 and snap.hurst > 0.55:
            # Very low vol + trending regime → breakout incoming
            # Direction from z-score
            if abs(snap.z_score_fast) > 0.5:
                action = SignalAction.BUY if snap.z_score_fast > 0 else SignalAction.SELL
                signals.append(Signal(
                    asset=asset, action=action, confidence=0.55, price=snap.price,
                    timestamp=now, strategy="quant-vol-squeeze", timeframe="tick",
                    indicators={"vol_percentile": snap.vol_percentile, "hurst": snap.hurst,
                                 "z_fast": snap.z_score_fast},
                    reason=f"Vol squeeze (p={snap.vol_percentile:.0%}) + trending (H={snap.hurst:.2f})",
                ))

        return signals

    def generate_pair_signals(self) -> list[Signal]:
        """Generate signals from cross-pair z-scores."""
        signals = []
        now = int(time.time() * 1000)

        for pair_snap in self._pair_snapshots.values():
            if pair_snap.signal == "neutral":
                continue
            if abs(pair_snap.correlation) < 0.5:
                continue  # Only trade well-correlated pairs

            # Asset A signal
            snap_a = self._snapshots.get(pair_snap.symbol_a)
            if not snap_a:
                continue

            conf = min(0.80, abs(pair_snap.spread_z_score) / 4)
            if pair_snap.half_life > 0:
                conf += 0.05  # Bonus for known mean-reversion speed

            if pair_snap.signal == "long_a_short_b":
                action = SignalAction.BUY
            else:
                action = SignalAction.SELL

            from config.assets import ALL_ASSETS
            asset_a = next((a for a in ALL_ASSETS if a.symbol == pair_snap.symbol_a), None)
            if asset_a:
                signals.append(Signal(
                    asset=asset_a, action=action, confidence=conf, price=snap_a.price,
                    timestamp=now, strategy="quant-pair-spread", timeframe="tick",
                    indicators={
                        "pair": pair_snap.pair_key,
                        "spread_z": pair_snap.spread_z_score,
                        "correlation": pair_snap.correlation,
                        "half_life": pair_snap.half_life,
                        "beta": pair_snap.beta,
                    },
                    reason=f"Pair {pair_snap.pair_key} z={pair_snap.spread_z_score:.2f}, "
                           f"corr={pair_snap.correlation:.2f}, HL={pair_snap.half_life:.1f}",
                ))

        return signals

    # ----------------------------------------------------------------
    # Getters
    # ----------------------------------------------------------------

    def get_snapshot(self, symbol: str) -> QuantSnapshot | None:
        return self._snapshots.get(symbol)

    def get_all_snapshots(self) -> dict[str, QuantSnapshot]:
        return dict(self._snapshots)

    def get_pair_snapshots(self) -> dict[str, PairSnapshot]:
        return dict(self._pair_snapshots)

    def get_recent_alerts(self, count: int = 50) -> list[QuantAlert]:
        return self._alerts[-count:]

    def get_status(self) -> dict:
        return {
            "tracked_assets": len(self._closes),
            "tracked_pairs": len(self._pair_snapshots),
            "total_ticks": self._tick_count,
            "pending_alerts": len(self._alerts),
            "z_alert_threshold": self.z_alert_threshold,
            "z_trade_threshold": self.z_trade_threshold,
        }

    # ----------------------------------------------------------------
    # Reporting
    # ----------------------------------------------------------------

    @staticmethod
    def format_dashboard(snapshots: dict[str, QuantSnapshot], pairs: dict[str, PairSnapshot]) -> str:
        """Format a live quant dashboard."""
        lines = ["\n=== QUANT ENGINE DASHBOARD ===\n"]

        # Sort by absolute z-score (most extreme first)
        sorted_snaps = sorted(snapshots.values(), key=lambda s: abs(s.z_score), reverse=True)

        lines.append(f"{'Symbol':<12} {'Price':>10} {'Z-fast':>7} {'Z-slow':>7} {'Z-avg':>7} "
                      f"{'RSI':>5} {'Div':>6} {'Vol%':>6} {'Hurst':>6} {'IRP%':>6}")
        lines.append("-" * 95)

        for s in sorted_snaps[:20]:
            z_flag = " **" if abs(s.z_score) > 2.0 else ""
            lines.append(
                f"{s.symbol:<12} {s.price:>10.5f} {s.z_score_fast:>+7.2f} {s.z_score_slow:>+7.2f} "
                f"{s.z_score:>+7.2f} {s.rsi:>5.0f} {s.rsi_divergence:>+6.2f} "
                f"{s.vol_percentile:>5.0%} {s.hurst:>6.2f} {s.irp_deviation:>+6.2f}{z_flag}"
            )

        if pairs:
            lines.append(f"\n{'Pair':<25} {'Z-score':>8} {'Corr':>6} {'HL':>6} {'Signal':<20}")
            lines.append("-" * 70)
            sorted_pairs = sorted(pairs.values(), key=lambda p: abs(p.spread_z_score), reverse=True)
            for p in sorted_pairs:
                lines.append(
                    f"{p.pair_key:<25} {p.spread_z_score:>+8.2f} {p.correlation:>6.2f} "
                    f"{p.half_life:>6.1f} {p.signal:<20}"
                )

        return "\n".join(lines)
