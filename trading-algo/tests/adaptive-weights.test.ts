import { describe, it, expect } from 'vitest';
import {
  detectRegime,
  computeAdaptiveWeights,
  formatAdaptiveWeights,
} from '../src/team/macro-economist/adaptive-weights.js';
import type { MacroIndicator } from '../src/shared/types.js';
import type { GlobalMacroSnapshot, GeopoliticalFactor, PolicyChange } from '../src/team/macro-economist/types.js';

// ---- Helpers ----

function makeIndicators(overrides: Partial<Record<string, { value: number; previousValue: number }>> = {}): MacroIndicator[] {
  const defaults: Record<string, { value: number; previousValue: number }> = {
    FEDFUNDS: { value: 5.25, previousValue: 5.25 },
    CPIAUCSL: { value: 314, previousValue: 313 },
    T10Y2Y: { value: -0.3, previousValue: -0.4 },
    VIXCLS: { value: 18, previousValue: 17 },
    UNRATE: { value: 3.7, previousValue: 3.8 },
    ...overrides,
  };

  return Object.entries(defaults).map(([name, data]) => ({
    name,
    value: data.value,
    previousValue: data.previousValue,
    date: '2026-03-16',
    source: 'test',
    impact: 'high' as const,
  }));
}

function makeGlobalSnapshots(): GlobalMacroSnapshot[] {
  return [
    { region: 'United States', indicators: { gdpGrowth: 2.1, inflation: 3.2, unemployment: 4.1, fedFunds: 5.25 }, policyStance: 'hawkish', growthOutlook: 'slowing', inflationTrend: 'sticky', timestamp: Date.now() },
    { region: 'Eurozone', indicators: { gdpGrowth: 0.8, inflation: 2.4, unemployment: 6.5 }, policyStance: 'dovish', growthOutlook: 'slowing', inflationTrend: 'falling', timestamp: Date.now() },
    { region: 'China', indicators: { gdpGrowth: 4.8, inflation: 0.3, unemployment: 5.2 }, policyStance: 'dovish', growthOutlook: 'recovering', inflationTrend: 'falling', timestamp: Date.now() },
    { region: 'Japan', indicators: { gdpGrowth: 1.1, inflation: 2.8, unemployment: 2.5 }, policyStance: 'hawkish', growthOutlook: 'expanding', inflationTrend: 'rising', timestamp: Date.now() },
    { region: 'United Kingdom', indicators: { gdpGrowth: 0.6, inflation: 3.0, unemployment: 4.3 }, policyStance: 'neutral', growthOutlook: 'slowing', inflationTrend: 'stable', timestamp: Date.now() },
  ];
}

function makeFactors(overrides?: Partial<GeopoliticalFactor>[]): GeopoliticalFactor[] {
  const base: GeopoliticalFactor = {
    category: 'conflict',
    region: 'Test',
    description: 'Test factor',
    severity: 'medium',
    affectedAssets: ['BTC/USDT'],
    marketImpact: 'volatile',
  };
  return (overrides ?? [{ severity: 'medium' as const }]).map(o => ({ ...base, ...o }));
}

// ---- Regime Detection ----

describe('detectRegime', () => {
  it('should detect crisis when VIX > 35 and yield curve deeply inverted', () => {
    const result = detectRegime({
      gdpGrowth: 0.5, inflation: 5.0,
      fedRate: 5.5, previousFedRate: 5.25,
      yieldCurve: -0.8, vix: 40,
      unemployment: 5.5, previousUnemployment: 4.5,
      globalPolicyBias: 'hawkish',
      highImpactPeriod: false,
      activeConflicts: 2, activeSanctions: 1,
    });
    expect(result.regime).toBe('crisis');
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('should detect goldilocks when growth moderate, inflation low, VIX low', () => {
    const result = detectRegime({
      gdpGrowth: 3.0, inflation: 2.5,
      fedRate: 4.0, previousFedRate: 4.0,
      yieldCurve: 1.2, vix: 12,
      unemployment: 3.5, previousUnemployment: 3.5,
      globalPolicyBias: 'dovish',
      highImpactPeriod: false,
      activeConflicts: 0, activeSanctions: 0,
    });
    expect(result.regime).toBe('goldilocks');
  });

  it('should detect stagflation with weak growth + high inflation', () => {
    const result = detectRegime({
      gdpGrowth: 0.5, inflation: 6.0,
      fedRate: 5.5, previousFedRate: 5.0,
      yieldCurve: -0.3, vix: 22,
      unemployment: 4.5, previousUnemployment: 4.2,
      globalPolicyBias: 'hawkish',
      highImpactPeriod: false,
      activeConflicts: 1, activeSanctions: 0,
    });
    expect(result.regime).toBe('stagflation');
  });

  it('should detect recovery when growth strong + rates falling', () => {
    const result = detectRegime({
      gdpGrowth: 3.5, inflation: 1.5,
      fedRate: 3.0, previousFedRate: 4.0,
      yieldCurve: 1.5, vix: 16,
      unemployment: 4.0, previousUnemployment: 4.0,
      globalPolicyBias: 'dovish',
      highImpactPeriod: false,
      activeConflicts: 0, activeSanctions: 0,
    });
    expect(['recovery', 'reflation', 'goldilocks']).toContain(result.regime);
  });

  it('should detect overheating with strong growth + high inflation + rising rates', () => {
    const result = detectRegime({
      gdpGrowth: 4.0, inflation: 5.0,
      fedRate: 6.0, previousFedRate: 5.5,
      yieldCurve: 0.3, vix: 20,
      unemployment: 3.0, previousUnemployment: 3.0,
      globalPolicyBias: 'hawkish',
      highImpactPeriod: false,
      activeConflicts: 0, activeSanctions: 0,
    });
    expect(result.regime).toBe('overheating');
  });

  it('should detect deflation with weak growth + low inflation', () => {
    const result = detectRegime({
      gdpGrowth: 0.3, inflation: 0.5,
      fedRate: 2.0, previousFedRate: 3.0,
      yieldCurve: 0.2, vix: 20,
      unemployment: 5.0, previousUnemployment: 4.5,
      globalPolicyBias: 'dovish',
      highImpactPeriod: false,
      activeConflicts: 0, activeSanctions: 0,
    });
    expect(result.regime).toBe('deflation');
  });

  it('should return a valid regime even for neutral inputs', () => {
    const result = detectRegime({
      gdpGrowth: 2.0, inflation: 3.0,
      fedRate: 5.0, previousFedRate: 5.0,
      yieldCurve: 0.0, vix: 18,
      unemployment: 4.0, previousUnemployment: 4.0,
      globalPolicyBias: 'mixed',
      highImpactPeriod: false,
      activeConflicts: 0, activeSanctions: 0,
    });
    expect(result.regime).toBeDefined();
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });
});

// ---- Adaptive Weights Computation ----

describe('computeAdaptiveWeights', () => {
  it('should return weights that sum to ~1 for strategies', () => {
    const weights = computeAdaptiveWeights(
      makeIndicators(),
      makeGlobalSnapshots(),
      makeFactors(),
      [],
      'mixed',
      false,
    );
    const sum = weights.strategyWeights.momentum +
      weights.strategyWeights.meanReversion +
      weights.strategyWeights.breakout +
      weights.strategyWeights.multiIndicator;
    expect(sum).toBeCloseTo(1.0, 1);
  });

  it('should have positive risk multipliers', () => {
    const weights = computeAdaptiveWeights(
      makeIndicators(),
      makeGlobalSnapshots(),
      makeFactors(),
      [],
      'mixed',
      false,
    );
    expect(weights.riskMultipliers.positionSize).toBeGreaterThan(0);
    expect(weights.riskMultipliers.stopLossWidth).toBeGreaterThan(0);
    expect(weights.riskMultipliers.maxExposure).toBeGreaterThan(0);
  });

  it('should reduce position sizes during high-impact events', () => {
    const normal = computeAdaptiveWeights(
      makeIndicators(),
      makeGlobalSnapshots(),
      makeFactors(),
      [],
      'mixed',
      false,
    );
    const eventDay = computeAdaptiveWeights(
      makeIndicators(),
      makeGlobalSnapshots(),
      makeFactors(),
      [],
      'mixed',
      true,
    );
    expect(eventDay.riskMultipliers.positionSize).toBeLessThan(normal.riskMultipliers.positionSize);
  });

  it('should reduce risk in crisis conditions', () => {
    const crisisIndicators = makeIndicators({
      VIXCLS: { value: 45, previousValue: 35 },
      T10Y2Y: { value: -0.8, previousValue: -0.5 },
    });
    const crisisSnapshots = makeGlobalSnapshots();
    crisisSnapshots[0] = { ...crisisSnapshots[0], indicators: { ...crisisSnapshots[0].indicators, gdpGrowth: 0.2, inflation: 5.5 } };

    const weights = computeAdaptiveWeights(
      crisisIndicators,
      crisisSnapshots,
      makeFactors([
        { severity: 'high', category: 'conflict' },
        { severity: 'critical', category: 'conflict' },
        { severity: 'high', category: 'sanctions' },
      ]),
      [],
      'hawkish',
      false,
    );
    expect(weights.regime).toBe('crisis');
    expect(weights.riskMultipliers.positionSize).toBeLessThan(0.5);
    expect(weights.riskMultipliers.maxExposure).toBeLessThan(0.3);
    // Crisis should favor mean-reversion + multi-indicator over momentum
    expect(weights.strategyWeights.meanReversion).toBeGreaterThan(weights.strategyWeights.momentum);
  });

  it('should boost forex on central bank divergence', () => {
    const weights = computeAdaptiveWeights(
      makeIndicators(),
      makeGlobalSnapshots(), // US hawkish, EU dovish, China dovish, Japan hawkish, UK neutral
      makeFactors(),
      [],
      'mixed',
      false,
    );
    // With 2 hawkish and 2 dovish, divergence should boost forex
    expect(weights.assetClassBias.forex).toBeGreaterThan(0);
  });

  it('should favor momentum in recovery regimes', () => {
    const recoveryIndicators = makeIndicators({
      VIXCLS: { value: 16, previousValue: 25 },
      T10Y2Y: { value: 1.5, previousValue: 1.0 },
      FEDFUNDS: { value: 3.0, previousValue: 4.0 },
    });
    const recoverySnapshots = makeGlobalSnapshots();
    recoverySnapshots[0] = { ...recoverySnapshots[0], indicators: { ...recoverySnapshots[0].indicators, gdpGrowth: 3.5, inflation: 1.5 }, policyStance: 'dovish' };

    const weights = computeAdaptiveWeights(
      recoveryIndicators,
      recoverySnapshots,
      [],
      [],
      'dovish',
      false,
    );
    // Recovery favors momentum and breakout
    expect(weights.strategyWeights.momentum).toBeGreaterThanOrEqual(weights.strategyWeights.meanReversion);
  });
});

// ---- Formatting ----

describe('formatAdaptiveWeights', () => {
  it('should produce readable output', () => {
    const weights = computeAdaptiveWeights(
      makeIndicators(),
      makeGlobalSnapshots(),
      makeFactors(),
      [],
      'mixed',
      false,
    );
    const report = formatAdaptiveWeights(weights);
    expect(report).toContain('ADAPTIVE MACRO WEIGHTS');
    expect(report).toContain('Regime:');
    expect(report).toContain('Strategy Weights');
    expect(report).toContain('Momentum');
    expect(report).toContain('Risk Multipliers');
    expect(report).toContain('Asset Class Bias');
  });
});

// ---- All Regimes Covered ----

describe('All Regimes Produce Valid Weights', () => {
  const scenarios: Array<{ name: string; vix: number; gdp: number; inflation: number; yieldCurve: number; fedRate: number; prevFed: number }> = [
    { name: 'goldilocks', vix: 12, gdp: 3.0, inflation: 2.5, yieldCurve: 1.2, fedRate: 4.0, prevFed: 4.0 },
    { name: 'crisis', vix: 45, gdp: 0.2, inflation: 5.5, yieldCurve: -0.8, fedRate: 5.5, prevFed: 5.0 },
    { name: 'stagflation', vix: 22, gdp: 0.5, inflation: 6.0, yieldCurve: -0.3, fedRate: 5.5, prevFed: 5.0 },
    { name: 'deflation', vix: 20, gdp: 0.3, inflation: 0.5, yieldCurve: 0.2, fedRate: 2.0, prevFed: 3.0 },
    { name: 'overheating', vix: 20, gdp: 4.0, inflation: 5.0, yieldCurve: 0.3, fedRate: 6.0, prevFed: 5.5 },
    { name: 'risk_off', vix: 30, gdp: 1.5, inflation: 3.0, yieldCurve: 0.0, fedRate: 5.0, prevFed: 5.0 },
  ];

  for (const scenario of scenarios) {
    it(`${scenario.name}: should produce valid strategy weights and risk multipliers`, () => {
      const indicators = makeIndicators({
        VIXCLS: { value: scenario.vix, previousValue: scenario.vix - 2 },
        T10Y2Y: { value: scenario.yieldCurve, previousValue: scenario.yieldCurve },
        FEDFUNDS: { value: scenario.fedRate, previousValue: scenario.prevFed },
      });
      const snapshots = makeGlobalSnapshots();
      snapshots[0] = {
        ...snapshots[0],
        indicators: { ...snapshots[0].indicators, gdpGrowth: scenario.gdp, inflation: scenario.inflation },
      };

      const weights = computeAdaptiveWeights(indicators, snapshots, makeFactors(), [], 'mixed', false);

      // Strategy weights should sum to ~1
      const wSum = weights.strategyWeights.momentum + weights.strategyWeights.meanReversion +
        weights.strategyWeights.breakout + weights.strategyWeights.multiIndicator;
      expect(wSum).toBeCloseTo(1.0, 1);

      // All strategy weights should be non-negative
      expect(weights.strategyWeights.momentum).toBeGreaterThanOrEqual(0);
      expect(weights.strategyWeights.meanReversion).toBeGreaterThanOrEqual(0);
      expect(weights.strategyWeights.breakout).toBeGreaterThanOrEqual(0);
      expect(weights.strategyWeights.multiIndicator).toBeGreaterThanOrEqual(0);

      // Risk multipliers should be positive
      expect(weights.riskMultipliers.positionSize).toBeGreaterThan(0);
      expect(weights.riskMultipliers.maxExposure).toBeGreaterThan(0);
      expect(weights.riskMultipliers.stopLossWidth).toBeGreaterThan(0);
    });
  }
});
