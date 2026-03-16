import type {
  AssetInfo,
  Signal,
  SignalAction,
  Timeframe,
} from '../../shared/types.js';

/**
 * Creates a properly typed Signal object.
 */
export function generateSignal(
  asset: AssetInfo,
  action: SignalAction,
  confidence: number,
  price: number,
  strategy: string,
  timeframe: Timeframe,
  indicators: Record<string, number>,
  reason: string,
): Signal {
  return {
    asset,
    action,
    confidence: Math.max(0, Math.min(1, confidence)),
    price,
    timestamp: Date.now(),
    strategy,
    timeframe,
    indicators,
    reason,
  };
}
