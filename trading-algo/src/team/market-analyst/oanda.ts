import axios, { type AxiosInstance } from 'axios';
import type { AssetClass, AssetInfo, Candle } from '../../shared/types.js';
import { config } from '../../config/index.js';
import { createModuleLogger } from '../../shared/logger.js';
import { generateSyntheticCandles } from '../../shared/synthetic.js';

const log = createModuleLogger('OandaDataFetcher');

const PRACTICE_URL = 'https://api-fxpractice.oanda.com';
const LIVE_URL = 'https://api-fxtrade.oanda.com';

/**
 * Map system timeframes to OANDA candle granularity.
 * Full list: S5 S10 S15 S30 M1 M2 M4 M5 M10 M15 M30 H1 H2 H3 H4 H6 H8 D W M
 */
const TIMEFRAME_TO_GRANULARITY: Record<string, string> = {
  '1m':  'M1',
  '5m':  'M5',
  '15m': 'M15',
  '30m': 'M30',
  '1h':  'H1',
  '2h':  'H2',
  '4h':  'H4',
  '1d':  'D',
  '1w':  'W',
};

/** Map OANDA instrument type string → our AssetClass */
const OANDA_TYPE_TO_ASSET_CLASS: Record<string, AssetClass> = {
  CURRENCY: 'forex',
  METAL:    'commodity',
  CFD:      'index',
};

/** 100 req/s on persistent Keep-Alive connections (OANDA best practices) */
const RATE_LIMIT_INTERVAL_MS = 10; // 1000ms / 100

interface OandaCandle {
  time: string;
  complete?: boolean;
  volume?: number;
  mid?: { o: string; h: string; l: string; c: string };
}

interface OandaPrice {
  instrument: string;
  tradeable?: boolean;
  time?: string;
  bids?: Array<{ price: string }>;
  asks?: Array<{ price: string }>;
}

export interface OandaPriceQuote {
  bid: number;
  ask: number;
  time: number;
  tradeable: boolean;
}

export interface OandaAccountSummary {
  balance: number;
  unrealizedPl: number;
  realizedPl: number;
  marginUsed: number;
  marginAvailable: number;
  openTradeCount: number;
  currency: string;
  lastTransactionId: string | null;
}

/**
 * Fetches historical OHLCV candles and real-time pricing from the OANDA v20 REST API.
 * Supports both practice (demo) and live environments.
 *
 * Best practices per https://developer.oanda.com/rest-live-v20/best-practices/:
 * - Persistent HTTP connection via axios (Keep-Alive by default)
 * - Rate-limited to 100 req/s on persistent connections
 * - count is NOT set when both from/to timestamps are provided
 * - Uses TransactionID-based polling for account state updates
 */
export class OandaDataFetcher {
  private readonly client: AxiosInstance;
  private readonly accountId: string;
  private readonly baseUrl: string;
  private lastRequestTime = 0;
  private lastTransactionId: string | null = null;

  constructor(apiToken?: string, accountId?: string, isLive?: boolean) {
    const token   = apiToken   ?? config.oandaApiToken;
    const acctId  = accountId  ?? config.oandaAccountId;
    const live    = isLive     ?? config.oandaIsLive;

    this.accountId = acctId;
    this.baseUrl   = live ? LIVE_URL : PRACTICE_URL;

    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: config.networkTimeoutMs,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept-Datetime-Format': 'UNIX',
      },
    });

    log.info({ live }, 'OandaDataFetcher initialised');
  }

  // ----------------------------------------------------------------
  // Internal helpers
  // ----------------------------------------------------------------

  /** Throttle to stay within OANDA's 100 req/s rate limit. */
  private async throttle(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestTime;
    if (elapsed < RATE_LIMIT_INTERVAL_MS) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, RATE_LIMIT_INTERVAL_MS - elapsed),
      );
    }
    this.lastRequestTime = Date.now();
  }

  /** EUR/USD → EUR_USD */
  private toInstrument(symbol: string): string {
    return symbol.replace('/', '_');
  }

  /** EUR_USD → EUR/USD */
  private fromInstrument(instrument: string): string {
    return instrument.replace('_', '/');
  }

  // ----------------------------------------------------------------
  // Instrument discovery
  // ----------------------------------------------------------------

  /**
   * Fetch all tradeable instruments from OANDA for this account.
   * Returns an empty array in cloud mode or when no token is configured
   * so callers can fall back to the static asset list gracefully.
   */
  async getInstruments(): Promise<AssetInfo[]> {
    if (config.cloudMode || !config.oandaApiToken) return [];

    await this.throttle();
    try {
      const { data } = await this.client.get<{
        instruments: Array<{ name: string; type: string; displayName: string }>;
      }>(`/v3/accounts/${this.accountId}/instruments`);

      const assets: AssetInfo[] = [];
      for (const inst of data.instruments ?? []) {
        const assetClass: AssetClass = OANDA_TYPE_TO_ASSET_CLASS[inst.type] ?? 'forex';
        // OANDA uses underscore notation: EUR_USD → EUR/USD
        const symbol = inst.name.replace('_', '/');
        const [base, quote] = symbol.split('/');
        assets.push({ symbol, assetClass, baseCurrency: base, quoteCurrency: quote });
      }

      log.info({ count: assets.length }, 'OANDA instruments loaded');
      return assets;
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'OANDA instrument discovery failed — using static list');
      return [];
    }
  }

  // ----------------------------------------------------------------
  // Historical candles
  // ----------------------------------------------------------------

  /**
   * Fetch historical OHLCV candles from OANDA.
   *
   * @param symbol      - e.g. "EUR/USD"
   * @param timeframe   - e.g. "1h", "4h", "1d"
   * @param count       - number of bars (max 5000), ignored when both from+to are given
   * @param fromMs      - start timestamp in milliseconds
   * @param toMs        - end timestamp in milliseconds
   */
  async fetchCandles(
    symbol: string,
    timeframe = '1h',
    count = 300,
    fromMs?: number,
    toMs?: number,
  ): Promise<Candle[]> {
    if (config.cloudMode || !config.oandaApiToken) {
      log.info({ symbol }, 'Cloud/no-token — using synthetic forex data');
      return generateSyntheticCandles(symbol, count, { intervalMs: 3_600_000, volatility: 0.005 });
    }

    const instrument  = this.toInstrument(symbol);
    const granularity = TIMEFRAME_TO_GRANULARITY[timeframe] ?? 'H1';

    const params: Record<string, string | number> = {
      granularity,
      price: 'M', // midpoint
      dailyAlignment: 17,
      alignmentTimezone: 'America/New_York',
    };

    if (fromMs !== undefined && toMs !== undefined) {
      // OANDA: do NOT include count when both from and to are set
      params['from'] = (fromMs / 1000).toString();
      params['to']   = (toMs   / 1000).toString();
    } else if (fromMs !== undefined) {
      params['from']  = (fromMs / 1000).toString();
      params['count'] = Math.min(count, 5000);
    } else {
      params['count'] = Math.min(count, 5000);
    }

    await this.throttle();

    try {
      const { data } = await this.client.get<{ candles: OandaCandle[] }>(
        `/v3/instruments/${instrument}/candles`,
        { params },
      );

      const candles: Candle[] = [];
      for (const bar of data.candles ?? []) {
        if (bar.complete === false) continue; // skip incomplete bar
        const mid = bar.mid;
        if (!mid) continue;
        candles.push({
          timestamp: Math.round(parseFloat(bar.time) * 1000),
          open:   parseFloat(mid.o),
          high:   parseFloat(mid.h),
          low:    parseFloat(mid.l),
          close:  parseFloat(mid.c),
          volume: bar.volume ?? 0,
        });
      }

      candles.sort((a, b) => a.timestamp - b.timestamp);
      log.info({ symbol, timeframe, count: candles.length }, 'Fetched candles from OANDA');
      return candles;
    } catch (err) {
      log.warn({ symbol, error: (err as Error).message }, 'OANDA candles failed — synthetic fallback');
      return generateSyntheticCandles(symbol, count, { intervalMs: 3_600_000, volatility: 0.005 });
    }
  }

  // ----------------------------------------------------------------
  // Real-time pricing
  // ----------------------------------------------------------------

  /**
   * Get current bid/ask prices for one or more instruments.
   *
   * @param symbols - e.g. ["EUR/USD", "GBP/USD"]
   */
  async getPrices(symbols: string[]): Promise<Record<string, OandaPriceQuote>> {
    const instruments = symbols.map((s) => this.toInstrument(s)).join(',');

    await this.throttle();

    try {
      const { data } = await this.client.get<{ prices: OandaPrice[] }>(
        `/v3/accounts/${this.accountId}/pricing`,
        { params: { instruments } },
      );

      const result: Record<string, OandaPriceQuote> = {};
      for (const p of data.prices ?? []) {
        const sym = this.fromInstrument(p.instrument);
        result[sym] = {
          bid:       parseFloat(p.bids?.[0]?.price ?? '0'),
          ask:       parseFloat(p.asks?.[0]?.price ?? '0'),
          time:      Math.round(parseFloat(p.time ?? '0') * 1000),
          tradeable: p.tradeable ?? false,
        };
      }

      return result;
    } catch (err) {
      log.error({ error: (err as Error).message }, 'OANDA pricing failed');
      return {};
    }
  }

  // ----------------------------------------------------------------
  // Account state
  // ----------------------------------------------------------------

  /**
   * Get account summary (balance, equity, margin).
   * Captures `lastTransactionID` for subsequent `pollAccountUpdates()` calls.
   */
  async getAccountSummary(): Promise<OandaAccountSummary | null> {
    await this.throttle();

    try {
      const { data } = await this.client.get<{
        account: Record<string, unknown>;
        lastTransactionID?: string;
      }>(`/v3/accounts/${this.accountId}/summary`);

      const acct = data.account as Record<string, unknown>;
      this.lastTransactionId = (data.lastTransactionID as string | undefined) ?? null;

      return {
        balance:         parseFloat(String(acct['balance']            ?? 0)),
        unrealizedPl:    parseFloat(String(acct['unrealizedPL']       ?? 0)),
        realizedPl:      parseFloat(String(acct['realizedPL']         ?? 0)),
        marginUsed:      parseFloat(String(acct['marginUsed']         ?? 0)),
        marginAvailable: parseFloat(String(acct['marginAvailable']    ?? 0)),
        openTradeCount:  parseInt  (String(acct['openTradeCount']     ?? 0), 10),
        currency:        String    (acct['currency']                  ?? 'USD'),
        lastTransactionId: this.lastTransactionId,
      };
    } catch (err) {
      log.error({ error: (err as Error).message }, 'OANDA account summary failed');
      return null;
    }
  }

  /**
   * Poll for incremental account changes since the last known TransactionID.
   * Call `getAccountSummary()` first to seed the ID.
   */
  async pollAccountUpdates(): Promise<Record<string, unknown> | null> {
    if (!this.lastTransactionId) return null;

    await this.throttle();

    try {
      const { data } = await this.client.get<{
        changes: Record<string, unknown[]>;
        state: Record<string, unknown>;
        lastTransactionID?: string;
      }>(`/v3/accounts/${this.accountId}/changes`, {
        params: { sinceTransactionID: this.lastTransactionId },
      });

      this.lastTransactionId = data.lastTransactionID ?? this.lastTransactionId;

      return {
        changes: {
          ordersCreated:   data.changes['ordersCreated']   ?? [],
          ordersCancelled: data.changes['ordersCancelled'] ?? [],
          ordersFilled:    data.changes['ordersFilled']    ?? [],
          tradesOpened:    data.changes['tradesOpened']    ?? [],
          tradesClosed:    data.changes['tradesClosed']    ?? [],
          tradesReduced:   data.changes['tradesReduced']   ?? [],
          positions:       data.changes['positions']       ?? [],
        },
        state: {
          unrealizedPl:    parseFloat(String(data.state['unrealizedPL']   ?? 0)),
          nav:             parseFloat(String(data.state['NAV']             ?? 0)),
          marginUsed:      parseFloat(String(data.state['marginUsed']      ?? 0)),
          marginAvailable: parseFloat(String(data.state['marginAvailable'] ?? 0)),
          positionValue:   parseFloat(String(data.state['positionValue']   ?? 0)),
        },
        lastTransactionId: this.lastTransactionId,
      };
    } catch (err) {
      log.error({ error: (err as Error).message }, 'OANDA poll updates failed');
      return null;
    }
  }
}
