"""Advanced risk metrics — VaR, CVaR, Sortino, drawdown circuit breakers."""

from __future__ import annotations

import logging
import math
import random
from dataclasses import dataclass, field

log = logging.getLogger(__name__)


# ============================================================
# Helpers
# ============================================================

def _mean(xs: list[float]) -> float:
    if not xs:
        return 0.0
    return sum(xs) / len(xs)


def _std(xs: list[float], ddof: int = 1) -> float:
    n = len(xs)
    if n <= ddof:
        return 0.0
    mu = _mean(xs)
    return math.sqrt(sum((x - mu) ** 2 for x in xs) / (n - ddof))


def _pearson(xs: list[float], ys: list[float]) -> float:
    n = min(len(xs), len(ys))
    if n < 2:
        return 0.0
    mx, my = _mean(xs[:n]), _mean(ys[:n])
    sx, sy = _std(xs[:n]), _std(ys[:n])
    if sx == 0.0 or sy == 0.0:
        return 0.0
    cov = sum((xs[i] - mx) * (ys[i] - my) for i in range(n)) / (n - 1)
    return max(-1.0, min(1.0, cov / (sx * sy)))


# ============================================================
# Value at Risk
# ============================================================

def calculate_var(
    returns: list[float],
    confidence: float = 0.95,
) -> float:
    """Historical Value at Risk.

    Returns the loss threshold at the given confidence level.
    A positive return means a loss (convention: VaR is reported as a
    positive number representing potential loss).

    Args:
        returns: List of period returns (e.g. daily).
        confidence: Confidence level (0.0 to 1.0), default 0.95.

    Returns:
        VaR as a positive float (loss magnitude at the confidence level).
    """
    if not returns:
        return 0.0

    sorted_returns = sorted(returns)
    # Index corresponding to the (1 - confidence) quantile
    index = int(math.floor((1.0 - confidence) * len(sorted_returns)))
    index = max(0, min(index, len(sorted_returns) - 1))
    var_value = -sorted_returns[index]
    log.debug("Historical VaR(%.1f%%): %.6f", confidence * 100, var_value)
    return max(var_value, 0.0)


# ============================================================
# Conditional VaR (Expected Shortfall)
# ============================================================

def calculate_cvar(
    returns: list[float],
    confidence: float = 0.95,
) -> float:
    """Conditional Value at Risk (Expected Shortfall).

    Average loss in the worst (1 - confidence) fraction of outcomes.

    Args:
        returns: List of period returns.
        confidence: Confidence level, default 0.95.

    Returns:
        CVaR as a positive float.
    """
    if not returns:
        return 0.0

    sorted_returns = sorted(returns)
    cutoff = int(math.floor((1.0 - confidence) * len(sorted_returns)))
    cutoff = max(1, cutoff)  # at least one observation

    tail = sorted_returns[:cutoff]
    cvar_value = -_mean(tail)
    log.debug("CVaR(%.1f%%): %.6f (from %d tail observations)", confidence * 100, cvar_value, len(tail))
    return max(cvar_value, 0.0)


# ============================================================
# Sortino Ratio
# ============================================================

def calculate_sortino_ratio(
    returns: list[float],
    risk_free_rate: float = 0.0,
) -> float:
    """Sortino ratio — excess return over downside deviation.

    Args:
        returns: List of period returns.
        risk_free_rate: Risk-free rate per period, default 0.0.

    Returns:
        Sortino ratio (float). Returns 0.0 if insufficient data.
    """
    if len(returns) < 2:
        return 0.0

    excess = [r - risk_free_rate for r in returns]
    mean_excess = _mean(excess)

    # Downside deviation: std of negative excess returns only
    downside = [r for r in excess if r < 0.0]
    if not downside:
        # No downside — infinite Sortino, cap at a large number
        return 100.0 if mean_excess > 0 else 0.0

    downside_std = math.sqrt(sum(d ** 2 for d in downside) / len(downside))

    if downside_std == 0.0:
        return 0.0

    ratio = mean_excess / downside_std
    log.debug("Sortino ratio: %.4f", ratio)
    return ratio


# ============================================================
# Information Ratio
# ============================================================

def calculate_information_ratio(
    returns: list[float],
    benchmark_returns: list[float],
) -> float:
    """Information ratio — active return per unit of tracking error.

    Args:
        returns: Portfolio period returns.
        benchmark_returns: Benchmark period returns (same length).

    Returns:
        Information ratio (float). Returns 0.0 if insufficient data.
    """
    n = min(len(returns), len(benchmark_returns))
    if n < 2:
        return 0.0

    active = [returns[i] - benchmark_returns[i] for i in range(n)]
    mean_active = _mean(active)
    tracking_error = _std(active)

    if tracking_error == 0.0:
        return 0.0

    ratio = mean_active / tracking_error
    log.debug("Information ratio: %.4f (tracking error: %.6f)", ratio, tracking_error)
    return ratio


# ============================================================
# Max Drawdown Duration
# ============================================================

def calculate_max_drawdown_duration(equity_curve: list[float]) -> int:
    """Longest drawdown duration in number of periods.

    A drawdown starts when equity drops below the running peak and
    ends when equity recovers to a new peak.

    Args:
        equity_curve: List of portfolio values over time.

    Returns:
        Duration of the longest drawdown in periods.
    """
    if len(equity_curve) < 2:
        return 0

    peak = equity_curve[0]
    current_duration = 0
    max_duration = 0

    for value in equity_curve[1:]:
        if value >= peak:
            peak = value
            if current_duration > max_duration:
                max_duration = current_duration
            current_duration = 0
        else:
            current_duration += 1

    # Handle case where drawdown extends to the end
    if current_duration > max_duration:
        max_duration = current_duration

    log.debug("Max drawdown duration: %d periods", max_duration)
    return max_duration


# ============================================================
# Monte Carlo VaR
# ============================================================

def monte_carlo_var(
    returns: list[float],
    n_simulations: int = 10000,
    horizon: int = 1,
    confidence: float = 0.95,
) -> float:
    """Monte Carlo Value at Risk.

    Simulates portfolio returns by random sampling with replacement
    from historical returns, then computes VaR on simulated outcomes.

    Args:
        returns: Historical period returns.
        n_simulations: Number of simulation paths, default 10000.
        horizon: Number of periods to simulate forward, default 1.
        confidence: Confidence level, default 0.95.

    Returns:
        VaR as a positive float.
    """
    if not returns:
        return 0.0

    n = len(returns)
    simulated_outcomes: list[float] = []

    for _ in range(n_simulations):
        cumulative = 1.0
        for _ in range(horizon):
            idx = random.randint(0, n - 1)
            cumulative *= (1.0 + returns[idx])
        simulated_outcomes.append(cumulative - 1.0)

    simulated_outcomes.sort()
    index = int(math.floor((1.0 - confidence) * len(simulated_outcomes)))
    index = max(0, min(index, len(simulated_outcomes) - 1))
    var_value = -simulated_outcomes[index]

    log.debug(
        "Monte Carlo VaR(%.1f%%, horizon=%d, sims=%d): %.6f",
        confidence * 100, horizon, n_simulations, var_value,
    )
    return max(var_value, 0.0)


# ============================================================
# Drawdown Circuit Breaker
# ============================================================

@dataclass
class DrawdownLimits:
    """Configurable drawdown limits for the circuit breaker."""

    daily_loss_pct: float = 3.0       # Max daily loss as % of portfolio
    weekly_loss_pct: float = 7.0      # Max weekly loss as % of portfolio
    total_loss_pct: float = 15.0      # Max total drawdown as % of peak


class DrawdownCircuitBreaker:
    """Halts trading when drawdown limits are breached.

    Monitors portfolio value against configured thresholds and
    returns halt signals with reasons.
    """

    def __init__(self, limits: DrawdownLimits | None = None) -> None:
        self.limits = limits or DrawdownLimits()
        self._daily_start_value: float | None = None
        self._weekly_start_value: float | None = None
        log.info(
            "DrawdownCircuitBreaker initialised (daily=%.1f%%, weekly=%.1f%%, total=%.1f%%)",
            self.limits.daily_loss_pct,
            self.limits.weekly_loss_pct,
            self.limits.total_loss_pct,
        )

    def reset_daily(self, portfolio_value: float) -> None:
        """Reset the daily reference value (call at start of trading day)."""
        self._daily_start_value = portfolio_value

    def reset_weekly(self, portfolio_value: float) -> None:
        """Reset the weekly reference value (call at start of trading week)."""
        self._weekly_start_value = portfolio_value

    def check(
        self,
        portfolio_value: float,
        peak_value: float,
    ) -> tuple[bool, str]:
        """Check whether trading should be halted.

        Args:
            portfolio_value: Current portfolio value.
            peak_value: All-time peak portfolio value.

        Returns:
            Tuple of (should_halt: bool, reason: str).
        """
        if peak_value <= 0:
            return False, "OK"

        # Total drawdown check
        total_dd_pct = ((peak_value - portfolio_value) / peak_value) * 100.0
        if total_dd_pct >= self.limits.total_loss_pct:
            reason = (
                f"HALT: Total drawdown {total_dd_pct:.2f}% exceeds "
                f"limit {self.limits.total_loss_pct:.1f}%"
            )
            log.warning(reason)
            return True, reason

        # Daily loss check
        if self._daily_start_value is not None and self._daily_start_value > 0:
            daily_loss_pct = (
                (self._daily_start_value - portfolio_value) / self._daily_start_value
            ) * 100.0
            if daily_loss_pct >= self.limits.daily_loss_pct:
                reason = (
                    f"HALT: Daily loss {daily_loss_pct:.2f}% exceeds "
                    f"limit {self.limits.daily_loss_pct:.1f}%"
                )
                log.warning(reason)
                return True, reason

        # Weekly loss check
        if self._weekly_start_value is not None and self._weekly_start_value > 0:
            weekly_loss_pct = (
                (self._weekly_start_value - portfolio_value) / self._weekly_start_value
            ) * 100.0
            if weekly_loss_pct >= self.limits.weekly_loss_pct:
                reason = (
                    f"HALT: Weekly loss {weekly_loss_pct:.2f}% exceeds "
                    f"limit {self.limits.weekly_loss_pct:.1f}%"
                )
                log.warning(reason)
                return True, reason

        return False, "OK"


# ============================================================
# Correlation-Adjusted Position Sizer
# ============================================================

class CorrelationAdjustedSizer:
    """Reduces position size when adding assets correlated with existing holdings.

    Computes the average absolute correlation between the new asset and
    all current portfolio assets, then scales the base size down accordingly.
    """

    def __init__(
        self,
        max_correlation: float = 0.85,
        min_size_factor: float = 0.2,
    ) -> None:
        """
        Args:
            max_correlation: Correlation threshold at which size is fully reduced.
            min_size_factor: Minimum scaling factor (floor) applied to base size.
        """
        self.max_correlation = max_correlation
        self.min_size_factor = min_size_factor
        log.info(
            "CorrelationAdjustedSizer initialised (max_corr=%.2f, min_factor=%.2f)",
            max_correlation, min_size_factor,
        )

    def adjust_size(
        self,
        base_size: float,
        new_asset_returns: list[float],
        portfolio_returns: dict[str, list[float]],
    ) -> float:
        """Adjust position size based on correlation with existing portfolio.

        Args:
            base_size: Original (unadjusted) position size.
            new_asset_returns: Return series for the asset being added.
            portfolio_returns: Dict of asset symbol to return series for
                all currently held assets.

        Returns:
            Adjusted position size (<= base_size).
        """
        if not portfolio_returns:
            log.debug("No existing positions — returning full base size %.4f", base_size)
            return base_size

        # Compute average absolute correlation with each existing holding
        correlations: list[float] = []
        for symbol, held_returns in portfolio_returns.items():
            corr = _pearson(new_asset_returns, held_returns)
            correlations.append(abs(corr))
            log.debug("Correlation with %s: %.4f", symbol, corr)

        avg_corr = _mean(correlations)

        # Scale factor: 1.0 when avg_corr=0, min_size_factor when avg_corr>=max_correlation
        if avg_corr >= self.max_correlation:
            scale = self.min_size_factor
        elif self.max_correlation > 0:
            # Linear interpolation
            scale = 1.0 - (1.0 - self.min_size_factor) * (avg_corr / self.max_correlation)
        else:
            scale = 1.0

        scale = max(self.min_size_factor, min(1.0, scale))
        adjusted = base_size * scale

        log.info(
            "CorrelationAdjustedSizer: avg_corr=%.4f, scale=%.4f, base=%.4f -> adjusted=%.4f",
            avg_corr, scale, base_size, adjusted,
        )
        return adjusted


__all__ = [
    "calculate_var",
    "calculate_cvar",
    "calculate_sortino_ratio",
    "calculate_information_ratio",
    "calculate_max_drawdown_duration",
    "monte_carlo_var",
    "DrawdownLimits",
    "DrawdownCircuitBreaker",
    "CorrelationAdjustedSizer",
]
