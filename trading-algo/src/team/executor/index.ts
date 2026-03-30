import type { Signal, RiskAssessment, Portfolio, Order } from '../../shared/types.js';
import type { TradeExecution } from './types.js';
import { LiveExecutor } from './live.js';
import { config } from '../../config/index.js';
import { createModuleLogger } from '../../shared/logger.js';

const log = createModuleLogger('executor');

/**
 * Trade Executor — routes orders to the live trading engine.
 */
export class Executor {
  private liveExecutor: LiveExecutor;

  constructor() {
    this.liveExecutor = new LiveExecutor({ initialCapital: config.initialCapital });
    log.info({ mode: 'live' }, 'Executor initialized');
  }

  async execute(signal: Signal, risk: RiskAssessment): Promise<TradeExecution> {
    return this.liveExecutor.executeTrade(signal, risk);
  }

  updatePrices(prices: Map<string, number>): void {
    this.liveExecutor.updatePrices(prices);
  }

  async checkStops(prices: Map<string, number>): Promise<void> {
    await this.liveExecutor.checkStops(prices);
  }

  getPortfolio(): Portfolio {
    return this.liveExecutor.getPortfolio();
  }

  getOrderHistory(): Order[] {
    return this.liveExecutor.getOrderHistory();
  }

  getSummary(): string {
    return this.liveExecutor.getSummary();
  }
}
