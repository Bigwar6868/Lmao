import { describe, it, expect } from 'vitest';
import { RegimeDetector } from '../src/team/regime-detector/index.js';
import { ScenarioSimulator } from '../src/team/scenario-simulator/index.js';
import { DiagnosticsEngine } from '../src/team/diagnostics/index.js';
import type { Candle, AssetInfo, MacroEnvironment, MacroIndicator } from '../src/shared/types.js';

// Helpers
function makeCandles(pattern: 'uptrend' | 'downtrend' | 'range' | 'volatile', count = 100): Candle[] {
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    let change: number;
    switch (pattern) {
      case 'uptrend': change = 0.5 + Math.random() * 0.5; break;
      case 'downtrend': change = -(0.5 + Math.random() * 0.5); break;
      case 'range': change = (Math.random() - 0.5) * 2; break;
      case 'volatile': change = (Math.random() - 0.5) * 10; break;
    }
    price = Math.max(1, price + change);
    candles.push({
      timestamp: Date.now() - (count - i) * 3600000,
      open: price - change * 0.3,
      high: price + Math.abs(change) * 0.5,
      low: price - Math.abs(change) * 0.5,
      close: price,
      volume: 1000 + Math.random() * 500,
    });
  }
  return candles;
}

const testAsset: AssetInfo = { symbol: 'BTC/USDT', assetClass: 'crypto', exchange: 'binance' };

function makeMacro(riskLevel: 'low' | 'medium' | 'high' | 'extreme'): MacroEnvironment {
  const vixValues: Record<string, number> = { low: 12, medium: 20, high: 30, extreme: 45 };
  return {
    indicators: [
      { name: 'FEDFUNDS', value: 3.625, previousValue: 3.75, date: '2026-01-01', source: 'FRED', impact: 'high' },
      { name: 'CPIAUCSL', value: 2.8, previousValue: 3.0, date: '2026-01-01', source: 'FRED', impact: 'high' },
      { name: 'VIXCLS', value: vixValues[riskLevel], previousValue: vixValues[riskLevel] - 2, date: '2026-01-01', source: 'FRED', impact: 'high' },
      { name: 'T10Y2Y', value: riskLevel === 'extreme' ? -0.5 : 0.2, previousValue: 0.3, date: '2026-01-01', source: 'FRED', impact: 'high' },
    ],
    sentiment: [],
    riskLevel,
    bias: riskLevel === 'low' ? 'bullish' : riskLevel === 'extreme' ? 'bearish' : 'neutral',
    timestamp: Date.now(),
  };
}

describe('Regime Detector', () => {
  const detector = new RegimeDetector();

  it('detects uptrend as trending_bull', () => {
    const candles = makeCandles('uptrend', 100);
    const result = detector.detect(candles);
    expect(result.trendStrength).toBeGreaterThan(0);
    expect(['trending_bull', 'range_bound', 'low_volatility', 'recovery']).toContain(result.regime);
  });

  it('detects downtrend as trending_bear', () => {
    const candles = makeCandles('downtrend', 100);
    const result = detector.detect(candles);
    expect(result.trendStrength).toBeLessThan(0);
    expect(['trending_bear', 'range_bound', 'high_volatility', 'low_volatility']).toContain(result.regime);
  });

  it('detects volatile market', () => {
    const candles = makeCandles('volatile', 100);
    const result = detector.detect(candles);
    // Volatile data should show non-zero volatility percentile
    expect(result.volatilityPercentile).toBeGreaterThanOrEqual(0);
    expect(result.volatilityPercentile).toBeLessThanOrEqual(100);
  });

  it('returns recommended strategies', () => {
    const candles = makeCandles('uptrend');
    const result = detector.detect(candles);
    expect(result.recommendedStrategies.length).toBeGreaterThan(0);
  });

  it('handles insufficient data gracefully', () => {
    const candles = makeCandles('range', 10);
    const result = detector.detect(candles);
    expect(result.regime).toBeDefined();
  });
});

describe('Scenario Simulator', () => {
  const simulator = new ScenarioSimulator();

  it('generates multiple scenarios', () => {
    const candles = makeCandles('range', 100);
    const report = simulator.simulate(testAsset, candles, 'range_bound');
    expect(report.scenarios.length).toBeGreaterThan(0);
    expect(report.bestScenario).toBeTruthy();
    expect(report.worstScenario).toBeTruthy();
  });

  it('provides price projections for each scenario', () => {
    const candles = makeCandles('uptrend', 100);
    const report = simulator.simulate(testAsset, candles, 'trending_bull');
    for (const scenario of report.scenarios) {
      expect(scenario.projections.length).toBeGreaterThan(0);
      for (const proj of scenario.projections) {
        expect(proj.bullCase).toBeGreaterThan(0);
        expect(proj.baseCase).toBeGreaterThan(0);
        expect(proj.bearCase).toBeGreaterThan(0);
      }
    }
  });

  it('adjusts probabilities based on macro', () => {
    const candles = makeCandles('range', 100);
    const macro = makeMacro('extreme');
    const report = simulator.simulate(testAsset, candles, 'crisis', macro);
    expect(report.keyRisks.length).toBeGreaterThan(0);
  });

  it('identifies opportunities', () => {
    const candles = makeCandles('uptrend', 100);
    const report = simulator.simulate(testAsset, candles, 'trending_bull');
    expect(report.opportunities.length).toBeGreaterThan(0);
  });
});

describe('Diagnostics Engine', () => {
  const engine = new DiagnosticsEngine();

  it('detects flash crash', () => {
    const candles = makeCandles('range', 50);
    // Inject flash crash
    candles.push({
      timestamp: Date.now(),
      open: candles[candles.length - 1].close,
      high: candles[candles.length - 1].close,
      low: candles[candles.length - 1].close * 0.9,
      close: candles[candles.length - 1].close * 0.92,
      volume: 5000,
    });
    const report = engine.scan({ candles: new Map([['BTC/USDT', candles]]) });
    const crashDiag = report.criticals.concat(report.warnings).find((d) => d.title.includes('crash') || d.title.includes('spike'));
    expect(crashDiag).toBeDefined();
  });

  it('detects volume anomaly', () => {
    const candles = makeCandles('range', 50);
    // Inject volume spike
    candles.push({
      timestamp: Date.now(),
      open: 100, high: 101, low: 99, close: 100.5,
      volume: 50000, // way above average
    });
    const report = engine.scan({ candles: new Map([['BTC/USDT', candles]]) });
    const volDiag = report.warnings.find((d) => d.title.includes('Volume'));
    expect(volDiag).toBeDefined();
  });

  it('calculates health score', () => {
    const candles = makeCandles('range', 50);
    const report = engine.scan({ candles: new Map([['BTC/USDT', candles]]) });
    expect(report.healthScore).toBeGreaterThanOrEqual(0);
    expect(report.healthScore).toBeLessThanOrEqual(100);
  });

  it('detects macro divergence', () => {
    const macro = makeMacro('extreme');
    // VIX > 30 should trigger
    const report = engine.scan({
      candles: new Map([['BTC/USDT', makeCandles('range', 50)]]),
      macro,
    });
    const macroDiag = [...report.emergencies, ...report.criticals, ...report.warnings]
      .find((d) => d.category === 'macro_divergence');
    expect(macroDiag).toBeDefined();
  });

  it('produces formatted report', () => {
    const candles = makeCandles('volatile', 50);
    const report = engine.scan({ candles: new Map([['BTC/USDT', candles]]) });
    const formatted = DiagnosticsEngine.formatReport(report);
    expect(formatted).toContain('DIAGNOSTIC REPORT');
    expect(formatted).toContain('Health:');
  });
});
