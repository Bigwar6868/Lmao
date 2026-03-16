// ============================================================
// Macro Economist — Main Module
// ============================================================

import { createModuleLogger } from '../../shared/logger.js';
import { eventBus } from '../../shared/events.js';
import type { MacroEnvironment, MacroIndicator } from '../../shared/types.js';
import { FredClient } from './fred.js';
import { EconomicCalendar } from './calendar.js';
import { GeopoliticalAnalyzer } from './geopolitical.js';
import { computeAdaptiveWeightsFromEnv, formatAdaptiveWeights } from './adaptive-weights.js';
import type { AdaptiveWeights } from './adaptive-weights.js';

export { FredClient } from './fred.js';
export { EconomicCalendar } from './calendar.js';
export { GeopoliticalAnalyzer } from './geopolitical.js';
export { computeAdaptiveWeights, computeAdaptiveWeightsFromEnv, detectRegime, formatAdaptiveWeights } from './adaptive-weights.js';
export type { MacroRegime, StrategyWeightProfile, RiskMultipliers, AdaptiveWeights } from './adaptive-weights.js';
export type { FredSeriesId, EconomicEvent, GeopoliticalRisk, GeopoliticalFactor, PolicyChange, GlobalMacroSnapshot } from './types.js';

const logger = createModuleLogger('macro-economist');

export class MacroEconomist {
  private readonly fred: FredClient;
  private readonly calendar: EconomicCalendar;
  private readonly geopolitical: GeopoliticalAnalyzer;
  private lastEnvironment: MacroEnvironment | null = null;

  constructor(fred?: FredClient) {
    this.fred = fred ?? new FredClient();
    this.calendar = new EconomicCalendar();
    this.geopolitical = new GeopoliticalAnalyzer(this.fred);
  }

  /**
   * Build a complete picture of the current macro environment.
   */
  async getEnvironment(): Promise<MacroEnvironment> {
    logger.info('Building macro environment snapshot');

    // Fetch all key indicators in parallel
    const [indicators, geoRisk] = await Promise.all([
      this.fred.fetchAllKey(),
      this.geopolitical.assess(),
    ]);

    const bias = this.determineBias(indicators);
    const isHighImpact = this.calendar.isHighImpactPeriod();

    if (isHighImpact) {
      logger.warn('Within 24h of a high-impact economic event');
    }

    const environment: MacroEnvironment = {
      indicators,
      sentiment: [], // Filled by SentimentAnalyst
      riskLevel: geoRisk.level,
      bias,
      timestamp: Date.now(),
    };

    this.lastEnvironment = environment;

    // Emit event for other modules
    await eventBus.emit('macro:update', environment, 'macro-economist');

    logger.info({ bias, riskLevel: geoRisk.level }, 'Macro environment updated');
    return environment;
  }

  /**
   * Get the current macro bias without re-fetching.
   * If no environment has been built yet, fetches fresh data.
   */
  async getBias(): Promise<'bullish' | 'bearish' | 'neutral'> {
    if (this.lastEnvironment) {
      return this.lastEnvironment.bias;
    }
    const env = await this.getEnvironment();
    return env.bias;
  }

  /**
   * Get geopolitical risk factors for a specific asset.
   */
  getGeopoliticalFactorsForAsset(symbol: string) {
    return this.geopolitical.getFactorsForAsset(symbol);
  }

  /**
   * Get recent policy changes affecting a market class.
   */
  getPolicyChanges(market?: 'crypto' | 'stocks' | 'forex') {
    if (market) return this.geopolitical.getPolicyChangesForMarket(market);
    return this.geopolitical.getPolicyChanges();
  }

  /**
   * Get global macro data for all regions (US, EU, China, Japan, UK).
   */
  getGlobalMacro() {
    return this.geopolitical.getGlobalMacro();
  }

  /**
   * Get macro data for a specific region.
   */
  getRegionMacro(region: string) {
    return this.geopolitical.getRegionMacro(region);
  }

  /**
   * Get overall global policy bias across all central banks.
   */
  getGlobalPolicyBias() {
    return this.geopolitical.getGlobalPolicyBias();
  }

  /**
   * Get upcoming economic events (calendar).
   */
  getUpcomingEvents() {
    return this.calendar.getUpcomingEvents();
  }

  /**
   * Check if a high-impact event is within 24 hours.
   */
  isHighImpactPeriod() {
    return this.calendar.isHighImpactPeriod();
  }

  /**
   * Compute adaptive strategy weights and risk multipliers
   * based on the current macro regime. Works across all environments:
   * goldilocks, reflation, stagflation, deflation, crisis, recovery, etc.
   */
  async getAdaptiveWeights(): Promise<AdaptiveWeights> {
    const env = this.lastEnvironment ?? await this.getEnvironment();
    const globalSnapshots = this.geopolitical.getGlobalMacro();
    const activeFactors = this.geopolitical.getActiveFactors();
    const policyChanges = this.geopolitical.getPolicyChanges();
    const policyBias = this.geopolitical.getGlobalPolicyBias();
    const highImpact = this.calendar.isHighImpactPeriod();

    return computeAdaptiveWeightsFromEnv(
      env,
      globalSnapshots,
      activeFactors,
      policyChanges,
      policyBias,
      highImpact,
    );
  }

  /**
   * Get a formatted adaptive weights report.
   */
  async getAdaptiveWeightsReport(): Promise<string> {
    const weights = await this.getAdaptiveWeights();
    return formatAdaptiveWeights(weights);
  }

  /**
   * Full geopolitical risk report.
   */
  async getGeopoliticalReport(): Promise<string> {
    const risk = await this.geopolitical.assess();
    return this.geopolitical.formatReport(risk);
  }

  // ---- private ----

  /**
   * Determine overall macro bias based on key indicators:
   *   - Yield curve (T10Y2Y): inverted (negative) = bearish
   *   - VIX (VIXCLS): high = bearish
   *   - Fed Funds (FEDFUNDS): rising = bearish for equities
   *   - CPI (CPIAUCSL): rising = bearish (tighter policy expected)
   *
   * Uses a simple scoring system: each factor adds/subtracts a point.
   */
  private determineBias(indicators: MacroIndicator[]): 'bullish' | 'bearish' | 'neutral' {
    let score = 0; // positive = bullish, negative = bearish

    const find = (name: string) => indicators.find((i) => i.name === name);

    // Yield curve
    const yieldCurve = find('T10Y2Y');
    if (yieldCurve) {
      if (yieldCurve.value < 0) {
        score -= 1; // Inverted yield curve — recession signal
        logger.debug({ value: yieldCurve.value }, 'Yield curve inverted — bearish signal');
      } else if (yieldCurve.value > 0.5) {
        score += 1; // Healthy spread
      }
    }

    // VIX
    const vix = find('VIXCLS');
    if (vix) {
      if (vix.value > 25) {
        score -= 1; // High fear
      } else if (vix.value < 15) {
        score += 1; // Complacency / low vol
      }
    }

    // Fed Funds rate trend
    const fedFunds = find('FEDFUNDS');
    if (fedFunds) {
      if (fedFunds.value > fedFunds.previousValue) {
        score -= 1; // Rates rising — tightening
      } else if (fedFunds.value < fedFunds.previousValue) {
        score += 1; // Rates falling — easing
      }
    }

    // CPI trend
    const cpi = find('CPIAUCSL');
    if (cpi) {
      if (cpi.value > cpi.previousValue) {
        score -= 1; // Inflation rising
      } else if (cpi.value < cpi.previousValue) {
        score += 1; // Inflation cooling
      }
    }

    logger.debug({ score }, 'Macro bias score calculated');

    if (score >= 2) return 'bullish';
    if (score <= -2) return 'bearish';
    return 'neutral';
  }
}
