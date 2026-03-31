import type { Candle } from '../../shared/types.js';
import { createModuleLogger } from '../../shared/logger.js';
import { mean, stdDev } from '../../shared/utils.js';

const log = createModuleLogger('hmm-regime');

/** HMM states */
export type HMMState = 'bull' | 'bear' | 'sideways';

/** State parameters (emission distribution) */
interface StateParams {
  meanReturn: number;
  volatility: number;
}

/** HMM result for a single asset or aggregate */
export interface HMMRegimeResult {
  currentState: HMMState;
  stateProbabilities: Record<HMMState, number>;
  stateHistory: HMMState[];         // recent state sequence
  transitionAlert: boolean;         // true if regime just changed
  previousState: HMMState | null;
  confidence: number;               // how certain we are of current state
  strategyWeights: Record<string, number>; // recommended strategy allocation
  timestamp: number;
}

/**
 * Hidden Markov Model Regime Detector
 *
 * Uses a simplified Baum-Welch-inspired approach:
 * - 3 states: bull (positive returns, low-med vol), bear (negative returns, high vol), sideways (near-zero returns, low vol)
 * - Emission model: Gaussian returns per state
 * - Forward algorithm for state probability estimation
 * - Viterbi-like decoding for most likely state sequence
 */
export class HMMRegimeDetector {
  /** Learned state parameters */
  private stateParams: Record<HMMState, StateParams> = {
    bull:     { meanReturn: 0.002, volatility: 0.01 },
    bear:     { meanReturn: -0.003, volatility: 0.02 },
    sideways: { meanReturn: 0.0001, volatility: 0.005 },
  };

  /** Transition matrix: P(next | current) */
  private transitions: Record<HMMState, Record<HMMState, number>> = {
    bull:     { bull: 0.85, bear: 0.05, sideways: 0.10 },
    bear:     { bull: 0.05, bear: 0.80, sideways: 0.15 },
    sideways: { bull: 0.15, bear: 0.10, sideways: 0.75 },
  };

  /** Prior state probabilities */
  private priors: Record<HMMState, number> = { bull: 0.33, bear: 0.33, sideways: 0.34 };

  /** Strategy weights per regime */
  private readonly strategyMap: Record<HMMState, Record<string, number>> = {
    bull:     { momentum: 1.0, breakout: 0.8, 'mean-reversion': 0.3, 'multi-indicator': 0.7, carry: 0.9 },
    bear:     { momentum: 0.7, breakout: 0.4, 'mean-reversion': 0.5, 'multi-indicator': 0.6, carry: 0.2 },
    sideways: { momentum: 0.3, breakout: 0.5, 'mean-reversion': 1.0, 'multi-indicator': 0.8, carry: 0.6 },
  };

  private lastState: HMMState | null = null;
  private stateHistory: HMMState[] = [];
  private readonly maxHistory = 200;

  /**
   * Detect regime from candle data.
   * Calibrates state params from data, then runs forward algorithm.
   */
  detect(candles: Candle[]): HMMRegimeResult {
    if (candles.length < 50) {
      return this.defaultResult();
    }

    // 1. Compute returns
    const closes = candles.map(c => c.close);
    const returns = closes.slice(1).map((c, i) => (c - closes[i]) / closes[i]);

    // 2. Calibrate state parameters from data
    this.calibrate(returns);

    // 3. Forward algorithm — compute state probabilities
    const probs = this.forward(returns);

    // 4. Determine most likely current state
    const states: HMMState[] = ['bull', 'bear', 'sideways'];
    let bestState: HMMState = 'sideways';
    let bestProb = 0;
    for (const s of states) {
      if (probs[s] > bestProb) {
        bestProb = probs[s];
        bestState = s;
      }
    }

    // 5. Transition alert
    const transitionAlert = this.lastState !== null && this.lastState !== bestState;
    const previousState = this.lastState;
    this.lastState = bestState;

    // 6. Update state history
    this.stateHistory.push(bestState);
    if (this.stateHistory.length > this.maxHistory) {
      this.stateHistory.splice(0, this.stateHistory.length - this.maxHistory);
    }

    if (transitionAlert) {
      log.info({ from: previousState, to: bestState, confidence: bestProb.toFixed(3) }, 'Regime transition detected');
    }

    const result: HMMRegimeResult = {
      currentState: bestState,
      stateProbabilities: probs,
      stateHistory: this.stateHistory.slice(-20),
      transitionAlert,
      previousState,
      confidence: bestProb,
      strategyWeights: { ...this.strategyMap[bestState] },
      timestamp: Date.now(),
    };

    log.info({
      state: bestState,
      bull: probs.bull.toFixed(3),
      bear: probs.bear.toFixed(3),
      sideways: probs.sideways.toFixed(3),
    }, 'HMM regime detected');

    return result;
  }

  /**
   * Get strategy weight for current regime.
   * Returns 0-1 multiplier for a given strategy.
   */
  getStrategyWeight(strategy: string): number {
    if (!this.lastState) return 1.0;
    return this.strategyMap[this.lastState][strategy] ?? 0.5;
  }

  /**
   * Calibrate emission parameters from observed returns.
   * Uses k-means-like clustering to identify 3 return regimes.
   */
  private calibrate(returns: number[]): void {
    if (returns.length < 30) return;

    // Sort returns to identify clusters
    const sorted = [...returns].sort((a, b) => a - b);
    const n = sorted.length;
    const third = Math.floor(n / 3);

    // Bear: bottom third
    const bearReturns = sorted.slice(0, third);
    // Sideways: middle third
    const sidReturns = sorted.slice(third, 2 * third);
    // Bull: top third
    const bullReturns = sorted.slice(2 * third);

    this.stateParams.bear = {
      meanReturn: mean(bearReturns),
      volatility: Math.max(0.001, stdDev(bearReturns)),
    };
    this.stateParams.sideways = {
      meanReturn: mean(sidReturns),
      volatility: Math.max(0.001, stdDev(sidReturns)),
    };
    this.stateParams.bull = {
      meanReturn: mean(bullReturns),
      volatility: Math.max(0.001, stdDev(bullReturns)),
    };
  }

  /**
   * Forward algorithm — compute P(state | observations).
   * Simplified: processes the last N observations to get current state probabilities.
   */
  private forward(returns: number[]): Record<HMMState, number> {
    const states: HMMState[] = ['bull', 'bear', 'sideways'];
    const lookback = Math.min(returns.length, 100);
    const recentReturns = returns.slice(-lookback);

    // Initialize with priors
    let alpha: Record<HMMState, number> = { ...this.priors };

    for (const r of recentReturns) {
      const newAlpha: Record<HMMState, number> = { bull: 0, bear: 0, sideways: 0 };

      for (const s of states) {
        // Sum over all previous states
        let transSum = 0;
        for (const prev of states) {
          transSum += alpha[prev] * this.transitions[prev][s];
        }
        // Emission probability (Gaussian)
        const emission = this.gaussian(r, this.stateParams[s].meanReturn, this.stateParams[s].volatility);
        newAlpha[s] = transSum * emission;
      }

      // Normalize
      const total = newAlpha.bull + newAlpha.bear + newAlpha.sideways;
      if (total > 0) {
        for (const s of states) newAlpha[s] /= total;
      } else {
        // Uniform if numerical issues
        for (const s of states) newAlpha[s] = 1 / 3;
      }

      alpha = newAlpha;
    }

    return alpha;
  }

  /** Gaussian PDF */
  private gaussian(x: number, mu: number, sigma: number): number {
    const z = (x - mu) / sigma;
    return Math.exp(-0.5 * z * z) / (sigma * Math.sqrt(2 * Math.PI));
  }

  private defaultResult(): HMMRegimeResult {
    return {
      currentState: 'sideways',
      stateProbabilities: { bull: 0.33, bear: 0.33, sideways: 0.34 },
      stateHistory: [],
      transitionAlert: false,
      previousState: null,
      confidence: 0.34,
      strategyWeights: this.strategyMap.sideways,
      timestamp: Date.now(),
    };
  }

  /** Format report for display */
  static formatReport(result: HMMRegimeResult): string {
    const lines: string[] = ['\n=== HMM REGIME DETECTOR ===\n'];
    lines.push(`  State: ${result.currentState.toUpperCase()} (confidence: ${(result.confidence * 100).toFixed(1)}%)`);
    lines.push(`  Probabilities: Bull ${(result.stateProbabilities.bull * 100).toFixed(1)}% | Bear ${(result.stateProbabilities.bear * 100).toFixed(1)}% | Sideways ${(result.stateProbabilities.sideways * 100).toFixed(1)}%`);
    if (result.transitionAlert) {
      lines.push(`  ** TRANSITION: ${result.previousState} -> ${result.currentState} **`);
    }
    lines.push(`  Strategy weights:`);
    for (const [strategy, weight] of Object.entries(result.strategyWeights)) {
      const bar = '|'.repeat(Math.round(weight * 10));
      lines.push(`    ${strategy.padEnd(18)} ${bar} ${(weight * 100).toFixed(0)}%`);
    }
    return lines.join('\n');
  }
}
