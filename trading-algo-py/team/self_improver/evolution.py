"""Self-improver — genetic algorithm for strategy parameter evolution.

Evolves strategy DNA parameters using:
1. Multi-objective fitness (Sharpe × return × win_rate - drawdown penalty)
2. Tournament selection + uniform crossover + Gaussian mutation
3. Parameter bounds to prevent degenerate configs
4. Multi-asset evaluation for robustness
5. Persistent DNA storage (saves best to data/evolved/)

AI Auto-Evolution Prompt (used by scripts/evolve.py):
  The system runs evolution autonomously:
  - Backtests each DNA variant across multiple assets
  - Selects winners by risk-adjusted return (Sharpe is king)
  - Breeds top performers, mutates parameters within safe bounds
  - Saves best DNA to disk and applies it to live strategies
"""

from __future__ import annotations

import copy
import json
import logging
import os
import random
import time
import uuid

from shared.types import MarketData, StrategyDNA, BacktestResult
from team.technical_strategist.strategies import create_strategy, ALL_STRATEGIES
from team.backtester.engine import Backtester
from config.settings import config

log = logging.getLogger(__name__)

# Parameter bounds — prevent degenerate values from mutation
PARAM_BOUNDS: dict[str, tuple[float, float]] = {
    # Periods (must be >= 2, reasonable upper limit)
    "fast_ema": (3, 50),
    "slow_ema": (10, 100),
    "ema_fast": (3, 50),
    "ema_slow": (10, 100),
    "rsi_period": (5, 30),
    "bb_period": (10, 50),
    "lookback": (10, 50),
    "atr_period": (5, 30),
    "macd_fast": (5, 20),
    "macd_slow": (15, 50),
    "macd_signal": (3, 15),
    "stoch_k": (5, 30),
    "stoch_d": (2, 10),
    "trend_period": (20, 100),
    # RSI thresholds
    "rsi_overbought": (60, 85),
    "rsi_oversold": (15, 40),
    # Multipliers / ratios
    "bb_std": (1.0, 3.5),
    "atr_multiplier": (0.8, 3.0),
    "atr_expansion": (1.0, 2.0),
    "volume_threshold": (1.0, 3.0),
    "min_bb_width_pct": (0.2, 2.0),
    # Weights (must sum to ~1.0, handled separately)
    "w_ema": (0.05, 0.5),
    "w_rsi": (0.05, 0.5),
    "w_macd": (0.05, 0.5),
    "w_stoch": (0.05, 0.5),
    # Thresholds
    "threshold": (0.15, 0.6),
    "min_confidence": (0.3, 0.8),
    "adx_threshold": (10, 35),
    # SMC parameters
    "swing_lookback": (3, 10),
    "displacement_threshold": (1.0, 3.0),
    "min_reversal_pct": (0.1, 1.0),
    "fvg_recency": (10, 40),
    "ob_recency": (10, 40),
    "structure_weight": (0.05, 0.5),
    "fvg_weight": (0.05, 0.5),
    "sweep_weight": (0.05, 0.5),
    "pd_weight": (0.05, 0.5),
    # SMC v3 / ICT enhancements
    "use_kill_zones": (0.0, 1.0),
    "use_po3": (0.0, 1.0),
    # Silver Bullet parameters
    "require_window": (0.0, 1.0),
    # ICT 2022 parameters
    "require_all_phases": (0.0, 1.0),
    "sweep_recency": (10, 30),
    "mss_recency": (15, 40),
}


def _clamp_param(key: str, val: float) -> float:
    """Clamp a parameter to its allowed bounds."""
    bounds = PARAM_BOUNDS.get(key)
    if bounds:
        return max(bounds[0], min(bounds[1], val))
    return val


def _normalise_weights(params: dict) -> dict:
    """Ensure w_ema + w_rsi + w_macd + w_stoch = 1.0."""
    weight_keys = [k for k in params if k.startswith("w_")]
    if not weight_keys:
        return params
    total = sum(params[k] for k in weight_keys)
    if total > 0:
        for k in weight_keys:
            params[k] = params[k] / total
    return params


class SelfImprover:
    """Evolves strategy parameters using a genetic algorithm."""

    def __init__(
        self,
        population_size: int | None = None,
        mutation_rate: float | None = None,
        elitism_count: int | None = None,
    ) -> None:
        self.pop_size = population_size or config.population_size
        self.mutation_rate = mutation_rate or config.mutation_rate
        self.elitism = elitism_count or config.elitism_count
        self.backtester = Backtester()
        self.generation = 0
        self.best_dna: dict[str, StrategyDNA] = {}
        self.history: list[dict] = []  # Track fitness over generations

        log.info("SelfImprover initialised (pop=%d, mut=%.2f)", self.pop_size, self.mutation_rate)

    def evolve(
        self,
        strategy_name: str,
        market_data: MarketData | list[MarketData],
        generations: int = 5,
    ) -> StrategyDNA:
        """Evolve a strategy's parameters over multiple generations.

        Args:
            strategy_name: Name of strategy to evolve
            market_data: Single MarketData or list for multi-asset evaluation
            generations: Number of generations to run

        Returns:
            The best-performing DNA after evolution.
        """
        if strategy_name not in ALL_STRATEGIES:
            raise ValueError(f"Unknown strategy: {strategy_name}")

        # Support both single and multi-asset
        datasets = market_data if isinstance(market_data, list) else [market_data]

        # Initialise population
        population = self._init_population(strategy_name)
        best_overall: StrategyDNA | None = None
        best_fitness = float("-inf")

        for gen in range(generations):
            self.generation += 1

            # Evaluate fitness across ALL datasets (multi-asset robustness)
            results: list[tuple[StrategyDNA, float]] = []
            for dna in population:
                strategy = create_strategy(strategy_name, dna)
                fitness_scores = []
                for data in datasets:
                    result = self.backtester.run(strategy, data)
                    fitness_scores.append(self._calc_fitness(result))

                # Average fitness across assets — rewards consistency
                avg_fitness = sum(fitness_scores) / len(fitness_scores)
                # Penalise high variance (inconsistent across assets)
                if len(fitness_scores) > 1:
                    mean = avg_fitness
                    variance = sum((f - mean) ** 2 for f in fitness_scores) / len(fitness_scores)
                    avg_fitness -= variance * 0.05  # Small penalty for inconsistency

                dna.fitness = avg_fitness
                results.append((dna, avg_fitness))

            # Sort by fitness
            results.sort(key=lambda x: x[1], reverse=True)

            if results[0][1] > best_fitness:
                best_fitness = results[0][1]
                best_overall = copy.deepcopy(results[0][0])

            gen_info = {
                "generation": gen + 1,
                "best_fitness": results[0][1],
                "avg_fitness": sum(f for _, f in results) / len(results),
                "worst_fitness": results[-1][1],
                "best_params": dict(results[0][0].params),
            }
            self.history.append(gen_info)

            log.info(
                "Gen %d/%d: best=%.2f, avg=%.2f, worst=%.2f",
                gen + 1, generations, gen_info["best_fitness"],
                gen_info["avg_fitness"], gen_info["worst_fitness"],
            )

            # Selection + crossover + mutation
            elite = [copy.deepcopy(dna) for dna, _ in results[:self.elitism]]
            new_pop = list(elite)

            while len(new_pop) < self.pop_size:
                parent1 = self._tournament_select(results)
                parent2 = self._tournament_select(results)
                child = self._crossover(parent1, parent2, strategy_name)
                child = self._mutate(child)
                new_pop.append(child)

            population = new_pop

        if best_overall:
            self.best_dna[strategy_name] = best_overall
            log.info("Evolution complete for %s: fitness=%.4f", strategy_name, best_fitness)

        return best_overall or population[0]

    def _init_population(self, strategy_name: str) -> list[StrategyDNA]:
        """Create initial population with randomised parameters within bounds."""
        base = create_strategy(strategy_name).get_default_dna()
        population = [copy.deepcopy(base)]

        for _ in range(self.pop_size - 1):
            dna = copy.deepcopy(base)
            dna.id = str(uuid.uuid4())[:8]
            # Randomise each param within bounds
            for key, val in dna.params.items():
                if isinstance(val, (int, float)):
                    factor = random.uniform(0.5, 1.5)
                    new_val = val * factor
                    new_val = _clamp_param(key, new_val)
                    dna.params[key] = type(val)(new_val)
            dna.params = _normalise_weights(dna.params)
            population.append(dna)

        return population

    def _calc_fitness(self, result: BacktestResult) -> float:
        """Multi-objective fitness: prioritise Sharpe, then return, then win rate."""
        m = result.metrics
        if m.total_trades < 3:
            return -1.0

        fitness = (
            m.sharpe_ratio * 25 * 0.35 +      # 35% Sharpe (risk-adjusted is king)
            m.total_return_pct * 0.25 +         # 25% raw return
            m.win_rate * 100 * 0.2 +            # 20% win rate
            m.profit_factor * 10 * 0.1 -        # 10% profitability ratio
            m.max_drawdown_pct * 0.15           # 15% drawdown penalty (increased)
        )
        return fitness

    def _tournament_select(self, results: list[tuple[StrategyDNA, float]], k: int = 3) -> StrategyDNA:
        """Tournament selection."""
        tournament = random.sample(results, min(k, len(results)))
        winner = max(tournament, key=lambda x: x[1])
        return copy.deepcopy(winner[0])

    def _crossover(self, p1: StrategyDNA, p2: StrategyDNA, strategy_name: str) -> StrategyDNA:
        """Uniform crossover between two parents."""
        child = copy.deepcopy(p1)
        child.id = str(uuid.uuid4())[:8]
        child.parent_id = p1.id
        child.generation = self.generation
        child.created_at = int(time.time() * 1000)

        for key in child.params:
            if key in p2.params and random.random() < 0.5:
                child.params[key] = p2.params[key]

        child.params = _normalise_weights(child.params)
        child.mutations = ["crossover"]
        return child

    def _mutate(self, dna: StrategyDNA) -> StrategyDNA:
        """Apply random mutations to parameters, clamped to bounds."""
        for key, val in dna.params.items():
            if random.random() < self.mutation_rate:
                if isinstance(val, (int, float)):
                    factor = random.gauss(1.0, 0.2)
                    new_val = val * factor
                    new_val = _clamp_param(key, new_val)
                    if isinstance(val, int):
                        new_val = max(1, int(new_val))
                    dna.params[key] = type(val)(new_val) if isinstance(val, int) else new_val
                    dna.mutations.append(f"mutate:{key}")
        dna.params = _normalise_weights(dna.params)
        return dna

    # ── Persistence ──────────────────────────────────────────

    def save_best(self, strategy_name: str, tag: str = "") -> str | None:
        """Save the best DNA for a strategy to disk."""
        dna = self.best_dna.get(strategy_name)
        if not dna:
            log.warning("No best DNA for %s to save", strategy_name)
            return None

        evolved_dir = os.path.join(config.data_dir, "evolved")
        os.makedirs(evolved_dir, exist_ok=True)

        filename = f"{strategy_name}{'_' + tag if tag else ''}.json"
        path = os.path.join(evolved_dir, filename)

        payload = {
            "strategy": strategy_name,
            "dna_id": dna.id,
            "generation": dna.generation,
            "fitness": dna.fitness,
            "params": dna.params,
            "parent_id": dna.parent_id,
            "mutations": dna.mutations,
            "evolved_at": int(time.time() * 1000),
            "history": self.history,
        }

        with open(path, "w") as f:
            json.dump(payload, f, indent=2)

        log.info("Saved evolved DNA to %s (fitness=%.4f)", path, dna.fitness)
        return path

    @staticmethod
    def load_dna(strategy_name: str, tag: str = "") -> StrategyDNA | None:
        """Load a previously evolved DNA from disk."""
        evolved_dir = os.path.join(config.data_dir, "evolved")
        filename = f"{strategy_name}{'_' + tag if tag else ''}.json"
        path = os.path.join(evolved_dir, filename)

        if not os.path.exists(path):
            return None

        with open(path) as f:
            payload = json.load(f)

        return StrategyDNA(
            id=payload["dna_id"],
            name=strategy_name,
            generation=payload.get("generation", 0),
            parent_id=payload.get("parent_id"),
            params=payload["params"],
            fitness=payload.get("fitness", 0),
            created_at=payload.get("evolved_at", 0),
            mutations=payload.get("mutations", []),
        )
