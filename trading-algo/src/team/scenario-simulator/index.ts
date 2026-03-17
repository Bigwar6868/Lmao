import type { Candle, MacroEnvironment, MacroIndicator, AssetInfo } from '../../shared/types.js';
import type { MarketRegime } from '../regime-detector/index.js';
import { mean, stdDev, roundTo } from '../../shared/utils.js';
import { createModuleLogger } from '../../shared/logger.js';

const log = createModuleLogger('scenario-simulator');

// ============================================================
// Scenario Types
// ============================================================

export interface ScenarioVariable {
  name: string;
  currentValue: number;
  scenarioValue: number;
  impact: 'positive' | 'negative' | 'neutral';
  description: string;
}

export interface PriceProjection {
  period: string;           // e.g. "1 week", "1 month"
  bullCase: number;         // price in bull scenario
  baseCase: number;         // price in base scenario
  bearCase: number;         // price in bear scenario
  probability: { bull: number; base: number; bear: number };
}

export interface ScenarioResult {
  name: string;
  description: string;
  probability: number;      // 0-1
  variables: ScenarioVariable[];
  projections: PriceProjection[];
  expectedReturn: number;   // percentage
  riskLevel: 'low' | 'medium' | 'high' | 'extreme';
  actionableInsight: string;
  timestamp: number;
}

export interface SimulationReport {
  asset: AssetInfo;
  currentPrice: number;
  currentRegime: MarketRegime;
  scenarios: ScenarioResult[];
  bestScenario: string;
  worstScenario: string;
  overallOutlook: 'bullish' | 'bearish' | 'neutral' | 'uncertain';
  keyRisks: string[];
  opportunities: string[];
  timestamp: number;
}

// ============================================================
// Scenario Templates
// ============================================================

interface ScenarioTemplate {
  name: string;
  description: string;
  /** How each macro variable shifts in this scenario */
  shifts: {
    fedRate: number;        // basis points change
    cpi: number;            // percentage point change
    vix: number;            // absolute change
    yieldCurve: number;     // bps change in 10Y-2Y spread
    gdpGrowth: number;      // pct point change
  };
  /** Impact on different asset classes */
  assetImpact: {
    crypto: number;         // -1 to +1
    forex_usd: number;      // positive = USD strengthens
  };
  baseProbability: number;
}

const SCENARIO_TEMPLATES: ScenarioTemplate[] = [
  {
    name: 'Soft Landing',
    description: 'Fed achieves inflation target with minimal economic damage. Rate cuts begin. Risk assets rally.',
    shifts: { fedRate: -50, cpi: -0.5, vix: -5, yieldCurve: 20, gdpGrowth: 0.3 },
    assetImpact: { crypto: 0.6, forex_usd: -0.3 },
    baseProbability: 0.25,
  },
  {
    name: 'Stagflation',
    description: 'Persistent inflation + slowing growth. Fed caught between cutting (growth) and hiking (inflation). Bad for most assets.',
    shifts: { fedRate: 25, cpi: 0.8, vix: 10, yieldCurve: -30, gdpGrowth: -0.5 },
    assetImpact: { crypto: -0.4, forex_usd: 0.2 },
    baseProbability: 0.15,
  },
  {
    name: 'Risk-On Rally',
    description: 'Strong economic data, earnings beats, geopolitical de-escalation. Animal spirits return.',
    shifts: { fedRate: 0, cpi: -0.2, vix: -8, yieldCurve: 10, gdpGrowth: 0.5 },
    assetImpact: { crypto: 0.8, forex_usd: -0.1 },
    baseProbability: 0.20,
  },
  {
    name: 'Geopolitical Shock',
    description: 'Major conflict escalation, supply chain disruption, or sanctions. Flight to safety.',
    shifts: { fedRate: -25, cpi: 0.5, vix: 20, yieldCurve: -50, gdpGrowth: -1.0 },
    assetImpact: { crypto: -0.5, forex_usd: 0.5 },
    baseProbability: 0.10,
  },
  {
    name: 'Liquidity Crunch',
    description: 'Credit tightening, bank stress, or DeFi contagion. Correlations spike, everything sells.',
    shifts: { fedRate: -75, cpi: -0.3, vix: 30, yieldCurve: -80, gdpGrowth: -1.5 },
    assetImpact: { crypto: -0.8, forex_usd: 0.4 },
    baseProbability: 0.05,
  },
  {
    name: 'Base Case (Status Quo)',
    description: 'Current trends continue. No major surprises. Gradual normalization.',
    shifts: { fedRate: 0, cpi: 0, vix: 0, yieldCurve: 0, gdpGrowth: 0 },
    assetImpact: { crypto: 0.1, forex_usd: 0 },
    baseProbability: 0.25,
  },
];

// ============================================================
// Scenario Simulator
// ============================================================

/**
 * Scenario Simulator
 *
 * Simulates future market conditions under different macro/geopolitical scenarios.
 * Uses Monte Carlo-style probability weighting adjusted by current regime and macro data.
 *
 * Key capabilities:
 * 1. Generate price projections under bull/base/bear cases
 * 2. Adjust scenario probabilities based on current macro environment
 * 3. Identify key risks and opportunities per scenario
 * 4. Provide actionable insights for each scenario
 */
export class ScenarioSimulator {
  /**
   * Run full scenario simulation for an asset.
   */
  simulate(
    asset: AssetInfo,
    candles: Candle[],
    regime: MarketRegime,
    macro?: MacroEnvironment
  ): SimulationReport {
    if (candles.length < 30) {
      return this.emptyReport(asset);
    }

    const currentPrice = candles[candles.length - 1].close;
    const historicalVol = this.calculateHistoricalVolatility(candles);
    const macroValues = this.extractMacroValues(macro);

    // Adjust scenario probabilities based on current conditions
    const adjustedTemplates = this.adjustProbabilities(SCENARIO_TEMPLATES, regime, macroValues);

    // Generate scenario results
    const scenarios = adjustedTemplates.map((template) =>
      this.generateScenario(template, asset, currentPrice, historicalVol, macroValues)
    );

    // Sort by expected return
    const sorted = [...scenarios].sort((a, b) => b.expectedReturn - a.expectedReturn);
    const bestScenario = sorted[0].name;
    const worstScenario = sorted[sorted.length - 1].name;

    // Overall outlook: probability-weighted expected return
    const weightedReturn = scenarios.reduce(
      (sum, s) => sum + s.expectedReturn * s.probability, 0
    );

    const overallOutlook: SimulationReport['overallOutlook'] =
      weightedReturn > 3 ? 'bullish' :
      weightedReturn < -3 ? 'bearish' :
      Math.abs(weightedReturn) < 1 ? 'neutral' : 'uncertain';

    // Key risks and opportunities
    const keyRisks = this.identifyKeyRisks(scenarios, regime, macroValues);
    const opportunities = this.identifyOpportunities(scenarios, regime, asset);

    const report: SimulationReport = {
      asset,
      currentPrice,
      currentRegime: regime,
      scenarios,
      bestScenario,
      worstScenario,
      overallOutlook,
      keyRisks,
      opportunities,
      timestamp: Date.now(),
    };

    log.info({
      asset: asset.symbol,
      outlook: overallOutlook,
      weightedReturn: roundTo(weightedReturn, 2),
      scenarios: scenarios.length,
    }, 'Simulation complete');

    return report;
  }

  /**
   * Generate a single scenario result.
   */
  private generateScenario(
    template: ScenarioTemplate,
    asset: AssetInfo,
    currentPrice: number,
    historicalVol: number,
    macroValues: MacroValues
  ): ScenarioResult {
    const assetClass = asset.assetClass;
    const impact = assetClass === 'crypto' ? template.assetImpact.crypto :
                   template.assetImpact.forex_usd;

    // Variables that change in this scenario
    const variables: ScenarioVariable[] = [
      {
        name: 'Fed Funds Rate',
        currentValue: macroValues.fedRate,
        scenarioValue: macroValues.fedRate + template.shifts.fedRate / 100,
        impact: template.shifts.fedRate > 0 ? 'negative' : template.shifts.fedRate < 0 ? 'positive' : 'neutral',
        description: template.shifts.fedRate > 0 ? `Rate hike of ${template.shifts.fedRate}bps` :
                     template.shifts.fedRate < 0 ? `Rate cut of ${Math.abs(template.shifts.fedRate)}bps` : 'Rates unchanged',
      },
      {
        name: 'CPI (Inflation)',
        currentValue: macroValues.cpi,
        scenarioValue: macroValues.cpi + template.shifts.cpi,
        impact: template.shifts.cpi > 0.3 ? 'negative' : template.shifts.cpi < -0.2 ? 'positive' : 'neutral',
        description: `CPI moves ${template.shifts.cpi > 0 ? 'up' : 'down'} by ${Math.abs(template.shifts.cpi).toFixed(1)} ppt`,
      },
      {
        name: 'VIX (Volatility)',
        currentValue: macroValues.vix,
        scenarioValue: macroValues.vix + template.shifts.vix,
        impact: template.shifts.vix > 5 ? 'negative' : template.shifts.vix < -3 ? 'positive' : 'neutral',
        description: `VIX ${template.shifts.vix > 0 ? 'spikes' : 'drops'} by ${Math.abs(template.shifts.vix)} points`,
      },
      {
        name: 'GDP Growth',
        currentValue: macroValues.gdpGrowth,
        scenarioValue: macroValues.gdpGrowth + template.shifts.gdpGrowth,
        impact: template.shifts.gdpGrowth > 0 ? 'positive' : template.shifts.gdpGrowth < 0 ? 'negative' : 'neutral',
        description: `GDP growth ${template.shifts.gdpGrowth > 0 ? 'accelerates' : 'decelerates'} by ${Math.abs(template.shifts.gdpGrowth).toFixed(1)} ppt`,
      },
    ];

    // Price projections using impact * vol * time
    const projections = this.projectPrices(currentPrice, impact, historicalVol);

    // Expected return = impact * historical vol * time factor
    const expectedReturn = impact * historicalVol * 100 * 0.5; // 50% of implied move

    const riskLevel: ScenarioResult['riskLevel'] =
      Math.abs(template.shifts.vix) > 15 ? 'extreme' :
      Math.abs(template.shifts.vix) > 8 ? 'high' :
      Math.abs(template.shifts.vix) > 3 ? 'medium' : 'low';

    return {
      name: template.name,
      description: template.description,
      probability: template.baseProbability,
      variables,
      projections,
      expectedReturn: roundTo(expectedReturn, 2),
      riskLevel,
      actionableInsight: this.generateInsight(template, asset, impact),
      timestamp: Date.now(),
    };
  }

  /**
   * Project prices for different time horizons.
   */
  private projectPrices(
    currentPrice: number,
    impact: number,
    historicalVol: number
  ): PriceProjection[] {
    const periods = [
      { label: '1 week', factor: 1 / 52 },
      { label: '1 month', factor: 1 / 12 },
      { label: '3 months', factor: 0.25 },
    ];

    return periods.map(({ label, factor }) => {
      const timeVol = historicalVol * Math.sqrt(factor);
      const drift = impact * timeVol;

      return {
        period: label,
        bullCase: roundTo(currentPrice * (1 + drift + timeVol), 2),
        baseCase: roundTo(currentPrice * (1 + drift * 0.5), 2),
        bearCase: roundTo(currentPrice * (1 + drift - timeVol), 2),
        probability: {
          bull: roundTo(impact > 0 ? 0.35 : 0.2, 2),
          base: 0.45,
          bear: roundTo(impact < 0 ? 0.35 : 0.2, 2),
        },
      };
    });
  }

  /**
   * Adjust scenario probabilities based on current regime and macro.
   */
  private adjustProbabilities(
    templates: ScenarioTemplate[],
    regime: MarketRegime,
    macro: MacroValues
  ): ScenarioTemplate[] {
    return templates.map((t) => {
      let probAdj = t.baseProbability;

      // Regime adjustments
      if (regime === 'crisis') {
        if (t.name === 'Liquidity Crunch') probAdj *= 2;
        if (t.name === 'Risk-On Rally') probAdj *= 0.3;
      } else if (regime === 'trending_bull') {
        if (t.name === 'Risk-On Rally') probAdj *= 1.5;
        if (t.name === 'Liquidity Crunch') probAdj *= 0.5;
      } else if (regime === 'high_volatility') {
        if (t.name === 'Geopolitical Shock') probAdj *= 1.5;
        if (t.name === 'Soft Landing') probAdj *= 0.7;
      }

      // Macro adjustments
      if (macro.vix > 30) {
        if (t.name.includes('Crunch') || t.name.includes('Shock')) probAdj *= 1.3;
      }
      if (macro.yieldCurve < 0) {
        // Inverted yield curve: recession risk
        if (t.name === 'Stagflation') probAdj *= 1.4;
        if (t.name === 'Risk-On Rally') probAdj *= 0.7;
      }

      return { ...t, baseProbability: probAdj };
    });
  }

  /**
   * Generate actionable insight for a scenario.
   */
  private generateInsight(template: ScenarioTemplate, asset: AssetInfo, impact: number): string {
    const action = impact > 0.3 ? 'Increase exposure' :
                   impact < -0.3 ? 'Reduce exposure / hedge' :
                   'Maintain current positions with tighter stops';

    const timing = Math.abs(impact) > 0.5 ? 'Act decisively' : 'Monitor closely before acting';

    return `${action} to ${asset.symbol}. ${timing}. ${template.description}`;
  }

  /**
   * Identify key risks from all scenarios.
   */
  private identifyKeyRisks(
    scenarios: ScenarioResult[],
    regime: MarketRegime,
    macro: MacroValues
  ): string[] {
    const risks: string[] = [];

    // High-probability negative scenarios
    const negativeScenarios = scenarios.filter((s) => s.expectedReturn < -5 && s.probability > 0.1);
    for (const s of negativeScenarios) {
      risks.push(`${s.name} (${(s.probability * 100).toFixed(0)}% probability): ${s.description}`);
    }

    // Macro-based risks
    if (macro.vix > 25) risks.push(`Elevated VIX (${macro.vix.toFixed(1)}) — market pricing significant risk`);
    if (macro.yieldCurve < 0) risks.push(`Inverted yield curve (${macro.yieldCurve.toFixed(2)}) — historical recession signal`);
    if (macro.cpi > 4) risks.push(`High inflation (CPI: ${macro.cpi.toFixed(1)}%) — Fed likely to maintain hawkish stance`);

    // Regime-based risks
    if (regime === 'high_volatility') risks.push('High volatility regime — wider stops needed, smaller positions');
    if (regime === 'crisis') risks.push('CRISIS REGIME — capital preservation is top priority');

    return risks.length > 0 ? risks : ['No significant risks identified in current environment'];
  }

  /**
   * Identify opportunities from scenarios.
   */
  private identifyOpportunities(
    scenarios: ScenarioResult[],
    regime: MarketRegime,
    asset: AssetInfo
  ): string[] {
    const opportunities: string[] = [];

    const positiveScenarios = scenarios.filter((s) => s.expectedReturn > 5 && s.probability > 0.15);
    for (const s of positiveScenarios) {
      opportunities.push(`${s.name}: Expected +${s.expectedReturn.toFixed(1)}% if realized`);
    }

    if (regime === 'low_volatility') {
      opportunities.push('Volatility squeeze detected — breakout trade opportunity with defined risk');
    }
    if (regime === 'recovery') {
      opportunities.push('Recovery phase — early momentum entry with confirmation');
    }

    if (asset.assetClass === 'crypto') {
      opportunities.push('Institutional crypto adoption accelerating — long-term structural tailwind');
    }

    return opportunities.length > 0 ? opportunities : ['No high-probability opportunities at this time'];
  }

  /**
   * Calculate annualized historical volatility from price data.
   */
  private calculateHistoricalVolatility(candles: Candle[]): number {
    const returns: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      returns.push(Math.log(candles[i].close / candles[i - 1].close));
    }
    const dailyVol = stdDev(returns);
    return dailyVol * Math.sqrt(365); // Annualize (365 for crypto/forex)
  }

  /**
   * Extract current macro values from environment.
   */
  private extractMacroValues(macro?: MacroEnvironment): MacroValues {
    if (!macro) {
      return { fedRate: 3.625, cpi: 2.8, vix: 18, yieldCurve: 0.2, gdpGrowth: 2.3 };
    }

    const find = (name: string) =>
      macro.indicators.find((i) => i.name.toLowerCase().includes(name.toLowerCase()))?.value;

    return {
      fedRate: find('fed') ?? find('FEDFUNDS') ?? 3.625,
      cpi: find('cpi') ?? find('CPIAUCSL') ?? 2.8,
      vix: find('vix') ?? find('VIXCLS') ?? 18,
      yieldCurve: find('yield') ?? find('T10Y2Y') ?? 0.2,
      gdpGrowth: find('gdp') ?? find('GDP') ?? 2.3,
    };
  }

  private emptyReport(asset: AssetInfo): SimulationReport {
    return {
      asset, currentPrice: 0, currentRegime: 'range_bound',
      scenarios: [], bestScenario: 'N/A', worstScenario: 'N/A',
      overallOutlook: 'uncertain', keyRisks: ['Insufficient data'],
      opportunities: [], timestamp: Date.now(),
    };
  }
}

interface MacroValues {
  fedRate: number;
  cpi: number;
  vix: number;
  yieldCurve: number;
  gdpGrowth: number;
}
