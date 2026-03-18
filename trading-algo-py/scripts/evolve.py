"""Auto-evolve — AI-driven strategy improvement via genetic algorithm.

This is the "AI auto-improve" prompt: run this script and it will:
1. Backtest each strategy across multiple forex pairs
2. Evolve parameters using genetic algorithm (selection → crossover → mutation)
3. Save the best DNA to data/evolved/<strategy>.json
4. Print before/after comparison

Usage:
    python -m scripts.evolve                      # Evolve all strategies
    python -m scripts.evolve --strategy momentum  # Evolve one strategy
    python -m scripts.evolve --generations 20     # More generations
    python -m scripts.evolve --assets 10          # More assets for robustness

KimiClaw integration:
    Run this via Telegram bot or cron to continuously improve the algo.
    Each run saves the best DNA — next auto-trade cycle picks it up.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time

from config.settings import config
from config.assets import FOREX_ASSETS
from shared.types import MarketData
from shared.synthetic import generate_synthetic_candles
from team.self_improver.evolution import SelfImprover
from team.technical_strategist.strategies import (
    create_strategy, get_all_strategies, ALL_STRATEGIES,
)
from team.backtester.engine import Backtester

logging.basicConfig(
    level=config.log_level,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
)
log = logging.getLogger("evolve")

STRATEGY_NAMES = list(ALL_STRATEGIES.keys())


def _fetch_data(assets, timeframe: str, count: int) -> list[MarketData]:
    """Fetch candles for multiple assets — OANDA or synthetic fallback."""
    datasets: list[MarketData] = []

    for asset in assets:
        candles = None
        if config.has_oanda_credentials and asset.asset_class.value == "forex":
            try:
                from team.market_analyst.oanda import OandaDataFetcher
                fetcher = OandaDataFetcher()
                candles = fetcher.fetch_candles(asset.symbol, timeframe, count=count)
            except Exception:
                pass

        if not candles or len(candles) < 60:
            interval_ms = {"1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000}.get(timeframe, 3_600_000)
            candles = generate_synthetic_candles(asset.symbol, count=count, interval_ms=interval_ms)

        datasets.append(MarketData(
            asset=asset, timeframe=timeframe, candles=candles,
            last_updated=int(time.time() * 1000),
        ))

    return datasets


def _backtest_strategy(strategy_name: str, datasets: list[MarketData], dna=None) -> dict:
    """Backtest a strategy across multiple assets, return aggregate metrics."""
    backtester = Backtester()
    strategy = create_strategy(strategy_name, dna)

    returns, sharpes, win_rates, drawdowns, trade_counts = [], [], [], [], []

    for data in datasets:
        result = backtester.run(strategy, data)
        m = result.metrics
        returns.append(m.total_return_pct)
        sharpes.append(m.sharpe_ratio)
        win_rates.append(m.win_rate * 100)
        drawdowns.append(m.max_drawdown_pct)
        trade_counts.append(m.total_trades)

    n = len(returns)
    return {
        "avg_return": sum(returns) / n,
        "avg_sharpe": sum(sharpes) / n,
        "avg_win_rate": sum(win_rates) / n,
        "max_drawdown": max(drawdowns),
        "total_trades": sum(trade_counts),
    }


def evolve_strategy(
    strategy_name: str,
    datasets: list[MarketData],
    generations: int = 10,
    population: int = 20,
) -> dict:
    """Evolve a single strategy and return before/after comparison."""
    log.info("=" * 60)
    log.info("EVOLVING: %s (%d generations, %d population, %d assets)",
             strategy_name, generations, population, len(datasets))
    log.info("=" * 60)

    # Before: baseline with default DNA
    before = _backtest_strategy(strategy_name, datasets)
    log.info("BEFORE — Return: %.2f%%, Sharpe: %.3f, WR: %.1f%%, DD: %.2f%%",
             before["avg_return"], before["avg_sharpe"], before["avg_win_rate"], before["max_drawdown"])

    # Evolve
    improver = SelfImprover(
        population_size=population,
        mutation_rate=config.mutation_rate,
        elitism_count=max(2, population // 5),
    )
    best_dna = improver.evolve(strategy_name, datasets, generations)

    # After: backtest with evolved DNA
    after = _backtest_strategy(strategy_name, datasets, dna=best_dna)
    log.info("AFTER  — Return: %.2f%%, Sharpe: %.3f, WR: %.1f%%, DD: %.2f%%",
             after["avg_return"], after["avg_sharpe"], after["avg_win_rate"], after["max_drawdown"])

    # Save best DNA
    path = improver.save_best(strategy_name)

    # Improvement delta
    sharpe_delta = after["avg_sharpe"] - before["avg_sharpe"]
    return_delta = after["avg_return"] - before["avg_return"]
    wr_delta = after["avg_win_rate"] - before["avg_win_rate"]

    improved = sharpe_delta > 0

    return {
        "strategy": strategy_name,
        "before": before,
        "after": after,
        "best_dna": dict(best_dna.params),
        "fitness": best_dna.fitness,
        "generations": generations,
        "improved": improved,
        "sharpe_delta": sharpe_delta,
        "return_delta": return_delta,
        "win_rate_delta": wr_delta,
        "saved_to": path,
        "history": improver.history,
    }


def print_report(results: list[dict]) -> None:
    """Print a formatted evolution report."""
    print("\n" + "=" * 70)
    print("AUTO-EVOLUTION REPORT")
    print("=" * 70)

    for r in results:
        status = "IMPROVED" if r["improved"] else "NO IMPROVEMENT"
        print(f"\n{'─' * 70}")
        print(f"Strategy: {r['strategy']}  [{status}]")
        print(f"{'─' * 70}")

        b, a = r["before"], r["after"]
        print(f"  {'Metric':<20} {'Before':>10} {'After':>10} {'Delta':>10}")
        print(f"  {'─' * 50}")
        print(f"  {'Avg Return%':<20} {b['avg_return']:>9.2f}% {a['avg_return']:>9.2f}% {r['return_delta']:>+9.2f}%")
        print(f"  {'Avg Sharpe':<20} {b['avg_sharpe']:>10.3f} {a['avg_sharpe']:>10.3f} {r['sharpe_delta']:>+10.3f}")
        print(f"  {'Avg Win Rate%':<20} {b['avg_win_rate']:>9.1f}% {a['avg_win_rate']:>9.1f}% {r['win_rate_delta']:>+9.1f}%")
        print(f"  {'Max Drawdown%':<20} {b['max_drawdown']:>9.2f}% {a['max_drawdown']:>9.2f}%")
        print(f"  {'Total Trades':<20} {b['total_trades']:>10d} {a['total_trades']:>10d}")

        print(f"\n  Best DNA params:")
        for k, v in r["best_dna"].items():
            print(f"    {k}: {v:.4f}" if isinstance(v, float) else f"    {k}: {v}")

        if r["saved_to"]:
            print(f"\n  Saved to: {r['saved_to']}")

    # Summary
    improved = sum(1 for r in results if r["improved"])
    print(f"\n{'=' * 70}")
    print(f"Summary: {improved}/{len(results)} strategies improved")
    print(f"{'=' * 70}\n")


def main() -> None:
    parser = argparse.ArgumentParser(description="Auto-evolve trading strategies")
    parser.add_argument("--strategy", choices=STRATEGY_NAMES, default=None,
                        help="Evolve a specific strategy (default: all)")
    parser.add_argument("--generations", type=int, default=10)
    parser.add_argument("--population", type=int, default=20)
    parser.add_argument("--assets", type=int, default=8,
                        help="Number of forex pairs to test against")
    parser.add_argument("--timeframe", default="1h")
    parser.add_argument("--candles", type=int, default=500)
    parser.add_argument("--json", action="store_true", help="Output raw JSON")
    args = parser.parse_args()

    # Fetch data
    assets = FOREX_ASSETS[:args.assets]
    log.info("Fetching data for %d assets...", len(assets))
    datasets = _fetch_data(assets, args.timeframe, args.candles)

    # Evolve
    strategies_to_evolve = [args.strategy] if args.strategy else STRATEGY_NAMES
    results = []

    for name in strategies_to_evolve:
        result = evolve_strategy(name, datasets, args.generations, args.population)
        results.append(result)

    # Output
    if args.json:
        # Strip non-serializable data
        for r in results:
            r.pop("history", None)
        print(json.dumps(results, indent=2))
    else:
        print_report(results)

    # Save full report
    report_dir = os.path.join(config.data_dir, "journal")
    os.makedirs(report_dir, exist_ok=True)
    report_path = os.path.join(report_dir, "evolution_report.json")
    with open(report_path, "w") as f:
        clean = []
        for r in results:
            clean.append({k: v for k, v in r.items() if k != "history"})
        json.dump(clean, f, indent=2)
    log.info("Report saved to %s", report_path)


if __name__ == "__main__":
    main()
