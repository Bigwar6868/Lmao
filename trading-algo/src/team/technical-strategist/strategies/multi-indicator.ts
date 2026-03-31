import type {
  MarketData,
  MacroEnvironment,
  Signal,
  SignalAction,
  Strategy,
  StrategyConfig,
  StrategyDNA,
} from '../../../shared/types.js';
import { generateId } from '../../../shared/utils.js';
import { createModuleLogger } from '../../../shared/logger.js';
import { RSI, MACD, BollingerBands, EMA } from '../indicators.js';
import { generateSignal } from '../signals.js';

const log = createModuleLogger('strategy:multi-indicator');

interface Vote {
  action: SignalAction;
  weight: number;
  reason: string;
}

export class MultiIndicatorStrategy implements Strategy {
  name = 'multi-indicator';
  config: StrategyConfig;
  dna: StrategyDNA;

  constructor(config?: Partial<StrategyConfig>) {
    this.config = {
      name: 'multi-indicator',
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
      name: 'multi-indicator',
      generation: 0,
      parentId: null,
      params: {
        rsiPeriod: 14,
        rsiOversold: 35,
        rsiOverbought: 65,
        macdFast: 12,
        macdSlow: 26,
        macdSignal: 9,
        bbPeriod: 20,
        bbStdDev: 2,
        rsiWeight: 0.3,
        macdWeight: 0.4,
        bbWeight: 0.3,
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

    const p = this.dna.params;
    const rsiPeriod = p.rsiPeriod ?? 14;
    const rsiOversold = p.rsiOversold ?? 30;
    const rsiOverbought = p.rsiOverbought ?? 70;
    const macdFast = p.macdFast ?? 12;
    const macdSlow = p.macdSlow ?? 26;
    const macdSignalPeriod = p.macdSignal ?? 9;
    const bbPeriod = p.bbPeriod ?? 20;
    const bbStdDev = p.bbStdDev ?? 2;
    const rsiWeight = p.rsiWeight ?? 0.3;
    const macdWeight = p.macdWeight ?? 0.4;
    const bbWeight = p.bbWeight ?? 0.3;

    const trendPeriod = p.trendEma ?? 200;

    const minCandles = Math.max(macdSlow + macdSignalPeriod, bbPeriod, rsiPeriod + 1, trendPeriod) + 1;
    if (candles.length < minCandles) {
      log.warn({ candles: candles.length, required: minCandles }, 'Not enough candles for multi-indicator analysis');
      return signals;
    }

    const rsi = RSI(candles, rsiPeriod);
    const macd = MACD(candles, macdFast, macdSlow, macdSignalPeriod);
    const bb = BollingerBands(candles, bbPeriod, bbStdDev);
    const trendEma = EMA(candles, trendPeriod).values;

    const lastIdx = candles.length - 1;
    const price = candles[lastIdx].close;
    const currentRsi = rsi.values[lastIdx];
    const currentMacd = macd.macd[lastIdx];
    const currentMacdSignal = macd.signal[lastIdx];
    const currentHistogram = macd.histogram[lastIdx];
    const upperBand = bb.upper[lastIdx];
    const lowerBand = bb.lower[lastIdx];
    const middleBand = bb.middle[lastIdx];
    const currentTrend = trendEma[lastIdx];

    if (
      isNaN(currentRsi) || isNaN(currentMacd) || isNaN(currentMacdSignal) ||
      isNaN(upperBand) || isNaN(lowerBand) || isNaN(currentTrend)
    ) {
      return signals;
    }

    // Trend direction from 200 EMA
    const bullishTrend = price > currentTrend;
    const bearishTrend = price < currentTrend;
    const trendWeight = 0.2;

    const votes: Vote[] = [];

    // Trend vote (new — ensures we trade WITH the trend)
    if (bullishTrend) {
      votes.push({ action: 'BUY', weight: trendWeight, reason: `Price above EMA(${trendPeriod}) — bullish trend` });
    } else if (bearishTrend) {
      votes.push({ action: 'SELL', weight: trendWeight, reason: `Price below EMA(${trendPeriod}) — bearish trend` });
    } else {
      votes.push({ action: 'HOLD', weight: trendWeight, reason: `Price at EMA(${trendPeriod}) — no clear trend` });
    }

    // RSI vote
    if (currentRsi < rsiOversold) {
      votes.push({ action: 'BUY', weight: rsiWeight, reason: `RSI=${currentRsi.toFixed(1)} oversold` });
    } else if (currentRsi > rsiOverbought) {
      votes.push({ action: 'SELL', weight: rsiWeight, reason: `RSI=${currentRsi.toFixed(1)} overbought` });
    } else {
      votes.push({ action: 'HOLD', weight: rsiWeight, reason: `RSI=${currentRsi.toFixed(1)} neutral` });
    }

    // MACD vote
    if (currentMacd > currentMacdSignal && currentHistogram > 0) {
      votes.push({ action: 'BUY', weight: macdWeight, reason: `MACD above signal, histogram=${currentHistogram.toFixed(4)}` });
    } else if (currentMacd < currentMacdSignal && currentHistogram < 0) {
      votes.push({ action: 'SELL', weight: macdWeight, reason: `MACD below signal, histogram=${currentHistogram.toFixed(4)}` });
    } else {
      votes.push({ action: 'HOLD', weight: macdWeight, reason: `MACD neutral, histogram=${currentHistogram.toFixed(4)}` });
    }

    // Bollinger Bands vote
    if (price <= lowerBand) {
      votes.push({ action: 'BUY', weight: bbWeight, reason: `Price at lower BB (${lowerBand.toFixed(2)})` });
    } else if (price >= upperBand) {
      votes.push({ action: 'SELL', weight: bbWeight, reason: `Price at upper BB (${upperBand.toFixed(2)})` });
    } else {
      votes.push({ action: 'HOLD', weight: bbWeight, reason: `Price within BB bands` });
    }

    // Tally weighted votes
    let buyScore = 0;
    let sellScore = 0;
    let holdScore = 0;
    const totalWeight = trendWeight + rsiWeight + macdWeight + bbWeight;
    const reasons: string[] = [];

    for (const vote of votes) {
      reasons.push(`[${vote.action}] ${vote.reason}`);
      switch (vote.action) {
        case 'BUY':
          buyScore += vote.weight;
          break;
        case 'SELL':
          sellScore += vote.weight;
          break;
        case 'HOLD':
          holdScore += vote.weight;
          break;
      }
    }

    const indicators: Record<string, number> = {
      rsi: currentRsi,
      macd: currentMacd,
      macdSignal: currentMacdSignal,
      macdHistogram: currentHistogram,
      bbUpper: upperBand,
      bbMiddle: middleBand,
      bbLower: lowerBand,
      trendEma: currentTrend,
      buyScore,
      sellScore,
      holdScore,
    };

    // Require >50% consensus for signal generation
    const consensusThreshold = totalWeight * 0.5;
    const maxScore = Math.max(buyScore, sellScore, holdScore);
    let action: SignalAction;

    if (buyScore >= consensusThreshold && buyScore > sellScore) {
      action = 'BUY';
    } else if (sellScore >= consensusThreshold && sellScore > buyScore) {
      action = 'SELL';
    } else {
      // No consensus — no signal
      return signals;
    }

    // Confidence = normalised winning score (how much agreement / total possible)
    const confidence = Math.min(1, maxScore / totalWeight);

    signals.push(
      generateSignal(
        asset,
        action,
        confidence,
        price,
        this.name,
        timeframe,
        indicators,
        `Multi-indicator consensus (${(maxScore / totalWeight * 100).toFixed(0)}%): ${reasons.join('; ')}`,
      ),
    );

    return signals;
  }
}
