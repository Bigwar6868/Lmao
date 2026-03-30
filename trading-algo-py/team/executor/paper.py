"""Paper trading engine — simulates order execution with margin tracking."""

from __future__ import annotations

import logging
import time
import uuid

from shared.types import (
    Signal, SignalAction, RiskAssessment, Order, Position, Portfolio,
    Side, OrderType, OrderStatus, PositionStatus,
)
from shared.events import event_bus
from team.risk_manager.margin import MarginManager, get_pair_leverage

log = logging.getLogger(__name__)


class PaperTrader:
    """Simulates trade execution with slippage, commission, and margin tracking."""

    def __init__(
        self,
        initial_capital: float = 10_000,
        slippage: float = 0.0005,
        commission: float = 0.001,
        max_open_positions: int = 10,
    ) -> None:
        self.initial_capital = initial_capital
        self.available_capital = initial_capital
        self.slippage = slippage
        self.commission = commission
        self.max_open = max_open_positions

        self.positions: list[Position] = []
        self.closed_positions: list[Position] = []
        self.orders: list[Order] = []
        self.peak_equity = initial_capital
        self.max_drawdown = 0.0
        self.margin_manager = MarginManager()

        log.info("PaperTrader initialised ($%.2f capital)", initial_capital)

    def execute_trade(self, signal: Signal, risk: RiskAssessment) -> dict:
        """Execute a paper trade based on signal and risk assessment."""
        if signal.action == SignalAction.HOLD:
            return {"success": False, "error": "HOLD signal"}

        if not risk.approved:
            return {"success": False, "error": risk.reason}

        open_count = sum(1 for p in self.positions if p.status == PositionStatus.OPEN)
        if open_count >= self.max_open:
            return {"success": False, "error": f"Max positions reached ({self.max_open})"}

        # Calculate position size
        quantity = risk.recommended_size / signal.price if signal.price > 0 else 0
        if quantity <= 0:
            return {"success": False, "error": "Position size too small"}

        # Apply slippage
        if signal.action == SignalAction.BUY:
            fill_price = signal.price * (1 + self.slippage)
            side = Side.BUY
        else:
            fill_price = signal.price * (1 - self.slippage)
            side = Side.SELL

        # Leverage & margin calculation
        leverage = get_pair_leverage(signal.asset)
        notional = quantity * fill_price
        margin_req = notional / leverage

        # Commission
        commission_cost = notional * self.commission
        total_cost = margin_req + commission_cost  # Only margin + commission locked (not full notional)

        # Margin check
        portfolio = self.get_portfolio()
        margin_check = self.margin_manager.check_margin(
            signal.asset, quantity, fill_price, portfolio,
        )
        if not margin_check.allowed:
            return {"success": False, "error": f"Margin: {margin_check.reason}"}

        if total_cost > self.available_capital:
            return {"success": False, "error": f"Insufficient free margin: need ${total_cost:.2f}, have ${self.available_capital:.2f}"}

        # Create order
        order = Order(
            id=str(uuid.uuid4())[:8],
            asset=signal.asset,
            side=side,
            type=OrderType.MARKET,
            quantity=quantity,
            strategy=signal.strategy,
            price=signal.price,
            status=OrderStatus.FILLED,
            filled_price=fill_price,
            filled_quantity=quantity,
            created_at=int(time.time() * 1000),
            filled_at=int(time.time() * 1000),
        )
        self.orders.append(order)

        # Create position with margin tracking
        position = Position(
            id=str(uuid.uuid4())[:8],
            asset=signal.asset,
            side=side,
            entry_price=fill_price,
            current_price=fill_price,
            quantity=quantity,
            strategy=signal.strategy,
            stop_loss=risk.stop_loss_price,
            take_profit=risk.take_profit_price,
            opened_at=int(time.time() * 1000),
            leverage=leverage,
            margin_required=margin_req,
            notional_value=notional,
        )
        self.positions.append(position)
        self.available_capital -= total_cost

        event_bus.emit("order:filled", order, "PaperTrader")
        event_bus.emit("position:opened", position, "PaperTrader")

        log.info(
            "%s %s %.4f @ %.5f (SL=%.5f, TP=%.5f)",
            side.value.upper(), signal.asset.symbol, quantity, fill_price,
            risk.stop_loss_price, risk.take_profit_price,
        )

        return {"success": True, "order": order, "position": position, "portfolio": self.get_portfolio()}

    def update_prices(self, prices: dict[str, float]) -> None:
        """Update current prices for all open positions."""
        for pos in self.positions:
            if pos.status == PositionStatus.OPEN and pos.asset.symbol in prices:
                pos.current_price = prices[pos.asset.symbol]
                if pos.side == Side.BUY:
                    pos.unrealized_pnl = (pos.current_price - pos.entry_price) * pos.quantity
                else:
                    pos.unrealized_pnl = (pos.entry_price - pos.current_price) * pos.quantity

    def check_stops(self, prices: dict[str, float]) -> list[Position]:
        """Check stop loss and take profit levels."""
        self.update_prices(prices)
        closed: list[Position] = []

        for pos in self.positions:
            if pos.status != PositionStatus.OPEN:
                continue

            price = pos.current_price
            hit_sl = pos.stop_loss and (
                (pos.side == Side.BUY and price <= pos.stop_loss) or
                (pos.side == Side.SELL and price >= pos.stop_loss)
            )
            hit_tp = pos.take_profit and (
                (pos.side == Side.BUY and price >= pos.take_profit) or
                (pos.side == Side.SELL and price <= pos.take_profit)
            )

            if hit_sl or hit_tp:
                self._close_position(pos, price, "stop_loss" if hit_sl else "take_profit")
                closed.append(pos)

        return closed

    def _close_position(self, pos: Position, price: float, reason: str) -> None:
        """Close a position at the given price."""
        pos.current_price = price
        if pos.side == Side.BUY:
            pos.realized_pnl = (price - pos.entry_price) * pos.quantity
        else:
            pos.realized_pnl = (pos.entry_price - price) * pos.quantity

        commission = price * pos.quantity * self.commission
        pos.realized_pnl -= commission

        pos.unrealized_pnl = 0
        pos.status = PositionStatus.CLOSED
        pos.closed_at = int(time.time() * 1000)

        # Release margin + return PnL (margin was locked, not full notional)
        self.available_capital += pos.margin_required + pos.realized_pnl
        self.closed_positions.append(pos)

        event_bus.emit("position:closed", pos, "PaperTrader")
        log.info("Closed %s %s @ %.5f (%s, PnL=%.2f)",
                 pos.side.value, pos.asset.symbol, price, reason, pos.realized_pnl)

    def get_portfolio(self) -> Portfolio:
        """Get current portfolio state with margin tracking."""
        open_positions = [p for p in self.positions if p.status == PositionStatus.OPEN]

        # Update notional values for open positions
        for p in open_positions:
            p.notional_value = p.current_price * p.quantity

        margin_used = sum(p.margin_required for p in open_positions)
        total_notional = sum(p.notional_value for p in open_positions)
        unrealized = sum(p.unrealized_pnl for p in open_positions)
        realized = sum(p.realized_pnl for p in self.closed_positions)
        total_pnl = unrealized + realized

        # Equity = available cash + margin locked + unrealized PnL
        equity = self.available_capital + margin_used + unrealized
        margin_available = max(0, equity - margin_used)
        margin_level = (equity / margin_used * 100) if margin_used > 0 else 0.0
        effective_leverage = total_notional / equity if equity > 0 else 0.0

        # Track drawdown
        if equity > self.peak_equity:
            self.peak_equity = equity
        drawdown = self.peak_equity - equity
        if drawdown > self.max_drawdown:
            self.max_drawdown = drawdown

        portfolio = Portfolio(
            capital=equity,
            available_capital=self.available_capital,
            positions=open_positions,
            total_pnl=total_pnl,
            total_pnl_pct=(total_pnl / self.initial_capital) * 100,
            max_drawdown=self.max_drawdown,
            last_updated=int(time.time() * 1000),
            margin_used=margin_used,
            margin_available=margin_available,
            margin_level_pct=margin_level,
            total_leverage=effective_leverage,
            total_notional=total_notional,
        )

        # Check stop-out
        stop_out = self.margin_manager.get_stop_out_positions(portfolio)
        if stop_out:
            for pos in stop_out[:1]:  # Close worst position
                self._close_position(pos, pos.current_price, "margin_stop_out")
                log.warning("MARGIN STOP-OUT: force-closed %s %s", pos.side.value, pos.asset.symbol)
            return self.get_portfolio()  # Recalculate after close

        return portfolio

    def get_order_history(self) -> list[Order]:
        return list(self.orders)

    def get_summary(self) -> str:
        p = self.get_portfolio()
        wins = sum(1 for pos in self.closed_positions if pos.realized_pnl > 0)
        losses = sum(1 for pos in self.closed_positions if pos.realized_pnl <= 0)
        total = wins + losses
        win_rate = (wins / total * 100) if total > 0 else 0
        margin_str = self.margin_manager.get_margin_summary(p)
        return (
            f"Portfolio: ${p.capital:.2f} | PnL: ${p.total_pnl:.2f} ({p.total_pnl_pct:.1f}%) | "
            f"Open: {len(p.positions)} | Closed: {total} | WR: {win_rate:.0f}% | DD: ${p.max_drawdown:.2f}\n"
            f"  {margin_str}"
        )
