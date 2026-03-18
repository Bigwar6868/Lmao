"""Full backtest — run all strategies across multiple assets and report results."""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time

from config.settings import config
from config.assets import FOREX_ASSETS, CRYPTO_ASSETS, ALL_ASSETS
from shared.types import MarketData, BacktestResult, PerformanceMetrics
from shared.synthetic import generate_synthetic_candles
from team.backtester.engine import Backtester
from team.technical_strategist.strategies import get_all_strategies

logging.basicConfig(
    level=config.log_level,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
)
log = logging.getLogger("backtest")

STRATEGIES = ["momentum", "mean_reversion", "breakout", "multi_indicator"]


def _fetch_candles(asset, timeframe: str, count: int):
    """Fetch candles — try OANDA for forex, fall back to synthetic."""
    if config.has_oanda_credentials and asset.asset_class.value == "forex":
        try:
            from team.market_analyst.oanda import OandaDataFetcher
            fetcher = OandaDataFetcher()
            candles = fetcher.fetch_candles(asset.symbol, timeframe, count=count)
            if candles and len(candles) >= 30:
                return candles, "live"
        except Exception as e:
            log.warning("OANDA fetch failed for %s: %s", asset.symbol, e)

    # Synthetic fallback
    interval_ms = {"1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000}.get(timeframe, 3_600_000)
    candles = generate_synthetic_candles(asset.symbol, count=count, interval_ms=interval_ms)
    return candles, "synthetic"


def run_backtest(
    assets: list | None = None,
    timeframe: str = "1h",
    candle_count: int = 500,
    initial_capital: float = 10_000,
) -> list[dict]:
    """Run all strategies on selected assets, return results."""
    if assets is None:
        assets = FOREX_ASSETS[:10]  # Top 10 forex pairs by default

    strategies = get_all_strategies()
    backtester = Backtester(initial_capital=initial_capital)
    results: list[dict] = []

    for asset in assets:
        candles, source = _fetch_candles(asset, timeframe, candle_count)
        market_data = MarketData(
            asset=asset, timeframe=timeframe, candles=candles,
            last_updated=int(time.time() * 1000),
        )

        for strategy in strategies:
            result = backtester.run(strategy, market_data)
            m = result.metrics
            results.append({
                "asset": asset.symbol,
                "strategy": result.strategy,
                "source": source,
                "total_return_pct": round(m.total_return_pct, 2),
                "sharpe_ratio": round(m.sharpe_ratio, 3),
                "max_drawdown_pct": round(m.max_drawdown_pct, 2),
                "calmar_ratio": round(m.calmar_ratio, 3),
                "win_rate": round(m.win_rate * 100, 1),
                "profit_factor": round(m.profit_factor, 3),
                "total_trades": m.total_trades,
                "winning_trades": m.winning_trades,
                "losing_trades": m.losing_trades,
                "avg_win": round(m.avg_win, 4),
                "avg_loss": round(m.avg_loss, 4),
            })

    return results


def _aggregate_by_strategy(results: list[dict]) -> dict[str, dict]:
    """Aggregate results per strategy."""
    agg: dict[str, dict] = {}
    for r in results:
        name = r["strategy"]
        if name not in agg:
            agg[name] = {
                "returns": [], "sharpes": [], "drawdowns": [],
                "win_rates": [], "profit_factors": [], "total_trades": 0,
                "winning_trades": 0, "losing_trades": 0,
            }
        a = agg[name]
        a["returns"].append(r["total_return_pct"])
        a["sharpes"].append(r["sharpe_ratio"])
        a["drawdowns"].append(r["max_drawdown_pct"])
        a["win_rates"].append(r["win_rate"])
        a["profit_factors"].append(r["profit_factor"])
        a["total_trades"] += r["total_trades"]
        a["winning_trades"] += r["winning_trades"]
        a["losing_trades"] += r["losing_trades"]
    return agg


def print_report(results: list[dict]) -> str:
    """Print a formatted backtest report and return it as string."""
    agg = _aggregate_by_strategy(results)
    lines: list[str] = []

    lines.append("=" * 70)
    lines.append("BACKTEST REPORT")
    lines.append("=" * 70)
    lines.append(f"Assets tested: {len(set(r['asset'] for r in results))}")
    lines.append(f"Strategies: {len(agg)}")
    lines.append(f"Data source: {results[0]['source'] if results else 'N/A'}")
    lines.append("")

    # Per-strategy summary
    lines.append("-" * 70)
    lines.append(f"{'Strategy':<20} {'Avg Return%':>11} {'Avg Sharpe':>11} "
                 f"{'Max DD%':>8} {'Win Rate%':>10} {'Trades':>7}")
    lines.append("-" * 70)

    ranked = []
    for name, a in agg.items():
        n = len(a["returns"])
        avg_ret = sum(a["returns"]) / n
        avg_sharpe = sum(a["sharpes"]) / n
        worst_dd = max(a["drawdowns"])
        avg_wr = sum(a["win_rates"]) / n
        total_t = a["total_trades"]
        ranked.append((name, avg_ret, avg_sharpe, worst_dd, avg_wr, total_t))

    ranked.sort(key=lambda x: x[2], reverse=True)  # Sort by Sharpe

    for name, avg_ret, avg_sharpe, worst_dd, avg_wr, total_t in ranked:
        lines.append(
            f"{name:<20} {avg_ret:>10.2f}% {avg_sharpe:>11.3f} "
            f"{worst_dd:>7.2f}% {avg_wr:>9.1f}% {total_t:>7d}"
        )

    lines.append("")

    # Best and worst individual results
    lines.append("-" * 70)
    lines.append("TOP 5 BEST PERFORMERS:")
    top = sorted(results, key=lambda r: r["sharpe_ratio"], reverse=True)[:5]
    for r in top:
        lines.append(
            f"  {r['asset']:<12} {r['strategy']:<20} "
            f"Sharpe={r['sharpe_ratio']:>7.3f}  Return={r['total_return_pct']:>7.2f}%  "
            f"WR={r['win_rate']:.0f}%"
        )

    lines.append("")
    lines.append("BOTTOM 5 WORST PERFORMERS:")
    bottom = sorted(results, key=lambda r: r["sharpe_ratio"])[:5]
    for r in bottom:
        lines.append(
            f"  {r['asset']:<12} {r['strategy']:<20} "
            f"Sharpe={r['sharpe_ratio']:>7.3f}  Return={r['total_return_pct']:>7.2f}%  "
            f"WR={r['win_rate']:.0f}%"
        )

    lines.append("")

    # Warnings
    lines.append("-" * 70)
    lines.append("WARNINGS:")
    warnings_found = False

    for name, avg_ret, avg_sharpe, worst_dd, avg_wr, total_t in ranked:
        if avg_sharpe < 0:
            lines.append(f"  [!] {name}: negative Sharpe ({avg_sharpe:.3f}) — losing money on average")
            warnings_found = True
        if worst_dd > 15:
            lines.append(f"  [!] {name}: high max drawdown ({worst_dd:.1f}%) — risk of ruin")
            warnings_found = True
        if avg_wr < 40:
            lines.append(f"  [!] {name}: low win rate ({avg_wr:.1f}%) — needs better entry filters")
            warnings_found = True
        if total_t < 5:
            lines.append(f"  [!] {name}: very few trades ({total_t}) — may not be generating signals")
            warnings_found = True

    if not warnings_found:
        lines.append("  No major warnings.")

    lines.append("=" * 70)

    report = "\n".join(lines)
    print(report)

    # Save to journal
    journal_dir = os.path.join(config.data_dir, "journal")
    os.makedirs(journal_dir, exist_ok=True)
    journal_path = os.path.join(journal_dir, "backtest_results.json")
    with open(journal_path, "w") as f:
        json.dump(results, f, indent=2)
    log.info("Results saved to %s", journal_path)

    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="Run full backtest")
    parser.add_argument("--assets", choices=["forex", "crypto", "all"], default="forex")
    parser.add_argument("--timeframe", default="1h")
    parser.add_argument("--candles", type=int, default=500)
    parser.add_argument("--capital", type=float, default=10_000)
    parser.add_argument("--json", action="store_true", help="Output raw JSON")
    args = parser.parse_args()

    asset_map = {"forex": FOREX_ASSETS, "crypto": CRYPTO_ASSETS[:10], "all": ALL_ASSETS[:20]}
    assets = asset_map[args.assets]

    results = run_backtest(assets, args.timeframe, args.candles, args.capital)

    if args.json:
        print(json.dumps(results, indent=2))
    else:
        print_report(results)


if __name__ == "__main__":
    main()
