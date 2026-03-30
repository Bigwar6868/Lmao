"""Trade Filters — session, spread, news, cooldown, correlation, and equity curve filters.

Pre-trade filters that a good EA must have:
  1. Session filter — only trade during liquid hours (London/NY overlap)
  2. Spread filter — skip when spread is too wide (rollover, news)
  3. News filter — avoid trading around high-impact news events
  4. Cooldown — wait after a losing trade before re-entering same pair
  5. Max concurrent per pair — limit exposure to any single pair
  6. Correlation filter — don't stack correlated bets
  7. Daily loss limit — hard stop after losing X% in one day
  8. Equity curve filter — reduce size when equity curve trends down
  9. Recovery mode — scale down after drawdown
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone

from shared.types import (
    AssetInfo, AssetClass, Position, Portfolio, Signal, SignalAction, PositionStatus, Side,
)
from config.settings import config

log = logging.getLogger(__name__)


# ============================================================
# Session filter
# ============================================================

@dataclass
class SessionWindow:
    name: str
    start_hour: int  # UTC hour
    end_hour: int    # UTC hour
    quality: float   # 0-1, how good this session is for trading


# Forex session windows (UTC)
SESSIONS = [
    SessionWindow("asian", 0, 8, 0.5),        # Tokyo/Sydney — low liquidity
    SessionWindow("london", 7, 16, 0.9),       # London — best liquidity
    SessionWindow("new_york", 13, 22, 0.85),   # New York
    SessionWindow("overlap", 13, 16, 1.0),     # London/NY overlap — peak
    SessionWindow("dead_zone", 22, 0, 0.2),    # After NY close — avoid
]


def get_current_session() -> tuple[str, float]:
    """Get current trading session and its quality score."""
    now = datetime.now(timezone.utc)
    hour = now.hour

    # Check overlap first (highest priority)
    if 13 <= hour < 16:
        return "overlap", 1.0
    elif 7 <= hour < 16:
        return "london", 0.9
    elif 13 <= hour < 22:
        return "new_york", 0.85
    elif 0 <= hour < 8:
        return "asian", 0.5
    else:
        return "dead_zone", 0.2


def session_filter(asset: AssetInfo, min_quality: float = 0.4) -> tuple[bool, str]:
    """Check if current session is suitable for trading this asset.

    Crypto trades 24/7 (always allowed).
    Forex requires minimum session quality.
    """
    if asset.asset_class == AssetClass.CRYPTO:
        return True, "crypto-24/7"

    session, quality = get_current_session()
    if quality >= min_quality:
        return True, f"session={session} quality={quality:.1f}"
    return False, f"session={session} quality={quality:.1f} < {min_quality} (avoid low-liquidity)"


# ============================================================
# Spread filter
# ============================================================

# Typical acceptable spreads in pips per pair
MAX_SPREADS_PIPS: dict[str, float] = {
    "EUR/USD": 2.0, "GBP/USD": 3.0, "USD/JPY": 2.0, "USD/CHF": 2.5,
    "AUD/USD": 2.5, "USD/CAD": 3.0, "NZD/USD": 3.0,
    "EUR/GBP": 3.0, "EUR/JPY": 3.5, "GBP/JPY": 5.0, "EUR/CHF": 3.0,
    "AUD/JPY": 4.0, "EUR/AUD": 5.0, "GBP/AUD": 6.0, "CAD/JPY": 4.0,
    "USD/MXN": 50.0, "USD/ZAR": 80.0, "USD/TRY": 100.0,
    "USD/SGD": 5.0, "USD/HKD": 5.0,
}


def spread_filter(asset: AssetInfo, current_spread_pips: float | None = None) -> tuple[bool, str]:
    """Check if current spread is acceptable for this pair.

    If no live spread is available, we check the session quality as a proxy.
    """
    if asset.asset_class == AssetClass.CRYPTO:
        return True, "crypto-no-spread-check"

    if current_spread_pips is None:
        # No live spread data — use session quality as proxy
        _, quality = get_current_session()
        if quality < 0.3:
            return False, "no spread data + low-liquidity session"
        return True, "no spread data (assumed normal)"

    max_spread = MAX_SPREADS_PIPS.get(asset.symbol, 10.0)
    if current_spread_pips <= max_spread:
        return True, f"spread={current_spread_pips:.1f}pip <= {max_spread:.1f}"
    return False, f"spread={current_spread_pips:.1f}pip > {max_spread:.1f} (too wide)"


# ============================================================
# Cooldown after loss
# ============================================================

class CooldownTracker:
    """Track per-pair cooldown after losing trades."""

    def __init__(self, cooldown_seconds: int = 1800) -> None:
        self.cooldown_seconds = cooldown_seconds  # 30 min default
        self._last_loss: dict[str, float] = {}    # symbol → timestamp

    def record_loss(self, symbol: str) -> None:
        self._last_loss[symbol] = time.time()

    def is_cooled_down(self, symbol: str) -> tuple[bool, str]:
        last = self._last_loss.get(symbol)
        if last is None:
            return True, "no recent loss"
        elapsed = time.time() - last
        if elapsed >= self.cooldown_seconds:
            return True, f"cooldown elapsed ({elapsed:.0f}s)"
        remaining = self.cooldown_seconds - elapsed
        return False, f"cooldown: {remaining:.0f}s remaining after loss on {symbol}"


# ============================================================
# Max concurrent per pair
# ============================================================

def max_concurrent_filter(
    asset: AssetInfo,
    portfolio: Portfolio,
    max_per_pair: int = 2,
) -> tuple[bool, str]:
    """Limit number of concurrent positions on the same pair."""
    count = sum(
        1 for p in portfolio.positions
        if p.status == PositionStatus.OPEN and p.asset.symbol == asset.symbol
    )
    if count < max_per_pair:
        return True, f"{count}/{max_per_pair} positions on {asset.symbol}"
    return False, f"max {max_per_pair} concurrent positions on {asset.symbol} (have {count})"


# ============================================================
# Correlation filter
# ============================================================

# Highly correlated forex groups — don't stack same-direction bets
CORRELATION_GROUPS = [
    {"EUR/USD", "GBP/USD"},            # Both vs USD, same direction
    {"USD/CHF", "USD/CAD"},            # USD strength plays
    {"AUD/USD", "NZD/USD"},            # Oceanic — highly correlated
    {"EUR/JPY", "GBP/JPY", "AUD/JPY", "CAD/JPY"},  # Yen crosses
]


def correlation_filter(
    signal: Signal,
    portfolio: Portfolio,
    max_correlated: int = 2,
) -> tuple[bool, str]:
    """Don't stack too many same-direction bets on correlated pairs."""
    symbol = signal.asset.symbol
    direction = "long" if signal.action == SignalAction.BUY else "short"

    # Find which group this pair belongs to
    my_group = None
    for group in CORRELATION_GROUPS:
        if symbol in group:
            my_group = group
            break

    if my_group is None:
        return True, "no correlation group"

    # Count same-direction positions in the same group
    same_direction = 0
    for p in portfolio.positions:
        if p.status != PositionStatus.OPEN:
            continue
        if p.asset.symbol in my_group and p.asset.symbol != symbol:
            pos_dir = "long" if p.side == Side.BUY else "short"
            if pos_dir == direction:
                same_direction += 1

    if same_direction < max_correlated:
        return True, f"{same_direction} correlated {direction} positions (max {max_correlated})"
    return False, f"correlated: {same_direction} same-direction positions in group {my_group}"


# ============================================================
# Daily loss limit
# ============================================================

class DailyLossTracker:
    """Track daily P&L and enforce daily loss limit."""

    def __init__(self, max_daily_loss_pct: float = 3.0) -> None:
        self.max_daily_loss_pct = max_daily_loss_pct
        self._daily_pnl: float = 0.0
        self._day_start_capital: float = 0.0
        self._current_day: str = ""
        self._trades_today: int = 0

    def start_day(self, capital: float) -> None:
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        if today != self._current_day:
            self._current_day = today
            self._daily_pnl = 0.0
            self._day_start_capital = capital
            self._trades_today = 0
            log.info("Daily loss tracker reset: capital=$%.2f, max_loss=%.1f%%",
                     capital, self.max_daily_loss_pct)

    def record_trade_pnl(self, pnl: float) -> None:
        self._daily_pnl += pnl
        self._trades_today += 1

    def is_allowed(self, capital: float) -> tuple[bool, str]:
        self.start_day(capital)
        if self._day_start_capital <= 0:
            return True, "no starting capital tracked"

        daily_pnl_pct = (self._daily_pnl / self._day_start_capital) * 100
        if daily_pnl_pct > -self.max_daily_loss_pct:
            return True, f"daily PnL: {daily_pnl_pct:+.2f}% ({self._trades_today} trades)"
        return False, f"DAILY LOSS LIMIT: {daily_pnl_pct:.2f}% exceeds -{self.max_daily_loss_pct}% (halted)"

    def get_daily_pnl(self) -> float:
        return self._daily_pnl

    def get_trades_today(self) -> int:
        return self._trades_today


# ============================================================
# Equity curve filter
# ============================================================

class EquityCurveFilter:
    """Reduce position size when equity curve is below its moving average.

    If equity < EMA(equity), reduce size by scale_factor.
    This avoids compounding losses during losing streaks.
    """

    def __init__(self, ema_period: int = 20, scale_factor: float = 0.5) -> None:
        self.ema_period = ema_period
        self.scale_factor = scale_factor
        self._equity_history: list[float] = []
        self._ema: float = 0.0

    def update(self, equity: float) -> None:
        self._equity_history.append(equity)
        if len(self._equity_history) > 500:
            self._equity_history = self._equity_history[-500:]

        # Update EMA
        if len(self._equity_history) == 1:
            self._ema = equity
        else:
            k = 2 / (self.ema_period + 1)
            self._ema = equity * k + self._ema * (1 - k)

    def get_size_multiplier(self) -> tuple[float, str]:
        """Returns size multiplier (0.5 or 1.0) and reason."""
        if len(self._equity_history) < self.ema_period:
            return 1.0, "insufficient history"

        current = self._equity_history[-1]
        if current >= self._ema:
            return 1.0, f"equity ${current:.2f} >= EMA ${self._ema:.2f}"
        return self.scale_factor, f"equity ${current:.2f} < EMA ${self._ema:.2f} → {self.scale_factor}x size"


# ============================================================
# Recovery mode
# ============================================================

class RecoveryMode:
    """Scale down after drawdown, gradually restore as equity recovers.

    drawdown > 5% → 50% size
    drawdown > 10% → 25% size
    drawdown > 15% → 10% size (survival mode)
    """

    def __init__(self) -> None:
        self._peak_equity: float = 0.0

    def update(self, equity: float) -> None:
        if equity > self._peak_equity:
            self._peak_equity = equity

    def get_size_multiplier(self, equity: float) -> tuple[float, str]:
        self.update(equity)
        if self._peak_equity <= 0:
            return 1.0, "no peak tracked"

        drawdown_pct = ((self._peak_equity - equity) / self._peak_equity) * 100
        if drawdown_pct > 15:
            return 0.10, f"SURVIVAL: drawdown {drawdown_pct:.1f}% → 10% size"
        elif drawdown_pct > 10:
            return 0.25, f"RECOVERY: drawdown {drawdown_pct:.1f}% → 25% size"
        elif drawdown_pct > 5:
            return 0.50, f"CAUTION: drawdown {drawdown_pct:.1f}% → 50% size"
        return 1.0, f"drawdown {drawdown_pct:.1f}% (normal)"


# ============================================================
# Combined pre-trade filter
# ============================================================

class TradeFilterEngine:
    """Aggregates all pre-trade filters into a single check."""

    def __init__(self) -> None:
        self.cooldown = CooldownTracker(cooldown_seconds=1800)
        self.daily_loss = DailyLossTracker(max_daily_loss_pct=3.0)
        self.equity_curve = EquityCurveFilter(ema_period=20, scale_factor=0.5)
        self.recovery = RecoveryMode()
        self._filters_applied: dict[str, int] = {}  # filter_name → block count

        log.info("TradeFilterEngine initialised (session, spread, cooldown, "
                 "daily_loss, correlation, equity_curve, recovery)")

    def check(
        self,
        signal: Signal,
        portfolio: Portfolio,
        spread_pips: float | None = None,
        max_per_pair: int = 2,
    ) -> tuple[bool, float, str]:
        """Run all filters. Returns (allowed, size_multiplier, reason).

        size_multiplier is applied to recommended_size (e.g. 0.5 during recovery).
        """
        reasons = []

        # 1. Session filter
        ok, reason = session_filter(signal.asset)
        if not ok:
            self._count("session")
            return False, 0, reason

        # 2. Spread filter
        ok, reason = spread_filter(signal.asset, spread_pips)
        if not ok:
            self._count("spread")
            return False, 0, reason

        # 3. Daily loss limit
        ok, reason = self.daily_loss.is_allowed(portfolio.capital)
        if not ok:
            self._count("daily_loss")
            return False, 0, reason
        reasons.append(reason)

        # 4. Cooldown after loss
        ok, reason = self.cooldown.is_cooled_down(signal.asset.symbol)
        if not ok:
            self._count("cooldown")
            return False, 0, reason

        # 5. Max concurrent per pair
        ok, reason = max_concurrent_filter(signal.asset, portfolio, max_per_pair)
        if not ok:
            self._count("max_per_pair")
            return False, 0, reason

        # 6. Correlation filter
        ok, reason = correlation_filter(signal, portfolio)
        if not ok:
            self._count("correlation")
            return False, 0, reason

        # 7. Size multipliers
        size_mult = 1.0

        # Equity curve
        eq_mult, eq_reason = self.equity_curve.get_size_multiplier()
        size_mult *= eq_mult
        if eq_mult < 1.0:
            reasons.append(eq_reason)

        # Recovery mode
        rec_mult, rec_reason = self.recovery.get_size_multiplier(portfolio.capital)
        size_mult *= rec_mult
        if rec_mult < 1.0:
            reasons.append(rec_reason)

        return True, size_mult, " | ".join(reasons) if reasons else "all filters passed"

    def on_trade_closed(self, symbol: str, pnl: float) -> None:
        """Call when a trade is closed to update cooldown and daily loss."""
        self.daily_loss.record_trade_pnl(pnl)
        if pnl < 0:
            self.cooldown.record_loss(symbol)

    def on_cycle_end(self, equity: float) -> None:
        """Call at the end of each cycle to update equity trackers."""
        self.equity_curve.update(equity)
        self.recovery.update(equity)

    def _count(self, filter_name: str) -> None:
        self._filters_applied[filter_name] = self._filters_applied.get(filter_name, 0) + 1

    def get_filter_stats(self) -> dict[str, int]:
        return dict(self._filters_applied)

    def format_status(self, portfolio: Portfolio) -> str:
        session, quality = get_current_session()
        daily = self.daily_loss.get_daily_pnl()
        eq_mult, _ = self.equity_curve.get_size_multiplier()
        rec_mult, _ = self.recovery.get_size_multiplier(portfolio.capital)
        blocks = self._filters_applied

        return (
            f"Filters: session={session}({quality:.1f}) | daily_pnl=${daily:+.2f} | "
            f"eq_mult={eq_mult:.1f}x | rec_mult={rec_mult:.1f}x | "
            f"blocks={sum(blocks.values())} ({', '.join(f'{k}={v}' for k, v in blocks.items()) if blocks else 'none'})"
        )
