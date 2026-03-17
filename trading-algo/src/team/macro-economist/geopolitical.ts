// ============================================================
// Geopolitical Risk Analyzer — Multi-factor risk engine
// Tracks: conflicts, sanctions, trade wars, elections,
//         policy changes, energy markets, pandemics, debt crises
// ============================================================

import { createModuleLogger } from '../../shared/logger.js';
import { FredClient } from './fred.js';
import type { GeopoliticalRisk, GeopoliticalFactor, PolicyChange, GlobalMacroSnapshot } from './types.js';

const logger = createModuleLogger('geopolitical-analyzer');

/**
 * Known geopolitical risk factors — updated based on current events.
 * In production, these would be fetched from news APIs.
 * For now, maintained as a rule-based assessment engine.
 */
const RISK_FACTORS: GeopoliticalFactor[] = [
  {
    category: 'conflict',
    region: 'Eastern Europe',
    description: 'Russia-Ukraine conflict ongoing — energy supply disruption risk',
    severity: 'high',
    affectedAssets: ['EUR/USD', 'natural-gas', 'wheat'],
    marketImpact: 'volatile',
  },
  {
    category: 'trade-war',
    region: 'US-China',
    description: 'US-China tech decoupling — chip export restrictions, tariff escalation',
    severity: 'high',
    affectedAssets: ['NVDA', 'AAPL', 'USD/CNY', 'SOL/USDT'],
    marketImpact: 'bearish',
  },
  {
    category: 'sanctions',
    region: 'Middle East',
    description: 'Iran sanctions — oil supply constraints',
    severity: 'medium',
    affectedAssets: ['oil', 'USD/JPY'],
    marketImpact: 'volatile',
  },
  {
    category: 'election',
    region: 'United States',
    description: 'US policy uncertainty — fiscal and regulatory outlook unclear',
    severity: 'medium',
    affectedAssets: ['SPY', 'BTC/USDT', 'USD/CHF'],
    marketImpact: 'volatile',
  },
  {
    category: 'policy',
    region: 'Global',
    description: 'Central bank divergence — Fed vs ECB vs BoJ rate paths',
    severity: 'high',
    affectedAssets: ['EUR/USD', 'USD/JPY', 'GBP/USD', 'GOOGL', 'MSFT'],
    marketImpact: 'volatile',
  },
  {
    category: 'energy',
    region: 'OPEC+',
    description: 'OPEC+ production decisions — oil price volatility',
    severity: 'medium',
    affectedAssets: ['oil', 'XRP/USDT', 'AUD/USD'],
    marketImpact: 'volatile',
  },
  {
    category: 'debt-crisis',
    region: 'Emerging Markets',
    description: 'EM sovereign debt stress — USD strength hurting EM borrowers',
    severity: 'medium',
    affectedAssets: ['USD/CAD', 'AUD/USD', 'BTC/USDT'],
    marketImpact: 'bearish',
  },
  {
    category: 'regulatory',
    region: 'Global',
    description: 'Crypto regulation tightening — SEC, MiCA, global frameworks',
    severity: 'medium',
    affectedAssets: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'XRP/USDT'],
    marketImpact: 'bearish',
  },
];

/**
 * Known policy change tracker.
 * In production, fetched from central bank RSS/API feeds.
 */
const RECENT_POLICY_CHANGES: PolicyChange[] = [
  {
    country: 'United States',
    institution: 'Federal Reserve',
    type: 'monetary',
    description: 'Fed holding rates, watching inflation data for cut timing',
    impact: 'neutral',
    affectedMarkets: ['crypto', 'forex'],
    effectiveDate: '2026-03-18',
    severity: 'high',
  },
  {
    country: 'European Union',
    institution: 'ECB',
    type: 'monetary',
    description: 'ECB began cutting cycle — dovish pivot',
    impact: 'dovish',
    affectedMarkets: ['forex', 'crypto'],
    effectiveDate: '2026-01-15',
    severity: 'high',
  },
  {
    country: 'Japan',
    institution: 'Bank of Japan',
    type: 'monetary',
    description: 'BoJ rate normalization — gradual tightening from near-zero',
    impact: 'hawkish',
    affectedMarkets: ['forex'],
    effectiveDate: '2026-02-01',
    severity: 'high',
  },
  {
    country: 'China',
    institution: 'PBoC',
    type: 'monetary',
    description: 'PBoC easing to support property sector and growth',
    impact: 'dovish',
    affectedMarkets: ['crypto', 'forex'],
    effectiveDate: '2026-01-20',
    severity: 'medium',
  },
  {
    country: 'United States',
    institution: 'SEC',
    type: 'regulatory',
    description: 'SEC crypto ETF approvals expanding, regulatory clarity improving',
    impact: 'expansionary',
    affectedMarkets: ['crypto'],
    effectiveDate: '2026-02-15',
    severity: 'medium',
  },
  {
    country: 'European Union',
    institution: 'European Commission',
    type: 'trade',
    description: 'EU carbon border adjustment — tariffs on high-emission imports',
    impact: 'restrictive',
    affectedMarkets: ['forex'],
    effectiveDate: '2026-01-01',
    severity: 'low',
  },
];

/**
 * Global macro snapshots by region.
 */
const GLOBAL_MACRO_SNAPSHOTS: GlobalMacroSnapshot[] = [
  {
    region: 'United States',
    indicators: { gdpGrowth: 2.1, inflation: 3.2, unemployment: 4.1, fedFunds: 5.25 },
    policyStance: 'hawkish',
    growthOutlook: 'slowing',
    inflationTrend: 'sticky',
    timestamp: Date.now(),
  },
  {
    region: 'Eurozone',
    indicators: { gdpGrowth: 0.8, inflation: 2.4, unemployment: 6.5, ecbRate: 3.5 },
    policyStance: 'dovish',
    growthOutlook: 'slowing',
    inflationTrend: 'falling',
    timestamp: Date.now(),
  },
  {
    region: 'China',
    indicators: { gdpGrowth: 4.8, inflation: 0.3, unemployment: 5.2, loanPrimeRate: 3.45 },
    policyStance: 'dovish',
    growthOutlook: 'recovering',
    inflationTrend: 'falling',
    timestamp: Date.now(),
  },
  {
    region: 'Japan',
    indicators: { gdpGrowth: 1.1, inflation: 2.8, unemployment: 2.5, bojRate: 0.25 },
    policyStance: 'hawkish',
    growthOutlook: 'expanding',
    inflationTrend: 'rising',
    timestamp: Date.now(),
  },
  {
    region: 'United Kingdom',
    indicators: { gdpGrowth: 0.6, inflation: 3.0, unemployment: 4.3, boeRate: 4.75 },
    policyStance: 'neutral',
    growthOutlook: 'slowing',
    inflationTrend: 'stable',
    timestamp: Date.now(),
  },
];

export class GeopoliticalAnalyzer {
  private readonly fred: FredClient;

  constructor(fred?: FredClient) {
    this.fred = fred ?? new FredClient();
  }

  /**
   * Full risk assessment combining VIX + geopolitical factors.
   */
  async assess(): Promise<GeopoliticalRisk> {
    const vixIndicator = await this.fred.fetchLatest('VIXCLS');
    const vix = vixIndicator.value;

    // Score from VIX
    const vixScore = this.scoreFromVix(vix);

    // Score from active geopolitical factors
    const activeFactors = this.getActiveFactors();
    const factorScore = this.scoreFromFactors(activeFactors);

    // Combined score (60% VIX, 40% factors)
    const combinedScore = Math.round(vixScore.score * 0.6 + factorScore * 0.4);
    const level = this.levelFromScore(combinedScore);

    logger.info({
      vix,
      vixScore: vixScore.score,
      factorScore,
      combinedScore,
      level,
      activeFactors: activeFactors.length,
    }, 'Geopolitical risk assessed');

    return {
      score: combinedScore,
      level,
      vixLevel: vix,
      factors: activeFactors,
      timestamp: Date.now(),
    };
  }

  /**
   * Get a numeric risk score (0–100).
   */
  async getRiskScore(): Promise<number> {
    const risk = await this.assess();
    return risk.score;
  }

  /**
   * Get risk level.
   */
  async getRiskLevel(): Promise<'low' | 'medium' | 'high' | 'extreme'> {
    const risk = await this.assess();
    return risk.level;
  }

  /**
   * Get active geopolitical factors affecting specific assets.
   */
  getFactorsForAsset(symbol: string): GeopoliticalFactor[] {
    return RISK_FACTORS.filter(f =>
      f.affectedAssets.some(a => symbol.includes(a) || a.includes(symbol)),
    );
  }

  /**
   * Get all active geopolitical risk factors.
   */
  getActiveFactors(): GeopoliticalFactor[] {
    return [...RISK_FACTORS];
  }

  /**
   * Get recent policy changes affecting markets.
   */
  getPolicyChanges(): PolicyChange[] {
    return [...RECENT_POLICY_CHANGES];
  }

  /**
   * Get policy changes affecting specific markets.
   */
  getPolicyChangesForMarket(market: 'crypto' | 'forex'): PolicyChange[] {
    return RECENT_POLICY_CHANGES.filter(p => p.affectedMarkets.includes(market));
  }

  /**
   * Get global macro snapshots for all tracked regions.
   */
  getGlobalMacro(): GlobalMacroSnapshot[] {
    return [...GLOBAL_MACRO_SNAPSHOTS];
  }

  /**
   * Get macro data for a specific region.
   */
  getRegionMacro(region: string): GlobalMacroSnapshot | undefined {
    return GLOBAL_MACRO_SNAPSHOTS.find(s =>
      s.region.toLowerCase().includes(region.toLowerCase()),
    );
  }

  /**
   * Determine overall global policy direction.
   */
  getGlobalPolicyBias(): 'hawkish' | 'dovish' | 'mixed' {
    const stances = GLOBAL_MACRO_SNAPSHOTS.map(s => s.policyStance);
    const hawkish = stances.filter(s => s === 'hawkish').length;
    const dovish = stances.filter(s => s === 'dovish').length;
    if (hawkish > dovish + 1) return 'hawkish';
    if (dovish > hawkish + 1) return 'dovish';
    return 'mixed';
  }

  /**
   * Format a comprehensive geopolitical report.
   */
  formatReport(risk: GeopoliticalRisk): string {
    const lines = [
      '\n=== GEOPOLITICAL & MACRO RISK REPORT ===',
      `Overall Risk: ${risk.level.toUpperCase()} (${risk.score}/100) | VIX: ${risk.vixLevel.toFixed(1)}`,
      '',
      'Active Risk Factors:',
    ];

    for (const f of risk.factors) {
      const icon = f.severity === 'critical' ? '!!' : f.severity === 'high' ? '!' : '-';
      lines.push(`  ${icon} [${f.category}] ${f.region}: ${f.description}`);
      lines.push(`    Severity: ${f.severity} | Impact: ${f.marketImpact} | Affects: ${f.affectedAssets.join(', ')}`);
    }

    lines.push('', 'Recent Policy Changes:');
    for (const p of RECENT_POLICY_CHANGES) {
      lines.push(`  ${p.country} (${p.institution}): ${p.description}`);
      lines.push(`    Impact: ${p.impact} | Markets: ${p.affectedMarkets.join(', ')}`);
    }

    lines.push('', 'Global Macro Overview:');
    for (const s of GLOBAL_MACRO_SNAPSHOTS) {
      lines.push(`  ${s.region}: Growth=${s.growthOutlook}, Inflation=${s.inflationTrend}, Policy=${s.policyStance}`);
    }

    const globalBias = this.getGlobalPolicyBias();
    lines.push(`\nGlobal Policy Bias: ${globalBias.toUpperCase()}`);

    return lines.join('\n');
  }

  // ---- private ----

  private scoreFromVix(vix: number): { score: number; level: GeopoliticalRisk['level'] } {
    if (vix < 15) return { score: 20, level: 'low' };
    if (vix <= 25) return { score: 50, level: 'medium' };
    if (vix <= 35) return { score: 75, level: 'high' };
    return { score: 90, level: 'extreme' };
  }

  private scoreFromFactors(factors: GeopoliticalFactor[]): number {
    let score = 0;
    for (const f of factors) {
      switch (f.severity) {
        case 'critical': score += 15; break;
        case 'high': score += 10; break;
        case 'medium': score += 5; break;
        case 'low': score += 2; break;
      }
    }
    return Math.min(100, score);
  }

  private levelFromScore(score: number): GeopoliticalRisk['level'] {
    if (score < 30) return 'low';
    if (score <= 55) return 'medium';
    if (score <= 75) return 'high';
    return 'extreme';
  }
}
