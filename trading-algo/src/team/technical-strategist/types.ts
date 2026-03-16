// ============================================================
// Technical Indicator Result Types
// ============================================================

export interface RSIResult {
  values: number[];
  period: number;
}

export interface MACDResult {
  macd: number[];
  signal: number[];
  histogram: number[];
  fastPeriod: number;
  slowPeriod: number;
  signalPeriod: number;
}

export interface BollingerResult {
  upper: number[];
  middle: number[];
  lower: number[];
  bandwidth: number[];
  period: number;
  stdDevMultiplier: number;
}

export interface EMAResult {
  values: number[];
  period: number;
}

export interface ATRResult {
  values: number[];
  period: number;
}

export interface StochasticResult {
  k: number[];
  d: number[];
  kPeriod: number;
  dPeriod: number;
}

export interface VWAPResult {
  values: number[];
}
