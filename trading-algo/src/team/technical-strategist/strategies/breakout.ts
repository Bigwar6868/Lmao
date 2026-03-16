import type {
  MarketData,
  MacroEnvironment,
  Signal,
  Strategy,
  StrategyConfig,
  StrategyDNA,
} from '../../../shared/types.js';
import { generateId, mean } from '../../../shared/utils.js';
import { createModuleLogger } from '../../../shared/logger.js';
import { BollingerBands } from '../indicators.js';
import { generateSignal } from '../signals.js';

const log = createModuleLogger('strategy:breakout');

export class BreakoutStrategy implements Strategy {
  name = 'breakout';
  config: StrategyConfig;
  dna: StrategyDNA;

  constructor(config?: Partial<StrategyConfig>) {
    this.config = {
      name: 'breakout',
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
      name: 'breakout',
      generation: 0,
      parentId: null,
      params: {
        bbPeriod: 20,
        bbStdDev: 2,
        squeezeThreshold: 0.05,
        volumeMultiplier: 1.5,
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
    const squeezeThreshold = this.dna.params.squeezeThreshold ?? 0.05;
    const volumeMultiplier = this.dna.params.volumeMultiplier ?? 1.5;

    // Need extra candles to detect squeeze history
    const minCandles = bbPeriod + 5;
    if (candles.length < minCandles) {
      log.warn({ candles: candles.length, required: minCandles }, 'Not enough candles for breakout analysis');
      return signals;
    }

    const bb = BollingerBands(candles, bbPeriod, bbStdDev);

    const lastIdx = candles.length - 1;
    const prevIdx = lastIdx - 1;
    const price = candles[lastIdx].close;

    if (isNaN(bb.bandwidth[lastIdx]) || isNaN(bb.bandwidth[prevIdx])) {
      return signals;
    }

    // Check for squeeze: bandwidth was below threshold recently
    // Look back up to 5 candles for a squeeze
    let wasInSqueeze = false;
    for (let i = Math.max(bbPeriod - 1, lastIdx - 5); i < lastIdx; i++) {
      if (!isNaN(bb.bandwidth[i]) && bb.bandwidth[i] < squeezeThreshold) {
        wasInSqueeze = true;
        break;
      }
    }

    if (!wasInSqueeze) {
      return signals;
    }

    // Current bandwidth should be expanding (breakout from squeeze)
    const currentBandwidth = bb.bandwidth[lastIdx];
    const prevBandwidth = bb.bandwidth[prevIdx];
    const bandwidthExpanding = currentBandwidth > prevBandwidth;

    if (!bandwidthExpanding) {
      return signals;
    }

    // Volume confirmation: current volume > average volume * multiplier
    const volumeWindow = candles.slice(Math.max(0, lastIdx - 20), lastIdx);
    const avgVolume = mean(volumeWindow.map((c) => c.volume));
    const currentVolume = candles[lastIdx].volume;
    const volumeSpike = currentVolume > avgVolume * volumeMultiplier;

    if (!volumeSpike) {
      return signals;
    }

    const upperBand = bb.upper[lastIdx];
    const lowerBand = bb.lower[lastIdx];
    const middleBand = bb.middle[lastIdx];

    const indicators: Record<string, number> = {
      bbUpper: upperBand,
      bbMiddle: middleBand,
      bbLower: lowerBand,
      bandwidth: currentBandwidth,
      prevBandwidth,
      volume: currentVolume,
      avgVolume,
      volumeRatio: currentVolume / avgVolume,
    };

    // Determine breakout direction
    if (price > upperBand) {
      // Upward breakout
      const volumeStrength = Math.min(1, (currentVolume / avgVolume - 1) / 2);
      const bandBreak = (price - upperBand) / (upperBand - lowerBand);
      const confidence = Math.min(1, 0.5 + volumeStrength * 0.25 + bandBreak * 0.25);

      signals.push(
        generateSignal(
          asset,
          'BUY',
          confidence,
          price,
          this.name,
          timeframe,
          indicators,
          `Upward breakout after BB squeeze (bandwidth ${prevBandwidth.toFixed(4)} -> ${currentBandwidth.toFixed(4)}), volume spike ${(currentVolume / avgVolume).toFixed(1)}x`,
        ),
      );
    } else if (price < lowerBand) {
      // Downward breakout
      const volumeStrength = Math.min(1, (currentVolume / avgVolume - 1) / 2);
      const bandBreak = (lowerBand - price) / (upperBand - lowerBand);
      const confidence = Math.min(1, 0.5 + volumeStrength * 0.25 + bandBreak * 0.25);

      signals.push(
        generateSignal(
          asset,
          'SELL',
          confidence,
          price,
          this.name,
          timeframe,
          indicators,
          `Downward breakout after BB squeeze (bandwidth ${prevBandwidth.toFixed(4)} -> ${currentBandwidth.toFixed(4)}), volume spike ${(currentVolume / avgVolume).toFixed(1)}x`,
        ),
      );
    }

    return signals;
  }
}
