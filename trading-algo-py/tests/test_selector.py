"""Tests for the auto-strategy selector."""

import pytest
from team.technical_strategist.selector import (
    rank_strategies,
    select_best_strategies,
    get_strategy_for_asset,
    print_selection_report,
    SelectionResult,
)

SAMPLE_RESULTS = [
    {
        "asset": "EUR/USD",
        "strategy": "momentum",
        "total_return_pct": 18.0,
        "sharpe_ratio": 1.25,
        "max_drawdown_pct": 1.3,
        "win_rate": 45.0,
        "profit_factor": 1.5,
        "total_trades": 10,
    },
    {
        "asset": "EUR/USD",
        "strategy": "breakout",
        "total_return_pct": 25.0,
        "sharpe_ratio": 1.8,
        "max_drawdown_pct": 3.0,
        "win_rate": 50.0,
        "profit_factor": 2.1,
        "total_trades": 12,
    },
    {
        "asset": "EUR/USD",
        "strategy": "smc",
        "total_return_pct": 5.0,
        "sharpe_ratio": 0.5,
        "max_drawdown_pct": 0.5,
        "win_rate": 30.0,
        "profit_factor": 0.8,
        "total_trades": 2,  # Below min_trades threshold
    },
    {
        "asset": "GBP/USD",
        "strategy": "momentum",
        "total_return_pct": 10.0,
        "sharpe_ratio": 0.9,
        "max_drawdown_pct": 2.0,
        "win_rate": 40.0,
        "profit_factor": 1.2,
        "total_trades": 8,
    },
]


class TestRankStrategies:
    def test_ranks_by_composite_score(self):
        rankings = rank_strategies(SAMPLE_RESULTS)
        assert "EUR/USD" in rankings
        # breakout should beat momentum (higher sharpe, return, win_rate, pf)
        assert rankings["EUR/USD"][0].strategy == "breakout"
        assert rankings["EUR/USD"][1].strategy == "momentum"

    def test_excludes_low_trade_count(self):
        rankings = rank_strategies(SAMPLE_RESULTS, min_trades=3)
        eur_strats = [r.strategy for r in rankings["EUR/USD"]]
        assert "smc" not in eur_strats  # Only 2 trades

    def test_includes_with_lower_threshold(self):
        rankings = rank_strategies(SAMPLE_RESULTS, min_trades=1)
        eur_strats = [r.strategy for r in rankings["EUR/USD"]]
        assert "smc" in eur_strats

    def test_empty_results(self):
        rankings = rank_strategies([])
        assert rankings == {}

    def test_single_asset_single_strategy(self):
        data = [SAMPLE_RESULTS[3]]  # Only GBP/USD momentum
        rankings = rank_strategies(data)
        assert len(rankings["GBP/USD"]) == 1
        assert rankings["GBP/USD"][0].strategy == "momentum"


class TestSelectBestStrategies:
    def test_selects_best_per_asset(self):
        result = select_best_strategies(results=SAMPLE_RESULTS)
        assert result.mapping["EUR/USD"] == "breakout"
        assert result.mapping["GBP/USD"] == "momentum"

    def test_fallback_on_empty(self):
        result = select_best_strategies(results=[], results_path="/nonexistent/path.json")
        assert result.mapping == {}
        assert result.fallback_strategy == "smc"

    def test_custom_fallback(self):
        result = select_best_strategies(results=[], fallback="momentum")
        assert result.fallback_strategy == "momentum"


class TestGetStrategyForAsset:
    def test_returns_mapped_strategy(self):
        result = select_best_strategies(results=SAMPLE_RESULTS)
        assert get_strategy_for_asset(result, "EUR/USD") == "breakout"

    def test_returns_fallback_for_unknown(self):
        result = select_best_strategies(results=SAMPLE_RESULTS, fallback="smc")
        assert get_strategy_for_asset(result, "AUD/USD") == "smc"


class TestPrintReport:
    def test_report_output(self):
        result = select_best_strategies(results=SAMPLE_RESULTS)
        report = print_selection_report(result)
        assert "EUR/USD" in report
        assert "breakout" in report
        assert "STRATEGY FREQUENCY" in report
