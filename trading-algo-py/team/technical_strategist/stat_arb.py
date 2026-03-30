"""Statistical Arbitrage / Pairs Trading strategy.

Implements cointegration-based pairs trading using the Engle-Granger method
with manual ADF test, OLS hedge ratio estimation, and Ornstein-Uhlenbeck
half-life calculation for dynamic lookback periods.

No external dependencies beyond the standard library — ADF critical values
and OLS regression are implemented from scratch.
"""

from __future__ import annotations

import math
import time
import logging
from dataclasses import dataclass, field

from shared.types import (
    AssetInfo,
    AssetClass,
    Candle,
    MarketData,
    Signal,
    SignalAction,
    StrategyConfig,
    StrategyDNA,
)
from team.technical_strategist.strategies import BaseStrategy

log = logging.getLogger(__name__)


# ============================================================
# Pair Definitions
# ============================================================

CRYPTO_PAIRS: list[tuple[str, str]] = [
    ("BTC/USDT", "ETH/USDT"),
    ("SOL/USDT", "AVAX/USDT"),
    ("BNB/USDT", "SOL/USDT"),
    ("ADA/USDT", "XRP/USDT"),
    ("DOGE/USDT", "SHIB/USDT"),
    ("LINK/USDT", "DOT/USDT"),
    ("MATIC/USDT", "AVAX/USDT"),
]

FOREX_PAIRS: list[tuple[str, str]] = [
    ("EUR/USD", "GBP/USD"),
    ("AUD/USD", "NZD/USD"),
    ("USD/CHF", "USD/JPY"),
    ("EUR/GBP", "EUR/CHF"),
    ("GBP/USD", "AUD/USD"),
    ("USD/CAD", "AUD/USD"),
]

ALL_PAIRS: list[tuple[str, str]] = CRYPTO_PAIRS + FOREX_PAIRS


# ============================================================
# Data Structures
# ============================================================

@dataclass
class PairState:
    """Cached state for a cointegrated pair."""
    symbol_a: str
    symbol_b: str
    hedge_ratio: float = 0.0
    spread_mean: float = 0.0
    spread_std: float = 0.0
    z_score: float = 0.0
    half_life: float = 20.0
    adf_statistic: float = 0.0
    is_cointegrated: bool = False
    last_updated: int = 0
    spread_series: list[float] = field(default_factory=list)


# ============================================================
# Statistical Helpers (no external dependencies)
# ============================================================

def _mean(values: list[float]) -> float:
    """Arithmetic mean."""
    if not values:
        return 0.0
    return sum(values) / len(values)


def _std(values: list[float], ddof: int = 1) -> float:
    """Standard deviation with Bessel's correction."""
    n = len(values)
    if n <= ddof:
        return 0.0
    mu = _mean(values)
    var = sum((x - mu) ** 2 for x in values) / (n - ddof)
    return math.sqrt(var)


def _ols_regression(y: list[float], x: list[float]) -> tuple[float, float, list[float]]:
    """Ordinary Least Squares: y = alpha + beta * x.

    Returns (alpha, beta, residuals).
    """
    n = len(y)
    if n < 3 or n != len(x):
        return 0.0, 0.0, []

    x_mean = _mean(x)
    y_mean = _mean(y)

    ss_xy = sum((x[i] - x_mean) * (y[i] - y_mean) for i in range(n))
    ss_xx = sum((x[i] - x_mean) ** 2 for i in range(n))

    if ss_xx == 0:
        return y_mean, 0.0, [y[i] - y_mean for i in range(n)]

    beta = ss_xy / ss_xx
    alpha = y_mean - beta * x_mean
    residuals = [y[i] - alpha - beta * x[i] for i in range(n)]
    return alpha, beta, residuals


def _adf_test(series: list[float]) -> tuple[float, bool]:
    """Augmented Dickey-Fuller test for stationarity (simplified).

    Tests H0: series has a unit root (non-stationary).
    Implements the basic DF regression: delta_y_t = alpha + gamma * y_{t-1} + epsilon_t
    and computes the t-statistic for gamma.

    Returns (adf_statistic, is_stationary) using 5% critical value of -2.86.

    Note: this is a simplified implementation without augmentation lags.
    For production use with very noisy data, consider adding lag terms.
    """
    n = len(series)
    if n < 20:
        log.debug("ADF test: insufficient data (%d points, need 20)", n)
        return 0.0, False

    # Compute first differences
    dy = [series[i] - series[i - 1] for i in range(1, n)]
    y_lag = series[:-1]  # y_{t-1}

    # Regress dy on y_lag: dy_t = alpha + gamma * y_lag_t
    _alpha, gamma, residuals = _ols_regression(dy, y_lag)

    if not residuals:
        return 0.0, False

    # Standard error of gamma
    n_resid = len(residuals)
    sse = sum(r ** 2 for r in residuals)
    mse = sse / max(n_resid - 2, 1)

    y_lag_mean = _mean(y_lag)
    ss_ylag = sum((yl - y_lag_mean) ** 2 for yl in y_lag)

    if ss_ylag == 0 or mse <= 0:
        return 0.0, False

    se_gamma = math.sqrt(mse / ss_ylag)

    if se_gamma == 0:
        return 0.0, False

    adf_stat = gamma / se_gamma

    # Critical values at 5% significance (approximate, for n > 100)
    # MacKinnon critical values: 1% = -3.43, 5% = -2.86, 10% = -2.57
    critical_5pct = -2.86
    is_stationary = adf_stat < critical_5pct

    log.debug(
        "ADF test: stat=%.4f, critical_5%%=%.2f, stationary=%s",
        adf_stat, critical_5pct, is_stationary,
    )
    return adf_stat, is_stationary


def _compute_half_life(spread: list[float]) -> float:
    """Estimate mean-reversion half-life via Ornstein-Uhlenbeck process.

    The OU process: dS = theta * (mu - S) * dt + sigma * dW
    We estimate theta from: delta_S_t = alpha + beta * S_{t-1} + epsilon
    Half-life = -ln(2) / beta (where beta should be negative for mean-reversion).

    Returns half-life in periods. Falls back to 20 if estimation fails.
    """
    n = len(spread)
    if n < 20:
        return 20.0

    delta_s = [spread[i] - spread[i - 1] for i in range(1, n)]
    s_lag = spread[:-1]

    _alpha, beta, _residuals = _ols_regression(delta_s, s_lag)

    if beta >= 0:
        # No mean-reversion detected
        log.debug("Half-life: beta=%.6f >= 0, no mean-reversion", beta)
        return 20.0

    half_life = -math.log(2) / beta

    # Clamp to reasonable bounds
    half_life = max(5.0, min(half_life, 200.0))
    log.debug("Half-life: %.1f periods (beta=%.6f)", half_life, beta)
    return half_life


def _z_score(value: float, mean: float, std: float) -> float:
    """Compute z-score."""
    if std == 0:
        return 0.0
    return (value - mean) / std


# ============================================================
# StatArbStrategy
# ============================================================

class StatArbStrategy(BaseStrategy):
    """Statistical Arbitrage / Pairs Trading strategy.

    Uses cointegration (Engle-Granger) to identify mean-reverting spreads
    between correlated asset pairs, then trades the z-score of the spread.

    Signals:
        BUY  when z-score < -entry_z  (spread is too low, expect reversion up)
        SELL when z-score >  entry_z  (spread is too high, expect reversion down)
        HOLD when |z-score| < exit_z  (spread near equilibrium)
    """

    # Class-level cache shared across instances
    _pair_cache: dict[str, PairState] = {}

    def __init__(
        self,
        config: StrategyConfig | None = None,
        dna: StrategyDNA | None = None,
    ) -> None:
        if config is None:
            config = StrategyConfig(
                name="stat-arb",
                enabled=True,
                params={
                    "entry_z": 2.0,
                    "exit_z": 0.5,
                    "lookback": 100.0,
                    "min_half_life": 5.0,
                    "max_half_life": 150.0,
                    "recalc_interval_ms": 3_600_000.0,  # 1 hour
                },
                asset_classes=[AssetClass.CRYPTO, AssetClass.FOREX],
                timeframes=["1h"],
            )
        super().__init__(config, dna)

    def get_default_dna(self) -> StrategyDNA:
        return StrategyDNA(
            id="stat-arb-v1",
            name="stat-arb",
            generation=0,
            params={
                "entry_z": 2.0,
                "exit_z": 0.5,
                "lookback": 100.0,
                "min_half_life": 5.0,
                "max_half_life": 150.0,
            },
        )

    # ----------------------------------------------------------
    # Public interface
    # ----------------------------------------------------------

    def analyze(self, data: MarketData) -> list[Signal]:
        """Analyze a single asset by checking all known pairs it belongs to.

        For each registered pair where this asset is a member, look up cached
        pair state and generate signals based on the current z-score. This
        allows the orchestrator to call analyze() per-asset while the actual
        pair analysis is done via analyze_pair().
        """
        symbol = data.asset.symbol
        signals: list[Signal] = []

        for sym_a, sym_b in ALL_PAIRS:
            if symbol not in (sym_a, sym_b):
                continue

            cache_key = self._cache_key(sym_a, sym_b)
            state = self._pair_cache.get(cache_key)

            if state is None or not state.is_cointegrated:
                log.debug("No cointegrated state for pair %s/%s", sym_a, sym_b)
                continue

            signal = self._signal_from_state(state, data)
            if signal is not None:
                signals.append(signal)

        return signals

    def analyze_pair(self, data_a: MarketData, data_b: MarketData) -> list[Signal]:
        """Full pair analysis: compute hedge ratio, spread, cointegration, and signals.

        This is the primary entry point for pair-based analysis. Call this with
        both legs of the pair to update cached state and generate signals.
        """
        sym_a = data_a.asset.symbol
        sym_b = data_b.asset.symbol
        cache_key = self._cache_key(sym_a, sym_b)

        closes_a = [c.close for c in data_a.candles]
        closes_b = [c.close for c in data_b.candles]

        # Align lengths
        min_len = min(len(closes_a), len(closes_b))
        if min_len < 30:
            log.warning(
                "Insufficient data for pair %s/%s: %d candles (need 30)",
                sym_a, sym_b, min_len,
            )
            return []

        closes_a = closes_a[-min_len:]
        closes_b = closes_b[-min_len:]

        # Check if we can skip recalculation
        now_ms = int(time.time() * 1000)
        existing = self._pair_cache.get(cache_key)
        recalc_interval = self.dna.params.get("recalc_interval_ms", 3_600_000)
        if existing and (now_ms - existing.last_updated) < recalc_interval:
            # Just update z-score with latest data
            state = self._update_z_score(existing, closes_a, closes_b)
        else:
            state = self._full_recalc(sym_a, sym_b, closes_a, closes_b, now_ms)

        self._pair_cache[cache_key] = state

        if not state.is_cointegrated:
            log.info(
                "Pair %s/%s not cointegrated (ADF=%.4f)",
                sym_a, sym_b, state.adf_statistic,
            )
            return []

        signals: list[Signal] = []

        sig_a = self._signal_from_state(state, data_a)
        if sig_a is not None:
            signals.append(sig_a)

        sig_b = self._signal_from_state(state, data_b, is_leg_b=True)
        if sig_b is not None:
            signals.append(sig_b)

        return signals

    # ----------------------------------------------------------
    # Internal: full recalculation
    # ----------------------------------------------------------

    def _full_recalc(
        self,
        sym_a: str,
        sym_b: str,
        closes_a: list[float],
        closes_b: list[float],
        now_ms: int,
    ) -> PairState:
        """Run full cointegration analysis and build PairState."""
        # Step 1: OLS hedge ratio  (price_a = alpha + beta * price_b + epsilon)
        alpha, beta, residuals = _ols_regression(closes_a, closes_b)

        if not residuals:
            log.warning("OLS regression failed for %s/%s", sym_a, sym_b)
            return PairState(symbol_a=sym_a, symbol_b=sym_b, last_updated=now_ms)

        log.debug("Hedge ratio for %s/%s: alpha=%.6f, beta=%.6f", sym_a, sym_b, alpha, beta)

        # Step 2: ADF test on residuals (spread)
        adf_stat, is_cointegrated = _adf_test(residuals)

        # Step 3: Half-life of the spread
        half_life = _compute_half_life(residuals)
        min_hl = self.dna.params.get("min_half_life", 5.0)
        max_hl = self.dna.params.get("max_half_life", 150.0)

        # Reject pairs with unsuitable half-life
        if is_cointegrated and not (min_hl <= half_life <= max_hl):
            log.info(
                "Pair %s/%s half-life %.1f outside [%.0f, %.0f] — skipping",
                sym_a, sym_b, half_life, min_hl, max_hl,
            )
            is_cointegrated = False

        # Step 4: Dynamic lookback from half-life (use ~4x half-life)
        lookback = int(min(max(half_life * 4, 30), len(residuals)))
        recent_spread = residuals[-lookback:]

        spread_mean = _mean(recent_spread)
        spread_std = _std(recent_spread)
        current_spread = residuals[-1]
        z = _z_score(current_spread, spread_mean, spread_std)

        state = PairState(
            symbol_a=sym_a,
            symbol_b=sym_b,
            hedge_ratio=beta,
            spread_mean=spread_mean,
            spread_std=spread_std,
            z_score=z,
            half_life=half_life,
            adf_statistic=adf_stat,
            is_cointegrated=is_cointegrated,
            last_updated=now_ms,
            spread_series=residuals[-lookback:],
        )

        log.info(
            "Pair %s/%s: cointegrated=%s, hedge=%.4f, z=%.2f, half_life=%.1f, ADF=%.4f",
            sym_a, sym_b, is_cointegrated, beta, z, half_life, adf_stat,
        )
        return state

    def _update_z_score(
        self,
        state: PairState,
        closes_a: list[float],
        closes_b: list[float],
    ) -> PairState:
        """Lightweight update: recompute current z-score without full recalc."""
        current_spread = closes_a[-1] - state.hedge_ratio * closes_b[-1]
        state.z_score = _z_score(current_spread, state.spread_mean, state.spread_std)
        state.spread_series.append(current_spread)

        # Keep spread_series bounded
        max_len = int(max(state.half_life * 4, 100))
        if len(state.spread_series) > max_len:
            state.spread_series = state.spread_series[-max_len:]

        return state

    # ----------------------------------------------------------
    # Internal: signal generation
    # ----------------------------------------------------------

    def _signal_from_state(
        self,
        state: PairState,
        data: MarketData,
        is_leg_b: bool = False,
    ) -> Signal | None:
        """Generate a signal for one leg of the pair based on z-score."""
        entry_z = self.dna.params.get("entry_z", 2.0)
        exit_z = self.dna.params.get("exit_z", 0.5)
        z = state.z_score

        if not data.candles:
            return None

        price = data.candles[-1].close

        indicators = {
            "z_score": z,
            "hedge_ratio": state.hedge_ratio,
            "spread_mean": state.spread_mean,
            "spread_std": state.spread_std,
            "half_life": state.half_life,
            "adf_statistic": state.adf_statistic,
        }

        # Confidence: based on z-score magnitude and cointegration strength
        # Higher |z-score| and more negative ADF statistic = higher confidence
        z_confidence = min(abs(z) / 4.0, 1.0)  # max out at z=4
        adf_confidence = min(abs(state.adf_statistic) / 5.0, 1.0)  # max out at ADF=-5
        confidence = 0.6 * z_confidence + 0.4 * adf_confidence

        # For leg B, signals are inverted (it's the other side of the pair)
        if z < -entry_z:
            # Spread too low: buy A, sell B
            action = SignalAction.SELL if is_leg_b else SignalAction.BUY
            reason = (
                f"Stat-arb: z-score={z:.2f} < -{entry_z} on pair "
                f"{state.symbol_a}/{state.symbol_b} (half-life={state.half_life:.1f})"
            )
            return self._make_signal(
                data.asset, action, confidence, price,
                data.timeframe, indicators, reason,
            )

        if z > entry_z:
            # Spread too high: sell A, buy B
            action = SignalAction.BUY if is_leg_b else SignalAction.SELL
            reason = (
                f"Stat-arb: z-score={z:.2f} > {entry_z} on pair "
                f"{state.symbol_a}/{state.symbol_b} (half-life={state.half_life:.1f})"
            )
            return self._make_signal(
                data.asset, action, confidence, price,
                data.timeframe, indicators, reason,
            )

        if abs(z) < exit_z:
            # Near mean — hold / exit existing positions
            log.debug(
                "Pair %s/%s z-score=%.2f within exit zone (%.1f), HOLD",
                state.symbol_a, state.symbol_b, z, exit_z,
            )

        return None

    # ----------------------------------------------------------
    # Helpers
    # ----------------------------------------------------------

    @staticmethod
    def _cache_key(sym_a: str, sym_b: str) -> str:
        """Deterministic cache key regardless of symbol order."""
        return "|".join(sorted([sym_a, sym_b]))

    @classmethod
    def get_pair_state(cls, sym_a: str, sym_b: str) -> PairState | None:
        """Retrieve cached pair state (for external inspection / dashboards)."""
        key = cls._cache_key(sym_a, sym_b)
        return cls._pair_cache.get(key)

    @classmethod
    def clear_cache(cls) -> None:
        """Clear the class-level pair cache."""
        cls._pair_cache.clear()

    @classmethod
    def get_known_pairs(cls, asset_class: AssetClass | None = None) -> list[tuple[str, str]]:
        """Return the registered pair definitions, optionally filtered by asset class."""
        if asset_class is None:
            return list(ALL_PAIRS)
        if asset_class == AssetClass.CRYPTO:
            return list(CRYPTO_PAIRS)
        if asset_class == AssetClass.FOREX:
            return list(FOREX_PAIRS)
        return []
