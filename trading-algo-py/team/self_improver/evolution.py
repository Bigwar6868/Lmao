"""Self-improver — genetic algorithm for strategy parameter evolution."""

from __future__ import annotations

import copy
import logging
import random
import time
import uuid

from shared.types import MarketData, StrategyDNA, BacktestResult
from team.technical_strategist.strategies import create_strategy, ALL_STRATEGIES
from team.backtester.engine import Backtester
from config.settings import config

log = logging.getLogger(__name__)


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

        log.info("SelfImprover initialised (pop=%d, mut=%.2f)", self.pop_size, self.mutation_rate)

    def evolve(self, strategy_name: str, market_data: MarketData, generations: int = 5) -> StrategyDNA:
        """Evolve a strategy's parameters over multiple generations.

        Args:
            strategy_name: Name of strategy to evolve
            market_data: Historical data to backtest against
            generations: Number of generations to run

        Returns:
            The best-performing DNA after evolution.
        """
        if strategy_name not in ALL_STRATEGIES:
            raise ValueError(f"Unknown strategy: {strategy_name}")

        # Initialise population
        population = self._init_population(strategy_name)
        best_overall: StrategyDNA | None = None
        best_fitness = float("-inf")

        for gen in range(generations):
            self.generation += 1

            # Evaluate fitness
            results: list[tuple[StrategyDNA, float]] = []
            for dna in population:
                strategy = create_strategy(strategy_name, dna)
                result = self.backtester.run(strategy, market_data)
                fitness = self._calc_fitness(result)
                dna.fitness = fitness
                results.append((dna, fitness))

            # Sort by fitness
            results.sort(key=lambda x: x[1], reverse=True)

            if results[0][1] > best_fitness:
                best_fitness = results[0][1]
                best_overall = copy.deepcopy(results[0][0])

            log.info(
                "Gen %d/%d: best=%.4f, avg=%.4f",
                gen + 1, generations, results[0][1],
                sum(f for _, f in results) / len(results),
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
        """Create initial population with randomised parameters."""
        base = create_strategy(strategy_name).get_default_dna()
        population = [copy.deepcopy(base)]

        for _ in range(self.pop_size - 1):
            dna = copy.deepcopy(base)
            dna.id = str(uuid.uuid4())[:8]
            # Randomise each param within +-50%
            for key, val in dna.params.items():
                if isinstance(val, (int, float)):
                    factor = random.uniform(0.5, 1.5)
                    dna.params[key] = type(val)(val * factor)
            population.append(dna)

        return population

    def _calc_fitness(self, result: BacktestResult) -> float:
        """Multi-objective fitness: return * sharpe * win_rate, penalise drawdown."""
        m = result.metrics
        if m.total_trades < 3:
            return -1.0

        fitness = (
            m.total_return_pct * 0.3 +
            m.sharpe_ratio * 20 * 0.3 +
            m.win_rate * 100 * 0.2 +
            m.profit_factor * 10 * 0.1 -
            m.max_drawdown_pct * 0.1
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

        child.mutations = ["crossover"]
        return child

    def _mutate(self, dna: StrategyDNA) -> StrategyDNA:
        """Apply random mutations to parameters."""
        for key, val in dna.params.items():
            if random.random() < self.mutation_rate:
                if isinstance(val, (int, float)):
                    factor = random.gauss(1.0, 0.2)
                    new_val = type(val)(val * factor)
                    if isinstance(val, int):
                        new_val = max(1, int(new_val))
                    dna.params[key] = new_val
                    dna.mutations.append(f"mutate:{key}")
        return dna
