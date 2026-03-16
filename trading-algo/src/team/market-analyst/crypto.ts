import ccxt, { type Exchange } from 'ccxt';
import type { Candle, Timeframe } from '../../shared/types.js';
import type { CryptoExchangeConfig } from './types.js';
import { createModuleLogger } from '../../shared/logger.js';
import { config } from '../../config/index.js';

const log = createModuleLogger('CryptoDataFetcher');

/** Default delay between requests to respect exchange rate limits (ms) */
const REQUEST_DELAY_MS = 1200;

/**
 * Fetches OHLCV market data from Binance (or other ccxt-supported exchanges).
 * Uses public endpoints only — no authentication required for market data.
 */
export class CryptoDataFetcher {
  private exchange: Exchange;
  private lastRequestTime = 0;

  constructor(exchangeConfig?: CryptoExchangeConfig) {
    const exchangeId = exchangeConfig?.exchangeId ?? 'binance';
    const ExchangeClass = (ccxt as Record<string, unknown>)[exchangeId] as new (
      opts: Record<string, unknown>,
    ) => Exchange;

    this.exchange = new ExchangeClass({
      apiKey: (exchangeConfig?.apiKey ?? config.binanceApiKey) || undefined,
      secret: (exchangeConfig?.secret ?? config.binanceSecret) || undefined,
      enableRateLimit: true,
      ...(exchangeConfig?.options ?? {}),
    });

    log.info({ exchangeId }, 'CryptoDataFetcher initialised');
  }

  /**
   * Enforce a minimum delay between requests to avoid rate-limit bans.
   */
  private async throttle(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestTime;
    if (elapsed < REQUEST_DELAY_MS) {
      const wait = REQUEST_DELAY_MS - elapsed;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    this.lastRequestTime = Date.now();
  }

  /**
   * Convert a raw ccxt OHLCV row into a typed Candle.
   */
  private toCandle(row: number[]): Candle {
    return {
      timestamp: row[0]!,
      open: row[1]!,
      high: row[2]!,
      low: row[3]!,
      close: row[4]!,
      volume: row[5]!,
    };
  }

  /**
   * Fetch OHLCV candles for a single symbol.
   *
   * @param symbol  - Trading pair in ccxt format, e.g. "BTC/USDT"
   * @param timeframe - One of the system Timeframe literals
   * @param limit   - Number of candles to retrieve (default 200)
   */
  async fetchOHLCV(
    symbol: string,
    timeframe: Timeframe,
    limit = 200,
  ): Promise<Candle[]> {
    await this.throttle();

    log.info({ symbol, timeframe, limit }, 'Fetching OHLCV');

    const ohlcv = await this.exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
    const candles = ohlcv.map((row) => this.toCandle(row as number[]));

    log.info({ symbol, count: candles.length }, 'OHLCV fetched');
    return candles;
  }

  /**
   * Fetch OHLCV candles for multiple symbols sequentially,
   * throttling between each request.
   */
  async fetchMultiple(
    symbols: string[],
    timeframe: Timeframe,
  ): Promise<Map<string, Candle[]>> {
    const results = new Map<string, Candle[]>();

    for (const symbol of symbols) {
      try {
        const candles = await this.fetchOHLCV(symbol, timeframe);
        results.set(symbol, candles);
      } catch (err) {
        log.error({ symbol, err }, 'Failed to fetch OHLCV');
        results.set(symbol, []);
      }
    }

    return results;
  }
}
