import { describe, it, expect } from 'vitest';
import { MacroEconomist } from '../src/team/macro-economist/index.js';
import { GeopoliticalAnalyzer } from '../src/team/macro-economist/geopolitical.js';
import { EconomicCalendar } from '../src/team/macro-economist/calendar.js';
import { FredClient } from '../src/team/macro-economist/fred.js';

// ---- FredClient (mock data mode — no API key) ----

describe('FredClient', () => {
  it('should return mock data when no API key', async () => {
    const fred = new FredClient(''); // empty key → mock mode
    const data = await fred.fetchSeries('FEDFUNDS');
    expect(data.length).toBeGreaterThan(0);
    expect(data[0].name).toBe('FEDFUNDS');
    expect(data[0].source).toContain('mock');
  });

  it('should return mock data for all key series', async () => {
    const fred = new FredClient('');
    const all = await fred.fetchAllKey();
    expect(all.length).toBeGreaterThanOrEqual(6);

    const names = all.map(i => i.name);
    expect(names).toContain('FEDFUNDS');
    expect(names).toContain('CPIAUCSL');
    expect(names).toContain('T10Y2Y');
    expect(names).toContain('VIXCLS');
  });

  it('should return latest indicator', async () => {
    const fred = new FredClient('');
    const latest = await fred.fetchLatest('VIXCLS');
    expect(latest.name).toBe('VIXCLS');
    expect(latest.value).toBeGreaterThan(0);
  });

  it('should handle unknown series gracefully', async () => {
    const fred = new FredClient('');
    const data = await fred.fetchSeries('UNKNOWN_SERIES_XYZ');
    expect(data.length).toBe(1);
    expect(data[0].value).toBe(0);
  });
});

// ---- GeopoliticalAnalyzer ----

describe('GeopoliticalAnalyzer', () => {
  it('should assess risk and return a score', async () => {
    const analyzer = new GeopoliticalAnalyzer();
    const risk = await analyzer.assess();
    expect(risk.score).toBeGreaterThanOrEqual(0);
    expect(risk.score).toBeLessThanOrEqual(100);
    expect(['low', 'medium', 'high', 'extreme']).toContain(risk.level);
    expect(risk.factors.length).toBeGreaterThan(0);
  });

  it('should return active geopolitical factors', () => {
    const analyzer = new GeopoliticalAnalyzer();
    const factors = analyzer.getActiveFactors();
    expect(factors.length).toBeGreaterThan(0);
    expect(factors[0]).toHaveProperty('category');
    expect(factors[0]).toHaveProperty('region');
    expect(factors[0]).toHaveProperty('severity');
  });

  it('should filter factors by asset', () => {
    const analyzer = new GeopoliticalAnalyzer();
    const btcFactors = analyzer.getFactorsForAsset('BTC/USDT');
    // BTC should have regulatory and election factors
    expect(btcFactors.length).toBeGreaterThan(0);
    for (const f of btcFactors) {
      expect(f.affectedAssets.some(a => a.includes('BTC'))).toBe(true);
    }
  });

  it('should return policy changes', () => {
    const analyzer = new GeopoliticalAnalyzer();
    const changes = analyzer.getPolicyChanges();
    expect(changes.length).toBeGreaterThan(0);
    expect(changes[0]).toHaveProperty('country');
    expect(changes[0]).toHaveProperty('institution');
    expect(changes[0]).toHaveProperty('type');
  });

  it('should filter policy changes by market', () => {
    const analyzer = new GeopoliticalAnalyzer();
    const cryptoChanges = analyzer.getPolicyChangesForMarket('crypto');
    for (const change of cryptoChanges) {
      expect(change.affectedMarkets).toContain('crypto');
    }
  });

  it('should return global macro snapshots', () => {
    const analyzer = new GeopoliticalAnalyzer();
    const snapshots = analyzer.getGlobalMacro();
    expect(snapshots.length).toBeGreaterThanOrEqual(5);

    const regions = snapshots.map(s => s.region);
    expect(regions).toContain('United States');
    expect(regions).toContain('Eurozone');
    expect(regions).toContain('China');
    expect(regions).toContain('Japan');
  });

  it('should get region-specific macro data', () => {
    const analyzer = new GeopoliticalAnalyzer();
    const us = analyzer.getRegionMacro('United States');
    expect(us).toBeDefined();
    expect(us!.indicators).toHaveProperty('gdpGrowth');
    expect(us!.indicators).toHaveProperty('inflation');
  });

  it('should determine global policy bias', () => {
    const analyzer = new GeopoliticalAnalyzer();
    const bias = analyzer.getGlobalPolicyBias();
    expect(['hawkish', 'dovish', 'mixed']).toContain(bias);
  });

  it('should format a comprehensive report', async () => {
    const analyzer = new GeopoliticalAnalyzer();
    const risk = await analyzer.assess();
    const report = analyzer.formatReport(risk);
    expect(report).toContain('GEOPOLITICAL');
    expect(report).toContain('Risk Factors');
    expect(report).toContain('Policy Changes');
    expect(report).toContain('Global Macro Overview');
  });
});

// ---- EconomicCalendar ----

describe('EconomicCalendar', () => {
  it('should return upcoming events', () => {
    const calendar = new EconomicCalendar();
    const events = calendar.getUpcomingEvents();
    expect(events.length).toBeGreaterThan(0);
  });

  it('should include FOMC dates', () => {
    const calendar = new EconomicCalendar();
    const events = calendar.getUpcomingEvents();
    const fomc = events.find(e => e.name.includes('FOMC'));
    expect(fomc).toBeDefined();
    expect(fomc!.impact).toBe('high');
  });

  it('should include CPI, NFP, GDP events', () => {
    const calendar = new EconomicCalendar();
    const events = calendar.getUpcomingEvents();
    const names = events.map(e => e.name);
    expect(names.some(n => n.includes('CPI'))).toBe(true);
    expect(names.some(n => n.includes('Non-Farm'))).toBe(true);
    expect(names.some(n => n.includes('GDP'))).toBe(true);
  });

  it('should sort events by date (soonest first)', () => {
    const calendar = new EconomicCalendar();
    const events = calendar.getUpcomingEvents();
    for (let i = 1; i < events.length; i++) {
      expect(events[i].nextDate >= events[i - 1].nextDate).toBe(true);
    }
  });

  it('isHighImpactPeriod should return boolean', () => {
    const calendar = new EconomicCalendar();
    const result = calendar.isHighImpactPeriod();
    expect(typeof result).toBe('boolean');
  });
});

// ---- MacroEconomist (integration) ----

describe('MacroEconomist', () => {
  it('should build a macro environment', async () => {
    const economist = new MacroEconomist();
    const env = await economist.getEnvironment();

    expect(env.indicators.length).toBeGreaterThan(0);
    expect(['bullish', 'bearish', 'neutral']).toContain(env.bias);
    expect(['low', 'medium', 'high', 'extreme']).toContain(env.riskLevel);
    expect(env.timestamp).toBeGreaterThan(0);
  });

  it('should return cached bias on second call', async () => {
    const economist = new MacroEconomist();
    const bias1 = await economist.getBias();
    const bias2 = await economist.getBias();
    expect(bias1).toBe(bias2);
  });

  it('should return geopolitical factors for specific assets', () => {
    const economist = new MacroEconomist();
    const factors = economist.getGeopoliticalFactorsForAsset('NVDA');
    expect(factors.length).toBeGreaterThan(0);
  });

  it('should return policy changes for market', () => {
    const economist = new MacroEconomist();
    const changes = economist.getPolicyChanges('crypto');
    expect(changes.length).toBeGreaterThan(0);
    for (const c of changes) {
      expect(c.affectedMarkets).toContain('crypto');
    }
  });

  it('should return global macro data', () => {
    const economist = new MacroEconomist();
    const global = economist.getGlobalMacro();
    expect(global.length).toBeGreaterThanOrEqual(5);
  });

  it('should return region macro data', () => {
    const economist = new MacroEconomist();
    const japan = economist.getRegionMacro('Japan');
    expect(japan).toBeDefined();
    expect(japan!.policyStance).toBeDefined();
  });

  it('should return global policy bias', () => {
    const economist = new MacroEconomist();
    const bias = economist.getGlobalPolicyBias();
    expect(['hawkish', 'dovish', 'mixed']).toContain(bias);
  });

  it('should return upcoming events', () => {
    const economist = new MacroEconomist();
    const events = economist.getUpcomingEvents();
    expect(events.length).toBeGreaterThan(0);
  });

  it('should generate geopolitical report', async () => {
    const economist = new MacroEconomist();
    const report = await economist.getGeopoliticalReport();
    expect(report).toContain('GEOPOLITICAL');
    expect(report.length).toBeGreaterThan(100);
  });
});
