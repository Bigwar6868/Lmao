import type { Signal, RiskAssessment, Portfolio, Order } from '../../shared/types.js';
import type { TradeExecution } from './types.js';
import { PaperTrader } from './paper.js';
import { LiveExecutor } from './live.js';
import { config } from '../../config/index.js';
import { createModuleLogger } from '../../shared/logger.js';

const log = createModuleLogger('executor');

/**
 * Trade Executor — routes orders to paper or live trading engine.
 */
export class Executor {
  private paperTrader: PaperTrader;
  private liveExecutor: LiveExecutor;
  private mode: 'paper' | 'live';

  constructor() {
    this.mode = config.tradingMode;
    this.paperTrader = new PaperTrader({ initialCapital: config.initialCapital });
    this.liveExecutor = new LiveExecutor();

    log.info({ mode: this.mode }, 'Executor initialized');
  }

  async execute(signal: Signal, risk: RiskAssessment): Promise<TradeExecution> {
    if (this.mode === 'live') {
      throw new Error('Live trading not yet implemented. Set TRADING_MODE=paper');
    }
    return this.paperTrader.executeTrade(signal, risk);
  }

  updatePrices(prices: Map<string, number>): void {
    this.paperTrader.updatePrices(prices);
  }

  async checkStops(prices: Map<string, number>): Promise<void> {
    await this.paperTrader.checkStops(prices);
  }

  getPortfolio(): Portfolio {
    return this.paperTrader.getPortfolio();
  }

  getOrderHistory(): Order[] {
    return this.paperTrader.getOrderHistory();
  }

  getSummary(): string {
    return this.paperTrader.getSummary();
  }
}
