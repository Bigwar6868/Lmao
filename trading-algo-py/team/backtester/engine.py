"""Backtesting engine — tests strategies against historical data."""

from __future__ import annotations

import logging
import math
import time
import uuid

from shared.types import (
    AssetInfo, Candle, MarketData, Signal, SignalAction,
    Order, Side, OrderType, OrderStatus,
    PerformanceMetrics, BacktestResult, StrategyDNA,
)
from team.technical_strategist.strategies import BaseStrategy

log = logging.getLogger(__name__)


class Backtester:
    """Runs strategy backtests on historical candle data."""

    def __init__(
        self,
        initial_capital: float = 10_000,
        commission: float = 0.001,
        slippage: float = 0.0005,
        position_size_pct: float = 5.0,
    ) -> None:
        self.initial_capital = initial_capital
        self.commission = commission
        self.slippage = slippage
        self.position_size_pct = position_size_pct

    def run(
        self,
        strategy: BaseStrategy,
        market_data: MarketData,
        min_candles: int = 30,
    ) -> BacktestResult:
        """Run a backtest for a strategy on the given market data.

        Walks forward through candles, feeding growing windows to the strategy.
        """
        candles = market_data.candles
        if len(candles) < min_candles:
            return BacktestResult(
                strategy=strategy.config.name,
                metrics=PerformanceMetrics(),
                dna=strategy.dna,
            )

        capital = self.initial_capital
        peak = capital
        max_dd = 0.0
        trades: list[Order] = []
        equity_curve: list[dict] = []
        position: dict | None = None  # {side, entry_price, quantity, stop_loss, take_profit}

        for i in range(min_candles, len(candles)):
            window = candles[:i + 1]
            current = candles[i]
            price = current.close

            # Check stops on open position
            if position is not None:
                hit_sl = position.get("stop_loss") and (
                    (position["side"] == "buy" and current.low <= position["stop_loss"]) or
                    (position["side"] == "sell" and current.high >= position["stop_loss"])
                )
                hit_tp = position.get("take_profit") and (
                    (position["side"] == "buy" and current.high >= position["take_profit"]) or
                    (position["side"] == "sell" and current.low <= position["take_profit"])
                )

                if hit_sl or hit_tp:
                    exit_price = position["stop_loss"] if hit_sl else position["take_profit"]
                    pnl = self._calc_pnl(position, exit_price)
                    capital += pnl
                    trades.append(self._make_trade(
                        market_data.asset, position, exit_price, "sl" if hit_sl else "tp",
                    ))
                    position = None

            # Run strategy on window
            window_data = MarketData(
                asset=market_data.asset,
                timeframe=market_data.timeframe,
                candles=window,
                last_updated=current.timestamp,
            )

            try:
                signals = strategy.analyze(window_data)
            except Exception:
                continue

            for signal in signals:
                if signal.action == SignalAction.HOLD:
                    continue

                if signal.action == SignalAction.BUY and position is None:
                    entry = price * (1 + self.slippage)
                    qty = (capital * self.position_size_pct / 100) / entry
                    from shared.indicators import atr as calc_atr
                    atr_vals = calc_atr(window, 14)
                    atr_val = atr_vals[-1] if atr_vals[-1] else price * 0.02
                    position = {
                        "side": "buy", "entry_price": entry, "quantity": qty,
                        "stop_loss": entry - atr_val * 2,
                        "take_profit": entry + atr_val * 3,
                    }
                    capital -= entry * qty * (1 + self.commission)

                elif signal.action == SignalAction.SELL and position is not None and position["side"] == "buy":
                    exit_price = price * (1 - self.slippage)
                    pnl = self._calc_pnl(position, exit_price)
                    capital += pnl
                    trades.append(self._make_trade(market_data.asset, position, exit_price, "signal"))
                    position = None

                elif signal.action == SignalAction.SELL and position is None:
                    entry = price * (1 - self.slippage)
                    qty = (capital * self.position_size_pct / 100) / entry
                    from shared.indicators import atr as calc_atr
                    atr_vals = calc_atr(window, 14)
                    atr_val = atr_vals[-1] if atr_vals[-1] else price * 0.02
                    position = {
                        "side": "sell", "entry_price": entry, "quantity": qty,
                        "stop_loss": entry + atr_val * 2,
                        "take_profit": entry - atr_val * 3,
                    }
                    capital -= entry * qty * self.commission  # Only commission for shorts

                elif signal.action == SignalAction.BUY and position is not None and position["side"] == "sell":
                    exit_price = price * (1 + self.slippage)
                    pnl = self._calc_pnl(position, exit_price)
                    capital += pnl
                    trades.append(self._make_trade(market_data.asset, position, exit_price, "signal"))
                    position = None

            # Track equity
            pos_value = 0
            if position:
                pos_value = self._calc_pnl(position, price)
            equity = capital + pos_value
            if equity > peak:
                peak = equity
            dd = peak - equity
            if dd > max_dd:
                max_dd = dd

            equity_curve.append({"timestamp": current.timestamp, "equity": equity})

        # Close any remaining position at last price
        if position is not None:
            exit_price = candles[-1].close
            pnl = self._calc_pnl(position, exit_price)
            capital += pnl
            trades.append(self._make_trade(market_data.asset, position, exit_price, "end"))

        metrics = self._calc_metrics(trades, capital, max_dd, equity_curve)

        log.info(
            "Backtest %s on %s: %d trades, %.1f%% return, %.1f%% win rate",
            strategy.config.name, market_data.asset.symbol,
            metrics.total_trades, metrics.total_return_pct, metrics.win_rate * 100,
        )

        return BacktestResult(
            strategy=strategy.config.name,
            metrics=metrics,
            trades=trades,
            equity_curve=equity_curve,
            dna=strategy.dna,
        )

    def _calc_pnl(self, position: dict, exit_price: float) -> float:
        qty = position["quantity"]
        entry = position["entry_price"]
        if position["side"] == "buy":
            gross = (exit_price - entry) * qty
        else:
            gross = (entry - exit_price) * qty
        commission = exit_price * qty * self.commission
        return gross - commission + entry * qty  # Return capital + profit

    def _make_trade(self, asset: AssetInfo, pos: dict, exit_price: float, reason: str) -> Order:
        side = Side.BUY if pos["side"] == "buy" else Side.SELL
        close_side = Side.SELL if side == Side.BUY else Side.BUY
        return Order(
            id=str(uuid.uuid4())[:8],
            asset=asset,
            side=side,
            type=OrderType.MARKET,
            quantity=pos["quantity"],
            strategy="backtest",
            price=pos["entry_price"],
            status=OrderStatus.FILLED,
            filled_price=exit_price,
            filled_quantity=pos["quantity"],
            created_at=0,
            filled_at=0,
        )

    def _calc_metrics(
        self, trades: list[Order], final_capital: float,
        max_dd: float, equity_curve: list[dict],
    ) -> PerformanceMetrics:
        total_return = final_capital - self.initial_capital
        total_return_pct = (total_return / self.initial_capital) * 100 if self.initial_capital else 0

        winners = [t for t in trades if t.filled_price and t.price and (
            (t.side == Side.BUY and t.filled_price > t.price) or
            (t.side == Side.SELL and t.filled_price < t.price)
        )]
        losers = [t for t in trades if t not in winners]

        total = len(trades)
        win_rate = len(winners) / total if total > 0 else 0

        avg_win = 0.0
        avg_loss = 0.0
        if winners:
            avg_win = sum(
                abs(t.filled_price - t.price) * t.quantity for t in winners
                if t.filled_price and t.price
            ) / len(winners)
        if losers:
            avg_loss = sum(
                abs(t.filled_price - t.price) * t.quantity for t in losers
                if t.filled_price and t.price
            ) / len(losers)

        profit_factor = avg_win * len(winners) / (avg_loss * len(losers)) if avg_loss * len(losers) > 0 else 0

        # Sharpe ratio (simplified)
        if len(equity_curve) > 1:
            returns = []
            for j in range(1, len(equity_curve)):
                prev_eq = equity_curve[j - 1]["equity"]
                if prev_eq > 0:
                    returns.append((equity_curve[j]["equity"] - prev_eq) / prev_eq)
            if returns:
                mean_r = sum(returns) / len(returns)
                std_r = math.sqrt(sum((r - mean_r) ** 2 for r in returns) / len(returns)) if len(returns) > 1 else 0
                sharpe = (mean_r / std_r) * math.sqrt(252) if std_r > 0 else 0
            else:
                sharpe = 0
        else:
            sharpe = 0

        max_dd_pct = (max_dd / self.initial_capital) * 100 if self.initial_capital else 0
        calmar = total_return_pct / max_dd_pct if max_dd_pct > 0 else 0

        return PerformanceMetrics(
            total_return=total_return,
            total_return_pct=total_return_pct,
            sharpe_ratio=sharpe,
            max_drawdown=max_dd,
            max_drawdown_pct=max_dd_pct,
            win_rate=win_rate,
            profit_factor=profit_factor,
            total_trades=total,
            winning_trades=len(winners),
            losing_trades=len(losers),
            avg_win=avg_win,
            avg_loss=avg_loss,
            calmar_ratio=calmar,
        )
