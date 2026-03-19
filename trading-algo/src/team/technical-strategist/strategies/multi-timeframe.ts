import type {
  MarketData,
  MacroEnvironment,
  Signal,
  Strategy,
  StrategyConfig,
  StrategyDNA,
  Candle,
  Timeframe,
  AssetInfo,
} from '../../../shared/types.js';
import { generateId } from '../../../shared/utils.js';
import { createModuleLogger } from '../../../shared/logger.js';
import { EMA, RSI, ATR, MACD, BollingerBands } from '../indicators.js';
import { generateSignal } from '../signals.js';

const log = createModuleLogger('strategy:multi-timeframe');

/**
 * Multi-Timeframe Strategy
 *
 * Institutional approach: uses a higher timeframe (e.g. 1h) for directional
 * bias and a lower timeframe (e.g. 5m) for precise entry timing.
 *
 * Flow:
 * 1. Analyze higher TF candles → determine trend direction (bullish/bearish/neutral)
 * 2. If directional bias exists, analyze lower TF candles for entry triggers
 * 3. Use higher TF for stop-loss levels, lower TF for entry precision
 *
 * This strategy requires two MarketData inputs (higher + lower TF).
 * When called with standard single-TF `analyze()`, it uses only the
 * provided data for direction and generates signals at reduced confidence.
 * For full multi-TF analysis, use `analyzeMultiTimeframe()`.
 */
export class MultiTimeframeStrategy implements Strategy {
  name = 'multi-timeframe';
  config: StrategyConfig;
  dna: StrategyDNA;

  constructor(config?: Partial<StrategyConfig>) {
    this.config = {
      name: 'multi-timeframe',
      enabled: true,
      params: {},
      assetClasses: ['crypto', 'forex'],
      timeframes: ['1m', '5m', '15m', '1h', '4h', '1d', '1w'],
      ...config,
    };
    this.dna = this.getDefaultDNA();
  }

  getDefaultDNA(): StrategyDNA {
    return {
      id: generateId(),
      name: 'multi-timeframe',
      generation: 0,
      parentId: null,
      params: {
        // Higher timeframe (direction) params
        htfFastEma: 9,
        htfSlowEma: 21,
        htfRsiPeriod: 14,
        htfTrendThreshold: 0.002, // min EMA separation for trend confirmation
        // Lower timeframe (entry) params
        ltfFastEma: 5,
        ltfSlowEma: 13,
        ltfRsiPeriod: 14,
        ltfRsiOversold: 35,
        ltfRsiOverbought: 65,
        // Entry confirmation
        pullbackDepth: 0.3, // how deep into EMA zone = valid pullback (0-1)
        breakoutConfirmBars: 2, // candles above/below for confirmation
        // Risk
        atrStopMultiplier: 2.0,
        atrTakeProfitMultiplier: 3.0,
      },
      fitness: 0,
      createdAt: Date.now(),
      mutations: [],
    };
  }

  /**
   * Standard single-timeframe analysis (Strategy interface compliance).
   * Uses the provided data for both direction and entry at reduced confidence.
   */
  async analyze(data: MarketData, _macro?: MacroEnvironment): Promise<Signal[]> {
    const { candles, asset, timeframe } = data;
    const signals: Signal[] = [];

    const direction = this.detectDirection(candles);
    if (direction === 'neutral') return signals;

    const entry = this.findEntry(candles, direction);
    if (!entry) return signals;

    // Single-TF mode gets 0.7x confidence (no multi-TF confirmation)
    const confidence = Math.min(1, entry.confidence * 0.7);
    if (confidence < 0.4) return signals;

    signals.push(
      generateSignal(
        asset,
        direction === 'bullish' ? 'BUY' : 'SELL',
        confidence,
        entry.price,
        this.name,
        timeframe,
        {
          ...entry.indicators,
          htfBias: direction === 'bullish' ? 1 : -1,
          mode: 0, // single-TF mode
        },
        `[Single-TF] ${direction} bias detected, ${entry.reason}`,
      ),
    );

    return signals;
  }

  /**
   * Full multi-timeframe analysis.
   * Call this with both higher TF and lower TF data for optimal signals.
   */
  analyzeMultiTimeframe(
    higherTfData: MarketData,
    lowerTfData: MarketData,
  ): Signal[] {
    const signals: Signal[] = [];
    const { asset } = lowerTfData;

    // Step 1: Higher TF directional bias
    const direction = this.detectDirection(higherTfData.candles);
    if (direction === 'neutral') {
      log.debug({ asset: asset.symbol }, 'No directional bias on higher TF — skipping');
      return signals;
    }

    // Step 2: Higher TF stop-loss level (ATR-based)
    const htfAtr = ATR(higherTfData.candles, 14);
    const htfAtrValue = htfAtr.values[higherTfData.candles.length - 1];
    const htfPrice = higherTfData.candles[higherTfData.candles.length - 1].close;

    // Step 3: Lower TF entry trigger
    const entry = this.findEntry(lowerTfData.candles, direction);
    if (!entry) {
      log.debug({ asset: asset.symbol, direction }, 'No entry trigger on lower TF');
      return signals;
    }

    // Full multi-TF confidence (1.0x multiplier)
    const confidence = Math.min(1, entry.confidence);
    if (confidence < 0.4) return signals;

    // Calculate stop/TP from higher TF ATR
    const stopMultiplier = this.dna.params.atrStopMultiplier ?? 2.0;
    const tpMultiplier = this.dna.params.atrTakeProfitMultiplier ?? 3.0;
    const stopDistance = isNaN(htfAtrValue) ? entry.price * 0.02 : htfAtrValue * stopMultiplier;
    const tpDistance = isNaN(htfAtrValue) ? entry.price * 0.03 : htfAtrValue * tpMultiplier;

    const stopLoss = direction === 'bullish'
      ? entry.price - stopDistance
      : entry.price + stopDistance;
    const takeProfit = direction === 'bullish'
      ? entry.price + tpDistance
      : entry.price - tpDistance;

    signals.push(
      generateSignal(
        asset,
        direction === 'bullish' ? 'BUY' : 'SELL',
        confidence,
        entry.price,
        this.name,
        lowerTfData.timeframe,
        {
          ...entry.indicators,
          htfBias: direction === 'bullish' ? 1 : -1,
          htfPrice,
          htfAtr: isNaN(htfAtrValue) ? 0 : htfAtrValue,
          stopLoss,
          takeProfit,
          riskReward: stopDistance > 0 ? tpDistance / stopDistance : 0,
          mode: 1, // multi-TF mode
        },
        `[Multi-TF] ${higherTfData.timeframe} ${direction} bias → ${lowerTfData.timeframe} ${entry.reason}. SL: ${stopLoss.toFixed(5)}, TP: ${takeProfit.toFixed(5)}`,
      ),
    );

    log.info({
      asset: asset.symbol,
      direction,
      htfTimeframe: higherTfData.timeframe,
      ltfTimeframe: lowerTfData.timeframe,
      confidence: confidence.toFixed(3),
      stopLoss: stopLoss.toFixed(5),
      takeProfit: takeProfit.toFixed(5),
    }, 'Multi-timeframe signal generated');

    return signals;
  }

  // ----------------------------------------------------------------
  // Directional bias detection (higher timeframe)
  // ----------------------------------------------------------------

  private detectDirection(candles: Candle[]): 'bullish' | 'bearish' | 'neutral' {
    const fastPeriod = this.dna.params.htfFastEma ?? 9;
    const slowPeriod = this.dna.params.htfSlowEma ?? 21;
    const rsiPeriod = this.dna.params.htfRsiPeriod ?? 14;
    const trendThreshold = this.dna.params.htfTrendThreshold ?? 0.002;

    const minCandles = Math.max(slowPeriod, rsiPeriod) + 2;
    if (candles.length < minCandles) return 'neutral';

    const fastEma = EMA(candles, fastPeriod).values;
    const slowEma = EMA(candles, slowPeriod).values;
    const rsi = RSI(candles, rsiPeriod).values;
    const macd = MACD(candles);

    const last = candles.length - 1;
    const price = candles[last].close;

    if (isNaN(fastEma[last]) || isNaN(slowEma[last]) || isNaN(rsi[last])) {
      return 'neutral';
    }

    // EMA alignment
    const emaSep = (fastEma[last] - slowEma[last]) / price;
    const emaAligned = Math.abs(emaSep) > trendThreshold;

    // Price above/below both EMAs
    const priceAboveBothEma = price > fastEma[last] && price > slowEma[last];
    const priceBelowBothEma = price < fastEma[last] && price < slowEma[last];

    // MACD confirmation
    const macdBullish = !isNaN(macd.histogram[last]) && macd.histogram[last] > 0;
    const macdBearish = !isNaN(macd.histogram[last]) && macd.histogram[last] < 0;

    // RSI confirmation (not extreme — we want trending, not exhausted)
    const rsiBullish = rsi[last] > 45 && rsi[last] < 75;
    const rsiBearish = rsi[last] < 55 && rsi[last] > 25;

    // Bullish: fast > slow + price above EMAs + MACD positive + RSI confirms
    let bullishScore = 0;
    if (emaSep > trendThreshold) bullishScore++;
    if (priceAboveBothEma) bullishScore++;
    if (macdBullish) bullishScore++;
    if (rsiBullish) bullishScore++;

    let bearishScore = 0;
    if (emaSep < -trendThreshold) bearishScore++;
    if (priceBelowBothEma) bearishScore++;
    if (macdBearish) bearishScore++;
    if (rsiBearish) bearishScore++;

    // Need at least 3/4 confirmations
    if (bullishScore >= 3 && bullishScore > bearishScore) return 'bullish';
    if (bearishScore >= 3 && bearishScore > bullishScore) return 'bearish';

    return 'neutral';
  }

  // ----------------------------------------------------------------
  // Entry trigger detection (lower timeframe)
  // ----------------------------------------------------------------

  private findEntry(
    candles: Candle[],
    direction: 'bullish' | 'bearish',
  ): { price: number; confidence: number; reason: string; indicators: Record<string, number> } | null {
    const fastPeriod = this.dna.params.ltfFastEma ?? 5;
    const slowPeriod = this.dna.params.ltfSlowEma ?? 13;
    const rsiPeriod = this.dna.params.ltfRsiPeriod ?? 14;
    const oversold = this.dna.params.ltfRsiOversold ?? 35;
    const overbought = this.dna.params.ltfRsiOverbought ?? 65;
    const pullbackDepth = this.dna.params.pullbackDepth ?? 0.3;

    const minCandles = Math.max(slowPeriod, rsiPeriod) + 5;
    if (candles.length < minCandles) return null;

    const fastEma = EMA(candles, fastPeriod).values;
    const slowEma = EMA(candles, slowPeriod).values;
    const rsi = RSI(candles, rsiPeriod).values;
    const bb = BollingerBands(candles, 20, 2);
    const atr = ATR(candles, 14);

    const last = candles.length - 1;
    const price = candles[last].close;

    if (isNaN(fastEma[last]) || isNaN(slowEma[last]) || isNaN(rsi[last])) {
      return null;
    }

    const indicators: Record<string, number> = {
      ltfFastEma: fastEma[last],
      ltfSlowEma: slowEma[last],
      ltfRsi: rsi[last],
      ltfAtr: isNaN(atr.values[last]) ? 0 : atr.values[last],
    };

    // Entry type 1: Pullback to EMA zone
    const pullbackEntry = this.checkPullbackEntry(
      candles, fastEma, slowEma, rsi, direction, pullbackDepth, oversold, overbought,
    );
    if (pullbackEntry) {
      return { price, confidence: pullbackEntry.confidence, reason: pullbackEntry.reason, indicators };
    }

    // Entry type 2: Breakout confirmation
    const breakoutEntry = this.checkBreakoutEntry(candles, bb, direction);
    if (breakoutEntry) {
      return { price, confidence: breakoutEntry.confidence, reason: breakoutEntry.reason, indicators };
    }

    // Entry type 3: EMA crossover aligned with HTF direction
    const crossoverEntry = this.checkCrossoverEntry(candles, fastEma, slowEma, rsi, direction);
    if (crossoverEntry) {
      return { price, confidence: crossoverEntry.confidence, reason: crossoverEntry.reason, indicators };
    }

    return null;
  }

  /**
   * Pullback entry: price retraces into the EMA zone, RSI confirms.
   * For bullish: price dips near slow EMA from above, RSI not oversold-extreme.
   * For bearish: price rises near slow EMA from below, RSI not overbought-extreme.
   */
  private checkPullbackEntry(
    candles: Candle[],
    fastEma: number[],
    slowEma: number[],
    rsi: number[],
    direction: 'bullish' | 'bearish',
    pullbackDepth: number,
    oversold: number,
    overbought: number,
  ): { confidence: number; reason: string } | null {
    const last = candles.length - 1;
    const price = candles[last].close;
    const prevPrice = candles[last - 1].close;

    const emaZoneWidth = Math.abs(fastEma[last] - slowEma[last]);
    const priceToSlowEma = Math.abs(price - slowEma[last]);

    // Price must be within pullbackDepth * emaZoneWidth of the slow EMA
    const inPullbackZone = priceToSlowEma < emaZoneWidth * (1 + pullbackDepth);

    if (!inPullbackZone) return null;

    if (direction === 'bullish') {
      // Price pulled back toward slow EMA but bouncing (current > previous)
      const bouncing = price > prevPrice;
      const rsiRecovering = rsi[last] > oversold && rsi[last] < 60;
      // Price should still be above slow EMA (pullback, not breakdown)
      const aboveSlowEma = price >= slowEma[last] * 0.998;

      if (bouncing && rsiRecovering && aboveSlowEma) {
        const depthRatio = 1 - (priceToSlowEma / (emaZoneWidth * 2));
        const confidence = 0.5 + depthRatio * 0.3 + (rsi[last] > 45 ? 0.1 : 0);
        return {
          confidence: Math.min(1, confidence),
          reason: `pullback to EMA zone (depth ${(depthRatio * 100).toFixed(0)}%), RSI recovering at ${rsi[last].toFixed(1)}`,
        };
      }
    } else {
      const bouncing = price < prevPrice;
      const rsiRecovering = rsi[last] < overbought && rsi[last] > 40;
      const belowSlowEma = price <= slowEma[last] * 1.002;

      if (bouncing && rsiRecovering && belowSlowEma) {
        const depthRatio = 1 - (priceToSlowEma / (emaZoneWidth * 2));
        const confidence = 0.5 + depthRatio * 0.3 + (rsi[last] < 55 ? 0.1 : 0);
        return {
          confidence: Math.min(1, confidence),
          reason: `pullback to EMA zone (depth ${(depthRatio * 100).toFixed(0)}%), RSI recovering at ${rsi[last].toFixed(1)}`,
        };
      }
    }

    return null;
  }

  /**
   * Breakout entry: price breaks through Bollinger Band in direction of HTF bias.
   */
  private checkBreakoutEntry(
    candles: Candle[],
    bb: { upper: number[]; lower: number[]; middle: number[]; bandwidth: number[] },
    direction: 'bullish' | 'bearish',
  ): { confidence: number; reason: string } | null {
    const last = candles.length - 1;
    const price = candles[last].close;
    const confirmBars = this.dna.params.breakoutConfirmBars ?? 2;

    if (isNaN(bb.upper[last]) || isNaN(bb.lower[last])) return null;

    if (direction === 'bullish' && price > bb.upper[last]) {
      // Confirm: previous bars were within bands (this is a fresh breakout)
      let confirmedBars = 0;
      for (let i = last - confirmBars; i < last; i++) {
        if (i >= 0 && !isNaN(bb.upper[i]) && candles[i].close <= bb.upper[i]) {
          confirmedBars++;
        }
      }
      if (confirmedBars >= confirmBars - 1) {
        const overshoot = (price - bb.upper[last]) / (bb.upper[last] - bb.middle[last]);
        return {
          confidence: Math.min(1, 0.55 + overshoot * 0.2),
          reason: `breakout above upper BB (${overshoot.toFixed(2)}x overshoot)`,
        };
      }
    }

    if (direction === 'bearish' && price < bb.lower[last]) {
      let confirmedBars = 0;
      for (let i = last - confirmBars; i < last; i++) {
        if (i >= 0 && !isNaN(bb.lower[i]) && candles[i].close >= bb.lower[i]) {
          confirmedBars++;
        }
      }
      if (confirmedBars >= confirmBars - 1) {
        const overshoot = (bb.lower[last] - price) / (bb.middle[last] - bb.lower[last]);
        return {
          confidence: Math.min(1, 0.55 + overshoot * 0.2),
          reason: `breakdown below lower BB (${overshoot.toFixed(2)}x overshoot)`,
        };
      }
    }

    return null;
  }

  /**
   * EMA crossover entry: lower TF EMA crossover aligned with HTF direction.
   */
  private checkCrossoverEntry(
    candles: Candle[],
    fastEma: number[],
    slowEma: number[],
    rsi: number[],
    direction: 'bullish' | 'bearish',
  ): { confidence: number; reason: string } | null {
    const last = candles.length - 1;
    const prev = last - 1;

    if (isNaN(fastEma[prev]) || isNaN(slowEma[prev])) return null;

    const bullishCross = fastEma[prev] <= slowEma[prev] && fastEma[last] > slowEma[last];
    const bearishCross = fastEma[prev] >= slowEma[prev] && fastEma[last] < slowEma[last];

    if (direction === 'bullish' && bullishCross && rsi[last] > 40) {
      const emaSep = Math.abs(fastEma[last] - slowEma[last]) / candles[last].close;
      return {
        confidence: Math.min(1, 0.5 + emaSep * 15 + 0.1),
        reason: `EMA crossover (fast above slow), RSI ${rsi[last].toFixed(1)}`,
      };
    }

    if (direction === 'bearish' && bearishCross && rsi[last] < 60) {
      const emaSep = Math.abs(fastEma[last] - slowEma[last]) / candles[last].close;
      return {
        confidence: Math.min(1, 0.5 + emaSep * 15 + 0.1),
        reason: `EMA crossover (fast below slow), RSI ${rsi[last].toFixed(1)}`,
      };
    }

    return null;
  }

  /**
   * Get the recommended higher/lower timeframe pair for a given base timeframe.
   */
  static getTimeframePair(baseTimeframe: Timeframe): { higher: Timeframe; lower: Timeframe } {
    const pairs: Record<string, { higher: Timeframe; lower: Timeframe }> = {
      '1m': { higher: '5m', lower: '1m' },
      '5m': { higher: '1h', lower: '5m' },
      '15m': { higher: '1h', lower: '15m' },
      '1h': { higher: '4h', lower: '15m' },
      '4h': { higher: '1d', lower: '1h' },
      '1d': { higher: '1w', lower: '4h' },
      '1w': { higher: '1w', lower: '1d' },
    };
    return pairs[baseTimeframe] ?? { higher: '1h', lower: '5m' };
  }
}
