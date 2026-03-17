import type { Timeframe } from '../../shared/types.js';

/** Configuration for connecting to a crypto exchange via ccxt */
export interface CryptoExchangeConfig {
  exchangeId: string;
  apiKey?: string;
  secret?: string;
  sandbox?: boolean;
  rateLimit?: number;
  options?: Record<string, unknown>;
}

/** Cached data entry with expiration metadata */
export interface DataCache {
  key: string;
  data: unknown;
  cachedAt: number;
  ttlMs: number;
  filePath: string;
}

/** Request parameters for fetching market data */
export interface MarketDataRequest {
  symbol: string;
  timeframe: Timeframe;
  limit?: number;
  since?: number;
  assetClass: 'crypto' | 'forex';
}
