import type { Candle, MacroEnvironment, Portfolio, Position, PerformanceMetrics } from '../../shared/types.js';
import type { MarketRegime, RegimeAnalysis } from '../regime-detector/index.js';
import type { SimulationReport } from '../scenario-simulator/index.js';
import { mean, stdDev, roundTo } from '../../shared/utils.js';
import { createModuleLogger } from '../../shared/logger.js';

const log = createModuleLogger('diagnostics');

// ============================================================
// Diagnostic Types
// ============================================================

export type Severity = 'info' | 'warning' | 'critical' | 'emergency';

export interface Diagnostic {
  id: string;
  category: DiagnosticCategory;
  severity: Severity;
  title: string;
  description: string;
  evidence: string[];
  recommendation: string;
  timestamp: number;
}

export type DiagnosticCategory =
  | 'market_anomaly'      // Unusual price/volume behavior
  | 'risk_exposure'       // Portfolio risk issues
  | 'strategy_decay'      // Strategy losing edge
  | 'macro_divergence'    // Macro signals conflicting
  | 'correlation_break'   // Unusual correlation shifts
  | 'liquidity_warning'   // Volume/spread concerns
  | 'regime_transition'   // Market regime changing
  | 'structural_risk';    // Systemic/structural concerns

export interface DiagnosticReport {
  timestamp: number;
  totalDiagnostics: number;
  emergencies: Diagnostic[];
  criticals: Diagnostic[];
  warnings: Diagnostic[];
  infos: Diagnostic[];
  healthScore: number;      // 0-100, overall system/market health
  summary: string;
}

// ============================================================
// Diagnostics Engine
// ============================================================

/**
 * Problem Diagnostics Engine
 *
 * Continuously monitors for:
 * 1. Market anomalies (flash crashes, volume spikes, price gaps)
 * 2. Portfolio risk exposure (concentration, drawdown, correlation)
 * 3. Strategy performance decay (declining Sharpe, win rate)
 * 4. Macro divergence (conflicting signals from different indicators)
 * 5. Correlation breaks (assets decoupling from normal patterns)
 * 6. Liquidity issues (thinning volume, widening spreads)
 * 7. Regime transitions (market character changing)
 * 8. Structural risks (systemic issues, black swan indicators)
 */
export class DiagnosticsEngine {
  private diagnosticCounter = 0;

  /**
   * Run full diagnostic scan.
   */
  scan(params: {
    candles: Map<string, Candle[]>;
    portfolio?: Portfolio;
    metrics?: Map<string, PerformanceMetrics>;
    regime?: RegimeAnalysis;
    simulation?: SimulationReport;
    macro?: MacroEnvironment;
  }): DiagnosticReport {
    const diagnostics: Diagnostic[] = [];

    // 1. Market anomaly detection
    for (const [symbol, data] of params.candles) {
      diagnostics.push(...this.detectMarketAnomalies(symbol, data));
    }

    // 2. Portfolio risk diagnostics
    if (params.portfolio) {
      diagnostics.push(...this.analyzePortfolioRisk(params.portfolio));
    }

    // 3. Strategy decay detection
    if (params.metrics) {
      diagnostics.push(...this.detectStrategyDecay(params.metrics));
    }

    // 4. Macro divergence
    if (params.macro) {
      diagnostics.push(...this.detectMacroDivergence(params.macro));
    }

    // 5. Cross-asset correlation analysis
    if (params.candles.size > 1) {
      diagnostics.push(...this.analyzeCorrelations(params.candles));
    }

    // 6. Regime transition warnings
    if (params.regime) {
      diagnostics.push(...this.checkRegimeTransition(params.regime));
    }

    // 7. Structural risk assessment
    if (params.macro && params.regime) {
      diagnostics.push(...this.assessStructuralRisks(params.macro, params.regime));
    }

    // Categorize and create report
    const emergencies = diagnostics.filter((d) => d.severity === 'emergency');
    const criticals = diagnostics.filter((d) => d.severity === 'critical');
    const warnings = diagnostics.filter((d) => d.severity === 'warning');
    const infos = diagnostics.filter((d) => d.severity === 'info');

    const healthScore = this.calculateHealthScore(diagnostics);

    const report: DiagnosticReport = {
      timestamp: Date.now(),
      totalDiagnostics: diagnostics.length,
      emergencies,
      criticals,
      warnings,
      infos,
      healthScore,
      summary: this.generateSummary(healthScore, emergencies, criticals, warnings),
    };

    log.info({
      health: healthScore,
      emergencies: emergencies.length,
      criticals: criticals.length,
      warnings: warnings.length,
    }, 'Diagnostic scan complete');

    return report;
  }

  // ============================================================
  // Market Anomaly Detection
  // ============================================================

  private detectMarketAnomalies(symbol: string, candles: Candle[]): Diagnostic[] {
    const results: Diagnostic[] = [];
    if (candles.length < 20) return results;

    const closes = candles.map((c) => c.close);
    const volumes = candles.map((c) => c.volume);
    const latest = candles[candles.length - 1];
    const prev = candles[candles.length - 2];

    // Flash crash detection: > 5% drop in single candle
    const priceChange = ((latest.close - prev.close) / prev.close) * 100;
    if (Math.abs(priceChange) > 5) {
      results.push(this.createDiagnostic(
        'market_anomaly',
        priceChange < 0 ? 'critical' : 'warning',
        `Flash ${priceChange < 0 ? 'crash' : 'spike'} on ${symbol}`,
        `${symbol} moved ${roundTo(priceChange, 2)}% in a single period.`,
        [`Price change: ${roundTo(priceChange, 2)}%`, `Close: ${latest.close}`, `Previous: ${prev.close}`],
        priceChange < 0
          ? 'Consider reducing exposure. Check for news catalysts. Tighten stops on open positions.'
          : 'Verify move is sustainable. Consider taking partial profits on longs.'
      ));
    }

    // Volume anomaly: > 3x average volume
    const avgVolume = mean(volumes.slice(-20));
    const volumeRatio = latest.volume / (avgVolume || 1);
    if (volumeRatio > 3) {
      results.push(this.createDiagnostic(
        'market_anomaly',
        'warning',
        `Volume spike on ${symbol}`,
        `Volume is ${roundTo(volumeRatio, 1)}x the 20-period average. This often precedes significant moves.`,
        [`Current volume: ${latest.volume}`, `Average volume: ${roundTo(avgVolume, 0)}`, `Ratio: ${roundTo(volumeRatio, 1)}x`],
        'Monitor for breakout confirmation. If accompanied by price breakout, increase conviction.'
      ));
    }

    // Price gap detection
    const gap = ((latest.open - prev.close) / prev.close) * 100;
    if (Math.abs(gap) > 2) {
      results.push(this.createDiagnostic(
        'market_anomaly',
        'warning',
        `Price gap on ${symbol}`,
        `${roundTo(Math.abs(gap), 2)}% gap ${gap > 0 ? 'up' : 'down'}. Gaps often fill — watch for retracement.`,
        [`Gap: ${roundTo(gap, 2)}%`, `Previous close: ${prev.close}`, `Current open: ${latest.open}`],
        'Gaps frequently fill. Consider fade trade with tight stop beyond gap.'
      ));
    }

    // Unusual wick: wick > 2x body (indecision / rejection)
    const body = Math.abs(latest.close - latest.open);
    const upperWick = latest.high - Math.max(latest.close, latest.open);
    const lowerWick = Math.min(latest.close, latest.open) - latest.low;
    const maxWick = Math.max(upperWick, lowerWick);
    if (body > 0 && maxWick > body * 3) {
      const wickSide = upperWick > lowerWick ? 'upper' : 'lower';
      results.push(this.createDiagnostic(
        'market_anomaly',
        'info',
        `Rejection wick on ${symbol}`,
        `Long ${wickSide} wick (${roundTo(maxWick / body, 1)}x body) signals strong ${wickSide === 'upper' ? 'selling' : 'buying'} pressure.`,
        [`Body: ${roundTo(body, 4)}`, `${wickSide} wick: ${roundTo(maxWick, 4)}`],
        `${wickSide === 'upper' ? 'Bearish' : 'Bullish'} rejection signal. Consider as reversal indicator.`
      ));
    }

    return results;
  }

  // ============================================================
  // Portfolio Risk Analysis
  // ============================================================

  private analyzePortfolioRisk(portfolio: Portfolio): Diagnostic[] {
    const results: Diagnostic[] = [];

    // Drawdown check
    if (portfolio.maxDrawdown > 15) {
      results.push(this.createDiagnostic(
        'risk_exposure',
        portfolio.maxDrawdown > 25 ? 'emergency' : 'critical',
        `Excessive drawdown: ${roundTo(portfolio.maxDrawdown, 1)}%`,
        `Portfolio drawdown has reached ${roundTo(portfolio.maxDrawdown, 1)}%, exceeding safe thresholds.`,
        [`Max drawdown: ${roundTo(portfolio.maxDrawdown, 1)}%`, `Capital: $${roundTo(portfolio.capital, 2)}`],
        portfolio.maxDrawdown > 25
          ? 'EMERGENCY: Close all positions immediately. Review strategy before resuming.'
          : 'Reduce position sizes by 50%. Tighten all stops. Consider pausing new entries.'
      ));
    }

    // Concentration risk
    if (portfolio.positions.length > 0) {
      const totalValue = portfolio.positions.reduce((s, p) => s + p.currentPrice * p.quantity, 0);
      for (const pos of portfolio.positions) {
        const exposure = (pos.currentPrice * pos.quantity) / (portfolio.capital || 1) * 100;
        if (exposure > 20) {
          results.push(this.createDiagnostic(
            'risk_exposure',
            'critical',
            `High concentration in ${pos.asset.symbol}`,
            `${roundTo(exposure, 1)}% of portfolio in single position. This creates unacceptable single-point failure risk.`,
            [`Position value: $${roundTo(pos.currentPrice * pos.quantity, 2)}`, `Portfolio: $${roundTo(portfolio.capital, 2)}`],
            'Trim position to under 10% of portfolio. Diversify across uncorrelated assets.'
          ));
        }
      }

      // All positions in same direction
      const sides = new Set(portfolio.positions.map((p) => p.side));
      if (sides.size === 1 && portfolio.positions.length > 3) {
        results.push(this.createDiagnostic(
          'risk_exposure',
          'warning',
          'Directional bias — all positions same side',
          `All ${portfolio.positions.length} positions are ${portfolio.positions[0].side}. No hedging or diversification.`,
          portfolio.positions.map((p) => `${p.asset.symbol}: ${p.side}`),
          'Consider adding counter-directional positions or reducing total exposure.'
        ));
      }

      // Unrealized losses
      const totalUnrealizedLoss = portfolio.positions
        .filter((p) => p.unrealizedPnl < 0)
        .reduce((s, p) => s + p.unrealizedPnl, 0);
      if (totalUnrealizedLoss < -(portfolio.capital * 0.1)) {
        results.push(this.createDiagnostic(
          'risk_exposure',
          'critical',
          `Large unrealized losses: $${roundTo(totalUnrealizedLoss, 2)}`,
          `Unrealized losses exceed 10% of capital. Holding losers too long erodes capital.`,
          portfolio.positions.filter((p) => p.unrealizedPnl < 0).map(
            (p) => `${p.asset.symbol}: $${roundTo(p.unrealizedPnl, 2)}`
          ),
          'Review each losing position. Cut positions with no recovery thesis. Set maximum loss tolerance.'
        ));
      }
    }

    return results;
  }

  // ============================================================
  // Strategy Decay Detection
  // ============================================================

  private detectStrategyDecay(metrics: Map<string, PerformanceMetrics>): Diagnostic[] {
    const results: Diagnostic[] = [];

    for (const [strategy, m] of metrics) {
      // Negative Sharpe
      if (m.sharpeRatio < 0 && m.totalTrades > 10) {
        results.push(this.createDiagnostic(
          'strategy_decay',
          'critical',
          `${strategy}: Negative risk-adjusted returns`,
          `Sharpe ratio is ${roundTo(m.sharpeRatio, 2)}. The strategy is destroying value on a risk-adjusted basis.`,
          [`Sharpe: ${roundTo(m.sharpeRatio, 2)}`, `Win rate: ${roundTo(m.winRate * 100, 1)}%`, `Trades: ${m.totalTrades}`],
          'Disable this strategy or re-optimize parameters. Run evolution cycle before re-enabling.'
        ));
      }

      // Win rate below 35%
      if (m.winRate < 0.35 && m.totalTrades > 15) {
        results.push(this.createDiagnostic(
          'strategy_decay',
          'warning',
          `${strategy}: Low win rate (${roundTo(m.winRate * 100, 1)}%)`,
          `Win rate has dropped below 35%. Strategy may not be suited for current market regime.`,
          [`Win rate: ${roundTo(m.winRate * 100, 1)}%`, `Profit factor: ${roundTo(m.profitFactor, 2)}`],
          'Check if market regime has changed. Consider pausing strategy until regime is favorable.'
        ));
      }

      // Profit factor below 1 (losing money)
      if (m.profitFactor < 1 && m.profitFactor > 0 && m.totalTrades > 10) {
        results.push(this.createDiagnostic(
          'strategy_decay',
          'warning',
          `${strategy}: Negative expectancy`,
          `Profit factor is ${roundTo(m.profitFactor, 2)} (below 1.0). Average losers outweigh average winners.`,
          [`Avg win: $${roundTo(m.avgWin, 2)}`, `Avg loss: $${roundTo(m.avgLoss, 2)}`],
          'Improve stop placement (tighter stops) or signal quality (higher confidence threshold).'
        ));
      }
    }

    return results;
  }

  // ============================================================
  // Macro Divergence Detection
  // ============================================================

  private detectMacroDivergence(macro: MacroEnvironment): Diagnostic[] {
    const results: Diagnostic[] = [];
    const indicators = macro.indicators;

    // Look for conflicting signals
    const fedRate = indicators.find((i) => i.name.toLowerCase().includes('fed'));
    const cpi = indicators.find((i) => i.name.toLowerCase().includes('cpi'));
    const yieldCurve = indicators.find((i) => i.name.toLowerCase().includes('yield') || i.name.toLowerCase().includes('t10y2y'));
    const vix = indicators.find((i) => i.name.toLowerCase().includes('vix'));

    // Yield curve inversion + low VIX = complacency (dangerous)
    if (yieldCurve && yieldCurve.value < 0 && vix && vix.value < 15) {
      results.push(this.createDiagnostic(
        'macro_divergence',
        'critical',
        'Yield curve inverted but VIX complacent',
        `Yield curve at ${roundTo(yieldCurve.value, 2)} (inverted — recession signal) but VIX only at ${roundTo(vix.value, 1)} (complacent). Markets may be underpricing recession risk.`,
        [`10Y-2Y spread: ${roundTo(yieldCurve.value, 2)}`, `VIX: ${roundTo(vix.value, 1)}`],
        'This divergence historically precedes sharp corrections. Consider buying protection (puts) or reducing equity exposure.'
      ));
    }

    // Rising rates + rising CPI = persistent inflation problem
    if (fedRate && cpi && fedRate.value > fedRate.previousValue && cpi.value > cpi.previousValue) {
      results.push(this.createDiagnostic(
        'macro_divergence',
        'warning',
        'Rising rates failing to curb inflation',
        `Fed rate increasing (${roundTo(fedRate.previousValue, 2)} → ${roundTo(fedRate.value, 2)}) but CPI still rising (${roundTo(cpi.previousValue, 1)} → ${roundTo(cpi.value, 1)}). Policy may need to become more restrictive.`,
        [`Fed rate: ${roundTo(fedRate.value, 2)}%`, `CPI: ${roundTo(cpi.value, 1)}%`],
        'Prepare for potentially higher rates. Reduce duration exposure. Favor short-duration assets.'
      ));
    }

    // VIX spike
    if (vix && vix.value > 30) {
      results.push(this.createDiagnostic(
        'macro_divergence',
        vix.value > 40 ? 'emergency' : 'critical',
        `VIX at ${roundTo(vix.value, 1)} — fear elevated`,
        `VIX above 30 indicates extreme fear. Markets are pricing in significant downside risk.`,
        [`VIX: ${roundTo(vix.value, 1)}`, `Previous: ${roundTo(vix.previousValue, 1)}`],
        vix.value > 40
          ? 'EXTREME FEAR. Reduce all exposure to minimum. Wait for VIX to stabilize below 30 before re-entering.'
          : 'Consider mean-reversion trades cautiously. Fear often overshoots. But protect capital first.'
      ));
    }

    return results;
  }

  // ============================================================
  // Cross-Asset Correlation Analysis
  // ============================================================

  private analyzeCorrelations(candlesMap: Map<string, Candle[]>): Diagnostic[] {
    const results: Diagnostic[] = [];
    const symbols = [...candlesMap.keys()];

    if (symbols.length < 2) return results;

    // Calculate pairwise correlations using returns
    const returnsMap = new Map<string, number[]>();
    for (const [symbol, candles] of candlesMap) {
      const returns: number[] = [];
      for (let i = 1; i < candles.length; i++) {
        returns.push((candles[i].close - candles[i - 1].close) / candles[i - 1].close);
      }
      returnsMap.set(symbol, returns);
    }

    // Check if all assets moving together (correlation spike = risk-off)
    let highCorrCount = 0;
    let totalPairs = 0;

    for (let i = 0; i < symbols.length; i++) {
      for (let j = i + 1; j < symbols.length; j++) {
        const r1 = returnsMap.get(symbols[i]) ?? [];
        const r2 = returnsMap.get(symbols[j]) ?? [];
        const minLen = Math.min(r1.length, r2.length);
        if (minLen < 10) continue;

        const corr = this.pearsonCorrelation(r1.slice(-minLen), r2.slice(-minLen));
        totalPairs++;

        if (Math.abs(corr) > 0.85) {
          highCorrCount++;
        }
      }
    }

    if (totalPairs > 0 && highCorrCount / totalPairs > 0.6) {
      results.push(this.createDiagnostic(
        'correlation_break',
        'critical',
        'Correlation spike — assets moving together',
        `${highCorrCount}/${totalPairs} asset pairs have correlation > 0.85. This is a hallmark of risk-off / panic selling where diversification fails.`,
        [`High correlation pairs: ${highCorrCount}`, `Total pairs: ${totalPairs}`],
        'Diversification is NOT working. Reduce total portfolio exposure. In correlated sell-offs, the only hedge is cash.'
      ));
    }

    return results;
  }

  // ============================================================
  // Regime Transition Detection
  // ============================================================

  private checkRegimeTransition(regime: RegimeAnalysis): Diagnostic[] {
    const results: Diagnostic[] = [];

    // Low confidence = regime may be transitioning
    if (regime.confidence < 0.4) {
      results.push(this.createDiagnostic(
        'regime_transition',
        'warning',
        'Market regime unclear — possible transition',
        `Regime detection confidence is only ${roundTo(regime.confidence * 100, 0)}%. The market may be transitioning between regimes. Signals will be unreliable.`,
        [`Current regime: ${regime.regime}`, `Confidence: ${roundTo(regime.confidence * 100, 0)}%`],
        'Reduce position sizes during transitions. Wait for regime clarity before committing capital.'
      ));
    }

    // Crisis or high volatility regime
    if (regime.regime === 'crisis') {
      results.push(this.createDiagnostic(
        'regime_transition',
        'emergency',
        'CRISIS REGIME DETECTED',
        `Market is in crisis mode. ${regime.details}`,
        [`Trend: ${roundTo(regime.trendStrength, 2)}`, `Vol percentile: ${roundTo(regime.volatilityPercentile, 0)}`],
        'STOP TRADING. Close non-essential positions. Preserve capital. Re-assess when regime shifts.'
      ));
    }

    return results;
  }

  // ============================================================
  // Structural Risk Assessment
  // ============================================================

  private assessStructuralRisks(macro: MacroEnvironment, regime: RegimeAnalysis): Diagnostic[] {
    const results: Diagnostic[] = [];

    // Multiple negative macro signals converging
    const negativeSignals: string[] = [];
    for (const indicator of macro.indicators) {
      if (indicator.impact === 'high') {
        if (indicator.name.toLowerCase().includes('vix') && indicator.value > 25) {
          negativeSignals.push(`VIX elevated (${roundTo(indicator.value, 1)})`);
        }
        if (indicator.name.toLowerCase().includes('yield') && indicator.value < 0) {
          negativeSignals.push(`Yield curve inverted (${roundTo(indicator.value, 2)})`);
        }
        if (indicator.name.toLowerCase().includes('unemployment') && indicator.value > indicator.previousValue + 0.3) {
          negativeSignals.push(`Unemployment rising (${roundTo(indicator.value, 1)}%)`);
        }
      }
    }

    if (negativeSignals.length >= 3) {
      results.push(this.createDiagnostic(
        'structural_risk',
        'emergency',
        'Multiple structural risk signals converging',
        `${negativeSignals.length} macro risk indicators are flashing simultaneously. This pattern historically precedes major market dislocations.`,
        negativeSignals,
        'MAXIMUM CAUTION. This is a potential black swan precursor. Reduce portfolio to 25% or less of normal exposure.'
      ));
    } else if (negativeSignals.length >= 2) {
      results.push(this.createDiagnostic(
        'structural_risk',
        'critical',
        'Structural risk signals building',
        `${negativeSignals.length} macro risk indicators are elevated. Monitor closely for escalation.`,
        negativeSignals,
        'Reduce exposure by 50%. Increase cash allocation. Review all stop losses.'
      ));
    }

    return results;
  }

  // ============================================================
  // Helpers
  // ============================================================

  private createDiagnostic(
    category: DiagnosticCategory,
    severity: Severity,
    title: string,
    description: string,
    evidence: string[],
    recommendation: string
  ): Diagnostic {
    return {
      id: `diag-${++this.diagnosticCounter}`,
      category, severity, title, description, evidence, recommendation,
      timestamp: Date.now(),
    };
  }

  private calculateHealthScore(diagnostics: Diagnostic[]): number {
    let score = 100;
    for (const d of diagnostics) {
      switch (d.severity) {
        case 'emergency': score -= 30; break;
        case 'critical': score -= 15; break;
        case 'warning': score -= 5; break;
        case 'info': score -= 1; break;
      }
    }
    return Math.max(0, Math.min(100, score));
  }

  private generateSummary(
    health: number,
    emergencies: Diagnostic[],
    criticals: Diagnostic[],
    warnings: Diagnostic[]
  ): string {
    if (emergencies.length > 0) {
      return `EMERGENCY: ${emergencies.length} critical issues require immediate action. Health score: ${health}/100. ${emergencies[0].title}`;
    }
    if (criticals.length > 0) {
      return `ALERT: ${criticals.length} significant issues detected. Health score: ${health}/100. Review and address before trading.`;
    }
    if (warnings.length > 0) {
      return `CAUTION: ${warnings.length} warnings to monitor. Health score: ${health}/100. System operational but stay vigilant.`;
    }
    return `ALL CLEAR: Health score ${health}/100. No significant issues detected. Trading conditions are favorable.`;
  }

  private pearsonCorrelation(x: number[], y: number[]): number {
    const n = Math.min(x.length, y.length);
    if (n < 2) return 0;
    const mx = mean(x.slice(0, n));
    const my = mean(y.slice(0, n));
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) {
      const a = x[i] - mx;
      const b = y[i] - my;
      num += a * b;
      dx += a * a;
      dy += b * b;
    }
    const denom = Math.sqrt(dx * dy);
    return denom === 0 ? 0 : num / denom;
  }

  /**
   * Print diagnostic report to console.
   */
  static formatReport(report: DiagnosticReport): string {
    const lines: string[] = [
      `\n${'='.repeat(60)}`,
      `  DIAGNOSTIC REPORT — Health: ${report.healthScore}/100`,
      `${'='.repeat(60)}`,
      `  ${report.summary}`,
      '',
    ];

    const printSection = (title: string, items: Diagnostic[]) => {
      if (items.length === 0) return;
      lines.push(`\n  --- ${title} ---`);
      for (const d of items) {
        lines.push(`  [${d.severity.toUpperCase()}] ${d.title}`);
        lines.push(`    ${d.description}`);
        lines.push(`    → ${d.recommendation}`);
      }
    };

    printSection('EMERGENCIES', report.emergencies);
    printSection('CRITICAL', report.criticals);
    printSection('WARNINGS', report.warnings);

    if (report.infos.length > 0) {
      lines.push(`\n  --- INFO (${report.infos.length} items) ---`);
      for (const d of report.infos) {
        lines.push(`  [INFO] ${d.title}`);
      }
    }

    lines.push(`\n${'='.repeat(60)}\n`);
    return lines.join('\n');
  }
}
