// ============================================================
// HybridStrategy — agent-discovered strategy from indicator mixing
//
// Instead of hardcoded logic, this strategy uses DNA-driven weights
// to combine multiple indicators. Agents discover their own
// trading rules through evolution and post-trade optimization.
// ============================================================

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
import { RSI, EMA, MACD, BollingerBands, SMA } from '../indicators.js';
import { generateSignal } from '../signals.js';

const log = createModuleLogger('strategy:hybrid');

/**
 * HybridStrategy — an agent-discoverable strategy.
 *
 * Instead of fixed indicator logic, it uses evolvable DNA weights to
 * combine RSI, EMA crossover, MACD, Bollinger Bands, and volume.
 * Each indicator produces a vote (-1 to +1), and the DNA determines
 * how much weight each vote carries. The aggregate vote determines
 * the trade direction and confidence.
 *
 * Agents evolve their DNA to discover which indicator combinations
 * work best for different market conditions. New hybrid variants
 * emerge through genetic mutation + post-trade optimization.
 */
export class HybridStrategy implements Strategy {
  name: string;
  config: StrategyConfig;
  dna: StrategyDNA;

  constructor(config?: Partial<StrategyConfig>, name?: string) {
    this.name = name ?? `hybrid-${generateId().slice(0, 6)}`;
    this.config = {
      name: this.name,
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
      name: this.name,
      generation: 0,
      parentId: null,
      params: {
        // Indicator weights — how much each indicator influences the decision
        rsiWeight: 0.25,
        emaWeight: 0.25,
        macdWeight: 0.2,
        bollingerWeight: 0.15,
        volumeWeight: 0.15,

        // Indicator parameters — evolvable
        rsiPeriod: 14,
        rsiBuyThreshold: 30,
        rsiSellThreshold: 70,
        fastEmaPeriod: 9,
        slowEmaPeriod: 21,
        macdFastPeriod: 12,
        macdSlowPeriod: 26,
        macdSignalPeriod: 9,
        bollingerPeriod: 20,
        bollingerStdDev: 2,

        // Trade parameters
        confidenceThreshold: 0.4,
        stopLossMultiplier: 2.0,
        takeProfitMultiplier: 3.0,
        trendWeight: 0.5,

        // Volume filter
        volumeThreshold: 0.8, // relative to average volume
      },
      fitness: 0,
      createdAt: Date.now(),
      mutations: ['genesis'],
    };
  }

  async analyze(data: MarketData, macro?: MacroEnvironment): Promise<Signal[]> {
    const { candles, asset, timeframe } = data;
    const p = this.dna.params;

    // Need minimum candles for the longest indicator
    const minCandles = Math.max(
      Math.round(p['slowEmaPeriod'] ?? 21) + 5,
      Math.round(p['bollingerPeriod'] ?? 20) + 5,
      Math.round(p['macdSlowPeriod'] ?? 26) + 5,
    );

    if (candles.length < minCandles) {
      log.warn({ candles: candles.length, required: minCandles }, `Not enough candles for ${this.name} analysis`);
      return [];
    }

    const closes = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume);
    const latestPrice = closes[closes.length - 1];

    // --- Compute all indicators ---
    const votes: Array<{ name: string; vote: number; weight: number; value: number }> = [];

    // 1. RSI vote
    const rsiPeriod = Math.round(p['rsiPeriod'] ?? 14);
    const rsiResult = RSI(candles, rsiPeriod);
    const rsiValue = rsiResult.values[candles.length - 1] ?? 50;
    const rsiBuy = p['rsiBuyThreshold'] ?? 30;
    const rsiSell = p['rsiSellThreshold'] ?? 70;

    let rsiVote = 0;
    if (rsiValue < rsiBuy) rsiVote = (rsiBuy - rsiValue) / rsiBuy; // 0 to 1 (oversold = buy)
    else if (rsiValue > rsiSell) rsiVote = -(rsiValue - rsiSell) / (100 - rsiSell); // -1 to 0 (overbought = sell)

    votes.push({ name: 'rsi', vote: rsiVote, weight: p['rsiWeight'] ?? 0.25, value: rsiValue });

    // 2. EMA crossover vote
    const fastPeriod = Math.round(p['fastEmaPeriod'] ?? 9);
    const slowPeriod = Math.round(p['slowEmaPeriod'] ?? 21);
    const fastEma = EMA(candles, fastPeriod);
    const slowEma = EMA(candles, slowPeriod);
    const fastVal = fastEma.values[candles.length - 1] ?? 0;
    const slowVal = slowEma.values[candles.length - 1] ?? 0;

    let emaVote = 0;
    if (slowVal > 0) {
      const spread = (fastVal - slowVal) / slowVal;
      emaVote = Math.max(-1, Math.min(1, spread * 20)); // scale to -1..1
    }

    votes.push({ name: 'ema', vote: emaVote, weight: p['emaWeight'] ?? 0.25, value: fastVal });

    // 3. MACD vote
    const macdResult = MACD(candles, {
      fastPeriod: Math.round(p['macdFastPeriod'] ?? 12),
      slowPeriod: Math.round(p['macdSlowPeriod'] ?? 26),
      signalPeriod: Math.round(p['macdSignalPeriod'] ?? 9),
    });
    const lastIdx = candles.length - 1;
    const macdHistogram = macdResult.histogram[lastIdx] ?? 0;
    let macdVote = 0;
    if (latestPrice > 0) {
      macdVote = Math.max(-1, Math.min(1, (macdHistogram / latestPrice) * 100));
    }

    votes.push({ name: 'macd', vote: macdVote, weight: p['macdWeight'] ?? 0.2, value: macdHistogram });

    // 4. Bollinger Bands vote
    const bbPeriod = Math.round(p['bollingerPeriod'] ?? 20);
    const bbStdDev = p['bollingerStdDev'] ?? 2;
    const bbResult = BollingerBands(candles, bbPeriod, bbStdDev);
    const bbUpper = bbResult.upper[lastIdx] ?? 0;
    const bbLower = bbResult.lower[lastIdx] ?? 0;
    const bbMiddle = bbResult.middle[lastIdx] ?? 0;
    let bbVote = 0;
    if (bbUpper > bbLower) {
      const range = bbUpper - bbLower;
      const position = (latestPrice - bbLower) / range; // 0 at lower, 1 at upper
      bbVote = -(position - 0.5) * 2; // -1 at upper band (sell), +1 at lower band (buy)
    }

    votes.push({ name: 'bollinger', vote: bbVote, weight: p['bollingerWeight'] ?? 0.15, value: bbMiddle });

    // 5. Volume vote — confirms or dampens signals
    const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const latestVolume = volumes[volumes.length - 1];
    const volumeRatio = avgVolume > 0 ? latestVolume / avgVolume : 1;
    const volThreshold = p['volumeThreshold'] ?? 0.8;
    const volumeMultiplier = volumeRatio >= volThreshold ? Math.min(1.5, volumeRatio) : 0.5;

    votes.push({ name: 'volume', vote: 0, weight: p['volumeWeight'] ?? 0.15, value: volumeRatio });

    // --- Aggregate votes ---
    let totalWeight = 0;
    let weightedVoteSum = 0;
    for (const v of votes) {
      if (v.name === 'volume') continue; // volume is a multiplier, not a vote
      totalWeight += v.weight;
      weightedVoteSum += v.vote * v.weight;
    }

    const normalizedVote = totalWeight > 0 ? weightedVoteSum / totalWeight : 0;
    const rawConfidence = Math.abs(normalizedVote) * volumeMultiplier;

    // Apply macro adjustment
    let macroMultiplier = 1;
    if (macro) {
      if (macro.riskLevel === 'extreme') macroMultiplier = 0.5;
      else if (macro.riskLevel === 'high') macroMultiplier = 0.7;
      else if (macro.riskLevel === 'low') macroMultiplier = 1.1;
    }

    const confidence = Math.min(1, rawConfidence * macroMultiplier);
    const threshold = p['confidenceThreshold'] ?? 0.4;

    if (confidence < threshold) {
      return [generateSignal(asset, 'HOLD', confidence, latestPrice, this.name, timeframe, this.buildIndicators(votes, rsiValue), 'Below confidence threshold')];
    }

    const action = normalizedVote > 0 ? 'BUY' : 'SELL';

    // Build reasoning from top contributing indicators
    const sorted = [...votes].filter(v => v.name !== 'volume').sort((a, b) => Math.abs(b.vote * b.weight) - Math.abs(a.vote * a.weight));
    const topReasons = sorted.slice(0, 2).map(v => {
      const dir = v.vote > 0 ? 'bullish' : 'bearish';
      return `${v.name} ${dir} (${(v.vote * 100).toFixed(0)}%)`;
    });
    const reason = `Hybrid signal: ${topReasons.join(', ')} | vol: ${volumeRatio.toFixed(1)}x`;

    return [generateSignal(
      asset, action, confidence, latestPrice, this.name, timeframe,
      this.buildIndicators(votes, rsiValue),
      reason,
    )];
  }

  private buildIndicators(
    votes: Array<{ name: string; value: number }>,
    rsiValue: number,
  ): Record<string, number> {
    const indicators: Record<string, number> = { rsi: rsiValue };
    for (const v of votes) {
      indicators[v.name] = v.value;
    }
    return indicators;
  }
}

/**
 * Create a new hybrid strategy with randomized DNA — for agent discovery.
 * Mutates weights and parameters to explore new indicator combinations.
 */
export function createRandomHybrid(): HybridStrategy {
  const strategy = new HybridStrategy();
  const dna = strategy.getDefaultDNA();

  // Randomize weights (normalized to sum to 1)
  const rawWeights = [
    0.1 + Math.random() * 0.4,  // rsi
    0.1 + Math.random() * 0.4,  // ema
    0.1 + Math.random() * 0.3,  // macd
    0.05 + Math.random() * 0.3, // bollinger
    0.05 + Math.random() * 0.3, // volume
  ];
  const weightSum = rawWeights.reduce((a, b) => a + b, 0);
  dna.params['rsiWeight'] = rawWeights[0] / weightSum;
  dna.params['emaWeight'] = rawWeights[1] / weightSum;
  dna.params['macdWeight'] = rawWeights[2] / weightSum;
  dna.params['bollingerWeight'] = rawWeights[3] / weightSum;
  dna.params['volumeWeight'] = rawWeights[4] / weightSum;

  // Randomize indicator periods
  dna.params['rsiPeriod'] = 7 + Math.floor(Math.random() * 21);   // 7-28
  dna.params['rsiBuyThreshold'] = 20 + Math.random() * 20;         // 20-40
  dna.params['rsiSellThreshold'] = 60 + Math.random() * 20;        // 60-80
  dna.params['fastEmaPeriod'] = 5 + Math.floor(Math.random() * 15); // 5-20
  dna.params['slowEmaPeriod'] = 15 + Math.floor(Math.random() * 35);// 15-50
  dna.params['bollingerPeriod'] = 10 + Math.floor(Math.random() * 30); // 10-40
  dna.params['bollingerStdDev'] = 1.5 + Math.random() * 1.5;      // 1.5-3.0
  dna.params['confidenceThreshold'] = 0.3 + Math.random() * 0.3;   // 0.3-0.6

  dna.mutations = ['random-discovery'];
  strategy.dna = dna;
  strategy.name = `hybrid-${dna.id.slice(0, 6)}`;
  strategy.config.name = strategy.name;

  return strategy;
}
