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
import { BollingerBands, RSI, EMA } from '../indicators.js';
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
      assetClasses: ['crypto', 'forex'],
      timeframes: ['1m', '5m', '15m', '1h', '4h', '1d', '1w'],
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
    const trendPeriod = this.dna.params.trendEma ?? 200;

    const minCandles = Math.max(bbPeriod, rsiPeriod + 1, trendPeriod) + 1;
    if (candles.length < minCandles) {
      log.warn({ candles: candles.length, required: minCandles }, 'Not enough candles for mean-reversion analysis');
      return signals;
    }

    const bb = BollingerBands(candles, bbPeriod, bbStdDev);
    const rsi = RSI(candles, rsiPeriod);
    const trendEma = EMA(candles, trendPeriod).values;

    const lastIdx = candles.length - 1;
    const price = candles[lastIdx].close;
    const upperBand = bb.upper[lastIdx];
    const lowerBand = bb.lower[lastIdx];
    const middleBand = bb.middle[lastIdx];
    const currentRsi = rsi.values[lastIdx];
    const currentTrend = trendEma[lastIdx];

    if (isNaN(upperBand) || isNaN(lowerBand) || isNaN(currentRsi) || isNaN(currentTrend)) {
      return signals;
    }

    // Regime filter: mean-reversion works best when price is NEAR the trend EMA
    // (range-bound). Skip when price is far from trend (strong trend = don't fade it).
    const trendDeviation = Math.abs(price - currentTrend) / currentTrend;
    const isRangeBound = trendDeviation < 0.03; // within 3% of 200 EMA = range-bound

    const bandwidth = upperBand - lowerBand;
    const indicators: Record<string, number> = {
      bbUpper: upperBand,
      bbMiddle: middleBand,
      bbLower: lowerBand,
      rsi: currentRsi,
      bandwidth: bb.bandwidth[lastIdx],
      trendEma: currentTrend,
      trendDeviation,
    };

    // BUY: price at or below lower band + RSI oversold + range-bound regime
    if (price <= lowerBand && currentRsi < oversold && bandwidth > 0 && isRangeBound) {
      const bandDistance = (lowerBand - price) / bandwidth;
      const rsiExtremity = (oversold - currentRsi) / oversold;
      // Confidence penalised if near trend boundary (less range-bound)
      const regimePenalty = Math.min(0.1, trendDeviation * 5);
      const confidence = Math.min(1, 0.45 + bandDistance * 0.3 + rsiExtremity * 0.3 - regimePenalty);

      signals.push(
        generateSignal(
          asset,
          'BUY',
          confidence,
          price,
          this.name,
          timeframe,
          indicators,
          `Price at lower BB (${lowerBand.toFixed(2)}), RSI=${currentRsi.toFixed(1)} oversold, range-bound regime — mean reversion buy`,
        ),
      );
    }

    // SELL: price at or above upper band + RSI overbought + range-bound regime
    if (price >= upperBand && currentRsi > overbought && bandwidth > 0 && isRangeBound) {
      const bandDistance = (price - upperBand) / bandwidth;
      const rsiExtremity = (currentRsi - overbought) / (100 - overbought);
      const regimePenalty = Math.min(0.1, trendDeviation * 5);
      const confidence = Math.min(1, 0.45 + bandDistance * 0.3 + rsiExtremity * 0.3 - regimePenalty);

      signals.push(
        generateSignal(
          asset,
          'SELL',
          confidence,
          price,
          this.name,
          timeframe,
          indicators,
          `Price at upper BB (${upperBand.toFixed(2)}), RSI=${currentRsi.toFixed(1)} overbought, range-bound regime — mean reversion sell`,
        ),
      );
    }

    return signals;
  }
}
