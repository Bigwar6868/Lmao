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

export { MomentumStrategy } from './strategies/momentum.js';
export { MeanReversionStrategy } from './strategies/mean-reversion.js';
export { BreakoutStrategy } from './strategies/breakout.js';
export { MultiIndicatorStrategy } from './strategies/multi-indicator.js';
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

    this.strategies.set(momentum.name, momentum);
    this.strategies.set(meanReversion.name, meanReversion);
    this.strategies.set(breakout.name, breakout);
    this.strategies.set(multiIndicator.name, multiIndicator);

    log.info({ strategies: [...this.strategies.keys()] }, 'TechnicalStrategist initialized');
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
