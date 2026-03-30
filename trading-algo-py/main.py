"""Trading Algorithm Orchestrator — main entry point.

Coordinates all modules: market data, strategies, risk, execution, evolution,
agent network, regime detection, macro, sentiment, diagnostics, scenario simulation.
"""

from __future__ import annotations

import asyncio
import logging
import sys
import time

from config.settings import config
from config.assets import ALL_ASSETS, FOREX_ASSETS, CRYPTO_ASSETS
from shared.types import SignalAction
from shared.events import event_bus
from team.market_analyst.analyst import MarketAnalyst
from team.technical_strategist.strategies import get_all_strategies, create_strategy
from team.technical_strategist.selector import (
    select_best_strategies, get_strategy_for_asset, print_selection_report,
)
from team.risk_manager.risk import RiskManager
from team.executor.executor import Executor
from team.agent_network import AgentNetwork, AgentSpawner, DecayDetector
from team.regime_detector import RegimeDetector
from team.macro_economist import MacroEconomist
from team.sentiment_analyst import SentimentAnalyst
from team.scenario_simulator import ScenarioSimulator
from team.diagnostics import DiagnosticsEngine
from team.opportunity_scanner import OpportunityScanner
from team.portfolio_optimizer import HierarchicalRiskParity
from team.risk_manager.advanced_risk import (
    calculate_var, calculate_cvar, calculate_sortino_ratio,
    DrawdownCircuitBreaker, CorrelationAdjustedSizer,
)
from team.ml_signals import MLSignalEnhancer

# Configure logging
logging.basicConfig(
    level=getattr(logging, config.log_level.upper(), logging.INFO),
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("orchestrator")


class TradingOrchestrator:
    """Main orchestrator — runs the full trading cycle with all modules."""

    def __init__(self, auto_select: bool = True) -> None:
        # Core modules
        self.analyst = MarketAnalyst()
        self.strategies = get_all_strategies()
        self.risk_manager = RiskManager()
        self.executor = Executor()

        # Agent network
        self.network = AgentNetwork()
        self.decay_detector = DecayDetector()

        # Analysis modules
        self.regime_detector = RegimeDetector()
        self.macro_economist = MacroEconomist()
        self.sentiment_analyst = SentimentAnalyst()
        self.scenario_simulator = ScenarioSimulator()
        self.diagnostics = DiagnosticsEngine()
        self.opportunity_scanner = OpportunityScanner()

        # Quant modules
        self.hrp = HierarchicalRiskParity()
        self.ml_enhancer = MLSignalEnhancer()
        self.circuit_breaker = DrawdownCircuitBreaker()
        self.correlation_sizer = CorrelationAdjustedSizer()

        self.cycle_count = 0
        self.auto_select = auto_select
        self.selection = None

        if auto_select:
            self.selection = select_best_strategies()
            if self.selection.mapping:
                log.info(
                    "Auto-select ON — %d assets mapped to best strategies",
                    len(self.selection.mapping),
                )
            else:
                log.info("Auto-select: no backtest data — using all strategies")

        log.info(
            "TradingOrchestrator initialised | mode=%s | cloud=%s | strategies=%d | assets=%d | auto_select=%s",
            config.trading_mode, config.cloud_mode,
            len(self.strategies), len(ALL_ASSETS), auto_select,
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

        # 2. Generate signals (auto-select best strategy per asset, or use all)
        all_signals = []
        for data in market_data_list:
            if self.auto_select and self.selection and self.selection.mapping:
                # Only run the best strategy for this asset
                best_name = get_strategy_for_asset(self.selection, data.asset.symbol)
                try:
                    strategy = create_strategy(best_name)
                    signals = strategy.analyze(data)
                    for s in signals:
                        if s.action != SignalAction.HOLD:
                            all_signals.append((s, data))
                except Exception as e:
                    log.error("Strategy %s error on %s: %s", best_name, data.asset.symbol, e)
            else:
                # Fallback: run all strategies
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

    def run_evolution(self, strategy_name: str, assets=None, generations: int = 10) -> None:
        """Evolve a strategy's parameters using genetic algorithm."""
        from team.self_improver.evolution import SelfImprover

        target_assets = assets or ALL_ASSETS[:8]
        improver = SelfImprover()

        # Collect data for multi-asset evaluation
        datasets = []
        for asset in target_assets:
            data = self.analyst.fetch_market_data(asset, config.default_timeframe)
            datasets.append(data)

        best = improver.evolve(strategy_name, datasets, generations)
        path = improver.save_best(strategy_name)
        log.info("Best DNA for %s: fitness=%.4f, saved=%s, params=%s",
                 strategy_name, best.fitness, path, best.params)


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

        elif cmd == "auto-select":
            selection = select_best_strategies()
            print_selection_report(selection)

        elif cmd == "regime":
            # Detect market regime for first few assets
            assets = ALL_ASSETS[:5]
            for asset in assets:
                data = orchestrator.analyst.fetch_market_data(asset, config.default_timeframe)
                if data and data.candles:
                    analysis = orchestrator.regime_detector.detect(data.candles)
                    print(f"\n{asset.symbol}: {analysis.regime.value} (confidence={analysis.confidence:.2f})")
                    print(f"  {analysis.details}")

        elif cmd == "macro":
            env = asyncio.run(orchestrator.macro_economist.get_environment())
            report = asyncio.run(orchestrator.macro_economist.get_geopolitical_report())
            print(f"\nMacro bias: {env.bias} | Risk: {env.risk_level}")
            print(report)

        elif cmd == "sentiment":
            symbols = [a.symbol.split("/")[0] for a in ALL_ASSETS[:10]]
            scores = orchestrator.sentiment_analyst.analyze(symbols)
            overall = orchestrator.sentiment_analyst.get_overall_sentiment()
            print(f"\nSentiment ({len(scores)} assets): overall={overall:.3f}")
            for s in scores:
                print(f"  {s.asset}: {s.score:+.3f} (source={s.source})")

        elif cmd == "diagnose":
            candles_map = {}
            for asset in ALL_ASSETS[:5]:
                data = orchestrator.analyst.fetch_market_data(asset, config.default_timeframe)
                if data and data.candles:
                    candles_map[asset.symbol] = data.candles
            report = orchestrator.diagnostics.scan(candles=candles_map)
            print(DiagnosticsEngine.format_report(report))

        elif cmd == "opportunities":
            # Scan for trading opportunities
            market_data_list = orchestrator.analyst.fetch_all(ALL_ASSETS, config.default_timeframe)
            all_signals = []
            md_map = {}
            for data in market_data_list:
                md_map[data.asset.symbol] = data
                for strategy in orchestrator.strategies:
                    try:
                        signals = strategy.analyze(data)
                        all_signals.extend(s for s in signals if s.action != SignalAction.HOLD)
                    except Exception:
                        pass
            opps = orchestrator.opportunity_scanner.scan(all_signals, md_map)
            print(OpportunityScanner.format_report(opps))

        elif cmd == "walk-forward":
            from team.backtester.engine import Backtester
            backtester = Backtester(initial_capital=config.initial_capital)
            assets = ALL_ASSETS[:5]
            for asset in assets:
                data = orchestrator.analyst.fetch_market_data(asset, config.default_timeframe)
                for strategy in orchestrator.strategies[:3]:
                    result = backtester.walk_forward(strategy, data)
                    print(f"\n{strategy.config.name} on {asset.symbol}:")
                    print(f"  IS return: {result.get('avg_in_sample_return', 0):.1f}%")
                    print(f"  OOS return: {result.get('avg_out_of_sample_return', 0):.1f}%")
                    print(f"  Overfit score: {result.get('overfit_score', 0):.2f}")

        elif cmd == "hrp":
            # Run HRP portfolio optimization
            returns_map = {}
            for asset in ALL_ASSETS[:15]:
                data = orchestrator.analyst.fetch_market_data(asset, config.default_timeframe)
                if data and data.candles and len(data.candles) > 20:
                    rets = []
                    for j in range(1, len(data.candles)):
                        if data.candles[j-1].close > 0:
                            rets.append((data.candles[j].close - data.candles[j-1].close) / data.candles[j-1].close)
                    returns_map[asset.symbol] = rets
            weights = orchestrator.hrp.optimize(returns_map)
            print("\n=== HRP Portfolio Weights ===")
            for sym, w in sorted(weights.items(), key=lambda x: x[1], reverse=True):
                print(f"  {sym:15s}: {w*100:5.1f}%")

        elif cmd == "risk-report":
            # Advanced risk metrics
            from team.risk_manager.advanced_risk import monte_carlo_var
            returns_map = {}
            for asset in ALL_ASSETS[:10]:
                data = orchestrator.analyst.fetch_market_data(asset, config.default_timeframe)
                if data and data.candles and len(data.candles) > 20:
                    rets = [(data.candles[j].close - data.candles[j-1].close) / data.candles[j-1].close
                            for j in range(1, len(data.candles)) if data.candles[j-1].close > 0]
                    returns_map[asset.symbol] = rets
            print("\n=== ADVANCED RISK REPORT ===")
            for sym, rets in returns_map.items():
                var95 = calculate_var(rets, 0.95)
                cvar95 = calculate_cvar(rets, 0.95)
                sortino = calculate_sortino_ratio(rets)
                mc_var = monte_carlo_var(rets)
                print(f"  {sym:15s}: VaR95={var95*100:+.2f}%  CVaR95={cvar95*100:+.2f}%  Sortino={sortino:.2f}  MC-VaR={mc_var*100:+.2f}%")

        elif cmd == "stat-arb":
            from team.technical_strategist.stat_arb import StatArbStrategy
            stat_arb = StatArbStrategy()
            # Analyze BTC vs ETH pair
            data_a = orchestrator.analyst.fetch_market_data(CRYPTO_ASSETS[0], config.default_timeframe)
            data_b = orchestrator.analyst.fetch_market_data(CRYPTO_ASSETS[1], config.default_timeframe)
            if data_a and data_b:
                signals = stat_arb.analyze_pair(data_a, data_b)
                print(f"\nStat Arb {CRYPTO_ASSETS[0].symbol} vs {CRYPTO_ASSETS[1].symbol}: {len(signals)} signals")
                for s in signals:
                    print(f"  {s.asset.symbol}: {s.action.value} conf={s.confidence:.2f} ({s.strategy})")

        else:
            print(f"Unknown command: {cmd}")
            print("Commands: backtest, paper-trade, evolve, analyze, auto-select, regime, macro,")
            print("          sentiment, diagnose, opportunities, walk-forward, hrp, risk-report, stat-arb")
    else:
        # Default: single cycle
        orchestrator.run_cycle()


if __name__ == "__main__":
    main()
