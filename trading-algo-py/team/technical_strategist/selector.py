"""Auto-strategy selector — picks the best strategy per asset from backtest results.

Reads backtest_results.json, ranks strategies per asset by a composite score,
and returns a mapping of asset → best strategy name. The orchestrator and
auto-trader use this to only run the winning strategy for each pair instead
of blasting all 7 strategies blindly.

Ranking formula (configurable weights):
  score = sharpe * W_sharpe + return% * W_return + win_rate * W_winrate
          + profit_factor * W_pf - max_dd% * W_dd

Minimum trade threshold: strategies with < MIN_TRADES are excluded
(not enough data to trust the result).

Fallback: if no backtest data exists for an asset, falls back to "smc"
(the overall best performer).
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field

from config.settings import config

log = logging.getLogger(__name__)

DEFAULT_FALLBACK_STRATEGY = "smc"
DEFAULT_MIN_TRADES = 3
RESULTS_PATH = os.path.join(config.data_dir, "journal", "backtest_results.json")


@dataclass
class StrategyRanking:
    """Ranking result for one asset-strategy pair."""
    asset: str
    strategy: str
    score: float
    sharpe: float
    return_pct: float
    win_rate: float
    max_dd_pct: float
    total_trades: int


@dataclass
class SelectionResult:
    """Output of the auto-selector: best strategy per asset + metadata."""
    mapping: dict[str, str] = field(default_factory=dict)         # asset → strategy
    rankings: dict[str, list[StrategyRanking]] = field(default_factory=dict)  # asset → sorted rankings
    fallback_strategy: str = DEFAULT_FALLBACK_STRATEGY
    source: str = ""  # path to the results file used


def load_backtest_results(path: str | None = None) -> list[dict]:
    """Load backtest results from JSON file."""
    p = path or RESULTS_PATH
    if not os.path.exists(p):
        log.warning("No backtest results found at %s", p)
        return []
    with open(p) as f:
        return json.load(f)


def rank_strategies(
    results: list[dict],
    w_sharpe: float = 0.35,
    w_return: float = 0.25,
    w_winrate: float = 0.15,
    w_pf: float = 0.10,
    w_dd: float = 0.15,
    min_trades: int = DEFAULT_MIN_TRADES,
) -> dict[str, list[StrategyRanking]]:
    """Rank strategies per asset using weighted scoring.

    Returns dict of asset → list of StrategyRanking sorted best-first.
    """
    # Group by asset
    by_asset: dict[str, list[dict]] = {}
    for r in results:
        by_asset.setdefault(r["asset"], []).append(r)

    rankings: dict[str, list[StrategyRanking]] = {}

    for asset, entries in by_asset.items():
        asset_rankings: list[StrategyRanking] = []

        for e in entries:
            trades = e.get("total_trades", 0)
            if trades < min_trades:
                continue

            sharpe = e.get("sharpe_ratio", 0) or 0
            ret = e.get("total_return_pct", 0) or 0
            wr = e.get("win_rate", 0) or 0
            pf = e.get("profit_factor", 0) or 0
            dd = e.get("max_drawdown_pct", 0) or 0

            # Normalised scoring:
            # Sharpe: typically 0-4, scale to 0-100
            # Return: typically 0-200%, use directly
            # Win rate: 0-100, use directly
            # Profit factor: typically 0-5, scale to 0-100
            # Max DD: typically 0-10%, penalty
            score = (
                sharpe * 25 * w_sharpe +    # Sharpe → 0-100 range
                ret * w_return +             # Return% directly
                wr * w_winrate +             # Win rate (0-100)
                pf * 20 * w_pf -             # Profit factor → 0-100 range
                dd * 10 * w_dd               # Drawdown penalty
            )

            asset_rankings.append(StrategyRanking(
                asset=asset,
                strategy=e["strategy"],
                score=score,
                sharpe=sharpe,
                return_pct=ret,
                win_rate=wr,
                max_dd_pct=dd,
                total_trades=trades,
            ))

        # Sort by score descending
        asset_rankings.sort(key=lambda r: r.score, reverse=True)
        rankings[asset] = asset_rankings

    return rankings


def select_best_strategies(
    results: list[dict] | None = None,
    results_path: str | None = None,
    fallback: str = DEFAULT_FALLBACK_STRATEGY,
    min_trades: int = DEFAULT_MIN_TRADES,
    w_sharpe: float = 0.35,
    w_return: float = 0.25,
    w_winrate: float = 0.15,
    w_pf: float = 0.10,
    w_dd: float = 0.15,
) -> SelectionResult:
    """Select the best strategy for each asset based on backtest results.

    This is the main entry point. Call this from the orchestrator or auto-trader.

    Args:
        results: Pre-loaded backtest results (optional, loads from file if None)
        results_path: Path to backtest_results.json (optional)
        fallback: Default strategy when no data exists for an asset
        min_trades: Minimum trades to trust a strategy's results
        w_sharpe/w_return/w_winrate/w_pf/w_dd: Scoring weights

    Returns:
        SelectionResult with mapping (asset → strategy) and full rankings.
    """
    path = results_path or RESULTS_PATH
    data = results or load_backtest_results(path)

    if not data:
        log.warning("No backtest data — using fallback '%s' for all assets", fallback)
        return SelectionResult(fallback_strategy=fallback, source=path)

    rankings = rank_strategies(
        data, w_sharpe=w_sharpe, w_return=w_return,
        w_winrate=w_winrate, w_pf=w_pf, w_dd=w_dd,
        min_trades=min_trades,
    )

    mapping: dict[str, str] = {}
    for asset, ranked in rankings.items():
        if ranked:
            mapping[asset] = ranked[0].strategy
        else:
            mapping[asset] = fallback

    result = SelectionResult(
        mapping=mapping,
        rankings=rankings,
        fallback_strategy=fallback,
        source=path,
    )

    log.info(
        "Auto-selected strategies for %d assets (fallback=%s)",
        len(mapping), fallback,
    )

    return result


def get_strategy_for_asset(
    selection: SelectionResult, asset_symbol: str,
) -> str:
    """Look up the best strategy for a specific asset.

    Falls back to the default if the asset wasn't in backtest results.
    """
    return selection.mapping.get(asset_symbol, selection.fallback_strategy)


def print_selection_report(selection: SelectionResult) -> str:
    """Print a human-readable report of the auto-selection."""
    lines = [
        "=" * 70,
        "AUTO-STRATEGY SELECTION REPORT",
        "=" * 70,
        f"Source: {selection.source}",
        f"Fallback: {selection.fallback_strategy}",
        f"Assets mapped: {len(selection.mapping)}",
        "",
        f"{'Asset':<12} {'Best Strategy':<16} {'Score':>8} {'Sharpe':>8} {'Return%':>9} {'WR%':>6} {'Trades':>7}",
        "-" * 70,
    ]

    for asset in sorted(selection.mapping.keys()):
        strategy = selection.mapping[asset]
        ranked = selection.rankings.get(asset, [])
        if ranked:
            best = ranked[0]
            lines.append(
                f"{asset:<12} {strategy:<16} {best.score:>8.1f} {best.sharpe:>8.2f} "
                f"{best.return_pct:>8.1f}% {best.win_rate:>5.1f} {best.total_trades:>7d}"
            )
        else:
            lines.append(f"{asset:<12} {strategy:<16} {'(fallback)':>8}")

    # Strategy frequency summary
    strategy_counts: dict[str, int] = {}
    for s in selection.mapping.values():
        strategy_counts[s] = strategy_counts.get(s, 0) + 1

    lines.extend([
        "",
        "-" * 70,
        "STRATEGY FREQUENCY:",
    ])
    for strat, count in sorted(strategy_counts.items(), key=lambda x: -x[1]):
        pct = count / len(selection.mapping) * 100 if selection.mapping else 0
        lines.append(f"  {strat:<20} {count:>3d} assets ({pct:.0f}%)")

    lines.append("=" * 70)
    report = "\n".join(lines)
    print(report)
    return report
