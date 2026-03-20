"""Opportunity Scanner — ranks trading signals into scored opportunities.

Ported from trading-algo/src/team/opportunity-scanner/index.ts
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field

from shared.types import AssetInfo, Candle, MacroEnvironment, MarketData, Signal

log = logging.getLogger(__name__)


# ============================================================
# Types
# ============================================================

@dataclass
class Opportunity:
    asset: AssetInfo
    score: int                  # 0-100 composite score
    action: str                 # "BUY" or "SELL"
    signals: list[Signal]
    avg_confidence: float
    signal_count: int
    momentum: float             # -1 to 1
    volatility: float           # ATR / price
    volume_trend: float         # volume increase ratio
    reason: str


# ============================================================
# Helpers
# ============================================================

def _mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _round_to(value: float, decimals: int) -> float:
    factor = 10 ** decimals
    return round(value * factor) / factor


# ============================================================
# Opportunity Scanner
# ============================================================

class OpportunityScanner:
    """Scans all assets, ranks opportunities by composite score."""

    def scan(
        self,
        signals: list[Signal],
        market_data_map: dict[str, MarketData],
        macro: MacroEnvironment | None = None,
    ) -> list[Opportunity]:
        """Score and rank all signals into opportunities."""
        # Group signals by asset
        by_asset: dict[str, list[Signal]] = {}
        for signal in signals:
            key = signal.asset.symbol
            by_asset.setdefault(key, []).append(signal)

        opportunities: list[Opportunity] = []

        for symbol, asset_signals in by_asset.items():
            md = market_data_map.get(symbol)
            if not md or len(md.candles) < 20:
                continue

            candles = md.candles

            buy_signals = [s for s in asset_signals if s.action.value == "BUY"]
            sell_signals = [s for s in asset_signals if s.action.value == "SELL"]
            buys = len(buy_signals)
            sells = len(sell_signals)

            if buys == 0 and sells == 0:
                continue

            action = "BUY" if buys >= sells else "SELL"
            dominant = buy_signals if action == "BUY" else sell_signals

            avg_confidence = sum(s.confidence for s in dominant) / len(dominant)
            signal_count = len(dominant)
            momentum = self._calculate_momentum(candles)
            volatility = self._calculate_volatility(candles)
            volume_trend = self._calculate_volume_trend(candles)

            score = self._calculate_score(
                avg_confidence=avg_confidence,
                signal_count=signal_count,
                total_strategies=4,
                momentum=momentum,
                volatility=volatility,
                volume_trend=volume_trend,
                action=action,
                macro=macro,
            )

            best_signal = sorted(dominant, key=lambda s: s.confidence, reverse=True)[0]

            opportunities.append(Opportunity(
                asset=best_signal.asset,
                score=score,
                action=action,
                signals=dominant,
                avg_confidence=avg_confidence,
                signal_count=signal_count,
                momentum=momentum,
                volatility=volatility,
                volume_trend=volume_trend,
                reason=self._build_reason(dominant, signal_count, momentum, volume_trend),
            ))

        # Filter NaN and sort
        opportunities = [o for o in opportunities if not (math.isnan(o.score) or math.isnan(o.avg_confidence))]
        opportunities.sort(key=lambda o: o.score, reverse=True)

        log.info(
            "Opportunity scan complete: assets=%d opportunities=%d top=%s(%d)",
            len(by_asset), len(opportunities),
            opportunities[0].asset.symbol if opportunities else "none",
            opportunities[0].score if opportunities else 0,
        )
        return opportunities

    def select_portfolio(
        self,
        opportunities: list[Opportunity],
        max_positions: int = 10,
        min_score: int = 40,
        min_confidence: float = 0.55,
        diversify: bool = True,
    ) -> list[Opportunity]:
        """Select best opportunities with optional diversification."""
        candidates = [o for o in opportunities if o.score >= min_score and o.avg_confidence >= min_confidence]

        if not diversify:
            return candidates[:max_positions]

        selected: list[Opportunity] = []
        class_counts: dict[str, int] = {}

        class_opps: dict[str, int] = {}
        for c in candidates:
            cls = c.asset.asset_class.value
            class_opps[cls] = class_opps.get(cls, 0) + 1

        total_classes = len(class_opps)
        base_per_class = max(2, max_positions // total_classes) if total_classes > 0 else max_positions
        class_budget = {cls: base_per_class for cls in class_opps}

        # First pass: pick top from each class
        for opp in candidates:
            if len(selected) >= max_positions:
                break
            cls = opp.asset.asset_class.value
            count = class_counts.get(cls, 0)
            budget = class_budget.get(cls, base_per_class)
            if count < budget:
                selected.append(opp)
                class_counts[cls] = count + 1

        # Second pass: fill remaining
        if len(selected) < max_positions:
            selected_symbols = {s.asset.symbol for s in selected}
            for opp in candidates:
                if len(selected) >= max_positions:
                    break
                if opp.asset.symbol not in selected_symbols:
                    selected.append(opp)

        log.info(
            "Portfolio selection: candidates=%d selected=%d classes=%s",
            len(candidates), len(selected), class_counts,
        )
        return selected

    # ------------------------------------------------------------------
    # Scoring
    # ------------------------------------------------------------------

    def _calculate_score(
        self,
        avg_confidence: float,
        signal_count: int,
        total_strategies: int,
        momentum: float,
        volatility: float,
        volume_trend: float,
        action: str,
        macro: MacroEnvironment | None,
    ) -> int:
        # Confluence (0-25)
        confluence = (signal_count / total_strategies) * 25

        # Confidence (0-25)
        confidence = avg_confidence * 25

        # Momentum alignment (0-20)
        aligned = (action == "BUY" and momentum > 0) or (action == "SELL" and momentum < 0)
        momentum_score = abs(momentum) * 20 if aligned else abs(momentum) * 5

        # Volume (0-15)
        volume_score = min(15, volume_trend * 10)

        # Volatility sweet spot (0-15)
        if 0.005 < volatility < 0.05:
            vol_score = 15.0
        elif volatility >= 0.05:
            vol_score = max(0, 15 - (volatility - 0.05) * 200)
        else:
            vol_score = max(0, volatility * 2000)

        # Macro adjustment (-10 to +10)
        macro_adj = 0.0
        if macro:
            if action == "BUY" and macro.bias == "bullish":
                macro_adj = 5
            elif action == "BUY" and macro.bias == "bearish":
                macro_adj = -5
            elif action == "SELL" and macro.bias == "bearish":
                macro_adj = 5
            elif action == "SELL" and macro.bias == "bullish":
                macro_adj = -5

            if macro.risk_level == "extreme":
                macro_adj -= 10
            elif macro.risk_level == "high":
                macro_adj -= 5

        raw = confluence + confidence + momentum_score + volume_score + vol_score + macro_adj
        return max(0, min(100, round(raw)))

    # ------------------------------------------------------------------
    # Technical Metrics
    # ------------------------------------------------------------------

    @staticmethod
    def _calculate_momentum(candles: list[Candle]) -> float:
        if len(candles) < 20:
            return 0.0
        recent = candles[-20:]
        start = recent[0].close
        end = recent[-1].close
        roc = (end - start) / start
        return max(-1, min(1, roc * 10))

    @staticmethod
    def _calculate_volatility(candles: list[Candle]) -> float:
        if len(candles) < 15:
            return 0.0
        recent = candles[-15:]
        sum_tr = 0.0
        for i in range(1, len(recent)):
            tr = max(
                recent[i].high - recent[i].low,
                abs(recent[i].high - recent[i - 1].close),
                abs(recent[i].low - recent[i - 1].close),
            )
            sum_tr += tr
        atr = sum_tr / (len(recent) - 1)
        price = recent[-1].close
        return atr / price if price > 0 else 0.0

    @staticmethod
    def _calculate_volume_trend(candles: list[Candle]) -> float:
        if len(candles) < 20:
            return 1.0
        recent = candles[-10:]
        older = candles[-20:-10]
        recent_avg = sum(c.volume for c in recent) / len(recent)
        older_avg = sum(c.volume for c in older) / len(older)
        return recent_avg / older_avg if older_avg > 0 else 1.0

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _build_reason(signals: list[Signal], count: int, momentum: float, volume_trend: float) -> str:
        strategies = ", ".join(sorted({s.strategy for s in signals}))
        parts = [f"{count}/4 strategies agree ({strategies})"]
        if abs(momentum) > 0.3:
            parts.append(f"strong {'bullish' if momentum > 0 else 'bearish'} momentum")
        if volume_trend > 1.3:
            parts.append("rising volume")
        return " | ".join(parts)

    @staticmethod
    def format_report(opportunities: list[Opportunity]) -> str:
        if not opportunities:
            return "\nNo trading opportunities found."

        lines = ["\n=== OPPORTUNITY SCANNER — TOP TRADES ===\n"]
        lines.append("Rank | Asset        | Class  | Action | Score | Conf  | Strategies | Reason")
        lines.append("-----|--------------|--------|--------|-------|-------|------------|-------")

        for i, o in enumerate(opportunities):
            cls = o.asset.asset_class.value if hasattr(o.asset.asset_class, "value") else str(o.asset.asset_class)
            lines.append(
                f"{i + 1:>4} | "
                f"{o.asset.symbol:<12} | "
                f"{cls:<6} | "
                f"{o.action:<6} | "
                f"{o.score:>5} | "
                f"{o.avg_confidence * 100:>4.0f}% | "
                f"{o.signal_count:>10} | "
                f"{o.reason}"
            )

        by_class: dict[str, int] = {}
        for o in opportunities:
            cls = o.asset.asset_class.value if hasattr(o.asset.asset_class, "value") else str(o.asset.asset_class)
            by_class[cls] = by_class.get(cls, 0) + 1

        lines.append("")
        lines.append(f"Total opportunities: {len(opportunities)}")
        lines.append(f"By class: {', '.join(f'{c}={n}' for c, n in by_class.items())}")
        lines.append(f"Best opportunity: {opportunities[0].asset.symbol} (score {opportunities[0].score})")

        return "\n".join(lines)
