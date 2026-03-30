"""Z-Score Parameter Optimizer — backtests every forex pair to find optimal params.

Uses scipy + statsmodels for statistical confidence:
  - ADF test (stationarity) to validate z-score mean reversion
  - Ornstein-Uhlenbeck half-life for optimal holding period
  - Shapiro-Wilk normality test for z-score distribution validation
  - Bootstrap confidence intervals for performance metrics
  - Ljung-Box autocorrelation test to detect serial dependence
  - Hurst exponent for regime classification

Auto-selects sample period per pair based on:
  - Minimum 100 candles required
  - ADF p-value < 0.05 (stationary window)
  - Expanding window until stationarity breaks

Output: optimal {z_fast, z_slow, entry_threshold, exit_threshold} per pair.
"""

from __future__ import annotations

import json
import logging
import math
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

import numpy as np
from scipy import stats as scipy_stats
from statsmodels.tsa.stattools import adfuller, acf
from statsmodels.stats.diagnostic import acorr_ljungbox

from shared.types import (
    AssetInfo, Candle, MarketData, Signal, SignalAction, AssetClass,
)

log = logging.getLogger(__name__)


# ============================================================
# Result types
# ============================================================

@dataclass
class StatTestResults:
    """Statistical test results for a z-score series."""
    adf_statistic: float = 0.0
    adf_pvalue: float = 1.0
    adf_is_stationary: bool = False
    shapiro_statistic: float = 0.0
    shapiro_pvalue: float = 1.0
    shapiro_is_normal: bool = False
    ljungbox_statistic: float = 0.0
    ljungbox_pvalue: float = 1.0
    ljungbox_has_autocorr: bool = False
    hurst_exponent: float = 0.5
    ou_half_life: float = 0.0
    mean_reversion_score: float = 0.0  # 0-1 composite


@dataclass
class ZScoreParams:
    """Optimized z-score parameters for one pair."""
    symbol: str
    z_fast_window: int = 20
    z_slow_window: int = 100
    entry_threshold: float = 2.0
    exit_threshold: float = 0.5
    optimal_sample_period: int = 200  # candles
    stat_tests: StatTestResults = field(default_factory=StatTestResults)
    backtest_sharpe: float = 0.0
    backtest_return_pct: float = 0.0
    backtest_win_rate: float = 0.0
    backtest_trades: int = 0
    backtest_profit_factor: float = 0.0
    confidence_score: float = 0.0  # 0-1 overall confidence
    regime: str = "unknown"  # "mean_reverting", "trending", "random_walk"
    optimized_at: int = 0


@dataclass
class OptimizationReport:
    """Full optimization report across all pairs."""
    pairs: list[ZScoreParams] = field(default_factory=list)
    total_pairs: int = 0
    mean_reverting_count: int = 0
    trending_count: int = 0
    random_walk_count: int = 0
    avg_confidence: float = 0.0
    best_pair: str = ""
    worst_pair: str = ""
    optimized_at: int = 0


# ============================================================
# Statistical helpers
# ============================================================

def _adf_test(series: np.ndarray) -> tuple[float, float, bool]:
    """Augmented Dickey-Fuller test for stationarity."""
    if len(series) < 20:
        return 0.0, 1.0, False
    try:
        result = adfuller(series, maxlag=min(20, len(series) // 4), autolag="AIC")
        return float(result[0]), float(result[1]), result[1] < 0.05
    except Exception:
        return 0.0, 1.0, False


def _shapiro_test(series: np.ndarray) -> tuple[float, float, bool]:
    """Shapiro-Wilk normality test (subsample if > 5000)."""
    if len(series) < 8:
        return 0.0, 1.0, False
    try:
        sample = series[-5000:] if len(series) > 5000 else series
        stat, p = scipy_stats.shapiro(sample)
        return float(stat), float(p), p > 0.05
    except Exception:
        return 0.0, 1.0, False


def _ljungbox_test(series: np.ndarray, lags: int = 10) -> tuple[float, float, bool]:
    """Ljung-Box test for autocorrelation (serial dependence)."""
    if len(series) < lags + 5:
        return 0.0, 1.0, False
    try:
        result = acorr_ljungbox(series, lags=[lags], return_df=True)
        stat = float(result["lb_stat"].iloc[0])
        p = float(result["lb_pvalue"].iloc[0])
        return stat, p, p < 0.05
    except Exception:
        return 0.0, 1.0, False


def _ou_half_life(series: np.ndarray) -> float:
    """Ornstein-Uhlenbeck half-life estimation via OLS regression.

    Fits: dS = theta * (mu - S) * dt
    Half-life = -ln(2) / ln(1 + theta)
    """
    if len(series) < 10:
        return 0.0
    try:
        y = np.diff(series)
        x = series[:-1] - np.mean(series)
        if np.std(x) == 0:
            return 0.0
        # OLS: y = beta * x + epsilon
        beta = np.sum(x * y) / np.sum(x ** 2)
        if beta >= 0:
            return 0.0  # Not mean-reverting
        half_life = -np.log(2) / np.log(1 + beta)
        return max(0.0, min(500.0, float(half_life)))
    except Exception:
        return 0.0


def _hurst_rs(series: np.ndarray, max_lag: int = 20) -> float:
    """Hurst exponent via rescaled range (R/S) analysis."""
    if len(series) < max_lag * 2:
        return 0.5
    try:
        lags = range(2, max_lag + 1)
        rs_log = []
        for lag in lags:
            chunks = [series[i:i + lag] for i in range(0, len(series) - lag, lag)]
            rs_list = []
            for chunk in chunks:
                if len(chunk) < 2:
                    continue
                mean = np.mean(chunk)
                devs = chunk - mean
                cumulative = np.cumsum(devs)
                r = np.max(cumulative) - np.min(cumulative)
                s = np.std(chunk, ddof=0)
                if s > 0:
                    rs_list.append(r / s)
            if rs_list:
                rs_log.append((np.log(lag), np.log(np.mean(rs_list))))
        if len(rs_log) < 3:
            return 0.5
        x = np.array([p[0] for p in rs_log])
        y = np.array([p[1] for p in rs_log])
        slope, _, _, _, _ = scipy_stats.linregress(x, y)
        return float(np.clip(slope, 0.0, 1.0))
    except Exception:
        return 0.5


def _bootstrap_sharpe(returns: np.ndarray, n_boot: int = 1000, ci: float = 0.95) -> tuple[float, float, float]:
    """Bootstrap confidence interval for Sharpe ratio.

    Returns (mean_sharpe, lower_bound, upper_bound).
    """
    if len(returns) < 10:
        return 0.0, 0.0, 0.0
    try:
        rng = np.random.default_rng(42)
        sharpes = []
        for _ in range(n_boot):
            sample = rng.choice(returns, size=len(returns), replace=True)
            mean_r = np.mean(sample)
            std_r = np.std(sample, ddof=1)
            if std_r > 0:
                sharpes.append(mean_r / std_r * np.sqrt(252))
        sharpes = np.array(sharpes)
        alpha = (1 - ci) / 2
        return float(np.mean(sharpes)), float(np.percentile(sharpes, alpha * 100)), float(np.percentile(sharpes, (1 - alpha) * 100))
    except Exception:
        return 0.0, 0.0, 0.0


# ============================================================
# Z-Score Backtester
# ============================================================

def _compute_z_scores(closes: np.ndarray, window: int) -> np.ndarray:
    """Rolling z-score computation."""
    z = np.full(len(closes), 0.0)
    for i in range(window, len(closes)):
        w = closes[i - window:i]
        mean = np.mean(w)
        std = np.std(w, ddof=0)
        if std > 0:
            z[i] = (closes[i] - mean) / std
    return z


def _backtest_zscore(
    closes: np.ndarray,
    z_fast_window: int,
    z_slow_window: int,
    entry_threshold: float,
    exit_threshold: float,
    commission: float = 0.0003,  # 3 pips for forex
    slippage: float = 0.0002,
) -> dict:
    """Backtest z-score mean reversion strategy on close prices.

    Entry: |z_avg| > entry_threshold (fade the move)
    Exit: |z_avg| < exit_threshold (mean reversion complete)
    """
    n = len(closes)
    start_idx = max(z_fast_window, z_slow_window, 30)
    if n < start_idx + 20:
        return {"sharpe": 0, "return_pct": 0, "win_rate": 0, "trades": 0, "profit_factor": 0, "returns": np.array([])}

    z_fast = _compute_z_scores(closes, z_fast_window)
    z_slow = _compute_z_scores(closes, z_slow_window)
    z_avg = (z_fast + z_slow) / 2

    position = 0  # 1=long, -1=short, 0=flat
    entry_price = 0.0
    trades_pnl = []
    equity = [1.0]

    for i in range(start_idx, n):
        price = closes[i]
        z = z_avg[i]

        # Entry
        if position == 0:
            if z < -entry_threshold:
                # Oversold → buy
                position = 1
                entry_price = price * (1 + slippage)
            elif z > entry_threshold:
                # Overbought → sell
                position = -1
                entry_price = price * (1 - slippage)

        # Exit
        elif position == 1:
            if z > -exit_threshold:
                exit_price = price * (1 - slippage)
                pnl = (exit_price - entry_price) / entry_price - commission * 2
                trades_pnl.append(pnl)
                equity.append(equity[-1] * (1 + pnl))
                position = 0
        elif position == -1:
            if z < exit_threshold:
                exit_price = price * (1 + slippage)
                pnl = (entry_price - exit_price) / entry_price - commission * 2
                trades_pnl.append(pnl)
                equity.append(equity[-1] * (1 + pnl))
                position = 0

    # Close open position
    if position != 0:
        price = closes[-1]
        if position == 1:
            pnl = (price - entry_price) / entry_price - commission * 2
        else:
            pnl = (entry_price - price) / entry_price - commission * 2
        trades_pnl.append(pnl)
        equity.append(equity[-1] * (1 + pnl))

    trades_pnl = np.array(trades_pnl)
    equity = np.array(equity)

    if len(trades_pnl) == 0:
        return {"sharpe": 0, "return_pct": 0, "win_rate": 0, "trades": 0, "profit_factor": 0, "returns": np.array([])}

    # Metrics
    total_return = (equity[-1] / equity[0] - 1) * 100
    wins = trades_pnl[trades_pnl > 0]
    losses = trades_pnl[trades_pnl < 0]
    win_rate = len(wins) / len(trades_pnl) if len(trades_pnl) > 0 else 0
    profit_factor = (np.sum(wins) / abs(np.sum(losses))) if len(losses) > 0 and np.sum(losses) != 0 else 0.0

    # Sharpe from trade returns
    if len(trades_pnl) > 1:
        sharpe = float(np.mean(trades_pnl) / np.std(trades_pnl, ddof=1) * np.sqrt(252 / max(1, len(trades_pnl))))
    else:
        sharpe = 0.0

    return {
        "sharpe": sharpe,
        "return_pct": total_return,
        "win_rate": win_rate,
        "trades": len(trades_pnl),
        "profit_factor": float(profit_factor),
        "returns": trades_pnl,
    }


# ============================================================
# Auto Sample Period Selection
# ============================================================

def _auto_select_sample(closes: np.ndarray, min_window: int = 100, max_window: int = 500) -> int:
    """Auto-select optimal sample period based on stationarity.

    Strategy:
    1. Start from the largest window that has enough data
    2. Run ADF test — find the largest stationary window
    3. If nothing is stationary, use min_window as fallback
    """
    n = len(closes)
    upper = min(max_window, n)

    # Test from largest to smallest — find largest stationary window
    for window in range(upper, min_window - 1, -25):
        if window > n:
            continue
        sample = closes[-window:]
        _, p, stationary = _adf_test(sample)
        if stationary:
            log.debug("Auto-sample: window=%d is stationary (ADF p=%.4f)", window, p)
            return window

    # Fallback: use the window with lowest ADF p-value
    best_window = min(min_window, n)
    best_p = 1.0
    for window in [100, 150, 200, 250, 300]:
        if window > n:
            continue
        _, p, _ = _adf_test(closes[-window:])
        if p < best_p:
            best_p = p
            best_window = window

    log.debug("Auto-sample: fallback window=%d (ADF p=%.4f)", best_window, best_p)
    return best_window


# ============================================================
# Main Optimizer
# ============================================================

class ZScoreOptimizer:
    """Optimizes z-score parameters for each forex pair using grid search + stat tests."""

    # Parameter grid
    FAST_WINDOWS = [10, 15, 20, 25, 30, 40, 50]
    SLOW_WINDOWS = [50, 75, 100, 125, 150, 200]
    ENTRY_THRESHOLDS = [1.5, 1.75, 2.0, 2.25, 2.5, 2.75, 3.0]
    EXIT_THRESHOLDS = [0.0, 0.25, 0.5, 0.75, 1.0]

    def __init__(self, data_dir: str | Path | None = None) -> None:
        self._data_dir = Path(data_dir) if data_dir else Path(__file__).resolve().parent.parent.parent / "data"
        self._results_dir = self._data_dir / "zscore_optimization"
        self._results_dir.mkdir(parents=True, exist_ok=True)

    def optimize_pair(self, asset: AssetInfo, candles: list[Candle]) -> ZScoreParams:
        """Find optimal z-score params for a single pair.

        Steps:
        1. Auto-select sample period (largest stationary window)
        2. Run statistical tests on price series
        3. Grid search over (fast, slow, entry, exit) combos
        4. Score using Sharpe + stat confidence
        5. Bootstrap confidence interval
        """
        symbol = asset.symbol
        closes_full = np.array([c.close for c in candles])

        if len(closes_full) < 50:
            log.warning("%s: insufficient data (%d candles)", symbol, len(closes_full))
            return ZScoreParams(symbol=symbol, regime="insufficient_data", optimized_at=int(time.time()))

        # Step 1: Auto-select sample period
        sample_period = _auto_select_sample(closes_full)
        closes = closes_full[-sample_period:]
        log.info("%s: auto-selected sample=%d candles (of %d available)", symbol, sample_period, len(closes_full))

        # Step 2: Statistical tests on raw price series
        returns = np.diff(np.log(closes))  # Log returns
        adf_stat, adf_p, adf_ok = _adf_test(returns)
        shap_stat, shap_p, shap_ok = _shapiro_test(returns)
        lb_stat, lb_p, lb_ok = _ljungbox_test(returns)
        hurst = _hurst_rs(closes)
        half_life = _ou_half_life(closes)

        # Classify regime
        if hurst < 0.45 and adf_ok:
            regime = "mean_reverting"
        elif hurst > 0.55:
            regime = "trending"
        else:
            regime = "random_walk"

        # Composite mean-reversion score (0-1)
        mr_score = 0.0
        mr_score += 0.30 * (1.0 if adf_ok else max(0, 1 - adf_p))  # ADF stationarity
        mr_score += 0.25 * max(0, (0.5 - hurst) * 4)                # Hurst < 0.5
        mr_score += 0.25 * min(1.0, half_life / 50) if half_life > 0 else 0  # Reasonable half-life
        mr_score += 0.10 * (1.0 if lb_ok else 0.0)                  # Autocorrelation present
        mr_score += 0.10 * (1.0 if shap_ok else 0.5)                # Normality bonus
        mr_score = float(np.clip(mr_score, 0, 1))

        stat_tests = StatTestResults(
            adf_statistic=adf_stat, adf_pvalue=adf_p, adf_is_stationary=adf_ok,
            shapiro_statistic=shap_stat, shapiro_pvalue=shap_p, shapiro_is_normal=shap_ok,
            ljungbox_statistic=lb_stat, ljungbox_pvalue=lb_p, ljungbox_has_autocorr=lb_ok,
            hurst_exponent=hurst, ou_half_life=half_life, mean_reversion_score=mr_score,
        )

        log.info(
            "%s: regime=%s | ADF p=%.4f %s | Hurst=%.3f | HL=%.1f | MR score=%.2f",
            symbol, regime, adf_p, "✓" if adf_ok else "✗", hurst, half_life, mr_score,
        )

        # Step 3: Grid search
        best_score = -999.0
        best_params = ZScoreParams(symbol=symbol, stat_tests=stat_tests, regime=regime,
                                   optimal_sample_period=sample_period, optimized_at=int(time.time()))
        combos_tested = 0

        for fast in self.FAST_WINDOWS:
            for slow in self.SLOW_WINDOWS:
                if fast >= slow:
                    continue  # Fast must be shorter than slow
                if slow > sample_period * 0.6:
                    continue  # Slow window can't be too large relative to data

                for entry in self.ENTRY_THRESHOLDS:
                    for exit_t in self.EXIT_THRESHOLDS:
                        if exit_t >= entry:
                            continue  # Exit must be tighter than entry

                        bt = _backtest_zscore(closes, fast, slow, entry, exit_t)
                        combos_tested += 1

                        if bt["trades"] < 5:
                            continue  # Need enough trades for significance

                        # Scoring: weighted combination
                        # Sharpe (40%) + win_rate (20%) + profit_factor (20%) + stat confidence (20%)
                        score = (
                            bt["sharpe"] * 0.40
                            + bt["win_rate"] * 0.20
                            + min(3.0, bt["profit_factor"]) / 3.0 * 0.20
                            + mr_score * 0.20
                        )

                        # Penalize too few trades (need statistical significance)
                        if bt["trades"] < 10:
                            score *= 0.7
                        # Penalize negative returns
                        if bt["return_pct"] < 0:
                            score *= 0.5

                        if score > best_score:
                            best_score = score
                            best_params = ZScoreParams(
                                symbol=symbol,
                                z_fast_window=fast,
                                z_slow_window=slow,
                                entry_threshold=entry,
                                exit_threshold=exit_t,
                                optimal_sample_period=sample_period,
                                stat_tests=stat_tests,
                                backtest_sharpe=bt["sharpe"],
                                backtest_return_pct=bt["return_pct"],
                                backtest_win_rate=bt["win_rate"],
                                backtest_trades=bt["trades"],
                                backtest_profit_factor=bt["profit_factor"],
                                regime=regime,
                                optimized_at=int(time.time()),
                            )

        # Step 4: Bootstrap confidence on best params
        if best_params.backtest_trades >= 5:
            bt_best = _backtest_zscore(
                closes, best_params.z_fast_window, best_params.z_slow_window,
                best_params.entry_threshold, best_params.exit_threshold,
            )
            boot_mean, boot_lo, boot_hi = _bootstrap_sharpe(bt_best["returns"])

            # Confidence: is the bootstrap lower bound > 0?
            # Higher confidence if lower bound is well above 0
            if boot_lo > 0:
                conf = min(1.0, 0.6 + boot_lo * 0.2 + mr_score * 0.2)
            elif boot_mean > 0:
                conf = min(0.6, 0.3 + mr_score * 0.3)
            else:
                conf = min(0.3, mr_score * 0.3)

            best_params.confidence_score = float(np.clip(conf, 0, 1))

            log.info(
                "%s: BEST → fast=%d slow=%d entry=%.2f exit=%.2f | "
                "Sharpe=%.2f [%.2f, %.2f] | Return=%.1f%% | WR=%.0f%% | Trades=%d | PF=%.2f | Conf=%.2f",
                symbol, best_params.z_fast_window, best_params.z_slow_window,
                best_params.entry_threshold, best_params.exit_threshold,
                best_params.backtest_sharpe, boot_lo, boot_hi,
                best_params.backtest_return_pct, best_params.backtest_win_rate * 100,
                best_params.backtest_trades, best_params.backtest_profit_factor,
                best_params.confidence_score,
            )
        else:
            best_params.confidence_score = mr_score * 0.3
            log.info("%s: no profitable combo found (%d tested)", symbol, combos_tested)

        log.info("%s: grid search complete (%d combos tested)", symbol, combos_tested)
        return best_params

    def optimize_all(self, assets: list[AssetInfo], candles_map: dict[str, list[Candle]]) -> OptimizationReport:
        """Optimize z-score params for all forex pairs."""
        report = OptimizationReport(optimized_at=int(time.time()))
        report.total_pairs = len(assets)

        for asset in assets:
            candles = candles_map.get(asset.symbol, [])
            if not candles:
                log.warning("No data for %s — skipping", asset.symbol)
                continue

            params = self.optimize_pair(asset, candles)
            report.pairs.append(params)

            if params.regime == "mean_reverting":
                report.mean_reverting_count += 1
            elif params.regime == "trending":
                report.trending_count += 1
            else:
                report.random_walk_count += 1

        if report.pairs:
            report.avg_confidence = sum(p.confidence_score for p in report.pairs) / len(report.pairs)
            best = max(report.pairs, key=lambda p: p.confidence_score)
            worst = min(report.pairs, key=lambda p: p.confidence_score)
            report.best_pair = best.symbol
            report.worst_pair = worst.symbol

        # Save results
        self._save_report(report)
        return report

    def _save_report(self, report: OptimizationReport) -> Path:
        """Save optimization results to JSON."""
        path = self._results_dir / "zscore_params.json"
        data = {
            "optimized_at": report.optimized_at,
            "total_pairs": report.total_pairs,
            "mean_reverting": report.mean_reverting_count,
            "trending": report.trending_count,
            "random_walk": report.random_walk_count,
            "avg_confidence": report.avg_confidence,
            "best_pair": report.best_pair,
            "worst_pair": report.worst_pair,
            "pairs": {},
        }
        for p in report.pairs:
            data["pairs"][p.symbol] = {
                "z_fast_window": p.z_fast_window,
                "z_slow_window": p.z_slow_window,
                "entry_threshold": p.entry_threshold,
                "exit_threshold": p.exit_threshold,
                "optimal_sample_period": p.optimal_sample_period,
                "backtest_sharpe": round(p.backtest_sharpe, 4),
                "backtest_return_pct": round(p.backtest_return_pct, 2),
                "backtest_win_rate": round(p.backtest_win_rate, 4),
                "backtest_trades": p.backtest_trades,
                "backtest_profit_factor": round(p.backtest_profit_factor, 4),
                "confidence_score": round(p.confidence_score, 4),
                "regime": p.regime,
                "stat_tests": {
                    "adf_pvalue": round(float(p.stat_tests.adf_pvalue), 6),
                    "adf_stationary": bool(p.stat_tests.adf_is_stationary),
                    "shapiro_pvalue": round(float(p.stat_tests.shapiro_pvalue), 6),
                    "shapiro_normal": bool(p.stat_tests.shapiro_is_normal),
                    "ljungbox_pvalue": round(float(p.stat_tests.ljungbox_pvalue), 6),
                    "ljungbox_autocorr": bool(p.stat_tests.ljungbox_has_autocorr),
                    "hurst": round(float(p.stat_tests.hurst_exponent), 4),
                    "ou_half_life": round(float(p.stat_tests.ou_half_life), 2),
                    "mean_reversion_score": round(float(p.stat_tests.mean_reversion_score), 4),
                },
            }
        path.write_text(json.dumps(data, indent=2, default=lambda o: bool(o) if isinstance(o, (np.bool_,)) else float(o) if isinstance(o, (np.floating,)) else int(o) if isinstance(o, (np.integer,)) else o))
        log.info("Saved optimization results to %s", path)
        return path

    def load_params(self) -> dict[str, ZScoreParams]:
        """Load previously optimized params from disk."""
        path = self._results_dir / "zscore_params.json"
        if not path.exists():
            return {}
        try:
            data = json.loads(path.read_text())
            result = {}
            for sym, p in data.get("pairs", {}).items():
                st = p.get("stat_tests", {})
                result[sym] = ZScoreParams(
                    symbol=sym,
                    z_fast_window=p["z_fast_window"],
                    z_slow_window=p["z_slow_window"],
                    entry_threshold=p["entry_threshold"],
                    exit_threshold=p["exit_threshold"],
                    optimal_sample_period=p.get("optimal_sample_period", 200),
                    backtest_sharpe=p.get("backtest_sharpe", 0),
                    backtest_return_pct=p.get("backtest_return_pct", 0),
                    backtest_win_rate=p.get("backtest_win_rate", 0),
                    backtest_trades=p.get("backtest_trades", 0),
                    backtest_profit_factor=p.get("backtest_profit_factor", 0),
                    confidence_score=p.get("confidence_score", 0),
                    regime=p.get("regime", "unknown"),
                    stat_tests=StatTestResults(
                        adf_pvalue=st.get("adf_pvalue", 1),
                        adf_is_stationary=st.get("adf_stationary", False),
                        shapiro_pvalue=st.get("shapiro_pvalue", 1),
                        shapiro_is_normal=st.get("shapiro_normal", False),
                        ljungbox_pvalue=st.get("ljungbox_pvalue", 1),
                        ljungbox_has_autocorr=st.get("ljungbox_autocorr", False),
                        hurst_exponent=st.get("hurst", 0.5),
                        ou_half_life=st.get("ou_half_life", 0),
                        mean_reversion_score=st.get("mean_reversion_score", 0),
                    ),
                )
            return result
        except Exception as e:
            log.warning("Failed to load zscore params: %s", e)
            return {}

    @staticmethod
    def format_report(report: OptimizationReport) -> str:
        """Format a human-readable optimization report."""
        lines = [
            "\n" + "=" * 100,
            "  Z-SCORE OPTIMIZATION REPORT",
            "=" * 100,
            f"\n  Pairs tested: {report.total_pairs}",
            f"  Mean-reverting: {report.mean_reverting_count} | Trending: {report.trending_count} | Random walk: {report.random_walk_count}",
            f"  Average confidence: {report.avg_confidence:.2f}",
            f"  Best pair: {report.best_pair} | Worst pair: {report.worst_pair}",
            "",
            f"  {'Pair':<12} {'Regime':<16} {'Fast':>5} {'Slow':>5} {'Entry':>6} {'Exit':>5} "
            f"{'Sharpe':>7} {'Return%':>8} {'WR%':>5} {'Trades':>6} {'PF':>6} {'Conf':>5} "
            f"{'ADF-p':>7} {'Hurst':>6} {'HL':>5}",
            "  " + "-" * 118,
        ]

        # Sort by confidence
        sorted_pairs = sorted(report.pairs, key=lambda p: p.confidence_score, reverse=True)
        for p in sorted_pairs:
            flag = " ***" if p.confidence_score >= 0.6 else " **" if p.confidence_score >= 0.4 else ""
            lines.append(
                f"  {p.symbol:<12} {p.regime:<16} {p.z_fast_window:>5} {p.z_slow_window:>5} "
                f"{p.entry_threshold:>6.2f} {p.exit_threshold:>5.2f} "
                f"{p.backtest_sharpe:>+7.2f} {p.backtest_return_pct:>+8.1f} "
                f"{p.backtest_win_rate * 100:>5.0f} {p.backtest_trades:>6} "
                f"{p.backtest_profit_factor:>6.2f} {p.confidence_score:>5.2f} "
                f"{p.stat_tests.adf_pvalue:>7.4f} {p.stat_tests.hurst_exponent:>6.3f} "
                f"{p.stat_tests.ou_half_life:>5.1f}{flag}"
            )

        lines.append("\n  Legend: *** = high confidence (>0.6), ** = moderate (>0.4)")
        lines.append("  ADF-p < 0.05 = stationary | Hurst < 0.5 = mean-reverting | HL = half-life (candles)")
        lines.append("=" * 100)
        return "\n".join(lines)
