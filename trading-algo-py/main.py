"""Trading Algorithm Orchestrator — main entry point.

Coordinates all modules: market data, strategies, risk, execution, evolution.
"""

from __future__ import annotations

import logging
import sys
import time

from config.settings import config
from config.assets import ALL_ASSETS, FOREX_ASSETS, CRYPTO_ASSETS
from shared.types import SignalAction
from shared.events import event_bus
from team.market_analyst.analyst import MarketAnalyst
from team.technical_strategist.strategies import get_all_strategies
from team.risk_manager.risk import RiskManager
from team.executor.executor import Executor

# Configure logging
logging.basicConfig(
    level=getattr(logging, config.log_level.upper(), logging.INFO),
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("orchestrator")


class TradingOrchestrator:
    """Main orchestrator — runs the trading cycle."""

    def __init__(self) -> None:
        self.analyst = MarketAnalyst()
        self.strategies = get_all_strategies()
        self.risk_manager = RiskManager()
        self.executor = Executor()
        self.cycle_count = 0

        log.info(
            "TradingOrchestrator initialised | mode=%s | cloud=%s | strategies=%d | assets=%d",
            config.trading_mode, config.cloud_mode,
            len(self.strategies), len(ALL_ASSETS),
        )

    def run_cycle(self, assets=None, timeframe: str | None = None) -> dict:
        """Run one trading cycle: fetch data -> analyze -> risk check -> execute."""
        self.cycle_count += 1
        tf = timeframe or config.default_timeframe
        target_assets = assets or ALL_ASSETS
        cycle_start = time.time()

        log.info("=== Cycle %d | %d assets | %s ===", self.cycle_count, len(target_assets), tf)

        # 1. Fetch market data
        market_data_list = self.analyst.fetch_all(target_assets, tf)
        log.info("Fetched data for %d/%d assets", len(market_data_list), len(target_assets))

        # 2. Generate signals
        all_signals = []
        for data in market_data_list:
            for strategy in self.strategies:
                try:
                    signals = strategy.analyze(data)
                    for s in signals:
                        if s.action != SignalAction.HOLD:
                            all_signals.append((s, data))
                except Exception as e:
                    log.error("Strategy %s error on %s: %s", strategy.config.name, data.asset.symbol, e)

        log.info("Generated %d actionable signals", len(all_signals))

        # 3. Risk assess and execute
        executions = []
        portfolio = self.executor.get_portfolio()

        for signal, data in all_signals:
            risk = self.risk_manager.assess(signal, data, portfolio)
            if risk.approved:
                result = self.executor.execute(signal, risk)
                executions.append(result)
                portfolio = self.executor.get_portfolio()

        # 4. Update prices for stop checks
        prices = {}
        for data in market_data_list:
            if data.candles:
                prices[data.asset.symbol] = data.candles[-1].close
        self.executor.check_stops(prices)

        elapsed = time.time() - cycle_start
        summary = self.executor.get_summary()
        log.info("Cycle %d complete (%.1fs) | %s", self.cycle_count, elapsed, summary)

        return {
            "cycle": self.cycle_count,
            "signals": len(all_signals),
            "executions": len(executions),
            "elapsed_s": elapsed,
            "portfolio": self.executor.get_portfolio(),
        }

    def run_backtest(self, assets=None, timeframe: str | None = None) -> list:
        """Run backtests for all strategies on all assets."""
        from team.backtester.engine import Backtester

        tf = timeframe or config.default_timeframe
        target_assets = assets or ALL_ASSETS[:10]  # Subset for speed
        backtester = Backtester(initial_capital=config.initial_capital)

        log.info("Running backtests: %d strategies x %d assets", len(self.strategies), len(target_assets))

        results = []
        for asset in target_assets:
            data = self.analyst.fetch_market_data(asset, tf)
            for strategy in self.strategies:
                result = backtester.run(strategy, data)
                results.append(result)
                m = result.metrics
                if m.total_trades > 0:
                    log.info(
                        "  %s | %s: %.1f%% return, %.0f%% WR, %d trades, Sharpe=%.2f",
                        strategy.config.name, asset.symbol,
                        m.total_return_pct, m.win_rate * 100, m.total_trades, m.sharpe_ratio,
                    )

        return results

    def run_evolution(self, strategy_name: str, assets=None, generations: int = 5) -> None:
        """Evolve a strategy's parameters using genetic algorithm."""
        from team.self_improver.evolution import SelfImprover

        target_assets = assets or ALL_ASSETS[:5]
        improver = SelfImprover()

        for asset in target_assets:
            data = self.analyst.fetch_market_data(asset, config.default_timeframe)
            best = improver.evolve(strategy_name, data, generations)
            log.info("Best DNA for %s on %s: fitness=%.4f, params=%s",
                     strategy_name, asset.symbol, best.fitness, best.params)


def main():
    """CLI entry point."""
    orchestrator = TradingOrchestrator()

    if len(sys.argv) > 1:
        cmd = sys.argv[1]

        if cmd == "backtest":
            results = orchestrator.run_backtest()
            print(f"\nCompleted {len(results)} backtests")
            winners = [r for r in results if r.metrics.total_return_pct > 0]
            print(f"Profitable: {len(winners)}/{len(results)}")
            if winners:
                best = max(winners, key=lambda r: r.metrics.total_return_pct)
                print(f"Best: {best.strategy} — {best.metrics.total_return_pct:.1f}% return")

        elif cmd == "paper-trade":
            while True:
                try:
                    orchestrator.run_cycle()
                    log.info("Sleeping %ds...", config.auto_trade_cycle_ms // 1000 if hasattr(config, 'auto_trade_cycle_ms') else 60)
                    time.sleep(60)
                except KeyboardInterrupt:
                    log.info("Paper trading stopped")
                    break

        elif cmd == "evolve":
            strategy = sys.argv[2] if len(sys.argv) > 2 else "momentum"
            orchestrator.run_evolution(strategy)

        elif cmd == "analyze":
            orchestrator.run_cycle()

        else:
            print(f"Unknown command: {cmd}")
            print("Usage: python main.py [backtest|paper-trade|evolve|analyze]")
    else:
        # Default: single cycle
        orchestrator.run_cycle()


if __name__ == "__main__":
    main()
