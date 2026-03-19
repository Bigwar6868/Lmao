import type {
  MarketData,
  MacroEnvironment,
  Signal,
  Strategy,
  StrategyDNA,
} from '../../shared/types.js';
import { createModuleLogger } from '../../shared/logger.js';
import { eventBus } from '../../shared/events.js';
import { MomentumStrategy } from './strategies/momentum.js';
import { MeanReversionStrategy } from './strategies/mean-reversion.js';
import { BreakoutStrategy } from './strategies/breakout.js';
import { MultiIndicatorStrategy } from './strategies/multi-indicator.js';
import { HybridStrategy, createRandomHybrid } from './strategies/hybrid.js';
import { MultiTimeframeStrategy } from './strategies/multi-timeframe.js';

export { MomentumStrategy } from './strategies/momentum.js';
export { MeanReversionStrategy } from './strategies/mean-reversion.js';
export { BreakoutStrategy } from './strategies/breakout.js';
export { MultiIndicatorStrategy } from './strategies/multi-indicator.js';
export { HybridStrategy, createRandomHybrid } from './strategies/hybrid.js';
export { MultiTimeframeStrategy } from './strategies/multi-timeframe.js';
export * from './types.js';
export * from './indicators.js';
export { generateSignal } from './signals.js';

const log = createModuleLogger('technical-strategist');

export class TechnicalStrategist {
  private strategies: Map<string, Strategy> = new Map();

  constructor() {
    // Initialize default strategies
    const momentum = new MomentumStrategy();
    const meanReversion = new MeanReversionStrategy();
    const breakout = new BreakoutStrategy();
    const multiIndicator = new MultiIndicatorStrategy();
    const hybrid = new HybridStrategy(undefined, 'hybrid');
    const multiTimeframe = new MultiTimeframeStrategy();

    this.strategies.set(momentum.name, momentum);
    this.strategies.set(meanReversion.name, meanReversion);
    this.strategies.set(breakout.name, breakout);
    this.strategies.set(multiIndicator.name, multiIndicator);
    this.strategies.set(hybrid.name, hybrid);
    this.strategies.set(multiTimeframe.name, multiTimeframe);

    log.info({ strategies: [...this.strategies.keys()] }, 'TechnicalStrategist initialized');
  }

  /**
   * Register a new discovered strategy (e.g., from agent strategy discovery).
   * Returns the strategy name for agent binding.
   */
  registerStrategy(strategy: Strategy): string {
    this.strategies.set(strategy.name, strategy);
    log.info({ strategy: strategy.name }, 'New strategy discovered and registered');
    return strategy.name;
  }

  /**
   * Create and register a new random hybrid strategy for discovery.
   * Agents can use this to explore new indicator combinations.
   */
  discoverNewStrategy(): Strategy {
    const hybrid = createRandomHybrid();
    this.strategies.set(hybrid.name, hybrid);
    log.info({
      strategy: hybrid.name,
      weights: {
        rsi: hybrid.dna.params['rsiWeight']?.toFixed(2),
        ema: hybrid.dna.params['emaWeight']?.toFixed(2),
        macd: hybrid.dna.params['macdWeight']?.toFixed(2),
        bb: hybrid.dna.params['bollingerWeight']?.toFixed(2),
        vol: hybrid.dna.params['volumeWeight']?.toFixed(2),
      },
    }, 'New hybrid strategy discovered');
    return hybrid;
  }

  /**
   * Run all enabled strategies against the provided market data.
   * Emits 'signal:generated' for each signal produced.
   */
  async analyzeAll(data: MarketData, macro?: MacroEnvironment): Promise<Signal[]> {
    const allSignals: Signal[] = [];

    for (const [name, strategy] of this.strategies) {
      if (!strategy.config.enabled) {
        log.debug({ strategy: name }, 'Strategy disabled, skipping');
        continue;
      }

      // Check if strategy supports this asset class and timeframe
      if (
        !strategy.config.assetClasses.includes(data.asset.assetClass) ||
        !strategy.config.timeframes.includes(data.timeframe)
      ) {
        continue;
      }

      try {
        const signals = await strategy.analyze(data, macro);

        for (const signal of signals) {
          allSignals.push(signal);
          await eventBus.emit('signal:generated', signal, 'technical-strategist');
          log.info(
            {
              strategy: name,
              action: signal.action,
              confidence: signal.confidence,
              price: signal.price,
              asset: signal.asset.symbol,
            },
            'Signal generated',
          );
        }
      } catch (err) {
        log.error({ strategy: name, error: err }, 'Strategy analysis failed');
      }
    }

    return allSignals;
  }

  /**
   * Returns all strategy instances.
   */
  getStrategies(): Strategy[] {
    return [...this.strategies.values()];
  }

  /**
   * Update the DNA (evolvable parameters) for a specific strategy.
   */
  updateDNA(strategyName: string, dna: StrategyDNA): void {
    const strategy = this.strategies.get(strategyName);
    if (!strategy) {
      log.warn({ strategyName }, 'Strategy not found for DNA update');
      return;
    }

    strategy.dna = dna;
    log.info(
      {
        strategy: strategyName,
        generation: dna.generation,
        params: dna.params,
      },
      'Strategy DNA updated',
    );
  }
}
