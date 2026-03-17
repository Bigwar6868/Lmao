"""Risk manager — Kelly criterion, ATR-based stops, position sizing."""

from __future__ import annotations

import logging
import math

from shared.types import (
    Candle, MarketData, Signal, SignalAction, RiskAssessment, Portfolio,
)
from shared.indicators import atr
from config.settings import config

log = logging.getLogger(__name__)


class RiskManager:
    """Manages risk assessment for trade signals."""

    def __init__(
        self,
        max_position_pct: float | None = None,
        kelly_fraction: float | None = None,
        stop_loss_atr: float | None = None,
        take_profit_atr: float | None = None,
    ) -> None:
        self.max_position_pct = max_position_pct or config.max_position_size_pct
        self.kelly_fraction = kelly_fraction or config.kelly_fraction
        self.stop_loss_atr = stop_loss_atr or config.default_stop_loss_atr
        self.take_profit_atr = take_profit_atr or config.default_take_profit_atr
        log.info("RiskManager initialised")

    def assess(
        self,
        signal: Signal,
        market_data: MarketData,
        portfolio: Portfolio,
        win_rate: float = 0.5,
        avg_win: float = 1.0,
        avg_loss: float = 1.0,
    ) -> RiskAssessment:
        """Assess risk for a trading signal.

        Args:
            signal: The trading signal to assess
            market_data: Current market data for the asset
            portfolio: Current portfolio state
            win_rate: Historical win rate for this strategy
            avg_win: Average winning trade return
            avg_loss: Average losing trade return

        Returns:
            RiskAssessment with position sizing and stop levels.
        """
        if signal.action == SignalAction.HOLD:
            return RiskAssessment(
                max_position_size=0, recommended_size=0,
                stop_loss_price=0, take_profit_price=0,
                risk_reward_ratio=0, kelly_fraction=0,
                approved=False, reason="HOLD signal — no trade",
            )

        candles = market_data.candles
        price = signal.price

        # Calculate ATR for stop placement
        atr_vals = atr(candles, 14)
        current_atr = atr_vals[-1] if atr_vals[-1] is not None else price * 0.02

        # Stop loss and take profit
        if signal.action == SignalAction.BUY:
            stop_loss = price - (current_atr * self.stop_loss_atr)
            take_profit = price + (current_atr * self.take_profit_atr)
        else:
            stop_loss = price + (current_atr * self.stop_loss_atr)
            take_profit = price - (current_atr * self.take_profit_atr)

        # Risk/reward ratio
        risk = abs(price - stop_loss)
        reward = abs(take_profit - price)
        risk_reward = reward / risk if risk > 0 else 0

        # Kelly criterion
        if avg_loss > 0:
            b = avg_win / avg_loss  # Win/loss ratio
            kelly = (win_rate * b - (1 - win_rate)) / b if b > 0 else 0
        else:
            kelly = 0

        kelly = max(kelly, 0) * self.kelly_fraction  # Half-Kelly

        # Max position size based on portfolio
        max_size = portfolio.available_capital * (self.max_position_pct / 100)

        # Kelly-based position size
        kelly_size = portfolio.available_capital * kelly

        # Use the smaller of max and Kelly
        recommended = min(max_size, kelly_size) if kelly > 0 else max_size * 0.5

        # Check drawdown limit
        drawdown_pct = (portfolio.max_drawdown / portfolio.capital * 100) if portfolio.capital > 0 else 0
        if drawdown_pct > config.max_drawdown_pct:
            return RiskAssessment(
                max_position_size=max_size, recommended_size=0,
                stop_loss_price=stop_loss, take_profit_price=take_profit,
                risk_reward_ratio=risk_reward, kelly_fraction=kelly,
                approved=False, reason=f"Max drawdown exceeded ({drawdown_pct:.1f}%)",
            )

        # Minimum confidence check
        if signal.confidence < 0.4:
            return RiskAssessment(
                max_position_size=max_size, recommended_size=0,
                stop_loss_price=stop_loss, take_profit_price=take_profit,
                risk_reward_ratio=risk_reward, kelly_fraction=kelly,
                approved=False, reason=f"Low confidence ({signal.confidence:.2f})",
            )

        # Minimum risk/reward check
        if risk_reward < 1.0:
            return RiskAssessment(
                max_position_size=max_size, recommended_size=recommended * 0.5,
                stop_loss_price=stop_loss, take_profit_price=take_profit,
                risk_reward_ratio=risk_reward, kelly_fraction=kelly,
                approved=True, reason=f"Low R:R ({risk_reward:.2f}) — reduced size",
            )

        return RiskAssessment(
            max_position_size=max_size,
            recommended_size=recommended,
            stop_loss_price=stop_loss,
            take_profit_price=take_profit,
            risk_reward_ratio=risk_reward,
            kelly_fraction=kelly,
            approved=True,
            reason="Risk approved",
        )
