import type {
  MarketData,
  MacroEnvironment,
  Signal,
  Strategy,
  StrategyConfig,
  StrategyDNA,
} from '../../../shared/types.js';
import { generateId } from '../../../shared/utils.js';
import { createModuleLogger } from '../../../shared/logger.js';
import { EMA, RSI } from '../indicators.js';
import { generateSignal } from '../signals.js';

const log = createModuleLogger('strategy:momentum');

export class MomentumStrategy implements Strategy {
  name = 'momentum';
  config: StrategyConfig;
  dna: StrategyDNA;

  constructor(config?: Partial<StrategyConfig>) {
    this.config = {
      name: 'momentum',
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
      name: 'momentum',
      generation: 0,
      parentId: null,
      params: {
        fastEma: 8,
        slowEma: 21,
        rsiPeriod: 14,
        rsiThreshold: 45,
        trendEma: 50,
      },
      fitness: 0,
      createdAt: Date.now(),
      mutations: [],
    };
  }

  async analyze(data: MarketData, _macro?: MacroEnvironment): Promise<Signal[]> {
    const { candles, asset, timeframe } = data;
    const signals: Signal[] = [];

    const fastPeriod = this.dna.params.fastEma ?? 9;
    const slowPeriod = this.dna.params.slowEma ?? 21;
    const rsiPeriod = this.dna.params.rsiPeriod ?? 14;
    const rsiThreshold = this.dna.params.rsiThreshold ?? 50;
    const trendPeriod = this.dna.params.trendEma ?? 200;

    const minCandles = Math.max(slowPeriod, rsiPeriod, trendPeriod) + 2;
    if (candles.length < minCandles) {
      log.warn({ candles: candles.length, required: minCandles }, 'Not enough candles for momentum analysis');
      return signals;
    }

    const fastEma = EMA(candles, fastPeriod).values;
    const slowEma = EMA(candles, slowPeriod).values;
    const trendEma = EMA(candles, trendPeriod).values;
    const rsi = RSI(candles, rsiPeriod).values;

    const lastIdx = candles.length - 1;
    const prevIdx = lastIdx - 1;

    if (
      isNaN(fastEma[lastIdx]) || isNaN(slowEma[lastIdx]) || isNaN(rsi[lastIdx]) ||
      isNaN(fastEma[prevIdx]) || isNaN(slowEma[prevIdx]) || isNaN(trendEma[lastIdx])
    ) {
      return signals;
    }

    const currentFast = fastEma[lastIdx];
    const currentSlow = slowEma[lastIdx];
    const prevFast = fastEma[prevIdx];
    const prevSlow = slowEma[prevIdx];
    const currentTrend = trendEma[lastIdx];
    const currentRsi = rsi[lastIdx];
    const price = candles[lastIdx].close;

    // Trend filter: only trade WITH the 200 EMA trend
    const bullishTrend = price > currentTrend;
    const bearishTrend = price < currentTrend;

    // Crossover detection
    const bullishCrossover = prevFast <= prevSlow && currentFast > currentSlow;
    const bearishCrossover = prevFast >= prevSlow && currentFast < currentSlow;

    // Confidence: EMA separation + RSI strength + trend alignment
    const emaSeparation = Math.abs(currentFast - currentSlow) / price;
    const rsiDistance = Math.abs(currentRsi - rsiThreshold) / 50;
    const trendDistance = Math.abs(price - currentTrend) / currentTrend; // how far from trend
    const trendBonus = Math.min(0.15, trendDistance * 5); // up to +0.15 for strong trend alignment

    let confidence = Math.min(1, 0.4 + emaSeparation * 8 + rsiDistance * 0.25 + trendBonus);

    const indicators: Record<string, number> = {
      fastEma: currentFast,
      slowEma: currentSlow,
      trendEma: currentTrend,
      rsi: currentRsi,
      emaSeparation,
      trendDistance,
    };

    if (bullishCrossover && currentRsi > rsiThreshold && bullishTrend) {
      signals.push(
        generateSignal(
          asset,
          'BUY',
          confidence,
          price,
          this.name,
          timeframe,
          indicators,
          `EMA(${fastPeriod}) crossed above EMA(${slowPeriod}), RSI=${currentRsi.toFixed(1)}, price above EMA(${trendPeriod}) trend`,
        ),
      );
    } else if (bearishCrossover && currentRsi < rsiThreshold && bearishTrend) {
      signals.push(
        generateSignal(
          asset,
          'SELL',
          confidence,
          price,
          this.name,
          timeframe,
          indicators,
          `EMA(${fastPeriod}) crossed below EMA(${slowPeriod}), RSI=${currentRsi.toFixed(1)}, price below EMA(${trendPeriod}) trend`,
        ),
      );
    }

    return signals;
  }
}
