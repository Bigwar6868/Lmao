import { describe, it, expect } from 'vitest';
import type { StrategyDNA } from '../src/shared/types.js';
import { StrategyEvolver } from '../src/team/self-improver/evolver.js';

// ---- Helpers ----

function makeBaseDna(overrides?: Partial<StrategyDNA>): StrategyDNA {
  return {
    id: 'base-dna-001',
    name: 'momentum',
    generation: 0,
    parentId: null,
    params: {
      fastEma: 9,
      slowEma: 21,
      rsiPeriod: 14,
      rsiThreshold: 50,
    },
    fitness: 0.5,
    createdAt: Date.now(),
    mutations: [],
    ...overrides,
  };
}

// ---- StrategyEvolver ----

describe('StrategyEvolver', () => {
  describe('mutate', () => {
    it('should return a new DNA with different id', () => {
      const evolver = new StrategyEvolver();
      const base = makeBaseDna();
      const mutated = evolver.mutate(base);

      expect(mutated.id).not.toBe(base.id);
      expect(mutated.parentId).toBe(base.id);
    });

    it('should preserve the strategy name', () => {
      const evolver = new StrategyEvolver();
      const base = makeBaseDna({ name: 'breakout' });
      const mutated = evolver.mutate(base);
      expect(mutated.name).toBe('breakout');
    });

    it('should perturb at least one parameter', () => {
      const evolver = new StrategyEvolver();
      const base = makeBaseDna();
      const mutated = evolver.mutate(base);

      // At least one param should be different
      const keys = Object.keys(base.params);
      const changed = keys.some(k => mutated.params[k] !== base.params[k]);
      expect(changed).toBe(true);
    });

    it('should keep integer params as integers', () => {
      const evolver = new StrategyEvolver();
      const base = makeBaseDna();
      const mutated = evolver.mutate(base);

      // fastEma, slowEma, rsiPeriod, rsiThreshold are all integers
      for (const key of ['fastEma', 'slowEma', 'rsiPeriod', 'rsiThreshold']) {
        if (mutated.params[key] !== undefined) {
          expect(Number.isInteger(mutated.params[key])).toBe(true);
        }
      }
    });

    it('should record mutation in mutations array', () => {
      const evolver = new StrategyEvolver();
      const base = makeBaseDna();
      const mutated = evolver.mutate(base);
      expect(mutated.mutations.length).toBeGreaterThan(0);
    });

    it('should reset fitness to 0', () => {
      const evolver = new StrategyEvolver();
      const base = makeBaseDna({ fitness: 100 });
      const mutated = evolver.mutate(base);
      expect(mutated.fitness).toBe(0);
    });

    it('should keep params positive', () => {
      const evolver = new StrategyEvolver();
      const base = makeBaseDna();
      for (let i = 0; i < 20; i++) {
        const mutated = evolver.mutate(base);
        for (const key of Object.keys(mutated.params)) {
          expect(mutated.params[key]).toBeGreaterThan(0);
        }
      }
    });
  });

  describe('crossover', () => {
    it('should produce a child with params from both parents', () => {
      const evolver = new StrategyEvolver();
      const parent1 = makeBaseDna({ id: 'p1', params: { a: 10, b: 20, c: 30 } });
      const parent2 = makeBaseDna({ id: 'p2', params: { a: 100, b: 200, c: 300 } });
      const child = evolver.crossover(parent1, parent2);

      // Child should have all keys
      expect(child.params).toHaveProperty('a');
      expect(child.params).toHaveProperty('b');
      expect(child.params).toHaveProperty('c');

      // Each param should come from one parent
      for (const key of ['a', 'b', 'c']) {
        expect(
          child.params[key] === parent1.params[key] || child.params[key] === parent2.params[key]
        ).toBe(true);
      }
    });

    it('should set parentId to first parent', () => {
      const evolver = new StrategyEvolver();
      const parent1 = makeBaseDna({ id: 'p1' });
      const parent2 = makeBaseDna({ id: 'p2' });
      const child = evolver.crossover(parent1, parent2);
      expect(child.parentId).toBe('p1');
    });

    it('should record crossover in mutations', () => {
      const evolver = new StrategyEvolver();
      const parent1 = makeBaseDna({ id: 'parent-001' });
      const parent2 = makeBaseDna({ id: 'parent-002' });
      const child = evolver.crossover(parent1, parent2);
      expect(child.mutations.some(m => m.includes('crossover'))).toBe(true);
    });
  });

  describe('createPopulation', () => {
    it('should create population of specified size', () => {
      const evolver = new StrategyEvolver();
      const base = makeBaseDna();
      const pop = evolver.createPopulation(base, 5);
      expect(pop).toHaveLength(5);
    });

    it('should include the base DNA as first member', () => {
      const evolver = new StrategyEvolver();
      const base = makeBaseDna();
      const pop = evolver.createPopulation(base, 5);
      expect(pop[0].id).toBe(base.id);
    });

    it('should have varied parameters across population', () => {
      const evolver = new StrategyEvolver();
      const base = makeBaseDna();
      const pop = evolver.createPopulation(base, 10);

      // Not all members should have exact same params
      const paramSets = pop.map(d => JSON.stringify(d.params));
      const unique = new Set(paramSets);
      expect(unique.size).toBeGreaterThan(1);
    });
  });

  describe('evolve', () => {
    it('should return empty array for empty population', () => {
      const evolver = new StrategyEvolver();
      const result = evolver.evolve([]);
      expect(result).toHaveLength(0);
    });

    it('should preserve top performers (elitism)', () => {
      const evolver = new StrategyEvolver();
      const pop = [
        makeBaseDna({ id: 'top', fitness: 100, params: { a: 1 } }),
        makeBaseDna({ id: 'mid', fitness: 50, params: { a: 2 } }),
        makeBaseDna({ id: 'low', fitness: 10, params: { a: 3 } }),
      ];
      const nextGen = evolver.evolve(pop);
      // Top performer should be in next gen (elitism)
      const topInNextGen = nextGen.some(d =>
        d.params.a === 1 && d.fitness === 100
      );
      expect(topInNextGen).toBe(true);
    });

    it('should increment generation for offspring', () => {
      const evolver = new StrategyEvolver();
      const pop = Array.from({ length: 5 }, (_, i) =>
        makeBaseDna({ id: `dna-${i}`, fitness: 50 - i * 10, generation: 3 }),
      );
      const nextGen = evolver.evolve(pop);
      // Offspring (non-elite) should have generation > 3
      const offspring = nextGen.filter(d => d.fitness === 0);
      for (const o of offspring) {
        expect(o.generation).toBeGreaterThan(3);
      }
    });
  });
});
