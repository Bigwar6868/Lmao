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
from team.risk_manager.journal import PostTradeReviewer
from shared.indicators import atr as calc_atr

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

        # CEO + Teams (lazy-init via start_ceo())
        self.ceo = None
        self.spawner = None
        self._teams: dict[str, object] = {}

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

    # ------------------------------------------------------------------
    # CEO-driven autonomous trading
    # ------------------------------------------------------------------

    def start_ceo(self) -> None:
        """Initialize the CEO agent, teams, spawner, and subagents.

        Each team can use a different AI model via config:
          CEO_AI_MODEL=kimiclaw:moonshot-v1-8k
          TRADING_AI_MODEL=claude:claude-sonnet-4-20250514
          RESEARCH_AI_MODEL=ollama:llama3
          etc.

        Format: "provider:model" — see create_provider() for supported providers.
        """
        from shared.agent_brain import auto_detect_provider, create_provider
        from team.ceo import CEOAgent, TradingTeam, ResearchTeam, RiskTeam, EvolutionTeam, OpsTeam, QuantTeam

        # Default provider (auto-detect from env)
        default_provider = auto_detect_provider()

        # CEO gets its own provider if configured
        ceo_provider = create_provider(config.ceo_ai_model) or default_provider
        provider_name = f"{ceo_provider.name}/{ceo_provider.model}" if ceo_provider else "rule-based"
        log.info("CEO brain: %s", provider_name)

        # Create CEO
        self.ceo = CEOAgent(self.network, llm_provider=ceo_provider)

        # Create teams
        trading_team = TradingTeam(self.network, self.ceo.id)
        trading_team.set_ceo(self.ceo)  # CEO monitors trades
        research_team = ResearchTeam(self.network, self.ceo.id)
        risk_team = RiskTeam(self.network, self.ceo.id)
        evolution_team = EvolutionTeam(self.network, self.ceo.id)
        ops_team = OpsTeam(self.network, self.ceo.id)
        quant_team = QuantTeam(self.network, self.ceo.id)

        self._teams = {
            "trading": trading_team,
            "research": research_team,
            "risk": risk_team,
            "evolution": evolution_team,
            "ops": ops_team,
            "quant": quant_team,
        }

        # Register with CEO
        for team in self._teams.values():
            self.ceo.register_team(team.get_config())

        # Set team prompts
        self.ceo.set_team_prompt("trading", "Execute profitable trades with strict risk management",
                                 ["Generate high-confidence signals", "Manage position sizing", "Review trade outcomes"])
        self.ceo.set_team_prompt("research", "Analyze markets and detect regime changes",
                                 ["Fetch fresh data", "Run technical analysis", "Detect correlations"])
        self.ceo.set_team_prompt("risk", "Preserve capital — monitor drawdowns and exposure",
                                 ["Enforce stop losses", "Monitor concentration", "Kill switch if >5% drawdown"])
        self.ceo.set_team_prompt("evolution", "Evolve strategies for better performance",
                                 ["Backtest strategies", "Mutate underperformers", "Detect decay"])
        self.ceo.set_team_prompt("ops", "Monitor system health and data sources",
                                 ["Check data freshness", "Monitor memory", "Validate cache"])
        self.ceo.set_team_prompt("quant", "Run real-time quant calculations every tick",
                                 ["Z-score mean reversion", "Cross-pair spreads", "IRP deviation",
                                  "RSI divergence", "Hurst regime detection", "Volatility percentile"])

        # Per-team AI model providers
        team_providers = {
            "trading": create_provider(config.trading_ai_model) or default_provider,
            "research": create_provider(config.research_ai_model) or default_provider,
            "risk": create_provider(config.risk_ai_model) or default_provider,
            "evolution": create_provider(config.evolution_ai_model) or default_provider,
            "ops": create_provider(config.ops_ai_model) or default_provider,
        }
        for team_id, prov in team_providers.items():
            if prov:
                log.info("  %s team AI: %s/%s", team_id, prov.name, prov.model)

        # Set up spawner — trading agents use the trading team's provider
        agents_dict: dict[str, object] = {}
        strategy_map = {s.config.name: type(s) for s in self.strategies}
        self.spawner = AgentSpawner(self.network, agents_dict, strategy_map, max_agents=config.max_agents)
        self.spawner.set_llm_provider(team_providers.get("trading", default_provider))

        # Spawn one agent per strategy (disable cooldown for initial batch)
        self.spawner.spawn_cooldown_ms = 0
        for strategy in self.strategies:
            agent = self.spawner.spawn_agent(strategy.config.name, role="trader")
            if agent:
                trading_team.register_agent(agent)
        self.spawner.spawn_cooldown_ms = 30_000  # Restore cooldown

        self.ceo.set_active_assets(ALL_ASSETS)
        self.ceo.set_active_strategies([s.config.name for s in self.strategies])

        # Post-trade reviewer — syncs closed trades and updates agent performance
        self.post_trade_reviewer = PostTradeReviewer()

        status = self.spawner.get_status()
        log.info(
            "CEO system online | %d agents | %d brains | %d loops | provider=%s",
            status["total_agents"], status["agents_with_brains"],
            status["agents_with_loops"], status["llm_provider"],
        )

    def run_ceo_cycle(self, assets=None, timeframe: str | None = None) -> dict:
        """Run one CEO-driven trading cycle.

        Flow:
        1. Research team fetches market data for all assets
        2. Research detects regime (trending, ranging, volatile, etc.)
        3. CEO decides risk mode based on regime + portfolio state
        4. 12 agents INDEPENDENTLY scan all assets for opportunities
        5. Best signals ranked by confidence, deduplicated per asset
        6. Execute top trades via OANDA (up to max_trades_per_cycle)
        7. Evolution team evaluates agent performance every 5 cycles
        """
        if not self.ceo:
            self.start_ceo()

        cycle = self.ceo.increment_cycle()
        tf = timeframe or config.default_timeframe
        target_assets = assets or ALL_ASSETS
        cycle_start = time.time()

        if self.ceo.is_paused():
            log.warning("CEO is PAUSED — skipping cycle %d", cycle)
            return {"cycle": cycle, "paused": True}

        log.info("=== CEO Cycle %d | %d assets | %d agents | %s ===",
                 cycle, len(target_assets), len(self.spawner.agents) if self.spawner else 0, tf)

        # --- Step 1: Research team fetches data ---
        research = self._teams.get("research")
        market_data_map = research.fetch_all_data(target_assets, tf) if research else {}
        log.info("Data: %d/%d assets fetched", len(market_data_map), len(target_assets))

        # --- Step 2: Detect regime ---
        regime = research.detect_regime(market_data_map) if research else None
        regime_str = getattr(regime, "regime", "unknown") if regime else "unknown"

        # --- Step 3: CEO decides risk mode ---
        portfolio = self._teams["trading"].get_portfolio() if "trading" in self._teams else self.executor.get_portfolio()
        pnl_pct = (portfolio.total_pnl / max(1, portfolio.capital)) * 100

        ceo_thought = self.ceo.think(
            f"Cycle {cycle}: {len(market_data_map)} assets, regime={regime_str}, "
            f"portfolio PnL={pnl_pct:+.1f}%. "
            f"Should we trade aggressively, conservatively, or pause?",
        )
        ceo_decision = ceo_thought.get("decision", "").lower()

        # Parse CEO decision into risk mode
        if "pause" in ceo_decision or "stop" in ceo_decision:
            self.ceo.pause(ceo_decision)
            return {"cycle": cycle, "paused": True, "ceo_decision": ceo_decision}
        elif "aggressive" in ceo_decision or "increase" in ceo_decision:
            risk_mode = "aggressive"
        elif "conservative" in ceo_decision or "reduce" in ceo_decision or "careful" in ceo_decision:
            risk_mode = "conservative"
        else:
            risk_mode = "normal"

        # Override: force conservative if drawdown > 3%
        if pnl_pct < -3:
            risk_mode = "conservative"
            log.warning("Risk override: conservative mode (drawdown %.1f%%)", pnl_pct)

        log.info("CEO: %s → risk_mode=%s", ceo_decision[:60], risk_mode)

        # --- Step 3.5: Quant team — feed data + generate quant signals ---
        quant = self._teams.get("quant")
        quant_signals = []
        if quant:
            quant.feed_market_data(market_data_map)
            quant_signals = quant.generate_signals(target_assets)
            if quant_signals:
                log.info("Quant: %d signals (z-score, divergence, IRP, pair-spread)", len(quant_signals))

        # --- Step 4-6: Trading team — agents independently seek + execute ---
        trading = self._teams.get("trading")

        # Inject quant signals into market_data_map as extra agent signals
        # by adding them to the trading cycle
        trade_result = trading.run_cycle(
            market_data_map, risk_mode=risk_mode, max_trades_per_cycle=20,
            extra_signals=quant_signals,
        ) if trading else {}

        # --- Step 7: Update prices + compute ATR for advanced stop management ---
        prices = {}
        atr_map = {}
        for data in market_data_map.values():
            if data.candles:
                prices[data.asset.symbol] = data.candles[-1].close
                atr_vals = calc_atr(data.candles, 14)
                if atr_vals and atr_vals[-1] is not None:
                    atr_map[data.asset.symbol] = atr_vals[-1]
        if trading:
            trading.check_stops(prices, atr_map=atr_map, market_data_map=market_data_map)

        # --- Step 7.5: Post-trade review — sync closed trades, update agent performance ---
        if hasattr(self, "post_trade_reviewer") and self.spawner:
            reviewer = self.post_trade_reviewer

            # Register any new trades for agent attribution
            if trading and trading.executor.paper.positions:
                for pos in trading.executor.paper.positions:
                    # Try to find which agent opened this trade from recent agent_hits
                    reviewer.register_trade(pos.id, trade_result.get("agent_hits", {}).get(pos.strategy, "unknown"))

            # Sync closed trades
            if self.executor.mode == "live":
                try:
                    closed_trades = reviewer.sync_closed_trades(self.executor)
                except Exception as e:
                    log.debug("Live trade sync: %s", e)
                    closed_trades = []
            else:
                closed_trades = reviewer.sync_paper_closed(self.executor.paper)

            # Update agent reputation based on closed trade results
            if closed_trades:
                updated = reviewer.update_agent_performance(closed_trades, self.spawner)
                if updated > 0:
                    log.info("Post-trade review: %d trades synced, %d agents updated", len(closed_trades), updated)

                # Update filter engine with closed trade PnL
                if trading:
                    for trade in closed_trades:
                        trading.filter_engine.on_trade_closed(
                            trade.get("instrument", ""),
                            trade.get("pnl", 0),
                        )

        # --- Step 8: Update CEO context + equity trackers ---
        portfolio = trading.get_portfolio() if trading else self.executor.get_portfolio()
        self.ceo.update_context(portfolio)

        # Update filter equity trackers
        if trading:
            trading.filter_engine.on_cycle_end(portfolio.capital)

        # --- Step 9: Risk team alert ---
        pnl_pct = (portfolio.total_pnl / max(1, portfolio.capital)) * 100
        risk_team = self._teams.get("risk")
        if risk_team and pnl_pct < -5:
            risk_team.report_to_ceo("risk-alert", f"DANGER: Drawdown {pnl_pct:.1f}%")

        # --- Step 10: Evolution every 5 cycles ---
        if self.spawner and cycle % 5 == 0:
            spawned, retired = self.spawner.evaluate()
            if retired:
                log.info("Evolution: retired %d agents, spawned %d replacements", len(retired), len(spawned))
            self.spawner.evolve_underperformers()

        # --- Report ---
        elapsed = time.time() - cycle_start
        spawner_status = self.spawner.get_status() if self.spawner else {}
        summary = trading.get_portfolio_summary() if trading else self.executor.get_summary()

        log.info(
            "CEO Cycle %d done (%.1fs) | %d opportunities → %d trades, %d rejected | %s | mode=%s | agents=%d",
            cycle, elapsed,
            trade_result.get("total_opportunities", 0),
            trade_result.get("executed", 0),
            trade_result.get("rejected", 0),
            summary, risk_mode,
            spawner_status.get("total_agents", 0),
        )

        # --- Step 10.5: Log quant dashboard every 5 cycles ---
        if quant and cycle % 5 == 0:
            dashboard = quant.get_dashboard()
            log.info(dashboard)

        # Log execution quality and filter stats
        if trading:
            exec_report = trading.executor.quality_monitor.format_report()
            filter_status = trading.filter_engine.format_status(portfolio)
            log.info(exec_report)
            log.info(filter_status)

        # Log top contributing agents
        agent_hits = trade_result.get("agent_hits", {})
        if agent_hits:
            log.info("Top agents: %s", ", ".join(f"{k}({v})" for k, v in
                     sorted(agent_hits.items(), key=lambda x: -x[1])[:5]))

        return {
            "cycle": cycle,
            "elapsed_s": elapsed,
            "total_opportunities": trade_result.get("total_opportunities", 0),
            "unique_opportunities": trade_result.get("unique_opportunities", 0),
            "executed": trade_result.get("executed", 0),
            "rejected": trade_result.get("rejected", 0),
            "risk_mode": risk_mode,
            "ceo_decision": ceo_thought.get("decision", ""),
            "agent_hits": agent_hits,
            "agents": spawner_status,
            "portfolio": portfolio,
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
    # Auto-update check on startup (non-blocking, rate-limited to 1x/hour)
    try:
        from shared.updater import check_for_updates, auto_update, format_update_status
        if len(sys.argv) > 1 and sys.argv[1] == "update":
            # Explicit update command
            print("Checking for updates...")
            updated = auto_update(force=True)
            if updated:
                print("Updated! Restart the system.")
            else:
                info = check_for_updates(force=True)
                print(format_update_status(info))
            return

        if len(sys.argv) > 1 and sys.argv[1] == "version":
            from shared.updater import get_current_version, get_local_commit
            print(f"v{get_current_version()} (commit: {get_local_commit() or '?'})")
            return

        # Background check (silent, rate-limited)
        info = check_for_updates()
        if info.update_available:
            log.info("Update available! Run: python main.py update")
    except Exception:
        pass  # Never block startup on update check failure

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

        elif cmd == "trade":
            # CEO-driven autonomous trading (default mode)
            orchestrator.start_ceo()
            while True:
                try:
                    result = orchestrator.run_ceo_cycle()
                    cycle_interval = getattr(config, 'auto_trade_cycle_ms', 60000) // 1000
                    log.info("Next cycle in %ds...", cycle_interval)
                    time.sleep(cycle_interval)
                except KeyboardInterrupt:
                    if orchestrator.spawner:
                        orchestrator.spawner.stop_all_loops()
                    log.info("CEO trading stopped")
                    break

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

        elif cmd == "optimize-zscore":
            # Backtest all forex pairs to find optimal z-score params
            from team.quant_engine.zscore_optimizer import ZScoreOptimizer
            optimizer = ZScoreOptimizer()
            target = FOREX_ASSETS
            if len(sys.argv) > 2:
                # Filter to specific pair(s): python main.py optimize-zscore EUR/USD GBP/USD
                symbols = set(sys.argv[2:])
                target = [a for a in FOREX_ASSETS if a.symbol in symbols]
                if not target:
                    print(f"No matching pairs. Available: {', '.join(a.symbol for a in FOREX_ASSETS)}")
                    return
            print(f"\nOptimizing z-score params for {len(target)} forex pairs...")
            print("Using scipy (ADF, Shapiro-Wilk, Ljung-Box) + statsmodels + bootstrap CI\n")
            candles_map = {}
            for asset in target:
                data = orchestrator.analyst.fetch_market_data(asset, config.default_timeframe)
                if data and data.candles:
                    candles_map[asset.symbol] = data.candles
                    print(f"  {asset.symbol}: {len(data.candles)} candles loaded")
            report = optimizer.optimize_all(target, candles_map)
            print(ZScoreOptimizer.format_report(report))

        elif cmd == "quant-dashboard":
            # Run quant engine on all assets and show dashboard
            from team.quant_engine import QuantEngine
            engine = QuantEngine()
            market_data_list = orchestrator.analyst.fetch_all(ALL_ASSETS, config.default_timeframe)
            for data in market_data_list:
                engine.feed_market_data(data)
            engine.compute_pair_metrics()
            print(QuantEngine.format_dashboard(engine.get_all_snapshots(), engine.get_pair_snapshots()))
            alerts = engine.get_recent_alerts(20)
            if alerts:
                print(f"\n=== Recent Alerts ({len(alerts)}) ===")
                for a in alerts:
                    print(f"  [{a.alert_type}] {a.symbol}: {a.direction} ({a.value:.2f} vs {a.threshold:.2f}) — {a.details}")
            # Show signals
            signals = []
            for asset in ALL_ASSETS:
                signals.extend(engine.generate_signals(asset))
            signals.extend(engine.generate_pair_signals())
            if signals:
                print(f"\n=== Quant Signals ({len(signals)}) ===")
                for s in sorted(signals, key=lambda x: x.confidence, reverse=True):
                    print(f"  {s.action.value:4s} {s.asset.symbol:<12s} conf={s.confidence:.2f} [{s.strategy}] {s.reason}")

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
            print("Commands: trade, backtest, paper-trade, evolve, analyze, auto-select, regime, macro,")
            print("          sentiment, diagnose, opportunities, walk-forward, hrp, risk-report,")
            print("          optimize-zscore, quant-dashboard, stat-arb, update, version")
    else:
        # Default: CEO-driven single cycle
        orchestrator.start_ceo()
        orchestrator.run_ceo_cycle()


if __name__ == "__main__":
    main()
