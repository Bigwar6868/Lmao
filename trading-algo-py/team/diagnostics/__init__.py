"""Diagnostics Engine — monitors market, portfolio, strategy, and macro health.

Ported from trading-algo/src/team/diagnostics/index.ts
"""

from __future__ import annotations

import logging
import math
import time
from dataclasses import dataclass, field
from typing import Literal

from shared.types import Candle, MacroEnvironment, Portfolio, PerformanceMetrics

log = logging.getLogger(__name__)

# ============================================================
# Types
# ============================================================

Severity = Literal["info", "warning", "critical", "emergency"]

DiagnosticCategory = Literal[
    "market_anomaly",
    "risk_exposure",
    "strategy_decay",
    "macro_divergence",
    "correlation_break",
    "liquidity_warning",
    "regime_transition",
    "structural_risk",
]


@dataclass
class Diagnostic:
    id: str
    category: DiagnosticCategory
    severity: Severity
    title: str
    description: str
    evidence: list[str]
    recommendation: str
    timestamp: int = 0


@dataclass
class DiagnosticReport:
    timestamp: int
    total_diagnostics: int
    emergencies: list[Diagnostic]
    criticals: list[Diagnostic]
    warnings: list[Diagnostic]
    infos: list[Diagnostic]
    health_score: int  # 0-100
    summary: str


# ============================================================
# Helpers
# ============================================================

def _mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _round_to(value: float, decimals: int) -> float:
    factor = 10 ** decimals
    return round(value * factor) / factor


def _pearson_correlation(x: list[float], y: list[float]) -> float:
    n = min(len(x), len(y))
    if n < 2:
        return 0.0
    mx = _mean(x[:n])
    my = _mean(y[:n])
    num = dx = dy = 0.0
    for i in range(n):
        a = x[i] - mx
        b = y[i] - my
        num += a * b
        dx += a * a
        dy += b * b
    denom = math.sqrt(dx * dy)
    return num / denom if denom != 0 else 0.0


# ============================================================
# Diagnostics Engine
# ============================================================

class DiagnosticsEngine:
    """Problem diagnostics engine for market, portfolio, strategy, and macro health."""

    def __init__(self) -> None:
        self._counter = 0

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def scan(
        self,
        candles: dict[str, list[Candle]],
        portfolio: Portfolio | None = None,
        metrics: dict[str, PerformanceMetrics] | None = None,
        regime: object | None = None,  # RegimeAnalysis
        macro: MacroEnvironment | None = None,
    ) -> DiagnosticReport:
        """Run full diagnostic scan."""
        diagnostics: list[Diagnostic] = []

        # 1. Market anomaly detection
        for symbol, data in candles.items():
            diagnostics.extend(self._detect_market_anomalies(symbol, data))

        # 2. Portfolio risk
        if portfolio:
            diagnostics.extend(self._analyze_portfolio_risk(portfolio))

        # 3. Strategy decay
        if metrics:
            diagnostics.extend(self._detect_strategy_decay(metrics))

        # 4. Macro divergence
        if macro:
            diagnostics.extend(self._detect_macro_divergence(macro))

        # 5. Cross-asset correlation
        if len(candles) > 1:
            diagnostics.extend(self._analyze_correlations(candles))

        # 6. Regime transition
        if regime:
            diagnostics.extend(self._check_regime_transition(regime))

        # 7. Structural risks
        if macro and regime:
            diagnostics.extend(self._assess_structural_risks(macro, regime))

        emergencies = [d for d in diagnostics if d.severity == "emergency"]
        criticals = [d for d in diagnostics if d.severity == "critical"]
        warnings = [d for d in diagnostics if d.severity == "warning"]
        infos = [d for d in diagnostics if d.severity == "info"]

        health_score = self._calculate_health_score(diagnostics)

        report = DiagnosticReport(
            timestamp=int(time.time() * 1000),
            total_diagnostics=len(diagnostics),
            emergencies=emergencies,
            criticals=criticals,
            warnings=warnings,
            infos=infos,
            health_score=health_score,
            summary=self._generate_summary(health_score, emergencies, criticals, warnings),
        )

        log.info(
            "Diagnostic scan complete: health=%d emergencies=%d criticals=%d warnings=%d",
            health_score, len(emergencies), len(criticals), len(warnings),
        )
        return report

    # ------------------------------------------------------------------
    # Market Anomaly Detection
    # ------------------------------------------------------------------

    def _detect_market_anomalies(self, symbol: str, candles: list[Candle]) -> list[Diagnostic]:
        results: list[Diagnostic] = []
        if len(candles) < 20:
            return results

        latest = candles[-1]
        prev = candles[-2]
        closes = [c.close for c in candles]
        volumes = [c.volume for c in candles]

        # Flash crash: > 5% move in single candle
        price_change = ((latest.close - prev.close) / prev.close) * 100
        if abs(price_change) > 5:
            results.append(self._create(
                "market_anomaly",
                "critical" if price_change < 0 else "warning",
                f"Flash {'crash' if price_change < 0 else 'spike'} on {symbol}",
                f"{symbol} moved {_round_to(price_change, 2)}% in a single period.",
                [f"Price change: {_round_to(price_change, 2)}%", f"Close: {latest.close}", f"Previous: {prev.close}"],
                "Consider reducing exposure. Check for news catalysts. Tighten stops."
                if price_change < 0 else
                "Verify move is sustainable. Consider taking partial profits.",
            ))

        # Volume anomaly: > 3x average
        avg_volume = _mean(volumes[-20:])
        volume_ratio = latest.volume / (avg_volume or 1)
        if volume_ratio > 3:
            results.append(self._create(
                "market_anomaly", "warning",
                f"Volume spike on {symbol}",
                f"Volume is {_round_to(volume_ratio, 1)}x the 20-period average.",
                [f"Current: {latest.volume}", f"Average: {_round_to(avg_volume, 0)}", f"Ratio: {_round_to(volume_ratio, 1)}x"],
                "Monitor for breakout confirmation.",
            ))

        # Price gap
        gap = ((latest.open - prev.close) / prev.close) * 100
        if abs(gap) > 2:
            results.append(self._create(
                "market_anomaly", "warning",
                f"Price gap on {symbol}",
                f"{_round_to(abs(gap), 2)}% gap {'up' if gap > 0 else 'down'}. Gaps often fill.",
                [f"Gap: {_round_to(gap, 2)}%", f"Prev close: {prev.close}", f"Open: {latest.open}"],
                "Gaps frequently fill. Consider fade trade with tight stop.",
            ))

        # Rejection wick
        body = abs(latest.close - latest.open)
        upper_wick = latest.high - max(latest.close, latest.open)
        lower_wick = min(latest.close, latest.open) - latest.low
        max_wick = max(upper_wick, lower_wick)
        if body > 0 and max_wick > body * 3:
            side = "upper" if upper_wick > lower_wick else "lower"
            results.append(self._create(
                "market_anomaly", "info",
                f"Rejection wick on {symbol}",
                f"Long {side} wick ({_round_to(max_wick / body, 1)}x body) signals strong {'selling' if side == 'upper' else 'buying'} pressure.",
                [f"Body: {_round_to(body, 4)}", f"{side} wick: {_round_to(max_wick, 4)}"],
                f"{'Bearish' if side == 'upper' else 'Bullish'} rejection signal.",
            ))

        return results

    # ------------------------------------------------------------------
    # Portfolio Risk
    # ------------------------------------------------------------------

    def _analyze_portfolio_risk(self, portfolio: Portfolio) -> list[Diagnostic]:
        results: list[Diagnostic] = []

        # Drawdown
        if portfolio.max_drawdown > 15:
            severity: Severity = "emergency" if portfolio.max_drawdown > 25 else "critical"
            results.append(self._create(
                "risk_exposure", severity,
                f"Excessive drawdown: {_round_to(portfolio.max_drawdown, 1)}%",
                f"Portfolio drawdown has reached {_round_to(portfolio.max_drawdown, 1)}%.",
                [f"Max drawdown: {_round_to(portfolio.max_drawdown, 1)}%", f"Capital: ${_round_to(portfolio.capital, 2)}"],
                "EMERGENCY: Close all positions immediately." if portfolio.max_drawdown > 25
                else "Reduce position sizes by 50%. Tighten all stops.",
            ))

        # Concentration & directional bias
        if portfolio.positions:
            for pos in portfolio.positions:
                exposure = (pos.current_price * pos.quantity) / (portfolio.capital or 1) * 100
                if exposure > 20:
                    results.append(self._create(
                        "risk_exposure", "critical",
                        f"High concentration in {pos.asset.symbol}",
                        f"{_round_to(exposure, 1)}% of portfolio in single position.",
                        [f"Position: ${_round_to(pos.current_price * pos.quantity, 2)}", f"Portfolio: ${_round_to(portfolio.capital, 2)}"],
                        "Trim to under 10%. Diversify across uncorrelated assets.",
                    ))

            sides = {p.side for p in portfolio.positions}
            if len(sides) == 1 and len(portfolio.positions) > 3:
                results.append(self._create(
                    "risk_exposure", "warning",
                    "Directional bias — all positions same side",
                    f"All {len(portfolio.positions)} positions are {portfolio.positions[0].side.value}.",
                    [f"{p.asset.symbol}: {p.side.value}" for p in portfolio.positions],
                    "Consider adding counter-directional positions.",
                ))

            total_unrealized = sum(p.unrealized_pnl for p in portfolio.positions if p.unrealized_pnl < 0)
            if total_unrealized < -(portfolio.capital * 0.1):
                results.append(self._create(
                    "risk_exposure", "critical",
                    f"Large unrealized losses: ${_round_to(total_unrealized, 2)}",
                    "Unrealized losses exceed 10% of capital.",
                    [f"{p.asset.symbol}: ${_round_to(p.unrealized_pnl, 2)}" for p in portfolio.positions if p.unrealized_pnl < 0],
                    "Review each losing position. Cut positions with no recovery thesis.",
                ))

        return results

    # ------------------------------------------------------------------
    # Strategy Decay
    # ------------------------------------------------------------------

    def _detect_strategy_decay(self, metrics: dict[str, PerformanceMetrics]) -> list[Diagnostic]:
        results: list[Diagnostic] = []

        for strategy, m in metrics.items():
            if m.sharpe_ratio < 0 and m.total_trades > 10:
                results.append(self._create(
                    "strategy_decay", "critical",
                    f"{strategy}: Negative risk-adjusted returns",
                    f"Sharpe ratio is {_round_to(m.sharpe_ratio, 2)}.",
                    [f"Sharpe: {_round_to(m.sharpe_ratio, 2)}", f"Win rate: {_round_to(m.win_rate * 100, 1)}%", f"Trades: {m.total_trades}"],
                    "Disable this strategy or re-optimize parameters.",
                ))

            if m.win_rate < 0.35 and m.total_trades > 15:
                results.append(self._create(
                    "strategy_decay", "warning",
                    f"{strategy}: Low win rate ({_round_to(m.win_rate * 100, 1)}%)",
                    "Win rate has dropped below 35%.",
                    [f"Win rate: {_round_to(m.win_rate * 100, 1)}%", f"Profit factor: {_round_to(m.profit_factor, 2)}"],
                    "Check if market regime has changed. Consider pausing strategy.",
                ))

            if 0 < m.profit_factor < 1 and m.total_trades > 10:
                results.append(self._create(
                    "strategy_decay", "warning",
                    f"{strategy}: Negative expectancy",
                    f"Profit factor is {_round_to(m.profit_factor, 2)} (below 1.0).",
                    [f"Avg win: ${_round_to(m.avg_win, 2)}", f"Avg loss: ${_round_to(m.avg_loss, 2)}"],
                    "Improve stop placement or signal quality.",
                ))

        return results

    # ------------------------------------------------------------------
    # Macro Divergence
    # ------------------------------------------------------------------

    def _detect_macro_divergence(self, macro: MacroEnvironment) -> list[Diagnostic]:
        results: list[Diagnostic] = []
        indicators = macro.indicators

        def _find(keyword: str):
            return next((i for i in indicators if keyword.lower() in i.name.lower()), None)

        yield_curve = _find("t10y2y") or _find("yield")
        vix = _find("vix")
        fed_rate = _find("fed")
        cpi = _find("cpi")

        if yield_curve and yield_curve.value < 0 and vix and vix.value < 15:
            results.append(self._create(
                "macro_divergence", "critical",
                "Yield curve inverted but VIX complacent",
                f"Yield curve at {_round_to(yield_curve.value, 2)} but VIX only {_round_to(vix.value, 1)}.",
                [f"10Y-2Y: {_round_to(yield_curve.value, 2)}", f"VIX: {_round_to(vix.value, 1)}"],
                "Consider buying protection or reducing equity exposure.",
            ))

        if fed_rate and cpi and fed_rate.value > fed_rate.previous_value and cpi.value > cpi.previous_value:
            results.append(self._create(
                "macro_divergence", "warning",
                "Rising rates failing to curb inflation",
                f"Fed rate {_round_to(fed_rate.previous_value, 2)} -> {_round_to(fed_rate.value, 2)}, CPI {_round_to(cpi.previous_value, 1)} -> {_round_to(cpi.value, 1)}.",
                [f"Fed rate: {_round_to(fed_rate.value, 2)}%", f"CPI: {_round_to(cpi.value, 1)}%"],
                "Prepare for higher rates. Reduce duration exposure.",
            ))

        if vix and vix.value > 30:
            results.append(self._create(
                "macro_divergence",
                "emergency" if vix.value > 40 else "critical",
                f"VIX at {_round_to(vix.value, 1)} — fear elevated",
                "VIX above 30 indicates extreme fear.",
                [f"VIX: {_round_to(vix.value, 1)}", f"Previous: {_round_to(vix.previous_value, 1)}"],
                "EXTREME FEAR. Reduce all exposure." if vix.value > 40
                else "Consider mean-reversion trades cautiously. Protect capital first.",
            ))

        return results

    # ------------------------------------------------------------------
    # Correlation Analysis
    # ------------------------------------------------------------------

    def _analyze_correlations(self, candles_map: dict[str, list[Candle]]) -> list[Diagnostic]:
        results: list[Diagnostic] = []
        symbols = list(candles_map.keys())
        if len(symbols) < 2:
            return results

        returns_map: dict[str, list[float]] = {}
        for symbol, data in candles_map.items():
            rets = []
            for i in range(1, len(data)):
                rets.append((data[i].close - data[i - 1].close) / data[i - 1].close)
            returns_map[symbol] = rets

        high_corr = 0
        total_pairs = 0
        for i in range(len(symbols)):
            for j in range(i + 1, len(symbols)):
                r1 = returns_map.get(symbols[i], [])
                r2 = returns_map.get(symbols[j], [])
                min_len = min(len(r1), len(r2))
                if min_len < 10:
                    continue
                corr = _pearson_correlation(r1[-min_len:], r2[-min_len:])
                total_pairs += 1
                if abs(corr) > 0.85:
                    high_corr += 1

        if total_pairs > 0 and high_corr / total_pairs > 0.6:
            results.append(self._create(
                "correlation_break", "critical",
                "Correlation spike — assets moving together",
                f"{high_corr}/{total_pairs} pairs have correlation > 0.85. Diversification failing.",
                [f"High corr pairs: {high_corr}", f"Total pairs: {total_pairs}"],
                "Reduce total portfolio exposure. In correlated sell-offs, cash is the only hedge.",
            ))

        return results

    # ------------------------------------------------------------------
    # Regime Transition
    # ------------------------------------------------------------------

    def _check_regime_transition(self, regime: object) -> list[Diagnostic]:
        results: list[Diagnostic] = []
        confidence = getattr(regime, "confidence", 1.0)
        regime_name = getattr(regime, "regime", "unknown")
        details = getattr(regime, "details", "")
        trend = getattr(regime, "trend_strength", 0.0)
        vol = getattr(regime, "volatility_percentile", 50.0)

        if confidence < 0.4:
            results.append(self._create(
                "regime_transition", "warning",
                "Market regime unclear — possible transition",
                f"Regime detection confidence is only {_round_to(confidence * 100, 0)}%.",
                [f"Current regime: {regime_name}", f"Confidence: {_round_to(confidence * 100, 0)}%"],
                "Reduce position sizes during transitions.",
            ))

        regime_val = regime_name.value if hasattr(regime_name, "value") else str(regime_name)
        if regime_val == "crisis":
            results.append(self._create(
                "regime_transition", "emergency",
                "CRISIS REGIME DETECTED",
                f"Market is in crisis mode. {details}",
                [f"Trend: {_round_to(trend, 2)}", f"Vol percentile: {_round_to(vol, 0)}"],
                "STOP TRADING. Close non-essential positions. Preserve capital.",
            ))

        return results

    # ------------------------------------------------------------------
    # Structural Risks
    # ------------------------------------------------------------------

    def _assess_structural_risks(self, macro: MacroEnvironment, regime: object) -> list[Diagnostic]:
        results: list[Diagnostic] = []
        negative_signals: list[str] = []

        for indicator in macro.indicators:
            if indicator.impact == "high":
                if "vix" in indicator.name.lower() and indicator.value > 25:
                    negative_signals.append(f"VIX elevated ({_round_to(indicator.value, 1)})")
                if "yield" in indicator.name.lower() and indicator.value < 0:
                    negative_signals.append(f"Yield curve inverted ({_round_to(indicator.value, 2)})")
                if "unemployment" in indicator.name.lower() and indicator.value > indicator.previous_value + 0.3:
                    negative_signals.append(f"Unemployment rising ({_round_to(indicator.value, 1)}%)")

        if len(negative_signals) >= 3:
            results.append(self._create(
                "structural_risk", "emergency",
                "Multiple structural risk signals converging",
                f"{len(negative_signals)} macro risk indicators are flashing simultaneously.",
                negative_signals,
                "MAXIMUM CAUTION. Reduce portfolio to 25% or less of normal exposure.",
            ))
        elif len(negative_signals) >= 2:
            results.append(self._create(
                "structural_risk", "critical",
                "Structural risk signals building",
                f"{len(negative_signals)} macro risk indicators are elevated.",
                negative_signals,
                "Reduce exposure by 50%. Increase cash allocation.",
            ))

        return results

    # ------------------------------------------------------------------
    # Internal Helpers
    # ------------------------------------------------------------------

    def _create(
        self,
        category: DiagnosticCategory,
        severity: Severity,
        title: str,
        description: str,
        evidence: list[str],
        recommendation: str,
    ) -> Diagnostic:
        self._counter += 1
        return Diagnostic(
            id=f"diag-{self._counter}",
            category=category,
            severity=severity,
            title=title,
            description=description,
            evidence=evidence,
            recommendation=recommendation,
            timestamp=int(time.time() * 1000),
        )

    @staticmethod
    def _calculate_health_score(diagnostics: list[Diagnostic]) -> int:
        score = 100
        for d in diagnostics:
            if d.severity == "emergency":
                score -= 30
            elif d.severity == "critical":
                score -= 15
            elif d.severity == "warning":
                score -= 5
            elif d.severity == "info":
                score -= 1
        return max(0, min(100, score))

    @staticmethod
    def _generate_summary(
        health: int,
        emergencies: list[Diagnostic],
        criticals: list[Diagnostic],
        warnings: list[Diagnostic],
    ) -> str:
        if emergencies:
            return (
                f"EMERGENCY: {len(emergencies)} critical issues require immediate action. "
                f"Health: {health}/100. {emergencies[0].title}"
            )
        if criticals:
            return f"ALERT: {len(criticals)} significant issues. Health: {health}/100. Review before trading."
        if warnings:
            return f"CAUTION: {len(warnings)} warnings. Health: {health}/100. Stay vigilant."
        return f"ALL CLEAR: Health {health}/100. No significant issues. Trading conditions favorable."

    @staticmethod
    def format_report(report: DiagnosticReport) -> str:
        sep = "=" * 60
        lines = [
            f"\n{sep}",
            f"  DIAGNOSTIC REPORT — Health: {report.health_score}/100",
            sep,
            f"  {report.summary}",
            "",
        ]

        def _section(title: str, items: list[Diagnostic]) -> None:
            if not items:
                return
            lines.append(f"\n  --- {title} ---")
            for d in items:
                lines.append(f"  [{d.severity.upper()}] {d.title}")
                lines.append(f"    {d.description}")
                lines.append(f"    -> {d.recommendation}")

        _section("EMERGENCIES", report.emergencies)
        _section("CRITICAL", report.criticals)
        _section("WARNINGS", report.warnings)

        if report.infos:
            lines.append(f"\n  --- INFO ({len(report.infos)} items) ---")
            for d in report.infos:
                lines.append(f"  [INFO] {d.title}")

        lines.append(f"\n{sep}\n")
        return "\n".join(lines)
