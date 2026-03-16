import type { Signal, AssetInfo, MarketData, Candle, MacroEnvironment } from '../../shared/types.js';
import { createModuleLogger } from '../../shared/logger.js';

const log = createModuleLogger('opportunity-scanner');

export interface Opportunity {
  asset: AssetInfo;
  score: number;            // 0-100 composite score
  action: 'BUY' | 'SELL';
  signals: Signal[];        // all signals for this asset
  avgConfidence: number;    // average signal confidence
  signalCount: number;      // number of agreeing strategies
  momentum: number;         // price momentum (-1 to 1)
  volatility: number;       // recent volatility (ATR/price)
  volumeTrend: number;      // volume increase ratio
  reason: string;
}

/**
 * Scans all assets, ranks opportunities by a composite score,
 * and returns the best trades across all asset classes.
 */
export class OpportunityScanner {
  /**
   * Score and rank all signals into opportunities.
   * Prioritizes assets where multiple strategies agree (confluence).
   */
  scan(
    signals: Signal[],
    marketDataMap: Map<string, MarketData>,
    macro?: MacroEnvironment,
  ): Opportunity[] {
    // Group signals by asset
    const byAsset = new Map<string, Signal[]>();
    for (const signal of signals) {
      const key = signal.asset.symbol;
      if (!byAsset.has(key)) byAsset.set(key, []);
      byAsset.get(key)!.push(signal);
    }

    const opportunities: Opportunity[] = [];

    for (const [symbol, assetSignals] of byAsset) {
      const marketData = marketDataMap.get(symbol);
      if (!marketData || marketData.candles.length < 20) continue;

      const candles = marketData.candles;

      // Separate BUY and SELL signals
      const buySignals = assetSignals.filter(s => s.action === 'BUY');
      const sellSignals = assetSignals.filter(s => s.action === 'SELL');

      // Determine dominant direction (most strategies agree)
      const buys = buySignals.length;
      const sells = sellSignals.length;

      if (buys === 0 && sells === 0) continue;

      const action = buys >= sells ? 'BUY' as const : 'SELL' as const;
      const dominantSignals = action === 'BUY' ? buySignals : sellSignals;

      // Metrics
      const avgConfidence = dominantSignals.reduce((s, sig) => s + sig.confidence, 0) / dominantSignals.length;
      const signalCount = dominantSignals.length;
      const momentum = this.calculateMomentum(candles);
      const volatility = this.calculateVolatility(candles);
      const volumeTrend = this.calculateVolumeTrend(candles);

      // Composite score (0-100)
      const score = this.calculateScore({
        avgConfidence,
        signalCount,
        totalStrategies: 4,
        momentum,
        volatility,
        volumeTrend,
        action,
        macro,
      });

      const bestSignal = dominantSignals.sort((a, b) => b.confidence - a.confidence)[0];

      opportunities.push({
        asset: bestSignal.asset,
        score,
        action,
        signals: dominantSignals,
        avgConfidence,
        signalCount,
        momentum,
        volatility,
        volumeTrend,
        reason: this.buildReason(dominantSignals, signalCount, momentum, volumeTrend),
      });
    }

    // Filter out NaN scores (from micro-price tokens with precision issues)
    // then sort by score descending — best opportunities first
    const valid = opportunities.filter(o => !isNaN(o.score) && !isNaN(o.avgConfidence));
    opportunities.length = 0;
    opportunities.push(...valid);
    opportunities.sort((a, b) => b.score - a.score);

    log.info({
      totalAssets: byAsset.size,
      opportunities: opportunities.length,
      topScore: opportunities[0]?.score ?? 0,
      topAsset: opportunities[0]?.asset.symbol ?? 'none',
    }, 'Opportunity scan complete');

    return opportunities;
  }

  /**
   * Select the best opportunities for portfolio construction.
   * Ensures diversification across asset classes.
   */
  selectPortfolio(
    opportunities: Opportunity[],
    opts: {
      maxPositions?: number;
      minScore?: number;
      minConfidence?: number;
      diversify?: boolean;
    } = {},
  ): Opportunity[] {
    const maxPositions = opts.maxPositions ?? 10;
    const minScore = opts.minScore ?? 40;
    const minConfidence = opts.minConfidence ?? 0.55;
    const diversify = opts.diversify ?? true;

    // Filter by minimum thresholds
    let candidates = opportunities.filter(
      o => o.score >= minScore && o.avgConfidence >= minConfidence,
    );

    if (!diversify) {
      return candidates.slice(0, maxPositions);
    }

    // Diversified selection: balance across asset classes
    const selected: Opportunity[] = [];
    const classCounts = new Map<string, number>();

    // Max positions per asset class (proportional to available opportunities)
    const classBudget = new Map<string, number>();
    const classOpps = new Map<string, number>();
    for (const c of candidates) {
      const cls = c.asset.assetClass;
      classOpps.set(cls, (classOpps.get(cls) ?? 0) + 1);
    }
    const totalClasses = classOpps.size;
    const basePerClass = Math.max(2, Math.floor(maxPositions / totalClasses));
    for (const cls of classOpps.keys()) {
      classBudget.set(cls, basePerClass);
    }

    // First pass: pick top from each class
    for (const opp of candidates) {
      if (selected.length >= maxPositions) break;
      const cls = opp.asset.assetClass;
      const count = classCounts.get(cls) ?? 0;
      const budget = classBudget.get(cls) ?? basePerClass;

      if (count < budget) {
        selected.push(opp);
        classCounts.set(cls, count + 1);
      }
    }

    // Second pass: fill remaining slots with best remaining
    if (selected.length < maxPositions) {
      const selectedSymbols = new Set(selected.map(s => s.asset.symbol));
      for (const opp of candidates) {
        if (selected.length >= maxPositions) break;
        if (!selectedSymbols.has(opp.asset.symbol)) {
          selected.push(opp);
        }
      }
    }

    log.info({
      candidates: candidates.length,
      selected: selected.length,
      classes: Object.fromEntries(classCounts),
    }, 'Portfolio selection complete');

    return selected;
  }

  // ----------------------------------------------------------------
  // Scoring
  // ----------------------------------------------------------------

  private calculateScore(params: {
    avgConfidence: number;
    signalCount: number;
    totalStrategies: number;
    momentum: number;
    volatility: number;
    volumeTrend: number;
    action: 'BUY' | 'SELL';
    macro?: MacroEnvironment;
  }): number {
    const { avgConfidence, signalCount, totalStrategies, momentum, volatility, volumeTrend, action, macro } = params;

    // Confluence: how many strategies agree (0-25 points)
    const confluenceScore = (signalCount / totalStrategies) * 25;

    // Confidence: average confidence of agreeing signals (0-25 points)
    const confidenceScore = avgConfidence * 25;

    // Momentum alignment: does price trend match signal direction? (0-20 points)
    const momentumAligned = (action === 'BUY' && momentum > 0) || (action === 'SELL' && momentum < 0);
    const momentumScore = momentumAligned ? Math.abs(momentum) * 20 : Math.abs(momentum) * 5;

    // Volume confirmation: increasing volume supports the move (0-15 points)
    const volumeScore = Math.min(15, volumeTrend * 10);

    // Volatility sweet spot: moderate volatility is ideal (0-15 points)
    // Too low = no opportunity, too high = too risky
    const volScore = volatility > 0.005 && volatility < 0.05
      ? 15
      : volatility >= 0.05
        ? Math.max(0, 15 - (volatility - 0.05) * 200)
        : Math.max(0, volatility * 2000);

    // Macro adjustment (-10 to +10)
    let macroAdj = 0;
    if (macro) {
      if (action === 'BUY' && macro.bias === 'bullish') macroAdj = 5;
      else if (action === 'BUY' && macro.bias === 'bearish') macroAdj = -5;
      else if (action === 'SELL' && macro.bias === 'bearish') macroAdj = 5;
      else if (action === 'SELL' && macro.bias === 'bullish') macroAdj = -5;

      if (macro.riskLevel === 'extreme') macroAdj -= 10;
      else if (macro.riskLevel === 'high') macroAdj -= 5;
    }

    const raw = confluenceScore + confidenceScore + momentumScore + volumeScore + volScore + macroAdj;
    return Math.max(0, Math.min(100, Math.round(raw)));
  }

  // ----------------------------------------------------------------
  // Technical Metrics
  // ----------------------------------------------------------------

  /** Price momentum: rate of change over last 20 candles, normalized to -1..1 */
  private calculateMomentum(candles: Candle[]): number {
    if (candles.length < 20) return 0;
    const recent = candles.slice(-20);
    const start = recent[0].close;
    const end = recent[recent.length - 1].close;
    const roc = (end - start) / start;
    return Math.max(-1, Math.min(1, roc * 10)); // normalize
  }

  /** Volatility: ATR / price ratio over last 14 candles */
  private calculateVolatility(candles: Candle[]): number {
    if (candles.length < 15) return 0;
    const recent = candles.slice(-15);
    let sumTr = 0;
    for (let i = 1; i < recent.length; i++) {
      const tr = Math.max(
        recent[i].high - recent[i].low,
        Math.abs(recent[i].high - recent[i - 1].close),
        Math.abs(recent[i].low - recent[i - 1].close),
      );
      sumTr += tr;
    }
    const atr = sumTr / (recent.length - 1);
    const price = recent[recent.length - 1].close;
    return price > 0 ? atr / price : 0;
  }

  /** Volume trend: ratio of recent volume to older volume */
  private calculateVolumeTrend(candles: Candle[]): number {
    if (candles.length < 20) return 1;
    const recent = candles.slice(-10);
    const older = candles.slice(-20, -10);

    const recentAvg = recent.reduce((s, c) => s + c.volume, 0) / recent.length;
    const olderAvg = older.reduce((s, c) => s + c.volume, 0) / older.length;

    if (olderAvg === 0) return 1;
    return recentAvg / olderAvg;
  }

  // ----------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------

  private buildReason(signals: Signal[], count: number, momentum: number, volumeTrend: number): string {
    const strategies = [...new Set(signals.map(s => s.strategy))].join(', ');
    const parts: string[] = [];
    parts.push(`${count}/4 strategies agree (${strategies})`);
    if (Math.abs(momentum) > 0.3) parts.push(`strong ${momentum > 0 ? 'bullish' : 'bearish'} momentum`);
    if (volumeTrend > 1.3) parts.push('rising volume');
    return parts.join(' | ');
  }

  /**
   * Format opportunities as a human-readable report.
   */
  static formatReport(opportunities: Opportunity[]): string {
    if (opportunities.length === 0) return '\nNo trading opportunities found.';

    const lines: string[] = ['\n=== OPPORTUNITY SCANNER — TOP TRADES ===\n'];
    lines.push('Rank | Asset        | Class  | Action | Score | Conf  | Strategies | Reason');
    lines.push('-----|--------------|--------|--------|-------|-------|------------|-------');

    for (let i = 0; i < opportunities.length; i++) {
      const o = opportunities[i];
      lines.push(
        `${String(i + 1).padStart(4)} | ` +
        `${o.asset.symbol.padEnd(12)} | ` +
        `${o.asset.assetClass.padEnd(6)} | ` +
        `${o.action.padEnd(6)} | ` +
        `${String(o.score).padStart(5)} | ` +
        `${(o.avgConfidence * 100).toFixed(0).padStart(4)}% | ` +
        `${String(o.signalCount).padStart(10)} | ` +
        `${o.reason}`,
      );
    }

    const byClass = new Map<string, number>();
    for (const o of opportunities) {
      const cls = o.asset.assetClass;
      byClass.set(cls, (byClass.get(cls) ?? 0) + 1);
    }

    lines.push('');
    lines.push(`Total opportunities: ${opportunities.length}`);
    lines.push(`By class: ${[...byClass.entries()].map(([c, n]) => `${c}=${n}`).join(', ')}`);
    lines.push(`Best opportunity: ${opportunities[0].asset.symbol} (score ${opportunities[0].score})`);

    return lines.join('\n');
  }
}
