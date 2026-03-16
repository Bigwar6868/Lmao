import type { Candle } from '../../shared/types.js';
import type {
  RSIResult,
  MACDResult,
  BollingerResult,
  EMAResult,
  ATRResult,
  StochasticResult,
  VWAPResult,
} from './types.js';

// ============================================================
// Simple Moving Average
// ============================================================

/**
 * Calculates Simple Moving Average for the close prices.
 * Returns an array of length candles.length where the first (period-1) values are NaN.
 */
export function SMA(candles: Candle[], period: number): number[] {
  const result: number[] = new Array(candles.length).fill(NaN);

  if (candles.length < period) return result;

  // Initial sum for the first window
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += candles[i].close;
  }
  result[period - 1] = sum / period;

  // Slide the window
  for (let i = period; i < candles.length; i++) {
    sum += candles[i].close - candles[i - period].close;
    result[i] = sum / period;
  }

  return result;
}

// ============================================================
// Exponential Moving Average
// ============================================================

/**
 * Calculates Exponential Moving Average for the close prices.
 * Uses SMA as the seed value for the first EMA point.
 * Returns an array of length candles.length where the first (period-1) values are NaN.
 */
export function EMA(candles: Candle[], period: number): EMAResult {
  const values: number[] = new Array(candles.length).fill(NaN);

  if (candles.length < period) return { values, period };

  const multiplier = 2 / (period + 1);

  // Seed with SMA of first `period` candles
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += candles[i].close;
  }
  values[period - 1] = sum / period;

  // Calculate EMA from period onward
  for (let i = period; i < candles.length; i++) {
    values[i] = (candles[i].close - values[i - 1]) * multiplier + values[i - 1];
  }

  return { values, period };
}

/**
 * Internal helper: compute EMA over a raw number array (not candles).
 */
function emaFromValues(data: number[], period: number): number[] {
  const result: number[] = new Array(data.length).fill(NaN);

  // Find first non-NaN index
  let startIdx = 0;
  while (startIdx < data.length && isNaN(data[startIdx])) {
    startIdx++;
  }

  if (startIdx + period > data.length) return result;

  const multiplier = 2 / (period + 1);

  // Seed with SMA
  let sum = 0;
  for (let i = startIdx; i < startIdx + period; i++) {
    sum += data[i];
  }
  const seedIdx = startIdx + period - 1;
  result[seedIdx] = sum / period;

  for (let i = seedIdx + 1; i < data.length; i++) {
    result[i] = (data[i] - result[i - 1]) * multiplier + result[i - 1];
  }

  return result;
}

// ============================================================
// RSI - Relative Strength Index (Wilder's smoothing)
// ============================================================

/**
 * Classic RSI using Wilder's smoothing method.
 * Period defaults to 14.
 */
export function RSI(candles: Candle[], period = 14): RSIResult {
  const values: number[] = new Array(candles.length).fill(NaN);

  if (candles.length < period + 1) return { values, period };

  // Calculate price changes
  const changes: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    changes.push(candles[i].close - candles[i - 1].close);
  }

  // Initial average gain and loss (simple average of first `period` changes)
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] >= 0) {
      avgGain += changes[i];
    } else {
      avgLoss += Math.abs(changes[i]);
    }
  }
  avgGain /= period;
  avgLoss /= period;

  // First RSI value at index = period
  if (avgLoss === 0) {
    values[period] = 100;
  } else {
    const rs = avgGain / avgLoss;
    values[period] = 100 - 100 / (1 + rs);
  }

  // Subsequent values using Wilder's smoothing
  for (let i = period; i < changes.length; i++) {
    const gain = changes[i] >= 0 ? changes[i] : 0;
    const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    if (avgLoss === 0) {
      values[i + 1] = 100;
    } else {
      const rs = avgGain / avgLoss;
      values[i + 1] = 100 - 100 / (1 + rs);
    }
  }

  return { values, period };
}

// ============================================================
// MACD - Moving Average Convergence Divergence
// ============================================================

/**
 * MACD using EMA-based calculation.
 * Defaults: fast=12, slow=26, signal=9.
 */
export function MACD(
  candles: Candle[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MACDResult {
  const len = candles.length;
  const macd: number[] = new Array(len).fill(NaN);
  const signal: number[] = new Array(len).fill(NaN);
  const histogram: number[] = new Array(len).fill(NaN);

  const fastEma = EMA(candles, fastPeriod).values;
  const slowEma = EMA(candles, slowPeriod).values;

  // MACD line = fast EMA - slow EMA
  for (let i = 0; i < len; i++) {
    if (!isNaN(fastEma[i]) && !isNaN(slowEma[i])) {
      macd[i] = fastEma[i] - slowEma[i];
    }
  }

  // Signal line = EMA of MACD line
  const signalLine = emaFromValues(macd, signalPeriod);
  for (let i = 0; i < len; i++) {
    signal[i] = signalLine[i];
  }

  // Histogram = MACD - Signal
  for (let i = 0; i < len; i++) {
    if (!isNaN(macd[i]) && !isNaN(signal[i])) {
      histogram[i] = macd[i] - signal[i];
    }
  }

  return {
    macd,
    signal,
    histogram,
    fastPeriod,
    slowPeriod,
    signalPeriod,
  };
}

// ============================================================
// Bollinger Bands
// ============================================================

/**
 * Bollinger Bands: SMA ± (stdDev * multiplier).
 * Defaults: period=20, stdDevMultiplier=2.
 */
export function BollingerBands(
  candles: Candle[],
  period = 20,
  stdDevMultiplier = 2,
): BollingerResult {
  const len = candles.length;
  const upper: number[] = new Array(len).fill(NaN);
  const middle: number[] = new Array(len).fill(NaN);
  const lower: number[] = new Array(len).fill(NaN);
  const bandwidth: number[] = new Array(len).fill(NaN);

  if (len < period) {
    return { upper, middle, lower, bandwidth, period, stdDevMultiplier };
  }

  for (let i = period - 1; i < len; i++) {
    // Calculate SMA for this window
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += candles[j].close;
    }
    const sma = sum / period;

    // Calculate standard deviation for this window
    let sqDiffSum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sqDiffSum += (candles[j].close - sma) ** 2;
    }
    // Population std dev (not sample) for Bollinger Bands
    const sd = Math.sqrt(sqDiffSum / period);

    middle[i] = sma;
    upper[i] = sma + stdDevMultiplier * sd;
    lower[i] = sma - stdDevMultiplier * sd;
    bandwidth[i] = sma !== 0 ? (upper[i] - lower[i]) / sma : 0;
  }

  return { upper, middle, lower, bandwidth, period, stdDevMultiplier };
}

// ============================================================
// ATR - Average True Range
// ============================================================

/**
 * Average True Range using Wilder's smoothing.
 * Period defaults to 14.
 */
export function ATR(candles: Candle[], period = 14): ATRResult {
  const len = candles.length;
  const values: number[] = new Array(len).fill(NaN);

  if (len < period + 1) return { values, period };

  // Calculate true ranges
  const trueRanges: number[] = [candles[0].high - candles[0].low];
  for (let i = 1; i < len; i++) {
    const highLow = candles[i].high - candles[i].low;
    const highPrevClose = Math.abs(candles[i].high - candles[i - 1].close);
    const lowPrevClose = Math.abs(candles[i].low - candles[i - 1].close);
    trueRanges.push(Math.max(highLow, highPrevClose, lowPrevClose));
  }

  // Initial ATR = simple average of first `period` true ranges (starting from index 1)
  let atr = 0;
  for (let i = 1; i <= period; i++) {
    atr += trueRanges[i];
  }
  atr /= period;
  values[period] = atr;

  // Wilder's smoothing for subsequent values
  for (let i = period + 1; i < len; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
    values[i] = atr;
  }

  return { values, period };
}

// ============================================================
// Stochastic Oscillator
// ============================================================

/**
 * Stochastic Oscillator: %K and %D.
 * %K = (close - lowest low) / (highest high - lowest low) * 100
 * %D = SMA of %K over dPeriod.
 * Defaults: kPeriod=14, dPeriod=3.
 */
export function Stochastic(
  candles: Candle[],
  kPeriod = 14,
  dPeriod = 3,
): StochasticResult {
  const len = candles.length;
  const k: number[] = new Array(len).fill(NaN);
  const d: number[] = new Array(len).fill(NaN);

  if (len < kPeriod) return { k, d, kPeriod, dPeriod };

  // Calculate %K
  for (let i = kPeriod - 1; i < len; i++) {
    let lowestLow = Infinity;
    let highestHigh = -Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (candles[j].low < lowestLow) lowestLow = candles[j].low;
      if (candles[j].high > highestHigh) highestHigh = candles[j].high;
    }
    const range = highestHigh - lowestLow;
    k[i] = range === 0 ? 50 : ((candles[i].close - lowestLow) / range) * 100;
  }

  // Calculate %D = SMA of %K
  const kStartIdx = kPeriod - 1;
  for (let i = kStartIdx + dPeriod - 1; i < len; i++) {
    let sum = 0;
    for (let j = i - dPeriod + 1; j <= i; j++) {
      sum += k[j];
    }
    d[i] = sum / dPeriod;
  }

  return { k, d, kPeriod, dPeriod };
}

// ============================================================
// VWAP - Volume Weighted Average Price
// ============================================================

/**
 * VWAP: cumulative (typical price * volume) / cumulative volume.
 * Typical price = (high + low + close) / 3.
 */
export function VWAP(candles: Candle[]): VWAPResult {
  const len = candles.length;
  const values: number[] = new Array(len).fill(NaN);

  if (len === 0) return { values };

  let cumulativeTPV = 0;
  let cumulativeVolume = 0;

  for (let i = 0; i < len; i++) {
    const typicalPrice = (candles[i].high + candles[i].low + candles[i].close) / 3;
    cumulativeTPV += typicalPrice * candles[i].volume;
    cumulativeVolume += candles[i].volume;

    values[i] = cumulativeVolume === 0 ? typicalPrice : cumulativeTPV / cumulativeVolume;
  }

  return { values };
}
