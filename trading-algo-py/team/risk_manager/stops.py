"""Advanced Stop Management — trailing stop, break-even, partial close.

  1. Trailing stop — moves SL in the direction of profit
  2. Break-even stop — moves SL to entry after X pips profit
  3. Partial close — close 50% at TP1, let rest run to TP2
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from shared.types import Position, Side, PositionStatus
from shared.indicators import atr as calc_atr

log = logging.getLogger(__name__)


@dataclass
class StopUpdate:
    """Result of a stop check — new SL/TP or partial close."""
    position_id: str
    new_stop_loss: float | None = None
    new_take_profit: float | None = None
    partial_close_pct: float = 0.0      # 0-1, fraction to close
    partial_close_price: float = 0.0
    reason: str = ""


class AdvancedStopManager:
    """Manages trailing stops, break-even, and partial closes for all positions.

    All thresholds are in ATR multiples (adaptive to volatility).
    """

    def __init__(
        self,
        trailing_start_atr: float = 1.5,   # Start trailing after 1.5x ATR profit
        trailing_step_atr: float = 0.5,     # Trail by 0.5x ATR
        breakeven_trigger_atr: float = 1.0, # Move to BE after 1x ATR profit
        breakeven_offset_pips: float = 2.0, # Lock in 2 pips above entry
        partial_close_at_atr: float = 2.0,  # Partial close at 2x ATR
        partial_close_pct: float = 0.5,     # Close 50%
    ) -> None:
        self.trailing_start = trailing_start_atr
        self.trailing_step = trailing_step_atr
        self.breakeven_trigger = breakeven_trigger_atr
        self.breakeven_offset = breakeven_offset_pips
        self.partial_close_at = partial_close_at_atr
        self.partial_close_pct = partial_close_pct

        # Track which positions have had break-even and partial close applied
        self._breakeven_applied: set[str] = set()
        self._partial_closed: set[str] = set()

        log.info(
            "AdvancedStopManager: trail_start=%.1fATR trail_step=%.1fATR "
            "BE=%.1fATR partial=%.0f%%@%.1fATR",
            trailing_start_atr, trailing_step_atr,
            breakeven_trigger_atr, partial_close_pct * 100, partial_close_at_atr,
        )

    def check_position(self, pos: Position, current_atr: float) -> StopUpdate | None:
        """Check if a position needs stop updates.

        Priority: 1) Partial close  2) Break-even  3) Trailing stop

        Args:
            pos: Open position
            current_atr: Current ATR value for this asset

        Returns StopUpdate if action needed, None if no change.
        """
        if pos.status != PositionStatus.OPEN or current_atr <= 0:
            return None

        price = pos.current_price
        entry = pos.entry_price

        # Calculate profit in ATR units
        if pos.side == Side.BUY:
            profit_atr = (price - entry) / current_atr
        else:
            profit_atr = (entry - price) / current_atr

        if profit_atr <= 0:
            return None  # Only manage winning positions

        # 1. Partial close check (one-time, at 2x ATR profit)
        if pos.id not in self._partial_closed and profit_atr >= self.partial_close_at:
            self._partial_closed.add(pos.id)
            return StopUpdate(
                position_id=pos.id,
                partial_close_pct=self.partial_close_pct,
                partial_close_price=price,
                reason=f"Partial close {self.partial_close_pct:.0%} at {profit_atr:.1f}x ATR profit",
            )

        # 2. Break-even check (one-time, at 1x ATR profit)
        if pos.id not in self._breakeven_applied and profit_atr >= self.breakeven_trigger:
            self._breakeven_applied.add(pos.id)
            # Move SL to entry + small offset (lock in 2 pips)
            pip_value = _pip_value(pos.asset.symbol)
            if pos.side == Side.BUY:
                new_sl = entry + (self.breakeven_offset * pip_value)
            else:
                new_sl = entry - (self.breakeven_offset * pip_value)

            # Only move SL if it's better than current
            if pos.stop_loss is None or _is_better_sl(pos.side, new_sl, pos.stop_loss):
                return StopUpdate(
                    position_id=pos.id,
                    new_stop_loss=new_sl,
                    reason=f"Break-even: SL → {new_sl:.5f} (+{self.breakeven_offset:.0f}pip offset)",
                )

        # 3. Trailing stop (continuous, after 1.5x ATR profit)
        if profit_atr >= self.trailing_start:
            trail_distance = current_atr * self.trailing_step
            if pos.side == Side.BUY:
                new_sl = price - trail_distance
            else:
                new_sl = price + trail_distance

            # Only tighten, never loosen
            if pos.stop_loss is None or _is_better_sl(pos.side, new_sl, pos.stop_loss):
                return StopUpdate(
                    position_id=pos.id,
                    new_stop_loss=new_sl,
                    reason=f"Trail: SL → {new_sl:.5f} ({profit_atr:.1f}x ATR profit, trail={self.trailing_step:.1f}ATR)",
                )

        return None

    def check_all(self, positions: list[Position], atr_map: dict[str, float]) -> list[StopUpdate]:
        """Check all positions for stop updates."""
        updates = []
        for pos in positions:
            if pos.status != PositionStatus.OPEN:
                continue
            atr_val = atr_map.get(pos.asset.symbol)
            if atr_val is None or atr_val <= 0:
                continue
            update = self.check_position(pos, atr_val)
            if update:
                updates.append(update)
        return updates

    def on_position_closed(self, position_id: str) -> None:
        """Clean up tracking when a position is closed."""
        self._breakeven_applied.discard(position_id)
        self._partial_closed.discard(position_id)


def _pip_value(symbol: str) -> float:
    """Get pip value for a symbol."""
    if "JPY" in symbol:
        return 0.01
    return 0.0001


def _is_better_sl(side: Side, new_sl: float, old_sl: float) -> bool:
    """Check if new SL is tighter (better) than old SL."""
    if side == Side.BUY:
        return new_sl > old_sl  # Higher SL is tighter for longs
    return new_sl < old_sl      # Lower SL is tighter for shorts
