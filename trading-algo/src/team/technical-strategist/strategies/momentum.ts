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
      timeframes: ['5m', '15m', '1h', '4h', '1d'],
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
        fastEma: 9,
        slowEma: 21,
        rsiPeriod: 14,
        rsiThreshold: 50,
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

    const minCandles = Math.max(slowPeriod, rsiPeriod) + 2;
    if (candles.length < minCandles) {
      log.warn({ candles: candles.length, required: minCandles }, 'Not enough candles for momentum analysis');
      return signals;
    }

    const fastEma = EMA(candles, fastPeriod).values;
    const slowEma = EMA(candles, slowPeriod).values;
    const rsi = RSI(candles, rsiPeriod).values;

    const lastIdx = candles.length - 1;
    const prevIdx = lastIdx - 1;

    // Ensure we have valid indicator values
    if (
      isNaN(fastEma[lastIdx]) || isNaN(slowEma[lastIdx]) || isNaN(rsi[lastIdx]) ||
      isNaN(fastEma[prevIdx]) || isNaN(slowEma[prevIdx])
    ) {
      return signals;
    }

    const currentFast = fastEma[lastIdx];
    const currentSlow = slowEma[lastIdx];
    const prevFast = fastEma[prevIdx];
    const prevSlow = slowEma[prevIdx];
    const currentRsi = rsi[lastIdx];
    const price = candles[lastIdx].close;

    // Crossover detection
    const bullishCrossover = prevFast <= prevSlow && currentFast > currentSlow;
    const bearishCrossover = prevFast >= prevSlow && currentFast < currentSlow;

    // Calculate confidence based on RSI distance from threshold and EMA separation
    const emaSeparation = Math.abs(currentFast - currentSlow) / price;
    const rsiDistance = Math.abs(currentRsi - rsiThreshold) / 50; // normalize 0-1
    const confidence = Math.min(1, 0.5 + emaSeparation * 10 + rsiDistance * 0.3);

    const indicators: Record<string, number> = {
      fastEma: currentFast,
      slowEma: currentSlow,
      rsi: currentRsi,
      emaSeparation,
    };

    if (bullishCrossover && currentRsi > rsiThreshold) {
      signals.push(
        generateSignal(
          asset,
          'BUY',
          confidence,
          price,
          this.name,
          timeframe,
          indicators,
          `EMA(${fastPeriod}) crossed above EMA(${slowPeriod}), RSI(${rsiPeriod})=${currentRsi.toFixed(1)} confirms bullish momentum`,
        ),
      );
    } else if (bearishCrossover && currentRsi < rsiThreshold) {
      signals.push(
        generateSignal(
          asset,
          'SELL',
          confidence,
          price,
          this.name,
          timeframe,
          indicators,
          `EMA(${fastPeriod}) crossed below EMA(${slowPeriod}), RSI(${rsiPeriod})=${currentRsi.toFixed(1)} confirms bearish momentum`,
        ),
      );
    }

    return signals;
  }
}
