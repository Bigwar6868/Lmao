// ============================================================
// Quant Module Manager — AI decision layer for optional modules
// ============================================================

import type { Signal, MarketData, Candle, AssetInfo, Timeframe, MacroEnvironment } from '../../shared/types.js';
import { createModuleLogger } from '../../shared/logger.js';

// High-impact (always active)
import { ICDecayTracker, type ICHealthReport } from './ic-decay-tracker.js';
import { HMMRegimeDetector, type HMMRegimeResult } from './hmm-regime.js';
import { StatisticalValidator, type WFEResult, type DeflatedSharpeResult } from './statistical-validation.js';
import { OUHalfLifeFilter, type HalfLifeResult } from './ou-halflife.js';

// Medium-impact (optional — AI decides)
import { FactorCrowdingDetector, type CrowdingReport } from './factor-crowding.js';
import { SessionSpreadModel, type SpreadEstimate } from './session-spread.js';
import { COTPositioning, type COTSignal } from './cot-positioning.js';
import { CarryFactor, type CarrySignal } from './carry-factor.js';
import { ONNXExporter } from './onnx-export.js';

const log = createModuleLogger('quant-manager');

/** Whether an optional module should be active this cycle */
export interface ModuleDecision {
  module: string;
  active: boolean;
  reason: string;
}

/** Complete quant analysis report */
export interface QuantReport {
  // High-impact (always present)
  icHealth: ICHealthReport[];
  hmmRegime: HMMRegimeResult;
  halfLifeResults: HalfLifeResult[];

  // Optional (present if AI activated)
  crowding?: CrowdingReport[];
  spreadEstimates?: SpreadEstimate[];
  cotSignals?: COTSignal[];
  carrySignals?: CarrySignal[];

  // Meta
  moduleDecisions: ModuleDecision[];
  adjustedSignals: Signal[];
  timestamp: number;
}

/**
 * Quant Module Manager
 *
 * Coordinates all quant modules. High-impact modules (IC, HMM, WFE, OU)
 * are always active. Medium-impact modules are activated by the AI based
 * on market conditions:
 *
 * - Factor Crowding: active when >=3 strategies converge
 * - Session Spread: active during Asian session or for exotic pairs
 * - COT Positioning: active when extreme positioning detected
 * - Carry Factor: active for forex pairs with rate differentials
 * - ONNX Export: on-demand only
 */
export class QuantModuleManager {
  // === HIGH-IMPACT (always active) ===
  readonly icTracker = new ICDecayTracker();
  readonly hmmRegime = new HMMRegimeDetector();
  readonly statValidator = new StatisticalValidator();
  readonly ouFilter = new OUHalfLifeFilter();

  // === MEDIUM-IMPACT (optional) ===
  readonly crowdingDetector = new FactorCrowdingDetector();
  readonly spreadModel = new SessionSpreadModel();
  readonly cotPositioning = new COTPositioning();
  readonly carryFactor = new CarryFactor();
  readonly onnxExporter = new ONNXExporter();

  private cycleCount = 0;

  constructor() {
    // Seed COT with synthetic data for cloud mode
    this.cotPositioning.seedSynthetic();
    log.info('QuantModuleManager initialized with 9 modules');
  }

  /**
   * Run full quant analysis cycle.
   *
   * 1. Always: IC tracking, HMM regime, OU half-life
   * 2. AI decides: which optional modules to activate
   * 3. Adjust signals based on all active module outputs
   */
  async runCycle(
    signals: Signal[],
    marketDataMap: Map<string, MarketData>,
    prices: Map<string, number>,
    macro?: MacroEnvironment,
  ): Promise<QuantReport> {
    this.cycleCount++;
    const moduleDecisions: ModuleDecision[] = [];

    // ================================================================
    // HIGH-IMPACT MODULES (always run)
    // ================================================================

    // 1. IC Decay Tracker — record signals, resolve outcomes
    this.icTracker.recordSignals(signals);
    this.icTracker.resolveOutcomes(prices);
    const icHealth = this.icTracker.getHealthReports();

    // 2. HMM Regime Detection — aggregate across major pairs
    const hmmRegime = this.detectAggregateRegime(marketDataMap);

    // 3. OU Half-Life — compute for all assets with candle data
    const halfLifeResults = this.computeHalfLives(marketDataMap);

    // ================================================================
    // AI DECISION: which optional modules to activate
    // ================================================================

    // Factor Crowding: activate if we have 3+ non-HOLD signals
    const nonHoldSignals = signals.filter(s => s.action !== 'HOLD');
    const useCrowding = nonHoldSignals.length >= 6;
    moduleDecisions.push({
      module: 'factor-crowding',
      active: useCrowding,
      reason: useCrowding
        ? `${nonHoldSignals.length} active signals — checking for crowding`
        : `Only ${nonHoldSignals.length} signals — crowding check unnecessary`,
    });

    // Session Spread: activate during Asian session or if trading exotics
    const currentSession = this.spreadModel.getCurrentSession();
    const hasExotics = [...marketDataMap.keys()].some(s =>
      s.includes('TRY') || s.includes('ZAR') || s.includes('THB') || s.includes('PLN'),
    );
    const useSpread = currentSession === 'asian' || hasExotics;
    moduleDecisions.push({
      module: 'session-spread',
      active: useSpread,
      reason: useSpread
        ? `${currentSession} session${hasExotics ? ' + exotic pairs' : ''} — spread awareness active`
        : `${currentSession} session with majors — spreads are tight`,
    });

    // COT Positioning: activate every 5 cycles (weekly-ish cadence)
    const useCOT = this.cycleCount % 5 === 0;
    moduleDecisions.push({
      module: 'cot-positioning',
      active: useCOT,
      reason: useCOT
        ? 'Periodic COT check — scanning for extreme positioning'
        : 'COT checked recently — skipping this cycle',
    });

    // Carry Factor: activate if we have forex pairs and regime isn't crisis
    const hasForex = [...marketDataMap.values()].some(d => d.asset.assetClass === 'forex');
    const useCarry = hasForex && hmmRegime.currentState !== 'bear';
    moduleDecisions.push({
      module: 'carry-factor',
      active: useCarry,
      reason: useCarry
        ? `Forex pairs present, ${hmmRegime.currentState} regime — carry factor active`
        : hasForex
          ? `Bear regime — carry factor disabled (crash risk)`
          : 'No forex pairs — carry factor N/A',
    });

    // ================================================================
    // RUN OPTIONAL MODULES
    // ================================================================

    let crowdingReports: CrowdingReport[] | undefined;
    if (useCrowding) {
      crowdingReports = this.crowdingDetector.analyze(nonHoldSignals);
    }

    let spreadEstimates: SpreadEstimate[] | undefined;
    if (useSpread) {
      spreadEstimates = [];
      for (const [, data] of marketDataMap) {
        const price = data.candles.length > 0 ? data.candles[data.candles.length - 1].close : 0;
        if (price > 0) {
          spreadEstimates.push(this.spreadModel.estimate(data.asset, price));
        }
      }
    }

    let cotSignals: COTSignal[] | undefined;
    if (useCOT) {
      cotSignals = [];
      for (const [symbol] of marketDataMap) {
        const sig = this.cotPositioning.getSignal(symbol);
        if (sig.signal !== 'neutral') cotSignals.push(sig);
      }
    }

    let carrySignals: CarrySignal[] | undefined;
    if (useCarry) {
      carrySignals = [];
      for (const [symbol] of marketDataMap) {
        const carry = this.carryFactor.getCarrySignal(symbol);
        if (carry.signal !== 'HOLD') carrySignals.push(carry);
      }
    }

    // ================================================================
    // ADJUST SIGNALS based on all active module outputs
    // ================================================================

    const adjustedSignals = this.adjustSignals(
      signals,
      icHealth,
      hmmRegime,
      halfLifeResults,
      crowdingReports,
      spreadEstimates,
      cotSignals,
      carrySignals,
    );

    const report: QuantReport = {
      icHealth,
      hmmRegime,
      halfLifeResults,
      crowding: crowdingReports,
      spreadEstimates,
      cotSignals,
      carrySignals,
      moduleDecisions,
      adjustedSignals,
      timestamp: Date.now(),
    };

    // Log summary
    const activeModules = moduleDecisions.filter(d => d.active).map(d => d.module);
    log.info({
      cycle: this.cycleCount,
      regime: hmmRegime.currentState,
      icReports: icHealth.length,
      halfLives: halfLifeResults.length,
      activeOptional: activeModules,
      signalsIn: signals.length,
      signalsOut: adjustedSignals.length,
    }, 'Quant cycle complete');

    return report;
  }

  /**
   * Adjust signal confidence and filter based on all module outputs.
   * This is where the high-impact modules directly affect trading.
   */
  private adjustSignals(
    signals: Signal[],
    icHealth: ICHealthReport[],
    hmmRegime: HMMRegimeResult,
    halfLifeResults: HalfLifeResult[],
    crowding?: CrowdingReport[],
    spreads?: SpreadEstimate[],
    cot?: COTSignal[],
    carry?: CarrySignal[],
  ): Signal[] {
    const adjusted: Signal[] = [];

    for (const signal of signals) {
      if (signal.action === 'HOLD') continue;

      let confidence = signal.confidence;
      const modifiers: string[] = [];

      // 1. IC Decay — scale by strategy health
      const icMult = this.icTracker.getStrategyConfidenceMultiplier(signal.strategy);
      if (icMult < 1.0) {
        confidence *= icMult;
        modifiers.push(`IC decay (${(icMult * 100).toFixed(0)}%)`);
      }

      // 2. HMM Regime — scale by regime suitability for this strategy
      const regimeWeight = hmmRegime.strategyWeights[signal.strategy] ?? 0.5;
      if (regimeWeight < 0.5) {
        confidence *= regimeWeight;
        modifiers.push(`regime ${hmmRegime.currentState} (${(regimeWeight * 100).toFixed(0)}%)`);
      } else if (regimeWeight > 0.7) {
        confidence *= Math.min(1.15, 1 + (regimeWeight - 0.7) * 0.5);
        modifiers.push(`regime boost (${(regimeWeight * 100).toFixed(0)}%)`);
      }

      // 3. OU Half-Life — filter MR signals on non-suitable pairs
      if (signal.strategy === 'mean-reversion') {
        const hlScore = this.ouFilter.getSuitabilityScore(signal.asset.symbol);
        if (hlScore < 0.3) {
          modifiers.push('OU filter: not mean-reverting');
          continue; // Skip this signal entirely
        }
        confidence *= Math.max(0.5, hlScore);
        if (hlScore < 1.0) modifiers.push(`OU half-life (${(hlScore * 100).toFixed(0)}%)`);
      }

      // 4. Factor Crowding (optional) — reduce size when crowded
      if (crowding) {
        const report = crowding.find(r => r.symbol === signal.asset.symbol);
        if (report?.isCrowded) {
          confidence *= report.sizeMultiplier;
          modifiers.push(`crowding (${(report.sizeMultiplier * 100).toFixed(0)}%)`);
        }
      }

      // 5. Session Spread (optional) — penalize expensive-to-trade pairs
      if (spreads) {
        const est = spreads.find(e => e.symbol === signal.asset.symbol);
        if (est && est.recommendation === 'avoid') {
          modifiers.push('spread too wide');
          continue; // Skip signal
        }
        if (est && est.recommendation === 'caution') {
          confidence *= 0.85;
          modifiers.push('wide spread (-15%)');
        }
      }

      // 6. COT Positioning (optional) — contrarian overlay
      if (cot) {
        const cotMod = this.cotPositioning.getConfidenceModifier(signal.asset.symbol, signal.action);
        if (cotMod !== 1.0) {
          confidence *= cotMod;
          modifiers.push(`COT ${cotMod > 1 ? 'boost' : 'penalty'} (${(cotMod * 100).toFixed(0)}%)`);
        }
      }

      // 7. Carry Factor (optional) — boost/penalize based on carry alignment
      if (carry) {
        const carryMod = this.carryFactor.getCarryModifier(signal.asset.symbol, signal.action);
        if (carryMod !== 1.0) {
          confidence *= carryMod;
          modifiers.push(`carry ${carryMod > 1 ? 'aligned' : 'counter'} (${(carryMod * 100).toFixed(0)}%)`);
        }
      }

      // Clamp confidence
      confidence = Math.max(0, Math.min(1, confidence));

      // Build adjusted signal
      const adjustedReason = modifiers.length > 0
        ? `${signal.reason} [QM: ${modifiers.join(', ')}]`
        : signal.reason;

      adjusted.push({
        ...signal,
        confidence,
        reason: adjustedReason,
      });
    }

    return adjusted;
  }

  /**
   * Detect aggregate regime from representative pairs.
   */
  private detectAggregateRegime(marketDataMap: Map<string, MarketData>): HMMRegimeResult {
    // Use EUR/USD as primary, fall back to first available
    const primary = marketDataMap.get('EUR/USD') ?? [...marketDataMap.values()][0];
    if (!primary || primary.candles.length < 50) {
      return this.hmmRegime.detect([]);
    }
    return this.hmmRegime.detect(primary.candles);
  }

  /**
   * Compute OU half-lives for all assets.
   */
  private computeHalfLives(marketDataMap: Map<string, MarketData>): HalfLifeResult[] {
    const results: HalfLifeResult[] = [];
    for (const [symbol, data] of marketDataMap) {
      if (data.candles.length >= 50) {
        results.push(this.ouFilter.compute(symbol, data.candles));
      }
    }
    return results;
  }

  /**
   * Get carry signals for the trading pipeline.
   * These are additional signals the carry module generates independently.
   */
  getCarrySignals(
    assets: AssetInfo[],
    candles: Map<string, Candle[]>,
    timeframe: Timeframe,
  ): Signal[] {
    return this.carryFactor.generateSignals(assets, candles, timeframe);
  }

  /**
   * Format full quant report for display.
   */
  static formatReport(report: QuantReport): string {
    const lines: string[] = [
      '\n' + '='.repeat(60),
      '  QUANT MODULE ANALYSIS',
      '='.repeat(60),
    ];

    // Module decisions
    lines.push('\nModule Status:');
    for (const d of report.moduleDecisions) {
      const icon = d.active ? 'ON ' : 'OFF';
      lines.push(`  [${icon}] ${d.module.padEnd(20)} ${d.reason}`);
    }

    // HMM Regime
    lines.push(HMMRegimeDetector.formatReport(report.hmmRegime));

    // IC Health
    lines.push(ICDecayTracker.formatReport(report.icHealth));

    // OU Half-Life (just summary)
    const mrSuitable = report.halfLifeResults.filter(r => r.suitableForMR);
    if (report.halfLifeResults.length > 0) {
      lines.push(`\nOU Half-Life: ${mrSuitable.length}/${report.halfLifeResults.length} pairs suitable for mean-reversion`);
    }

    // Optional module reports
    if (report.crowding) {
      lines.push(FactorCrowdingDetector.formatReport(report.crowding));
    }
    if (report.cotSignals && report.cotSignals.length > 0) {
      lines.push(COTPositioning.formatReport(report.cotSignals));
    }
    if (report.carrySignals && report.carrySignals.length > 0) {
      lines.push(CarryFactor.formatReport(report.carrySignals));
    }

    // Signal adjustment summary
    lines.push(`\nSignals adjusted: ${report.adjustedSignals.length} (from quant module analysis)`);

    return lines.join('\n');
  }
}
