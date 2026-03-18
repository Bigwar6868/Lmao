import type { StrategyDNA } from '../../shared/types.js';
import { generateId } from '../../shared/utils.js';
import { config } from '../../config/index.js';
import { createModuleLogger } from '../../shared/logger.js';

const log = createModuleLogger('evolver');

/**
 * Genetic algorithm engine for evolving strategy parameters.
 * Implements mutation, crossover, selection, and elitism.
 */
export class StrategyEvolver {
  /**
   * Evolve a population of strategy DNAs into the next generation.
   */
  evolve(population: StrategyDNA[]): StrategyDNA[] {
    if (population.length === 0) return [];

    // Sort by fitness (descending)
    const sorted = [...population].sort((a, b) => b.fitness - a.fitness);

    const nextGen: StrategyDNA[] = [];

    // Elitism: keep top performers unchanged
    for (let i = 0; i < Math.min(config.elitismCount, sorted.length); i++) {
      nextGen.push({ ...sorted[i] });
    }

    // Fill remaining slots with offspring
    while (nextGen.length < config.populationSize) {
      // Tournament selection: pick 2 random parents, keep the fitter one
      const parent1 = this.tournamentSelect(sorted);
      const parent2 = this.tournamentSelect(sorted);

      // Crossover
      let child = this.crossover(parent1, parent2);

      // Mutation
      if (Math.random() < config.mutationRate) {
        child = this.mutate(child);
      }

      child.generation = Math.max(parent1.generation, parent2.generation) + 1;
      nextGen.push(child);
    }

    log.info(
      {
        generation: nextGen[0]?.generation ?? 0,
        populationSize: nextGen.length,
        bestFitness: sorted[0]?.fitness.toFixed(4),
      },
      'Evolution cycle complete'
    );

    return nextGen;
  }

  /**
   * Mutate a DNA by randomly perturbing 1-3 parameters.
   */
  mutate(dna: StrategyDNA): StrategyDNA {
    const mutated: StrategyDNA = {
      ...dna,
      id: generateId(),
      parentId: dna.id,
      params: { ...dna.params },
      mutations: [...dna.mutations],
      fitness: 0, // Will be evaluated
    };

    const paramKeys = Object.keys(mutated.params);
    const numMutations = Math.min(1 + Math.floor(Math.random() * 3), paramKeys.length);
    const keysToMutate = this.shuffle(paramKeys).slice(0, numMutations);

    for (const key of keysToMutate) {
      const oldValue = mutated.params[key];
      // Random perturbation: ±5% to ±20%
      const perturbation = 1 + (Math.random() * 0.3 - 0.15); // 0.85 to 1.15
      let newValue = oldValue * perturbation;

      // Keep integer parameters as integers
      if (Number.isInteger(oldValue)) {
        newValue = Math.round(newValue);
        newValue = Math.max(1, newValue); // Minimum 1 for periods
      } else {
        newValue = Math.round(newValue * 1000) / 1000;
      }

      // Ensure positive values for most params
      if (oldValue > 0) newValue = Math.max(0.001, newValue);

      mutated.params[key] = newValue;
      mutated.mutations.push(`${key}: ${oldValue} → ${newValue}`);
    }

    log.info(
      {
        id: mutated.id.slice(0, 8),
        parentId: mutated.parentId?.slice(0, 8),
        strategy: mutated.name,
        changes: keysToMutate.map(k => `${k}: ${dna.params[k]} → ${mutated.params[k]}`),
      },
      `Mutation applied (${keysToMutate.length} param${keysToMutate.length > 1 ? 's' : ''})`
    );

    return mutated;
  }

  /**
   * Crossover: combine parameters from two parents.
   * Uses uniform crossover — each param randomly from parent1 or parent2.
   */
  crossover(parent1: StrategyDNA, parent2: StrategyDNA): StrategyDNA {
    const child: StrategyDNA = {
      id: generateId(),
      name: parent1.name,
      generation: 0,
      parentId: parent1.id,
      params: {},
      fitness: 0,
      createdAt: Date.now(),
      mutations: [`crossover(${parent1.id.slice(0, 8)}, ${parent2.id.slice(0, 8)})`],
    };

    const allKeys = new Set([...Object.keys(parent1.params), ...Object.keys(parent2.params)]);
    for (const key of allKeys) {
      child.params[key] = Math.random() < 0.5
        ? (parent1.params[key] ?? parent2.params[key])
        : (parent2.params[key] ?? parent1.params[key]);
    }

    return child;
  }

  /**
   * Create initial population from a base DNA.
   */
  createPopulation(baseDna: StrategyDNA, size?: number): StrategyDNA[] {
    const popSize = size ?? config.populationSize;
    const population: StrategyDNA[] = [{ ...baseDna }];

    for (let i = 1; i < popSize; i++) {
      population.push(this.mutate(baseDna));
    }

    return population;
  }

  private tournamentSelect(sorted: StrategyDNA[]): StrategyDNA {
    const a = Math.floor(Math.random() * sorted.length);
    const b = Math.floor(Math.random() * sorted.length);
    return sorted[a].fitness >= sorted[b].fitness ? sorted[a] : sorted[b];
  }

  private shuffle<T>(arr: T[]): T[] {
    const result = [...arr];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }
}
