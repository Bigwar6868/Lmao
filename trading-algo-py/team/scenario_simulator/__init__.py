"""Scenario Simulator -- macro-driven what-if analysis for assets."""

from __future__ import annotations

import logging
import math
import time
from dataclasses import dataclass, field
from typing import Literal

from shared.types import AssetInfo, Candle

log = logging.getLogger(__name__)

# ============================================================
# Types
# ============================================================

MarketRegime = Literal[
    "trending_bull", "trending_bear", "range_bound",
    "high_volatility", "low_volatility", "recovery", "crisis",
]


@dataclass
class ScenarioVariable:
    name: str
    current_value: float
    scenario_value: float
    impact: Literal["positive", "negative", "neutral"]
    description: str


@dataclass
class PriceProjection:
    period: str                 # e.g. "1 week", "1 month"
    bull_case: float
    base_case: float
    bear_case: float
    probability: dict[str, float] = field(default_factory=dict)  # bull/base/bear


@dataclass
class ScenarioResult:
    name: str
    description: str
    probability: float          # 0-1
    variables: list[ScenarioVariable] = field(default_factory=list)
    projections: list[PriceProjection] = field(default_factory=list)
    expected_return: float = 0.0  # percentage
    risk_level: Literal["low", "medium", "high", "extreme"] = "medium"
    actionable_insight: str = ""
    timestamp: int = 0


@dataclass
class SimulationReport:
    asset: AssetInfo
    current_price: float
    current_regime: MarketRegime
    scenarios: list[ScenarioResult] = field(default_factory=list)
    best_scenario: str = "N/A"
    worst_scenario: str = "N/A"
    overall_outlook: Literal["bullish", "bearish", "neutral", "uncertain"] = "uncertain"
    key_risks: list[str] = field(default_factory=list)
    opportunities: list[str] = field(default_factory=list)
    timestamp: int = 0


# ============================================================
# Internal helpers
# ============================================================

@dataclass
class _MacroValues:
    fed_rate: float = 3.625
    cpi: float = 2.8
    vix: float = 18.0
    yield_curve: float = 0.2
    gdp_growth: float = 2.3


@dataclass
class _ScenarioTemplate:
    name: str
    description: str
    shifts_fed_rate: float       # basis points
    shifts_cpi: float            # pct point
    shifts_vix: float            # absolute
    shifts_yield_curve: float    # bps
    shifts_gdp_growth: float     # pct point
    impact_crypto: float         # -1 to +1
    impact_forex_usd: float      # positive = USD strengthens
    base_probability: float


_SCENARIO_TEMPLATES: list[_ScenarioTemplate] = [
    _ScenarioTemplate(
        "Soft Landing",
        "Fed achieves inflation target with minimal economic damage. Rate cuts begin. Risk assets rally.",
        -50, -0.5, -5, 20, 0.3, 0.6, -0.3, 0.25,
    ),
    _ScenarioTemplate(
        "Stagflation",
        "Persistent inflation + slowing growth. Fed caught between cutting (growth) and hiking (inflation). Bad for most assets.",
        25, 0.8, 10, -30, -0.5, -0.4, 0.2, 0.15,
    ),
    _ScenarioTemplate(
        "Risk-On Rally",
        "Strong economic data, earnings beats, geopolitical de-escalation. Animal spirits return.",
        0, -0.2, -8, 10, 0.5, 0.8, -0.1, 0.20,
    ),
    _ScenarioTemplate(
        "Geopolitical Shock",
        "Major conflict escalation, supply chain disruption, or sanctions. Flight to safety.",
        -25, 0.5, 20, -50, -1.0, -0.5, 0.5, 0.10,
    ),
    _ScenarioTemplate(
        "Liquidity Crunch",
        "Credit tightening, bank stress, or DeFi contagion. Correlations spike, everything sells.",
        -75, -0.3, 30, -80, -1.5, -0.8, 0.4, 0.05,
    ),
    _ScenarioTemplate(
        "Base Case (Status Quo)",
        "Current trends continue. No major surprises. Gradual normalization.",
        0, 0, 0, 0, 0, 0.1, 0, 0.25,
    ),
]


def _round_to(value: float, decimals: int) -> float:
    factor = 10 ** decimals
    return round(value * factor) / factor


def _mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _std_dev(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    m = _mean(values)
    variance = sum((v - m) ** 2 for v in values) / (len(values) - 1)
    return math.sqrt(variance)


# ============================================================
# Scenario Simulator
# ============================================================

class ScenarioSimulator:
    """Simulate future market conditions under different macro/geopolitical scenarios.

    Uses probability weighting adjusted by current regime and macro data to
    generate price projections, key risks, and opportunities.
    """

    def simulate(
        self,
        asset: AssetInfo,
        candles: list[Candle],
        regime: MarketRegime,
        macro_indicators: list[dict[str, object]] | None = None,
    ) -> SimulationReport:
        """Run full scenario simulation for *asset*."""
        if len(candles) < 30:
            return self._empty_report(asset)

        current_price = candles[-1].close
        historical_vol = self._calculate_historical_volatility(candles)
        macro = self._extract_macro_values(macro_indicators)

        adjusted = self._adjust_probabilities(_SCENARIO_TEMPLATES, regime, macro)

        scenarios = [
            self._generate_scenario(t, asset, current_price, historical_vol, macro)
            for t in adjusted
        ]

        sorted_by_return = sorted(scenarios, key=lambda s: s.expected_return, reverse=True)
        best_scenario = sorted_by_return[0].name
        worst_scenario = sorted_by_return[-1].name

        weighted_return = sum(s.expected_return * s.probability for s in scenarios)

        if weighted_return > 3:
            overall_outlook: Literal["bullish", "bearish", "neutral", "uncertain"] = "bullish"
        elif weighted_return < -3:
            overall_outlook = "bearish"
        elif abs(weighted_return) < 1:
            overall_outlook = "neutral"
        else:
            overall_outlook = "uncertain"

        key_risks = self._identify_key_risks(scenarios, regime, macro)
        opportunities = self._identify_opportunities(scenarios, regime, asset)

        report = SimulationReport(
            asset=asset,
            current_price=current_price,
            current_regime=regime,
            scenarios=scenarios,
            best_scenario=best_scenario,
            worst_scenario=worst_scenario,
            overall_outlook=overall_outlook,
            key_risks=key_risks,
            opportunities=opportunities,
            timestamp=int(time.time() * 1000),
        )

        log.info(
            "Simulation complete: asset=%s outlook=%s weighted_return=%.2f scenarios=%d",
            asset.symbol, overall_outlook, _round_to(weighted_return, 2), len(scenarios),
        )
        return report

    # ----------------------------------------------------------------
    # Scenario generation
    # ----------------------------------------------------------------

    def _generate_scenario(
        self,
        template: _ScenarioTemplate,
        asset: AssetInfo,
        current_price: float,
        historical_vol: float,
        macro: _MacroValues,
    ) -> ScenarioResult:
        impact = (
            template.impact_crypto if asset.asset_class == "crypto"
            else template.impact_forex_usd
        )

        variables = [
            ScenarioVariable(
                name="Fed Funds Rate",
                current_value=macro.fed_rate,
                scenario_value=macro.fed_rate + template.shifts_fed_rate / 100,
                impact=(
                    "negative" if template.shifts_fed_rate > 0
                    else "positive" if template.shifts_fed_rate < 0
                    else "neutral"
                ),
                description=(
                    f"Rate hike of {template.shifts_fed_rate}bps" if template.shifts_fed_rate > 0
                    else f"Rate cut of {abs(template.shifts_fed_rate)}bps" if template.shifts_fed_rate < 0
                    else "Rates unchanged"
                ),
            ),
            ScenarioVariable(
                name="CPI (Inflation)",
                current_value=macro.cpi,
                scenario_value=macro.cpi + template.shifts_cpi,
                impact=(
                    "negative" if template.shifts_cpi > 0.3
                    else "positive" if template.shifts_cpi < -0.2
                    else "neutral"
                ),
                description=f"CPI moves {'up' if template.shifts_cpi > 0 else 'down'} by {abs(template.shifts_cpi):.1f} ppt",
            ),
            ScenarioVariable(
                name="VIX (Volatility)",
                current_value=macro.vix,
                scenario_value=macro.vix + template.shifts_vix,
                impact=(
                    "negative" if template.shifts_vix > 5
                    else "positive" if template.shifts_vix < -3
                    else "neutral"
                ),
                description=f"VIX {'spikes' if template.shifts_vix > 0 else 'drops'} by {abs(template.shifts_vix)} points",
            ),
            ScenarioVariable(
                name="GDP Growth",
                current_value=macro.gdp_growth,
                scenario_value=macro.gdp_growth + template.shifts_gdp_growth,
                impact=(
                    "positive" if template.shifts_gdp_growth > 0
                    else "negative" if template.shifts_gdp_growth < 0
                    else "neutral"
                ),
                description=(
                    f"GDP growth {'accelerates' if template.shifts_gdp_growth > 0 else 'decelerates'} "
                    f"by {abs(template.shifts_gdp_growth):.1f} ppt"
                ),
            ),
        ]

        projections = self._project_prices(current_price, impact, historical_vol)
        expected_return = impact * historical_vol * 100 * 0.5

        abs_vix_shift = abs(template.shifts_vix)
        if abs_vix_shift > 15:
            risk_level: Literal["low", "medium", "high", "extreme"] = "extreme"
        elif abs_vix_shift > 8:
            risk_level = "high"
        elif abs_vix_shift > 3:
            risk_level = "medium"
        else:
            risk_level = "low"

        return ScenarioResult(
            name=template.name,
            description=template.description,
            probability=template.base_probability,
            variables=variables,
            projections=projections,
            expected_return=_round_to(expected_return, 2),
            risk_level=risk_level,
            actionable_insight=self._generate_insight(template, asset, impact),
            timestamp=int(time.time() * 1000),
        )

    # ----------------------------------------------------------------
    # Price projections
    # ----------------------------------------------------------------

    def _project_prices(
        self, current_price: float, impact: float, historical_vol: float,
    ) -> list[PriceProjection]:
        periods = [
            ("1 week", 1 / 52),
            ("1 month", 1 / 12),
            ("3 months", 0.25),
        ]
        results: list[PriceProjection] = []
        for label, factor in periods:
            time_vol = historical_vol * math.sqrt(factor)
            drift = impact * time_vol
            results.append(PriceProjection(
                period=label,
                bull_case=_round_to(current_price * (1 + drift + time_vol), 2),
                base_case=_round_to(current_price * (1 + drift * 0.5), 2),
                bear_case=_round_to(current_price * (1 + drift - time_vol), 2),
                probability={
                    "bull": _round_to(0.35 if impact > 0 else 0.2, 2),
                    "base": 0.45,
                    "bear": _round_to(0.35 if impact < 0 else 0.2, 2),
                },
            ))
        return results

    # ----------------------------------------------------------------
    # Probability adjustments
    # ----------------------------------------------------------------

    def _adjust_probabilities(
        self,
        templates: list[_ScenarioTemplate],
        regime: MarketRegime,
        macro: _MacroValues,
    ) -> list[_ScenarioTemplate]:
        adjusted: list[_ScenarioTemplate] = []
        for t in templates:
            prob = t.base_probability

            # Regime adjustments
            if regime == "crisis":
                if t.name == "Liquidity Crunch":
                    prob *= 2
                if t.name == "Risk-On Rally":
                    prob *= 0.3
            elif regime == "trending_bull":
                if t.name == "Risk-On Rally":
                    prob *= 1.5
                if t.name == "Liquidity Crunch":
                    prob *= 0.5
            elif regime == "high_volatility":
                if t.name == "Geopolitical Shock":
                    prob *= 1.5
                if t.name == "Soft Landing":
                    prob *= 0.7

            # Macro adjustments
            if macro.vix > 30:
                if "Crunch" in t.name or "Shock" in t.name:
                    prob *= 1.3
            if macro.yield_curve < 0:
                if t.name == "Stagflation":
                    prob *= 1.4
                if t.name == "Risk-On Rally":
                    prob *= 0.7

            adjusted.append(_ScenarioTemplate(
                name=t.name,
                description=t.description,
                shifts_fed_rate=t.shifts_fed_rate,
                shifts_cpi=t.shifts_cpi,
                shifts_vix=t.shifts_vix,
                shifts_yield_curve=t.shifts_yield_curve,
                shifts_gdp_growth=t.shifts_gdp_growth,
                impact_crypto=t.impact_crypto,
                impact_forex_usd=t.impact_forex_usd,
                base_probability=prob,
            ))
        return adjusted

    # ----------------------------------------------------------------
    # Insight generation
    # ----------------------------------------------------------------

    @staticmethod
    def _generate_insight(template: _ScenarioTemplate, asset: AssetInfo, impact: float) -> str:
        if impact > 0.3:
            action = "Increase exposure"
        elif impact < -0.3:
            action = "Reduce exposure / hedge"
        else:
            action = "Maintain current positions with tighter stops"

        timing = "Act decisively" if abs(impact) > 0.5 else "Monitor closely before acting"
        return f"{action} to {asset.symbol}. {timing}. {template.description}"

    # ----------------------------------------------------------------
    # Risks & opportunities
    # ----------------------------------------------------------------

    @staticmethod
    def _identify_key_risks(
        scenarios: list[ScenarioResult],
        regime: MarketRegime,
        macro: _MacroValues,
    ) -> list[str]:
        risks: list[str] = []

        for s in scenarios:
            if s.expected_return < -5 and s.probability > 0.1:
                risks.append(
                    f"{s.name} ({s.probability * 100:.0f}% probability): {s.description}"
                )

        if macro.vix > 25:
            risks.append(f"Elevated VIX ({macro.vix:.1f}) -- market pricing significant risk")
        if macro.yield_curve < 0:
            risks.append(f"Inverted yield curve ({macro.yield_curve:.2f}) -- historical recession signal")
        if macro.cpi > 4:
            risks.append(f"High inflation (CPI: {macro.cpi:.1f}%) -- Fed likely to maintain hawkish stance")

        if regime == "high_volatility":
            risks.append("High volatility regime -- wider stops needed, smaller positions")
        if regime == "crisis":
            risks.append("CRISIS REGIME -- capital preservation is top priority")

        return risks if risks else ["No significant risks identified in current environment"]

    @staticmethod
    def _identify_opportunities(
        scenarios: list[ScenarioResult],
        regime: MarketRegime,
        asset: AssetInfo,
    ) -> list[str]:
        opportunities: list[str] = []

        for s in scenarios:
            if s.expected_return > 5 and s.probability > 0.15:
                opportunities.append(f"{s.name}: Expected +{s.expected_return:.1f}% if realized")

        if regime == "low_volatility":
            opportunities.append("Volatility squeeze detected -- breakout trade opportunity with defined risk")
        if regime == "recovery":
            opportunities.append("Recovery phase -- early momentum entry with confirmation")
        if asset.asset_class == "crypto":
            opportunities.append("Institutional crypto adoption accelerating -- long-term structural tailwind")

        return opportunities if opportunities else ["No high-probability opportunities at this time"]

    # ----------------------------------------------------------------
    # Volatility & macro extraction
    # ----------------------------------------------------------------

    @staticmethod
    def _calculate_historical_volatility(candles: list[Candle]) -> float:
        log_returns = [
            math.log(candles[i].close / candles[i - 1].close)
            for i in range(1, len(candles))
            if candles[i - 1].close > 0
        ]
        daily_vol = _std_dev(log_returns)
        return daily_vol * math.sqrt(365)  # annualize (crypto/forex)

    @staticmethod
    def _extract_macro_values(
        indicators: list[dict[str, object]] | None,
    ) -> _MacroValues:
        if not indicators:
            return _MacroValues()

        def _find(keyword: str) -> float | None:
            for ind in indicators:  # type: ignore[union-attr]
                name = str(ind.get("name", "")).lower()
                if keyword.lower() in name:
                    val = ind.get("value")
                    if val is not None:
                        return float(val)
            return None

        return _MacroValues(
            fed_rate=_find("fed") or _find("FEDFUNDS") or 3.625,
            cpi=_find("cpi") or _find("CPIAUCSL") or 2.8,
            vix=_find("vix") or _find("VIXCLS") or 18.0,
            yield_curve=_find("yield") or _find("T10Y2Y") or 0.2,
            gdp_growth=_find("gdp") or _find("GDP") or 2.3,
        )

    @staticmethod
    def _empty_report(asset: AssetInfo) -> SimulationReport:
        return SimulationReport(
            asset=asset,
            current_price=0.0,
            current_regime="range_bound",
            best_scenario="N/A",
            worst_scenario="N/A",
            overall_outlook="uncertain",
            key_risks=["Insufficient data"],
            timestamp=int(time.time() * 1000),
        )
