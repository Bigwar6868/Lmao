// ============================================================
// Adaptive Weighting Engine
//
// Dynamically adjusts strategy weights and risk parameters
// based on the current macro regime. The system should function
// in EVERY macro environment: bull, bear, crisis, recovery,
// range-bound, stagflation, deflation, etc.
//
// Key insight: no single set of weights works everywhere.
// Instead, we detect the regime and apply regime-specific
// weight profiles that have been calibrated for each environment.
// ============================================================

import { createModuleLogger } from '../../shared/logger.js';
import type { MacroIndicator, MacroEnvironment } from '../../shared/types.js';
import type { GlobalMacroSnapshot, GeopoliticalFactor, PolicyChange } from './types.js';

const logger = createModuleLogger('adaptive-weights');

// ---- Macro Regime Classification ----

export type MacroRegime =
  | 'goldilocks'        // Moderate growth, low inflation, accommodative policy
  | 'reflation'         // Rising growth, rising inflation
  | 'stagflation'       // Low growth, high inflation
  | 'deflation'         // Falling growth, falling inflation
  | 'crisis'            // Extreme stress — VIX > 35, yield curve deeply inverted
  | 'recovery'          // Post-crisis recovery — growth inflecting up
  | 'overheating'       // Strong growth, tightening policy, late cycle
  | 'risk_off'          // Elevated fear but not full crisis
  | 'neutral';          // No clear regime

export interface StrategyWeightProfile {
  momentum: number;
  meanReversion: number;
  breakout: number;
  multiIndicator: number;
}

export interface RiskMultipliers {
  positionSize: number;    // 0.0–2.0 multiplier on base position size
  stopLossWidth: number;   // 1.0 = default, >1 = wider stops, <1 = tighter
  maxExposure: number;     // 0.0–1.0 fraction of max allowed exposure to use
  takeProfitRatio: number; // Multiplier on take-profit distance
}

export interface AdaptiveWeights {
  regime: MacroRegime;
  confidence: number;           // 0–1: how confident we are in the regime classification
  strategyWeights: StrategyWeightProfile;
  riskMultipliers: RiskMultipliers;
  assetClassBias: Record<string, number>; // crypto/stock/forex → -1 (avoid) to +1 (prefer)
  signals: string[];            // Human-readable explanations
}

// ---- Regime Detection ----

interface RegimeInputs {
  gdpGrowth: number;           // YoY %
  inflation: number;           // YoY %
  fedRate: number;
  previousFedRate: number;
  yieldCurve: number;          // T10Y2Y spread
  vix: number;
  unemployment: number;
  previousUnemployment: number;
  globalPolicyBias: 'hawkish' | 'dovish' | 'mixed';
  highImpactPeriod: boolean;
  activeConflicts: number;     // Count of high/critical severity factors
  activeSanctions: number;
}

/**
 * Detect the current macro regime from a comprehensive set of inputs.
 * Uses a multi-factor scoring system — not a simple threshold.
 */
export function detectRegime(inputs: RegimeInputs): { regime: MacroRegime; confidence: number; signals: string[] } {
  const signals: string[] = [];
  const scores: Partial<Record<MacroRegime, number>> = {};

  // Initialize all regime scores
  for (const regime of ['goldilocks', 'reflation', 'stagflation', 'deflation', 'crisis', 'recovery', 'overheating', 'risk_off', 'neutral'] as MacroRegime[]) {
    scores[regime] = 0;
  }

  // ---- VIX-based signals ----
  if (inputs.vix > 35) {
    scores.crisis = (scores.crisis ?? 0) + 3;
    signals.push(`VIX extremely elevated (${inputs.vix}) — crisis conditions`);
  } else if (inputs.vix > 25) {
    scores.risk_off = (scores.risk_off ?? 0) + 2;
    signals.push(`VIX elevated (${inputs.vix}) — risk-off environment`);
  } else if (inputs.vix < 15) {
    scores.goldilocks = (scores.goldilocks ?? 0) + 1;
    signals.push(`VIX low (${inputs.vix}) — complacent/goldilocks`);
  }

  // ---- Yield curve signals ----
  if (inputs.yieldCurve < -0.5) {
    scores.crisis = (scores.crisis ?? 0) + 2;
    scores.stagflation = (scores.stagflation ?? 0) + 1;
    signals.push(`Yield curve deeply inverted (${inputs.yieldCurve}) — recession signal`);
  } else if (inputs.yieldCurve < 0) {
    scores.risk_off = (scores.risk_off ?? 0) + 1;
    scores.stagflation = (scores.stagflation ?? 0) + 1;
    signals.push(`Yield curve inverted (${inputs.yieldCurve})`);
  } else if (inputs.yieldCurve > 1.0) {
    scores.recovery = (scores.recovery ?? 0) + 1;
    scores.goldilocks = (scores.goldilocks ?? 0) + 1;
    signals.push(`Yield curve steep (${inputs.yieldCurve}) — recovery/expansion`);
  }

  // ---- Growth + Inflation quadrant ----
  const growthStrong = inputs.gdpGrowth > 2.5;
  const growthWeak = inputs.gdpGrowth < 1.0;
  const inflationHigh = inputs.inflation > 4.0;
  const inflationLow = inputs.inflation < 2.0;
  const inflationModerate = !inflationHigh && !inflationLow;

  if (growthStrong && inflationHigh) {
    scores.overheating = (scores.overheating ?? 0) + 3;
    signals.push(`Growth strong (${inputs.gdpGrowth}%) + inflation high (${inputs.inflation}%) — overheating`);
  } else if (growthStrong && inflationModerate) {
    scores.goldilocks = (scores.goldilocks ?? 0) + 3;
    signals.push(`Growth strong + inflation moderate — goldilocks`);
  } else if (growthWeak && inflationHigh) {
    scores.stagflation = (scores.stagflation ?? 0) + 3;
    signals.push(`Growth weak (${inputs.gdpGrowth}%) + inflation high (${inputs.inflation}%) — stagflation`);
  } else if (growthWeak && inflationLow) {
    scores.deflation = (scores.deflation ?? 0) + 3;
    signals.push(`Growth weak + inflation low — deflationary`);
  } else if (growthStrong && inflationLow) {
    scores.reflation = (scores.reflation ?? 0) + 2;
    scores.goldilocks = (scores.goldilocks ?? 0) + 1;
    signals.push(`Growth strong + inflation low — reflation`);
  }

  // ---- Monetary policy stance ----
  const rateRising = inputs.fedRate > inputs.previousFedRate;
  const rateFalling = inputs.fedRate < inputs.previousFedRate;

  if (rateRising && inflationHigh) {
    scores.overheating = (scores.overheating ?? 0) + 1;
    scores.stagflation = (scores.stagflation ?? 0) + 1;
    signals.push('Rates rising + inflation high — tightening cycle');
  } else if (rateFalling) {
    scores.recovery = (scores.recovery ?? 0) + 1;
    scores.reflation = (scores.reflation ?? 0) + 1;
    signals.push('Rates falling — easing cycle favors recovery');
  }

  if (inputs.globalPolicyBias === 'dovish') {
    scores.recovery = (scores.recovery ?? 0) + 1;
    scores.reflation = (scores.reflation ?? 0) + 1;
  } else if (inputs.globalPolicyBias === 'hawkish') {
    scores.overheating = (scores.overheating ?? 0) + 1;
    scores.risk_off = (scores.risk_off ?? 0) + 1;
  }

  // ---- Employment signals ----
  const unemploymentRising = inputs.unemployment > inputs.previousUnemployment + 0.3;
  if (unemploymentRising) {
    scores.crisis = (scores.crisis ?? 0) + 1;
    scores.deflation = (scores.deflation ?? 0) + 1;
    signals.push(`Unemployment rising (${inputs.unemployment}%) — labor market weakening`);
  }

  // ---- Geopolitical signals ----
  if (inputs.activeConflicts >= 2) {
    scores.crisis = (scores.crisis ?? 0) + 1;
    scores.risk_off = (scores.risk_off ?? 0) + 1;
    signals.push(`Multiple active conflicts (${inputs.activeConflicts}) — elevated geopolitical risk`);
  }

  // ---- Event calendar ----
  if (inputs.highImpactPeriod) {
    signals.push('High-impact economic event within 24h — elevated uncertainty');
  }

  // Find the winning regime
  let maxScore = 0;
  let regime: MacroRegime = 'neutral';
  for (const [r, s] of Object.entries(scores)) {
    if (s! > maxScore) {
      maxScore = s!;
      regime = r as MacroRegime;
    }
  }

  // Confidence = winning score / total possible score (capped at 1)
  const totalScore = Object.values(scores).reduce((a, b) => a + (b ?? 0), 0) || 1;
  const confidence = Math.min(1, maxScore / Math.max(totalScore * 0.5, 1));

  logger.info({ regime, confidence: confidence.toFixed(2), maxScore, signals: signals.length }, 'Macro regime detected');

  return { regime, confidence, signals };
}

// ---- Strategy Weight Profiles per Regime ----

/**
 * Each regime has a calibrated strategy weight profile.
 * Weights represent relative allocation (normalized to sum=1 at runtime).
 *
 * Rationale:
 * - Trending markets (bull/recovery/reflation): favor momentum + breakout
 * - Range-bound markets (goldilocks/neutral): favor mean-reversion + multi-indicator
 * - Crisis: reduce everything, favor mean-reversion (snap-back potential)
 * - Stagflation: low conviction everywhere, cautious multi-indicator
 */
const REGIME_STRATEGY_WEIGHTS: Record<MacroRegime, StrategyWeightProfile> = {
  goldilocks:   { momentum: 0.30, meanReversion: 0.30, breakout: 0.15, multiIndicator: 0.25 },
  reflation:    { momentum: 0.35, meanReversion: 0.15, breakout: 0.30, multiIndicator: 0.20 },
  stagflation:  { momentum: 0.10, meanReversion: 0.30, breakout: 0.10, multiIndicator: 0.50 },
  deflation:    { momentum: 0.15, meanReversion: 0.35, breakout: 0.10, multiIndicator: 0.40 },
  crisis:       { momentum: 0.05, meanReversion: 0.40, breakout: 0.05, multiIndicator: 0.50 },
  recovery:     { momentum: 0.40, meanReversion: 0.10, breakout: 0.30, multiIndicator: 0.20 },
  overheating:  { momentum: 0.25, meanReversion: 0.25, breakout: 0.20, multiIndicator: 0.30 },
  risk_off:     { momentum: 0.10, meanReversion: 0.35, breakout: 0.10, multiIndicator: 0.45 },
  neutral:      { momentum: 0.25, meanReversion: 0.25, breakout: 0.25, multiIndicator: 0.25 },
};

// ---- Risk Multipliers per Regime ----

const REGIME_RISK_MULTIPLIERS: Record<MacroRegime, RiskMultipliers> = {
  goldilocks:   { positionSize: 1.2,  stopLossWidth: 1.0, maxExposure: 0.9,  takeProfitRatio: 1.0 },
  reflation:    { positionSize: 1.1,  stopLossWidth: 1.1, maxExposure: 0.85, takeProfitRatio: 1.2 },
  stagflation:  { positionSize: 0.6,  stopLossWidth: 0.8, maxExposure: 0.5,  takeProfitRatio: 0.8 },
  deflation:    { positionSize: 0.5,  stopLossWidth: 0.8, maxExposure: 0.4,  takeProfitRatio: 0.7 },
  crisis:       { positionSize: 0.3,  stopLossWidth: 0.6, maxExposure: 0.2,  takeProfitRatio: 0.5 },
  recovery:     { positionSize: 1.0,  stopLossWidth: 1.2, maxExposure: 0.8,  takeProfitRatio: 1.5 },
  overheating:  { positionSize: 0.7,  stopLossWidth: 0.9, maxExposure: 0.6,  takeProfitRatio: 0.9 },
  risk_off:     { positionSize: 0.5,  stopLossWidth: 0.7, maxExposure: 0.4,  takeProfitRatio: 0.7 },
  neutral:      { positionSize: 1.0,  stopLossWidth: 1.0, maxExposure: 0.7,  takeProfitRatio: 1.0 },
};

// ---- Asset Class Biases per Regime ----

/**
 * How much to prefer each asset class in different regimes.
 * -1 = strongly avoid, 0 = neutral, +1 = strongly prefer
 */
const REGIME_ASSET_BIAS: Record<MacroRegime, Record<string, number>> = {
  goldilocks:   { crypto: 0.5,  stock: 0.7,  forex: 0.2 },
  reflation:    { crypto: 0.6,  stock: 0.5,  forex: 0.3 },
  stagflation:  { crypto: -0.3, stock: -0.4, forex: 0.5 },
  deflation:    { crypto: -0.5, stock: -0.3, forex: 0.4 },
  crisis:       { crypto: -0.7, stock: -0.6, forex: 0.3 },
  recovery:     { crypto: 0.7,  stock: 0.6,  forex: 0.1 },
  overheating:  { crypto: 0.2,  stock: 0.0,  forex: 0.4 },
  risk_off:     { crypto: -0.4, stock: -0.2, forex: 0.5 },
  neutral:      { crypto: 0.0,  stock: 0.0,  forex: 0.0 },
};

// ---- Main Engine ----

/**
 * Build adaptive weights from the current macro environment.
 *
 * This is the central function that translates macro state into
 * actionable strategy weights and risk parameters.
 */
export function computeAdaptiveWeights(
  indicators: MacroIndicator[],
  globalSnapshots: GlobalMacroSnapshot[],
  activeFactors: GeopoliticalFactor[],
  policyChanges: PolicyChange[],
  globalPolicyBias: 'hawkish' | 'dovish' | 'mixed',
  highImpactPeriod: boolean,
): AdaptiveWeights {
  const find = (name: string) => indicators.find(i => i.name === name);

  // Extract inputs
  const usSnapshot = globalSnapshots.find(s => s.region === 'United States');
  const gdpGrowth = usSnapshot?.indicators.gdpGrowth ?? 2.0;
  const inflation = usSnapshot?.indicators.inflation ?? 3.0;
  const unemployment = usSnapshot?.indicators.unemployment ?? 4.0;

  const fedFunds = find('FEDFUNDS');
  const vixInd = find('VIXCLS');
  const yieldCurve = find('T10Y2Y');
  const unrate = find('UNRATE');

  const inputs: RegimeInputs = {
    gdpGrowth,
    inflation,
    fedRate: fedFunds?.value ?? 5.0,
    previousFedRate: fedFunds?.previousValue ?? 5.0,
    yieldCurve: yieldCurve?.value ?? 0.0,
    vix: vixInd?.value ?? 18,
    unemployment: unrate?.value ?? unemployment,
    previousUnemployment: unrate?.previousValue ?? unemployment,
    globalPolicyBias,
    highImpactPeriod,
    activeConflicts: activeFactors.filter(f =>
      (f.category === 'conflict' || f.category === 'sanctions') &&
      (f.severity === 'high' || f.severity === 'critical')
    ).length,
    activeSanctions: activeFactors.filter(f => f.category === 'sanctions').length,
  };

  const { regime, confidence, signals } = detectRegime(inputs);

  // Apply event calendar adjustment
  const eventAdjustedRisk = { ...REGIME_RISK_MULTIPLIERS[regime] };
  if (highImpactPeriod) {
    eventAdjustedRisk.positionSize *= 0.7;
    eventAdjustedRisk.maxExposure *= 0.7;
    signals.push('Reduced position sizes -30% due to upcoming high-impact event');
  }

  // Apply geopolitical conflict premium
  const highSeverityCount = activeFactors.filter(f => f.severity === 'high' || f.severity === 'critical').length;
  if (highSeverityCount >= 3) {
    eventAdjustedRisk.positionSize *= 0.8;
    eventAdjustedRisk.stopLossWidth *= 0.9;
    signals.push(`Geopolitical premium applied — ${highSeverityCount} high-severity factors active`);
  }

  // Policy divergence adjustment (if major central banks diverge, forex gets a boost)
  const policyStances = globalSnapshots.map(s => s.policyStance);
  const hawkishCount = policyStances.filter(s => s === 'hawkish').length;
  const dovishCount = policyStances.filter(s => s === 'dovish').length;
  const assetBias = { ...REGIME_ASSET_BIAS[regime] };
  if (Math.abs(hawkishCount - dovishCount) >= 2) {
    assetBias.forex = Math.min(1, (assetBias.forex ?? 0) + 0.3);
    signals.push('Central bank policy divergence → forex opportunities');
  }

  return {
    regime,
    confidence,
    strategyWeights: REGIME_STRATEGY_WEIGHTS[regime],
    riskMultipliers: eventAdjustedRisk,
    assetClassBias: assetBias,
    signals,
  };
}

/**
 * Convenience: build adaptive weights directly from a MacroEconomist's environment
 * and geopolitical data.
 */
export function computeAdaptiveWeightsFromEnv(
  env: MacroEnvironment,
  globalSnapshots: GlobalMacroSnapshot[],
  activeFactors: GeopoliticalFactor[],
  policyChanges: PolicyChange[],
  globalPolicyBias: 'hawkish' | 'dovish' | 'mixed',
  highImpactPeriod: boolean,
): AdaptiveWeights {
  return computeAdaptiveWeights(
    env.indicators,
    globalSnapshots,
    activeFactors,
    policyChanges,
    globalPolicyBias,
    highImpactPeriod,
  );
}

/**
 * Format adaptive weights for human-readable output.
 */
export function formatAdaptiveWeights(weights: AdaptiveWeights): string {
  const lines: string[] = [
    '\n=== ADAPTIVE MACRO WEIGHTS ===',
    `Regime: ${weights.regime.toUpperCase()} (confidence: ${(weights.confidence * 100).toFixed(0)}%)`,
    '',
    'Strategy Weights:',
    `  Momentum:        ${(weights.strategyWeights.momentum * 100).toFixed(0)}%`,
    `  Mean Reversion:  ${(weights.strategyWeights.meanReversion * 100).toFixed(0)}%`,
    `  Breakout:        ${(weights.strategyWeights.breakout * 100).toFixed(0)}%`,
    `  Multi-Indicator: ${(weights.strategyWeights.multiIndicator * 100).toFixed(0)}%`,
    '',
    'Risk Multipliers:',
    `  Position Size:   ${weights.riskMultipliers.positionSize.toFixed(2)}x`,
    `  Stop Width:      ${weights.riskMultipliers.stopLossWidth.toFixed(2)}x`,
    `  Max Exposure:    ${(weights.riskMultipliers.maxExposure * 100).toFixed(0)}%`,
    `  Take Profit:     ${weights.riskMultipliers.takeProfitRatio.toFixed(2)}x`,
    '',
    'Asset Class Bias:',
    `  Crypto:  ${weights.assetClassBias.crypto >= 0 ? '+' : ''}${(weights.assetClassBias.crypto * 100).toFixed(0)}%`,
    `  Stocks:  ${weights.assetClassBias.stock >= 0 ? '+' : ''}${(weights.assetClassBias.stock * 100).toFixed(0)}%`,
    `  Forex:   ${weights.assetClassBias.forex >= 0 ? '+' : ''}${(weights.assetClassBias.forex * 100).toFixed(0)}%`,
  ];

  if (weights.signals.length > 0) {
    lines.push('', 'Signals:');
    for (const s of weights.signals) {
      lines.push(`  • ${s}`);
    }
  }

  return lines.join('\n');
}
