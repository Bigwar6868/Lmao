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
import { BollingerBands, RSI } from '../indicators.js';
import { generateSignal } from '../signals.js';

const log = createModuleLogger('strategy:mean-reversion');

export class MeanReversionStrategy implements Strategy {
  name = 'mean-reversion';
  config: StrategyConfig;
  dna: StrategyDNA;

  constructor(config?: Partial<StrategyConfig>) {
    this.config = {
      name: 'mean-reversion',
      enabled: true,
      params: {},
      assetClasses: ['crypto', 'stock', 'forex'],
      timeframes: ['15m', '1h', '4h', '1d'],
      ...config,
    };
    this.dna = this.getDefaultDNA();
  }

  getDefaultDNA(): StrategyDNA {
    return {
      id: generateId(),
      name: 'mean-reversion',
      generation: 0,
      parentId: null,
      params: {
        bbPeriod: 20,
        bbStdDev: 2,
        rsiPeriod: 14,
        oversold: 30,
        overbought: 70,
      },
      fitness: 0,
      createdAt: Date.now(),
      mutations: [],
    };
  }

  async analyze(data: MarketData, _macro?: MacroEnvironment): Promise<Signal[]> {
    const { candles, asset, timeframe } = data;
    const signals: Signal[] = [];

    const bbPeriod = this.dna.params.bbPeriod ?? 20;
    const bbStdDev = this.dna.params.bbStdDev ?? 2;
    const rsiPeriod = this.dna.params.rsiPeriod ?? 14;
    const oversold = this.dna.params.oversold ?? 30;
    const overbought = this.dna.params.overbought ?? 70;

    const minCandles = Math.max(bbPeriod, rsiPeriod + 1) + 1;
    if (candles.length < minCandles) {
      log.warn({ candles: candles.length, required: minCandles }, 'Not enough candles for mean-reversion analysis');
      return signals;
    }

    const bb = BollingerBands(candles, bbPeriod, bbStdDev);
    const rsi = RSI(candles, rsiPeriod);

    const lastIdx = candles.length - 1;
    const price = candles[lastIdx].close;
    const upperBand = bb.upper[lastIdx];
    const lowerBand = bb.lower[lastIdx];
    const middleBand = bb.middle[lastIdx];
    const currentRsi = rsi.values[lastIdx];

    if (isNaN(upperBand) || isNaN(lowerBand) || isNaN(currentRsi)) {
      return signals;
    }

    const indicators: Record<string, number> = {
      bbUpper: upperBand,
      bbMiddle: middleBand,
      bbLower: lowerBand,
      rsi: currentRsi,
      bandwidth: bb.bandwidth[lastIdx],
    };

    // BUY: price at or below lower band + RSI oversold
    const bandwidth = upperBand - lowerBand;
    if (price <= lowerBand && currentRsi < oversold && bandwidth > 0) {
      // Confidence: how far below band + how extreme the RSI
      const bandDistance = (lowerBand - price) / bandwidth;
      const rsiExtremity = (oversold - currentRsi) / oversold;
      const confidence = Math.min(1, 0.5 + bandDistance * 0.3 + rsiExtremity * 0.3);

      signals.push(
        generateSignal(
          asset,
          'BUY',
          confidence,
          price,
          this.name,
          timeframe,
          indicators,
          `Price touched lower BB (${lowerBand.toFixed(2)}), RSI=${currentRsi.toFixed(1)} oversold — mean reversion buy`,
        ),
      );
    }

    // SELL: price at or above upper band + RSI overbought
    if (price >= upperBand && currentRsi > overbought && bandwidth > 0) {
      const bandDistance = (price - upperBand) / bandwidth;
      const rsiExtremity = (currentRsi - overbought) / (100 - overbought);
      const confidence = Math.min(1, 0.5 + bandDistance * 0.3 + rsiExtremity * 0.3);

      signals.push(
        generateSignal(
          asset,
          'SELL',
          confidence,
          price,
          this.name,
          timeframe,
          indicators,
          `Price touched upper BB (${upperBand.toFixed(2)}), RSI=${currentRsi.toFixed(1)} overbought — mean reversion sell`,
        ),
      );
    }

    return signals;
  }
}
