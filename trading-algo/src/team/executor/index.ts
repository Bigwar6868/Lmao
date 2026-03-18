import type { Signal, RiskAssessment, Portfolio, Order } from '../../shared/types.js';
import type { TradeExecution } from './types.js';
import { PaperTrader } from './paper.js';
import { LiveExecutor } from './live.js';
import { OandaExecutor } from './oanda.js';
import { config } from '../../config/index.js';
import { createModuleLogger } from '../../shared/logger.js';

const log = createModuleLogger('executor');

/**
 * Trade Executor — routes orders to paper or live trading engine.
 */
export class Executor {
  private paperTrader: PaperTrader;
  private liveExecutor: LiveExecutor;
  private oandaExecutor: OandaExecutor | null;
  private mode: 'paper' | 'live';

  constructor() {
    this.mode = config.tradingMode;
    this.paperTrader   = new PaperTrader({ initialCapital: config.initialCapital });
    this.liveExecutor  = new LiveExecutor();
    // Use OANDA for live forex execution when credentials are configured
    this.oandaExecutor = config.oandaApiToken ? new OandaExecutor() : null;

    log.info({ mode: this.mode, oandaEnabled: !!this.oandaExecutor }, 'Executor initialized');
  }

  async execute(signal: Signal, risk: RiskAssessment): Promise<TradeExecution> {
    if (this.mode === 'live') {
      // Route forex signals through OANDA when configured
      if (this.oandaExecutor && signal.asset.assetClass === 'forex') {
        const order     = await this.oandaExecutor.executeOrder(signal, risk);
        const portfolio = await this.oandaExecutor.getPortfolio();
        return { order, portfolio, success: true };
      }
      throw new Error(
        'Live trading requires OANDA credentials for forex (set OANDA_API_TOKEN + OANDA_ACCOUNT_ID). ' +
        'Use TRADING_MODE=paper for simulation.',
      );
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
