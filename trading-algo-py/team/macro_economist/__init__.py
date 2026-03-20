"""Macro Economist — coordinator for macro-economic data.

Combines data from:
- FRED API (GDP, CPI, FEDFUNDS, UNRATE, T10Y2Y, VIX)
- Geopolitical risk analysis (hardcoded rule-based engine)
- Economic calendar (recurring high-impact events)

Ported from trading-algo/src/team/macro-economist/
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from enum import Enum
from typing import Literal

import httpx

from shared.types import (
    EconomicEvent,
    GeopoliticalFactor,
    GeopoliticalRisk,
    GlobalMacroSnapshot,
    MacroEnvironment,
    MacroIndicator,
    PolicyChange,
    SentimentScore,
)

logger = logging.getLogger(__name__)


# ============================================================
# Constants — FRED
# ============================================================

FredSeriesId = Literal[
    "FEDFUNDS", "CPIAUCSL", "GDP", "UNRATE", "T10Y2Y",
    "VIXCLS", "DGS10", "DGS2", "PAYEMS", "UMCSENT",
]

_SERIES_IMPACT: dict[str, Literal["high", "medium", "low"]] = {
    "FEDFUNDS": "high",
    "CPIAUCSL": "high",
    "GDP": "high",
    "UNRATE": "high",
    "T10Y2Y": "high",
    "VIXCLS": "medium",
    "DGS10": "medium",
    "DGS2": "medium",
    "PAYEMS": "high",
    "UMCSENT": "medium",
}

_MOCK_DATA: dict[str, dict[str, float]] = {
    "FEDFUNDS": {"value": 5.33, "previous_value": 5.33},
    "CPIAUCSL": {"value": 314.69, "previous_value": 313.05},
    "GDP": {"value": 27956.0, "previous_value": 27610.0},
    "UNRATE": {"value": 3.7, "previous_value": 3.8},
    "T10Y2Y": {"value": -0.32, "previous_value": -0.44},
    "VIXCLS": {"value": 18.5, "previous_value": 17.2},
    "DGS10": {"value": 4.25, "previous_value": 4.18},
    "DGS2": {"value": 4.57, "previous_value": 4.62},
    "PAYEMS": {"value": 157200, "previous_value": 157000},
    "UMCSENT": {"value": 67.4, "previous_value": 69.7},
}


# ============================================================
# Constants — Geopolitical
# ============================================================

_RISK_FACTORS: list[GeopoliticalFactor] = [
    GeopoliticalFactor(
        category="conflict", region="Eastern Europe",
        description="Russia-Ukraine conflict ongoing -- energy supply disruption risk",
        severity="high",
        affected_assets=["EUR/USD", "natural-gas", "wheat"],
        market_impact="volatile",
    ),
    GeopoliticalFactor(
        category="trade-war", region="US-China",
        description="US-China tech decoupling -- chip export restrictions, tariff escalation",
        severity="high",
        affected_assets=["NVDA", "AAPL", "USD/CNY", "SOL/USDT"],
        market_impact="bearish",
    ),
    GeopoliticalFactor(
        category="sanctions", region="Middle East",
        description="Iran sanctions -- oil supply constraints",
        severity="medium",
        affected_assets=["oil", "USD/JPY"],
        market_impact="volatile",
    ),
    GeopoliticalFactor(
        category="election", region="United States",
        description="US policy uncertainty -- fiscal and regulatory outlook unclear",
        severity="medium",
        affected_assets=["SPY", "BTC/USDT", "USD/CHF"],
        market_impact="volatile",
    ),
    GeopoliticalFactor(
        category="policy", region="Global",
        description="Central bank divergence -- Fed vs ECB vs BoJ rate paths",
        severity="high",
        affected_assets=["EUR/USD", "USD/JPY", "GBP/USD", "GOOGL", "MSFT"],
        market_impact="volatile",
    ),
    GeopoliticalFactor(
        category="energy", region="OPEC+",
        description="OPEC+ production decisions -- oil price volatility",
        severity="medium",
        affected_assets=["oil", "XRP/USDT", "AUD/USD"],
        market_impact="volatile",
    ),
    GeopoliticalFactor(
        category="debt-crisis", region="Emerging Markets",
        description="EM sovereign debt stress -- USD strength hurting EM borrowers",
        severity="medium",
        affected_assets=["USD/CAD", "AUD/USD", "BTC/USDT"],
        market_impact="bearish",
    ),
    GeopoliticalFactor(
        category="regulatory", region="Global",
        description="Crypto regulation tightening -- SEC, MiCA, global frameworks",
        severity="medium",
        affected_assets=["BTC/USDT", "ETH/USDT", "SOL/USDT", "BNB/USDT", "XRP/USDT"],
        market_impact="bearish",
    ),
]

_RECENT_POLICY_CHANGES: list[PolicyChange] = [
    PolicyChange(
        country="United States", institution="Federal Reserve", type="monetary",
        description="Fed holding rates, watching inflation data for cut timing",
        impact="neutral", affected_markets=["crypto", "forex"],
        effective_date="2026-03-18", severity="high",
    ),
    PolicyChange(
        country="European Union", institution="ECB", type="monetary",
        description="ECB began cutting cycle -- dovish pivot",
        impact="dovish", affected_markets=["forex", "crypto"],
        effective_date="2026-01-15", severity="high",
    ),
    PolicyChange(
        country="Japan", institution="Bank of Japan", type="monetary",
        description="BoJ rate normalization -- gradual tightening from near-zero",
        impact="hawkish", affected_markets=["forex"],
        effective_date="2026-02-01", severity="high",
    ),
    PolicyChange(
        country="China", institution="PBoC", type="monetary",
        description="PBoC easing to support property sector and growth",
        impact="dovish", affected_markets=["crypto", "forex"],
        effective_date="2026-01-20", severity="medium",
    ),
    PolicyChange(
        country="United States", institution="SEC", type="regulatory",
        description="SEC crypto ETF approvals expanding, regulatory clarity improving",
        impact="expansionary", affected_markets=["crypto"],
        effective_date="2026-02-15", severity="medium",
    ),
    PolicyChange(
        country="European Union", institution="European Commission", type="trade",
        description="EU carbon border adjustment -- tariffs on high-emission imports",
        impact="restrictive", affected_markets=["forex"],
        effective_date="2026-01-01", severity="low",
    ),
]

_GLOBAL_MACRO_SNAPSHOTS: list[GlobalMacroSnapshot] = [
    GlobalMacroSnapshot(
        region="United States",
        indicators={"gdpGrowth": 2.1, "inflation": 3.2, "unemployment": 4.1, "fedFunds": 5.25},
        policy_stance="hawkish", growth_outlook="slowing", inflation_trend="sticky",
        timestamp=int(time.time() * 1000),
    ),
    GlobalMacroSnapshot(
        region="Eurozone",
        indicators={"gdpGrowth": 0.8, "inflation": 2.4, "unemployment": 6.5, "ecbRate": 3.5},
        policy_stance="dovish", growth_outlook="slowing", inflation_trend="falling",
        timestamp=int(time.time() * 1000),
    ),
    GlobalMacroSnapshot(
        region="China",
        indicators={"gdpGrowth": 4.8, "inflation": 0.3, "unemployment": 5.2, "loanPrimeRate": 3.45},
        policy_stance="dovish", growth_outlook="recovering", inflation_trend="falling",
        timestamp=int(time.time() * 1000),
    ),
    GlobalMacroSnapshot(
        region="Japan",
        indicators={"gdpGrowth": 1.1, "inflation": 2.8, "unemployment": 2.5, "bojRate": 0.25},
        policy_stance="hawkish", growth_outlook="expanding", inflation_trend="rising",
        timestamp=int(time.time() * 1000),
    ),
    GlobalMacroSnapshot(
        region="United Kingdom",
        indicators={"gdpGrowth": 0.6, "inflation": 3.0, "unemployment": 4.3, "boeRate": 4.75},
        policy_stance="neutral", growth_outlook="slowing", inflation_trend="stable",
        timestamp=int(time.time() * 1000),
    ),
]


# FOMC meeting dates for 2026
_FOMC_DATES_2026 = [
    "2026-01-28", "2026-03-18", "2026-05-06", "2026-06-17",
    "2026-07-29", "2026-09-16", "2026-11-04", "2026-12-16",
]

# Recurring economic events (excluding computed next_date)
_RECURRING_EVENTS: list[dict] = [
    {"name": "FOMC Interest Rate Decision", "description": "Federal Open Market Committee interest rate announcement",
     "impact": "high", "schedule": "8 times per year (~every 6 weeks)", "source": "Federal Reserve"},
    {"name": "CPI Release", "description": "Consumer Price Index monthly report",
     "impact": "high", "schedule": "Monthly, around the 10th-13th", "source": "Bureau of Labor Statistics"},
    {"name": "Non-Farm Payrolls (NFP)", "description": "Employment situation report",
     "impact": "high", "schedule": "First Friday of each month", "source": "Bureau of Labor Statistics"},
    {"name": "GDP Report", "description": "Gross Domestic Product quarterly estimate",
     "impact": "high", "schedule": "Quarterly -- advance, second, and third estimate", "source": "Bureau of Economic Analysis"},
    {"name": "PCE Price Index", "description": "Personal Consumption Expenditures -- Fed's preferred inflation gauge",
     "impact": "high", "schedule": "Monthly, last week of the month", "source": "Bureau of Economic Analysis"},
    {"name": "ISM Manufacturing PMI", "description": "Institute for Supply Management manufacturing index",
     "impact": "medium", "schedule": "First business day of each month", "source": "ISM"},
    {"name": "Retail Sales", "description": "Monthly retail and food services sales",
     "impact": "medium", "schedule": "Monthly, around the 15th", "source": "Census Bureau"},
    {"name": "JOLTS Job Openings", "description": "Job Openings and Labor Turnover Survey",
     "impact": "medium", "schedule": "Monthly, first or second week", "source": "Bureau of Labor Statistics"},
    {"name": "Initial Jobless Claims", "description": "Weekly unemployment insurance claims",
     "impact": "medium", "schedule": "Every Thursday", "source": "Department of Labor"},
    {"name": "Michigan Consumer Sentiment", "description": "University of Michigan consumer confidence survey",
     "impact": "low", "schedule": "Monthly -- preliminary mid-month, final end of month", "source": "University of Michigan"},
]


# ============================================================
# FRED Client
# ============================================================

class FredClient:
    """Fetch economic data from the FRED API with mock-data fallback."""

    BASE_URL = "https://api.stlouisfed.org/fred/series/observations"

    def __init__(self, api_key: str = "") -> None:
        self._api_key = api_key

    # ------------------------------------------------------------------

    async def fetch_series(self, series_id: str, limit: int = 10) -> list[MacroIndicator]:
        """Fetch a FRED data series. Falls back to mock data when no API key."""
        if not self._api_key:
            logger.warning("No FRED API key configured -- returning mock data for %s", series_id)
            return self._get_mock_data(series_id)

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(self.BASE_URL, params={
                    "series_id": series_id,
                    "api_key": self._api_key,
                    "file_type": "json",
                    "sort_order": "desc",
                    "limit": limit,
                })
                resp.raise_for_status()
                data = resp.json()

            observations = [
                obs for obs in data.get("observations", [])
                if obs.get("value") != "."
            ]

            if not observations:
                logger.warning("No valid observations from FRED for %s", series_id)
                return self._get_mock_data(series_id)

            results: list[MacroIndicator] = []
            for idx, obs in enumerate(observations):
                prev_obs = observations[idx + 1] if idx + 1 < len(observations) else None
                results.append(MacroIndicator(
                    name=series_id,
                    value=float(obs["value"]),
                    previous_value=float(prev_obs["value"]) if prev_obs else float(obs["value"]),
                    date=obs["date"],
                    source="FRED",
                    impact=_SERIES_IMPACT.get(series_id, "low"),
                ))
            return results

        except Exception:
            logger.exception("Failed to fetch FRED series %s -- falling back to mock", series_id)
            return self._get_mock_data(series_id)

    async def fetch_latest(self, series_id: str) -> MacroIndicator:
        """Fetch latest single observation for a series."""
        series = await self.fetch_series(series_id, limit=2)
        return series[0]

    async def fetch_all_key(self) -> list[MacroIndicator]:
        """Fetch all key macro series in parallel."""
        keys: list[str] = ["FEDFUNDS", "CPIAUCSL", "GDP", "UNRATE", "T10Y2Y", "VIXCLS"]
        tasks = [self.fetch_latest(k) for k in keys]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        return [r for r in results if isinstance(r, MacroIndicator)]

    # ------------------------------------------------------------------

    def _get_mock_data(self, series_id: str) -> list[MacroIndicator]:
        mock = _MOCK_DATA.get(series_id)
        today_str = date.today().isoformat()
        if mock is None:
            return [MacroIndicator(
                name=series_id, value=0.0, previous_value=0.0,
                date=today_str, source="FRED (mock)", impact="low",
            )]
        return [MacroIndicator(
            name=series_id,
            value=mock["value"],
            previous_value=mock["previous_value"],
            date=today_str,
            source="FRED (mock)",
            impact=_SERIES_IMPACT.get(series_id, "low"),
        )]


# ============================================================
# Geopolitical Analyzer
# ============================================================

class GeopoliticalAnalyzer:
    """Rule-based geopolitical risk assessment engine."""

    def __init__(self, fred: FredClient | None = None) -> None:
        self._fred = fred or FredClient()

    # ------------------------------------------------------------------

    async def assess(self) -> GeopoliticalRisk:
        """Full risk assessment combining VIX + geopolitical factors."""
        vix_indicator = await self._fred.fetch_latest("VIXCLS")
        vix = vix_indicator.value

        vix_score = self._score_from_vix(vix)
        active_factors = self.get_active_factors()
        factor_score = self._score_from_factors(active_factors)

        combined_score = round(vix_score * 0.6 + factor_score * 0.4)
        level = self._level_from_score(combined_score)

        logger.info(
            "Geopolitical risk assessed: vix=%.1f combined=%d level=%s factors=%d",
            vix, combined_score, level, len(active_factors),
        )

        return GeopoliticalRisk(
            score=combined_score,
            level=level,
            vix_level=vix,
            factors=active_factors,
            timestamp=int(time.time() * 1000),
        )

    async def get_risk_score(self) -> int:
        risk = await self.assess()
        return risk.score

    async def get_risk_level(self) -> str:
        risk = await self.assess()
        return risk.level

    # ------------------------------------------------------------------

    def get_factors_for_asset(self, symbol: str) -> list[GeopoliticalFactor]:
        return [
            f for f in _RISK_FACTORS
            if any(symbol in a or a in symbol for a in f.affected_assets)
        ]

    def get_active_factors(self) -> list[GeopoliticalFactor]:
        return list(_RISK_FACTORS)

    def get_policy_changes(self) -> list[PolicyChange]:
        return list(_RECENT_POLICY_CHANGES)

    def get_policy_changes_for_market(self, market: str) -> list[PolicyChange]:
        return [p for p in _RECENT_POLICY_CHANGES if market in p.affected_markets]

    def get_global_macro(self) -> list[GlobalMacroSnapshot]:
        return list(_GLOBAL_MACRO_SNAPSHOTS)

    def get_region_macro(self, region: str) -> GlobalMacroSnapshot | None:
        region_lower = region.lower()
        for s in _GLOBAL_MACRO_SNAPSHOTS:
            if region_lower in s.region.lower():
                return s
        return None

    def get_global_policy_bias(self) -> Literal["hawkish", "dovish", "mixed"]:
        stances = [s.policy_stance for s in _GLOBAL_MACRO_SNAPSHOTS]
        hawkish = sum(1 for s in stances if s == "hawkish")
        dovish = sum(1 for s in stances if s == "dovish")
        if hawkish > dovish + 1:
            return "hawkish"
        if dovish > hawkish + 1:
            return "dovish"
        return "mixed"

    def format_report(self, risk: GeopoliticalRisk) -> str:
        lines = [
            "\n=== GEOPOLITICAL & MACRO RISK REPORT ===",
            f"Overall Risk: {risk.level.upper()} ({risk.score}/100) | VIX: {risk.vix_level:.1f}",
            "",
            "Active Risk Factors:",
        ]

        for f in risk.factors:
            icon = "!!" if f.severity == "critical" else "!" if f.severity == "high" else "-"
            lines.append(f"  {icon} [{f.category}] {f.region}: {f.description}")
            assets = ", ".join(f.affected_assets)
            lines.append(f"    Severity: {f.severity} | Impact: {f.market_impact} | Affects: {assets}")

        lines.extend(["", "Recent Policy Changes:"])
        for p in _RECENT_POLICY_CHANGES:
            lines.append(f"  {p.country} ({p.institution}): {p.description}")
            markets = ", ".join(p.affected_markets)
            lines.append(f"    Impact: {p.impact} | Markets: {markets}")

        lines.extend(["", "Global Macro Overview:"])
        for s in _GLOBAL_MACRO_SNAPSHOTS:
            lines.append(
                f"  {s.region}: Growth={s.growth_outlook}, "
                f"Inflation={s.inflation_trend}, Policy={s.policy_stance}"
            )

        global_bias = self.get_global_policy_bias()
        lines.append(f"\nGlobal Policy Bias: {global_bias.upper()}")

        return "\n".join(lines)

    # ------------------------------------------------------------------

    @staticmethod
    def _score_from_vix(vix: float) -> int:
        if vix < 15:
            return 20
        if vix <= 25:
            return 50
        if vix <= 35:
            return 75
        return 90

    @staticmethod
    def _score_from_factors(factors: list[GeopoliticalFactor]) -> int:
        score = 0
        severity_points = {"critical": 15, "high": 10, "medium": 5, "low": 2}
        for f in factors:
            score += severity_points.get(f.severity, 0)
        return min(100, score)

    @staticmethod
    def _level_from_score(score: int) -> Literal["low", "medium", "high", "extreme"]:
        if score < 30:
            return "low"
        if score <= 55:
            return "medium"
        if score <= 75:
            return "high"
        return "extreme"


# ============================================================
# Economic Calendar
# ============================================================

class EconomicCalendar:
    """Static schedule of recurring economic events."""

    def get_upcoming_events(self) -> list[EconomicEvent]:
        """Get upcoming economic events with estimated next dates."""
        today = date.today()
        events: list[EconomicEvent] = []
        for ev in _RECURRING_EVENTS:
            next_date = self._estimate_next_date(ev["name"], today)
            events.append(EconomicEvent(
                name=ev["name"],
                description=ev["description"],
                impact=ev["impact"],
                schedule=ev["schedule"],
                next_date=next_date,
                source=ev["source"],
            ))
        events.sort(key=lambda e: e.next_date)
        logger.debug("Generated %d upcoming economic events", len(events))
        return events

    def is_high_impact_period(self) -> bool:
        """Returns True if a high-impact event is within 24 hours."""
        now_ms = time.time() * 1000
        twenty_four_h = 24 * 60 * 60 * 1000
        for ev in self.get_upcoming_events():
            if ev.impact != "high":
                continue
            event_time = datetime.fromisoformat(ev.next_date).timestamp() * 1000
            if abs(event_time - now_ms) <= twenty_four_h:
                return True
        return False

    # ------------------------------------------------------------------

    def _estimate_next_date(self, event_name: str, today: date) -> str:
        dispatch: dict[str, str] = {
            "FOMC Interest Rate Decision": self._next_fomc_date(today),
            "CPI Release": self._next_monthly_date(today, 12),
            "Non-Farm Payrolls (NFP)": self._next_first_friday(today),
            "GDP Report": self._next_quarterly_date(today, 28),
            "PCE Price Index": self._next_monthly_date(today, 28),
            "ISM Manufacturing PMI": self._next_monthly_date(today, 1),
            "Retail Sales": self._next_monthly_date(today, 15),
            "JOLTS Job Openings": self._next_monthly_date(today, 7),
            "Initial Jobless Claims": self._next_thursday(today),
            "Michigan Consumer Sentiment": self._next_monthly_date(today, 14),
        }
        return dispatch.get(event_name, self._next_monthly_date(today, 15))

    @staticmethod
    def _next_fomc_date(today: date) -> str:
        today_str = today.isoformat()
        for d in _FOMC_DATES_2026:
            if d >= today_str:
                return d
        return f"{today.year + 1}-01-28"

    @staticmethod
    def _next_monthly_date(today: date, day_of_month: int) -> str:
        try:
            candidate = date(today.year, today.month, day_of_month)
        except ValueError:
            # Handle months shorter than day_of_month
            candidate = date(today.year, today.month, 28)
        if candidate > today:
            return candidate.isoformat()
        # Move to next month
        if today.month == 12:
            candidate = date(today.year + 1, 1, day_of_month)
        else:
            try:
                candidate = date(today.year, today.month + 1, day_of_month)
            except ValueError:
                candidate = date(today.year, today.month + 1, 28)
        return candidate.isoformat()

    @staticmethod
    def _next_first_friday(today: date) -> str:
        candidate = date(today.year, today.month, 1)
        while candidate.weekday() != 4:  # Friday
            candidate += timedelta(days=1)
        if candidate > today:
            return candidate.isoformat()
        # Next month
        if today.month == 12:
            candidate = date(today.year + 1, 1, 1)
        else:
            candidate = date(today.year, today.month + 1, 1)
        while candidate.weekday() != 4:
            candidate += timedelta(days=1)
        return candidate.isoformat()

    @staticmethod
    def _next_thursday(today: date) -> str:
        days_until = (3 - today.weekday() + 7) % 7 or 7  # Thursday = weekday 3
        candidate = today + timedelta(days=days_until)
        return candidate.isoformat()

    @staticmethod
    def _next_quarterly_date(today: date, day_of_month: int) -> str:
        quarter_end_months = [3, 6, 9, 12]
        for m in quarter_end_months:
            try:
                candidate = date(today.year, m, day_of_month)
            except ValueError:
                candidate = date(today.year, m, 28)
            if candidate > today:
                return candidate.isoformat()
        return f"{today.year + 1}-03-{day_of_month:02d}"


# ============================================================
# Macro Economist — Coordinator
# ============================================================

class MacroEconomist:
    """Coordinate FRED data, geopolitical analysis and the economic calendar
    into a single :class:`MacroEnvironment` snapshot.
    """

    def __init__(self, fred: FredClient | None = None) -> None:
        self._fred = fred or FredClient()
        self._calendar = EconomicCalendar()
        self._geopolitical = GeopoliticalAnalyzer(self._fred)
        self._last_environment: MacroEnvironment | None = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def get_environment(self) -> MacroEnvironment:
        """Build a complete picture of the current macro environment."""
        logger.info("Building macro environment snapshot")

        indicators, geo_risk = await asyncio.gather(
            self._fred.fetch_all_key(),
            self._geopolitical.assess(),
        )

        bias = self._determine_bias(indicators)
        is_high_impact = self._calendar.is_high_impact_period()

        if is_high_impact:
            logger.warning("Within 24h of a high-impact economic event")

        environment = MacroEnvironment(
            indicators=indicators,
            sentiment=[],  # Filled by SentimentAnalyst
            risk_level=geo_risk.level,
            bias=bias,
            timestamp=int(time.time() * 1000),
        )

        self._last_environment = environment
        logger.info("Macro environment updated: bias=%s risk=%s", bias, geo_risk.level)
        return environment

    async def get_bias(self) -> Literal["bullish", "bearish", "neutral"]:
        """Get current macro bias without re-fetching if available."""
        if self._last_environment:
            return self._last_environment.bias
        env = await self.get_environment()
        return env.bias

    def get_geopolitical_factors_for_asset(self, symbol: str) -> list[GeopoliticalFactor]:
        return self._geopolitical.get_factors_for_asset(symbol)

    def get_policy_changes(self, market: str | None = None) -> list[PolicyChange]:
        if market:
            return self._geopolitical.get_policy_changes_for_market(market)
        return self._geopolitical.get_policy_changes()

    def get_global_macro(self) -> list[GlobalMacroSnapshot]:
        return self._geopolitical.get_global_macro()

    def get_region_macro(self, region: str) -> GlobalMacroSnapshot | None:
        return self._geopolitical.get_region_macro(region)

    def get_global_policy_bias(self) -> Literal["hawkish", "dovish", "mixed"]:
        return self._geopolitical.get_global_policy_bias()

    def get_upcoming_events(self) -> list[EconomicEvent]:
        return self._calendar.get_upcoming_events()

    def is_high_impact_period(self) -> bool:
        return self._calendar.is_high_impact_period()

    async def get_geopolitical_report(self) -> str:
        risk = await self._geopolitical.assess()
        return self._geopolitical.format_report(risk)

    # ------------------------------------------------------------------
    # Private
    # ------------------------------------------------------------------

    @staticmethod
    def _determine_bias(
        indicators: list[MacroIndicator],
    ) -> Literal["bullish", "bearish", "neutral"]:
        """Simple scoring: each factor adds/subtracts a point.

        - Yield curve (T10Y2Y): inverted = bearish
        - VIX (VIXCLS): high = bearish
        - Fed Funds (FEDFUNDS): rising = bearish
        - CPI (CPIAUCSL): rising = bearish
        """
        score = 0

        def find(name: str) -> MacroIndicator | None:
            return next((i for i in indicators if i.name == name), None)

        # Yield curve
        yield_curve = find("T10Y2Y")
        if yield_curve:
            if yield_curve.value < 0:
                score -= 1
            elif yield_curve.value > 0.5:
                score += 1

        # VIX
        vix = find("VIXCLS")
        if vix:
            if vix.value > 25:
                score -= 1
            elif vix.value < 15:
                score += 1

        # Fed Funds rate trend
        fed_funds = find("FEDFUNDS")
        if fed_funds:
            if fed_funds.value > fed_funds.previous_value:
                score -= 1
            elif fed_funds.value < fed_funds.previous_value:
                score += 1

        # CPI trend
        cpi = find("CPIAUCSL")
        if cpi:
            if cpi.value > cpi.previous_value:
                score -= 1
            elif cpi.value < cpi.previous_value:
                score += 1

        logger.debug("Macro bias score: %d", score)

        if score >= 2:
            return "bullish"
        if score <= -2:
            return "bearish"
        return "neutral"
