"""Margin Manager — tracks margin usage, enforces leverage limits, prevents margin calls.

Forex margin rules:
  - Margin required = notional_value / leverage
  - Margin level = (equity / margin_used) * 100%
  - Margin call: margin_level < 50% (configurable) → halt new trades
  - Stop-out: margin_level < 30% (configurable) → force-close largest loser
  - Max margin usage: don't open new trades if margin_used > 80% of equity

Leverage tiers (per asset class):
  - Forex majors: up to 1:30 (EU) or 1:50 (non-EU)
  - Forex minors/crosses: up to 1:20
  - Forex exotics: up to 1:10
  - Crypto: 1:2 (regulated) or 1:5 (unregulated)
  - Configurable per-pair via PER_PAIR_LEVERAGE env var
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from shared.types import (
    AssetClass, AssetInfo, Position, Portfolio, PositionStatus, Side,
)
from config.settings import config

log = logging.getLogger(__name__)


# ============================================================
# Leverage classification
# ============================================================

# Default leverage by pair type
FOREX_MAJOR_PAIRS = {
    "EUR/USD", "GBP/USD", "USD/JPY", "USD/CHF", "AUD/USD", "USD/CAD", "NZD/USD",
}
FOREX_CROSS_PAIRS = {
    "EUR/GBP", "EUR/JPY", "GBP/JPY", "EUR/CHF", "AUD/JPY",
    "EUR/AUD", "GBP/AUD", "CAD/JPY",
}
FOREX_EXOTIC_PAIRS = {
    "USD/MXN", "USD/ZAR", "USD/TRY", "USD/SGD", "USD/HKD",
}


def get_pair_leverage(asset: AssetInfo) -> float:
    """Get leverage for a specific pair, respecting per-pair overrides and asset class defaults."""
    # Per-pair override from config (e.g. "EUR/USD:50,GBP/JPY:20")
    per_pair = _parse_per_pair_leverage()
    if asset.symbol in per_pair:
        return min(per_pair[asset.symbol], config.max_leverage)

    # Asset class defaults
    if asset.asset_class == AssetClass.CRYPTO:
        return min(2.0, config.max_leverage)

    # Forex tiers
    if asset.symbol in FOREX_MAJOR_PAIRS:
        return min(config.default_leverage, config.max_leverage)
    elif asset.symbol in FOREX_CROSS_PAIRS:
        return min(config.default_leverage * 0.67, config.max_leverage)  # ~1:20 if default=30
    elif asset.symbol in FOREX_EXOTIC_PAIRS:
        return min(config.default_leverage * 0.33, config.max_leverage)  # ~1:10 if default=30
    else:
        return min(config.default_leverage * 0.5, config.max_leverage)


def _parse_per_pair_leverage() -> dict[str, float]:
    """Parse PER_PAIR_LEVERAGE env var: 'EUR/USD:50,GBP/JPY:20'"""
    raw = config.per_pair_leverage
    if not raw:
        return {}
    result = {}
    for pair in raw.split(","):
        parts = pair.strip().split(":")
        if len(parts) == 2:
            try:
                result[parts[0].strip()] = float(parts[1].strip())
            except ValueError:
                pass
    return result


# ============================================================
# Margin calculations
# ============================================================

@dataclass
class MarginCheck:
    """Result of a margin pre-trade check."""
    allowed: bool
    margin_required: float       # Margin this trade would lock
    notional_value: float        # Full notional value
    leverage: float              # Leverage applied
    margin_after: float          # Margin used after this trade
    margin_level_after: float    # Margin level % after this trade
    margin_usage_after: float    # Margin usage % after this trade
    reason: str = ""


class MarginManager:
    """Tracks and enforces margin across all positions.

    Responsibilities:
    1. Calculate margin required per trade (notional / leverage)
    2. Track total margin used across all open positions
    3. Block new trades if margin usage > max_margin_usage_pct
    4. Emit margin call alert if margin_level < margin_call_level
    5. Force-close positions if margin_level < margin_stop_out_level
    """

    def __init__(self) -> None:
        self.margin_call_level = config.margin_call_level      # 50%
        self.stop_out_level = config.margin_stop_out_level      # 30%
        self.max_margin_usage = config.max_margin_usage_pct     # 80%
        self._margin_call_active = False
        self._total_margin_used = 0.0

        log.info(
            "MarginManager initialised | default_leverage=1:%.0f | max=1:%.0f | "
            "margin_call=%.0f%% | stop_out=%.0f%% | max_usage=%.0f%%",
            config.default_leverage, config.max_leverage,
            self.margin_call_level, self.stop_out_level, self.max_margin_usage,
        )

    # ----------------------------------------------------------------
    # Pre-trade margin check
    # ----------------------------------------------------------------

    def check_margin(
        self,
        asset: AssetInfo,
        quantity: float,
        price: float,
        portfolio: Portfolio,
    ) -> MarginCheck:
        """Check if a new trade can be opened within margin limits.

        Args:
            asset: The asset to trade
            quantity: Number of units
            price: Entry price
            portfolio: Current portfolio state

        Returns:
            MarginCheck with allowed/denied and details
        """
        leverage = get_pair_leverage(asset)
        notional = quantity * price
        margin_req = notional / leverage

        # Current margin state
        equity = portfolio.capital
        current_margin = self._calc_margin_used(portfolio)
        margin_after = current_margin + margin_req

        # Margin level after trade (equity / margin_used * 100)
        margin_level_after = (equity / margin_after * 100) if margin_after > 0 else float("inf")

        # Margin usage after trade (margin_used / equity * 100)
        margin_usage_after = (margin_after / equity * 100) if equity > 0 else 100.0

        # Check 1: Margin call already active
        if self._margin_call_active:
            return MarginCheck(
                allowed=False, margin_required=margin_req, notional_value=notional,
                leverage=leverage, margin_after=margin_after,
                margin_level_after=margin_level_after, margin_usage_after=margin_usage_after,
                reason=f"MARGIN CALL ACTIVE — no new trades (margin level {margin_level_after:.0f}%)",
            )

        # Check 2: Would exceed max margin usage
        if margin_usage_after > self.max_margin_usage:
            return MarginCheck(
                allowed=False, margin_required=margin_req, notional_value=notional,
                leverage=leverage, margin_after=margin_after,
                margin_level_after=margin_level_after, margin_usage_after=margin_usage_after,
                reason=f"Margin usage {margin_usage_after:.0f}% exceeds max {self.max_margin_usage:.0f}%",
            )

        # Check 3: Would drop below margin call level
        if margin_level_after < self.margin_call_level:
            return MarginCheck(
                allowed=False, margin_required=margin_req, notional_value=notional,
                leverage=leverage, margin_after=margin_after,
                margin_level_after=margin_level_after, margin_usage_after=margin_usage_after,
                reason=f"Margin level would drop to {margin_level_after:.0f}% (call at {self.margin_call_level:.0f}%)",
            )

        # Check 4: Sufficient free margin
        free_margin = equity - current_margin
        if margin_req > free_margin:
            return MarginCheck(
                allowed=False, margin_required=margin_req, notional_value=notional,
                leverage=leverage, margin_after=margin_after,
                margin_level_after=margin_level_after, margin_usage_after=margin_usage_after,
                reason=f"Insufficient free margin: need ${margin_req:.2f}, have ${free_margin:.2f}",
            )

        return MarginCheck(
            allowed=True, margin_required=margin_req, notional_value=notional,
            leverage=leverage, margin_after=margin_after,
            margin_level_after=margin_level_after, margin_usage_after=margin_usage_after,
            reason=f"OK (leverage 1:{leverage:.0f}, margin ${margin_req:.2f}, usage {margin_usage_after:.0f}%)",
        )

    # ----------------------------------------------------------------
    # Margin monitoring
    # ----------------------------------------------------------------

    def update_margin_state(self, portfolio: Portfolio) -> Portfolio:
        """Recalculate and update margin fields on the portfolio."""
        equity = portfolio.capital
        margin_used = self._calc_margin_used(portfolio)
        total_notional = sum(
            p.current_price * p.quantity
            for p in portfolio.positions
            if p.status == PositionStatus.OPEN
        )

        margin_available = max(0, equity - margin_used)
        margin_level = (equity / margin_used * 100) if margin_used > 0 else float("inf")
        effective_leverage = total_notional / equity if equity > 0 else 0

        portfolio.margin_used = margin_used
        portfolio.margin_available = margin_available
        portfolio.margin_level_pct = margin_level
        portfolio.total_leverage = effective_leverage
        portfolio.total_notional = total_notional

        # Check for margin call
        was_in_call = self._margin_call_active
        if margin_used > 0 and margin_level < self.margin_call_level:
            self._margin_call_active = True
            if not was_in_call:
                log.warning(
                    "MARGIN CALL: level=%.0f%% (threshold=%.0f%%) | used=$%.2f | equity=$%.2f",
                    margin_level, self.margin_call_level, margin_used, equity,
                )
        elif self._margin_call_active and margin_level > self.margin_call_level * 1.1:
            # Release margin call only when 10% above threshold (hysteresis)
            self._margin_call_active = False
            log.info("Margin call cleared: level=%.0f%%", margin_level)

        self._total_margin_used = margin_used
        return portfolio

    def get_stop_out_positions(self, portfolio: Portfolio) -> list[Position]:
        """If margin level < stop_out, return positions to force-close (worst PnL first)."""
        equity = portfolio.capital
        margin_used = self._calc_margin_used(portfolio)
        if margin_used <= 0:
            return []

        margin_level = (equity / margin_used * 100)
        if margin_level >= self.stop_out_level:
            return []

        log.warning(
            "STOP OUT TRIGGERED: margin level=%.0f%% < %.0f%% | closing worst positions",
            margin_level, self.stop_out_level,
        )

        # Sort open positions by unrealized PnL (worst first)
        open_positions = [
            p for p in portfolio.positions if p.status == PositionStatus.OPEN
        ]
        return sorted(open_positions, key=lambda p: p.unrealized_pnl)

    def is_margin_call(self) -> bool:
        return self._margin_call_active

    # ----------------------------------------------------------------
    # Helpers
    # ----------------------------------------------------------------

    def _calc_margin_used(self, portfolio: Portfolio) -> float:
        """Sum margin_required across all open positions."""
        return sum(
            p.margin_required
            for p in portfolio.positions
            if p.status == PositionStatus.OPEN
        )

    def get_margin_summary(self, portfolio: Portfolio) -> str:
        """Format margin state for display."""
        equity = portfolio.capital
        margin_used = self._calc_margin_used(portfolio)
        free = max(0, equity - margin_used)
        level = (equity / margin_used * 100) if margin_used > 0 else 0
        total_notional = sum(
            p.current_price * p.quantity
            for p in portfolio.positions
            if p.status == PositionStatus.OPEN
        )
        eff_leverage = total_notional / equity if equity > 0 else 0

        call_flag = " *** MARGIN CALL ***" if self._margin_call_active else ""

        return (
            f"Margin: used=${margin_used:.2f} | free=${free:.2f} | "
            f"level={level:.0f}% | leverage=1:{eff_leverage:.1f} | "
            f"notional=${total_notional:.2f}{call_flag}"
        )

    def format_position_margin(self, positions: list[Position]) -> str:
        """Show margin breakdown per position."""
        lines = []
        for p in positions:
            if p.status != PositionStatus.OPEN:
                continue
            lines.append(
                f"  {p.asset.symbol:<12} {p.side.value:>4} | "
                f"notional=${p.notional_value:>10.2f} | "
                f"margin=${p.margin_required:>8.2f} | "
                f"leverage=1:{p.leverage:.0f} | "
                f"PnL=${p.unrealized_pnl:>+8.2f}"
            )
        return "\n".join(lines) if lines else "  (no open positions)"
