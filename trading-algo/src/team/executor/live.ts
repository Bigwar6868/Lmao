import type { Signal, RiskAssessment, Order, AssetInfo } from '../../shared/types.js';
import { createModuleLogger } from '../../shared/logger.js';

const log = createModuleLogger('live-executor');

/**
 * Live trade executor — scaffolding for real exchange execution.
 * Currently throws errors to prevent accidental live trading.
 * To enable: implement exchange-specific order placement via CCXT.
 */
export class LiveExecutor {
  constructor() {
    log.warn('Live executor initialized — NOT READY FOR PRODUCTION');
  }

  async executeOrder(signal: Signal, risk: RiskAssessment): Promise<Order> {
    throw new Error(
      'Live trading is not yet implemented. Use paper trading mode. ' +
      'To implement: integrate CCXT exchange.createOrder() for crypto ' +
      'or forex broker API for forex.'
    );
  }

  async cancelOrder(orderId: string, asset: AssetInfo): Promise<void> {
    throw new Error('Live trading not implemented');
  }

  async getOpenOrders(asset: AssetInfo): Promise<Order[]> {
    throw new Error('Live trading not implemented');
  }
}
