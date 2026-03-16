import type { Order, Signal, AssetInfo, Side, OrderType, OrderStatus } from '../../shared/types.js';
import { generateId } from '../../shared/utils.js';

/**
 * Create an order from a signal.
 */
export function createOrderFromSignal(
  signal: Signal,
  quantity: number,
  orderType: OrderType = 'market',
  limitPrice?: number
): Order {
  return {
    id: generateId(),
    asset: signal.asset,
    side: signal.action === 'BUY' ? 'buy' : 'sell',
    type: orderType,
    quantity,
    price: limitPrice ?? signal.price,
    status: 'pending',
    createdAt: Date.now(),
    strategy: signal.strategy,
  };
}

/**
 * Create a manual order.
 */
export function createOrder(
  asset: AssetInfo,
  side: Side,
  quantity: number,
  type: OrderType = 'market',
  price?: number,
  strategy: string = 'manual'
): Order {
  return {
    id: generateId(),
    asset,
    side,
    type,
    quantity,
    price,
    status: 'pending',
    createdAt: Date.now(),
    strategy,
  };
}

/**
 * Fill an order (simulate or actual).
 */
export function fillOrder(
  order: Order,
  filledPrice: number,
  filledQuantity?: number
): Order {
  return {
    ...order,
    status: 'filled' as OrderStatus,
    filledPrice,
    filledQuantity: filledQuantity ?? order.quantity,
    filledAt: Date.now(),
  };
}
