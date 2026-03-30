/**
 * OANDA v20 REST API client for TypeScript.
 *
 * Handles order execution, candle fetching, and pricing.
 * Follows OANDA best practices:
 * - Persistent HTTP via axios
 * - Rate limit handling with retry on 429
 * - timeInForce on stopLossOnFill / takeProfitOnFill
 * - Positive units = buy, negative units = sell
 */

import axios, { type AxiosInstance } from 'axios';
import { config } from '../../config/index.js';
import { createModuleLogger } from '../../shared/logger.js';

const log = createModuleLogger('oanda');

const PRACTICE_URL = 'https://api-fxpractice.oanda.com';
const LIVE_URL = 'https://api-fxtrade.oanda.com';

/** JPY pairs use 3 decimal precision, metals 2, default forex 5 */
const JPY_PAIRS = new Set([
  'USD_JPY', 'EUR_JPY', 'GBP_JPY', 'AUD_JPY', 'NZD_JPY',
  'CAD_JPY', 'CHF_JPY', 'SGD_JPY', 'HKD_JPY', 'TRY_JPY',
]);

/** Minimum SL/TP distance in pips per instrument type to avoid OANDA rejection */
const MIN_SL_DISTANCE_PIPS: Record<string, number> = {
  forex: 10,        // 10 pips for standard forex
  forex_jpy: 10,    // 10 pips for JPY pairs (= 0.100)
  metal_xau: 50,    // 50 pips for gold (= 0.50)
  metal_xag: 10,    // 10 pips for silver (= 0.100)
  metal_xpt: 100,   // 100 pips for platinum
  metal_xpd: 200,   // 200 pips for palladium
};

function pricePrecision(instrument: string): number {
  if (JPY_PAIRS.has(instrument)) return 3;
  if (instrument.startsWith('XAU') || instrument.startsWith('XAG')) return 2;
  if (instrument.startsWith('XPT') || instrument.startsWith('XPD')) return 1;
  return 5;
}

function formatPrice(price: number, instrument: string): string {
  return price.toFixed(pricePrecision(instrument));
}

function toInstrument(symbol: string): string {
  return symbol.replace('/', '_');
}

function fromInstrument(instrument: string): string {
  return instrument.replace('_', '/');
}

/** Get minimum SL distance in price units for an instrument */
function getMinSlDistance(instrument: string): number {
  if (JPY_PAIRS.has(instrument)) {
    return MIN_SL_DISTANCE_PIPS.forex_jpy * 0.01;  // 10 pips = 0.100
  }
  if (instrument.startsWith('XAU')) return MIN_SL_DISTANCE_PIPS.metal_xau * 0.01;
  if (instrument.startsWith('XAG')) return MIN_SL_DISTANCE_PIPS.metal_xag * 0.01;
  if (instrument.startsWith('XPT')) return MIN_SL_DISTANCE_PIPS.metal_xpt * 0.1;
  if (instrument.startsWith('XPD')) return MIN_SL_DISTANCE_PIPS.metal_xpd * 0.1;
  // Standard forex: 10 pips = 0.00100
  return MIN_SL_DISTANCE_PIPS.forex * 0.0001;
}

export interface OandaOrderResult {
  orderId: string;
  tradeId: string;
  fillPrice: number;
  units: number;
  commission: number;
}

export interface OandaPricing {
  bid: number;
  ask: number;
  spread: number;
  tradeable: boolean;
  time: number;
}

const TIMEFRAME_MAP: Record<string, string> = {
  '1m': 'M1', '5m': 'M5', '15m': 'M15', '30m': 'M30',
  '1h': 'H1', '2h': 'H2', '4h': 'H4', '1d': 'D', '1w': 'W',
};

export class OandaClient {
  private client: AxiosInstance;
  private baseUrl: string;
  private accountId: string;

  constructor() {
    const isLive = config.oandaIsLive;
    this.baseUrl = isLive ? LIVE_URL : PRACTICE_URL;
    this.accountId = config.oandaAccountId;

    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: config.networkTimeoutMs,
      headers: {
        'Authorization': `Bearer ${config.oandaApiToken}`,
        'Content-Type': 'application/json',
        'Accept-Datetime-Format': 'UNIX',
      },
    });

    log.info({ live: isLive, accountId: this.accountId ? '***' : 'none' }, 'OANDA client initialized');
  }

  get isConfigured(): boolean {
    return !!(config.oandaApiToken && config.oandaAccountId);
  }

  // ------------------------------------------------------------------
  // Pricing (for spread-based sizing)
  // ------------------------------------------------------------------

  async getPrices(symbols: string[]): Promise<Map<string, OandaPricing>> {
    const instruments = symbols.map(toInstrument).join(',');
    const result = new Map<string, OandaPricing>();

    try {
      const resp = await this.client.get(
        `/v3/accounts/${this.accountId}/pricing`,
        { params: { instruments } },
      );

      for (const p of resp.data.prices ?? []) {
        const sym = fromInstrument(p.instrument);
        const bid = parseFloat(p.bids?.[0]?.price ?? '0');
        const ask = parseFloat(p.asks?.[0]?.price ?? '0');
        result.set(sym, {
          bid,
          ask,
          spread: ask - bid,
          tradeable: p.tradeable ?? false,
          time: Math.round(parseFloat(p.time ?? '0') * 1000),
        });
      }
    } catch (err) {
      log.error({ err }, 'OANDA pricing failed');
    }

    return result;
  }

  // ------------------------------------------------------------------
  // Order Execution
  // ------------------------------------------------------------------

  async placeMarketOrder(
    symbol: string,
    side: 'buy' | 'sell',
    dollarSize: number,
    price: number,
    stopLoss?: number,
    takeProfit?: number,
  ): Promise<OandaOrderResult> {
    const instrument = toInstrument(symbol);

    // Convert dollar size to OANDA units (forex = base currency units)
    let units = Math.round((dollarSize / price) * 100_000);
    if (side === 'sell') units = -units;

    const orderBody: Record<string, unknown> = {
      order: {
        type: 'MARKET',
        instrument,
        units: String(units),
        timeInForce: 'FOK',
        positionFill: 'DEFAULT',
      },
    };

    // Add SL/TP with minimum distance validation
    const minDist = getMinSlDistance(instrument);
    const order = orderBody.order as Record<string, unknown>;

    if (stopLoss && stopLoss > 0) {
      const slDistance = Math.abs(price - stopLoss);
      const validSl = slDistance >= minDist
        ? stopLoss
        : (side === 'buy' ? price - minDist : price + minDist);

      order.stopLossOnFill = {
        price: formatPrice(validSl, instrument),
        timeInForce: 'GTC',
      };
    }

    if (takeProfit && takeProfit > 0) {
      const tpDistance = Math.abs(takeProfit - price);
      const validTp = tpDistance >= minDist
        ? takeProfit
        : (side === 'buy' ? price + minDist : price - minDist);

      order.takeProfitOnFill = {
        price: formatPrice(validTp, instrument),
        timeInForce: 'GTC',
      };
    }

    order.clientExtensions = {
      comment: 'algo:live',
    };

    const resp = await this.requestWithRetry('post',
      `/v3/accounts/${this.accountId}/orders`,
      orderBody,
    );

    const data = resp.data;
    const fillTx = data.orderFillTransaction ?? {};
    const tradeOpened = fillTx.tradeOpened ?? {};

    const fillPrice = parseFloat(fillTx.price ?? String(price));
    const tradeId = tradeOpened.tradeID ?? '';

    // Verify SL/TP attached — if missing, attach as safety net
    if (tradeId && (stopLoss || takeProfit)) {
      await this.ensureSlTp(tradeId, instrument, stopLoss, takeProfit, price, side);
    }

    log.info(
      { symbol, side, units: Math.abs(units), price: fillPrice, tradeId },
      'OANDA order filled',
    );

    return {
      orderId: String(fillTx.orderID ?? data.orderCreateTransaction?.id ?? ''),
      tradeId,
      fillPrice,
      units: Math.abs(units),
      commission: parseFloat(fillTx.commission ?? '0'),
    };
  }

  private async ensureSlTp(
    tradeId: string,
    instrument: string,
    stopLoss: number | undefined,
    takeProfit: number | undefined,
    price: number,
    side: 'buy' | 'sell',
  ): Promise<void> {
    try {
      const resp = await this.client.get(
        `/v3/accounts/${this.accountId}/trades/${tradeId}`,
      );
      const trade = resp.data.trade ?? {};
      const body: Record<string, unknown> = {};
      const minDist = getMinSlDistance(instrument);

      if (stopLoss && !trade.stopLossOrder) {
        const slDistance = Math.abs(price - stopLoss);
        const validSl = slDistance >= minDist
          ? stopLoss
          : (side === 'buy' ? price - minDist : price + minDist);
        body.stopLoss = { price: formatPrice(validSl, instrument), timeInForce: 'GTC' };
        log.warn({ tradeId }, 'SL missing — attaching');
      }
      if (takeProfit && !trade.takeProfitOrder) {
        const tpDistance = Math.abs(takeProfit - price);
        const validTp = tpDistance >= minDist
          ? takeProfit
          : (side === 'buy' ? price + minDist : price - minDist);
        body.takeProfit = { price: formatPrice(validTp, instrument), timeInForce: 'GTC' };
        log.warn({ tradeId }, 'TP missing — attaching');
      }

      if (Object.keys(body).length > 0) {
        await this.client.put(
          `/v3/accounts/${this.accountId}/trades/${tradeId}/orders`,
          body,
        );
        log.info({ tradeId }, 'SL/TP attached');
      }
    } catch (err) {
      log.error({ err, tradeId }, 'Failed to verify/attach SL/TP');
    }
  }

  // ------------------------------------------------------------------
  // Candle Data
  // ------------------------------------------------------------------

  async fetchCandles(
    symbol: string,
    timeframe: string = '1h',
    count: number = 300,
  ): Promise<Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }>> {
    const instrument = toInstrument(symbol);
    const granularity = TIMEFRAME_MAP[timeframe] ?? 'H1';

    try {
      const resp = await this.client.get(
        `/v3/instruments/${instrument}/candles`,
        {
          params: {
            granularity,
            count: Math.min(count, 5000),
            price: 'M',
            dailyAlignment: 17,
            alignmentTimezone: 'America/New_York',
          },
        },
      );

      const candles = [];
      for (const bar of resp.data.candles ?? []) {
        if (!bar.complete) continue;
        const mid = bar.mid ?? {};
        candles.push({
          timestamp: Math.round(parseFloat(bar.time ?? '0') * 1000),
          open: parseFloat(mid.o ?? '0'),
          high: parseFloat(mid.h ?? '0'),
          low: parseFloat(mid.l ?? '0'),
          close: parseFloat(mid.c ?? '0'),
          volume: parseInt(bar.volume ?? '0', 10),
        });
      }
      return candles;
    } catch (err) {
      log.error({ err, symbol }, 'OANDA candle fetch failed');
      return [];
    }
  }

  // ------------------------------------------------------------------
  // Account
  // ------------------------------------------------------------------

  async getAccountSummary(): Promise<{
    balance: number; nav: number; unrealizedPl: number;
    marginUsed: number; marginAvailable: number; openTradeCount: number; currency: string;
  } | null> {
    try {
      const resp = await this.client.get(
        `/v3/accounts/${this.accountId}/summary`,
      );
      const acct = resp.data.account ?? {};
      return {
        balance: parseFloat(acct.balance ?? '0'),
        nav: parseFloat(acct.NAV ?? '0'),
        unrealizedPl: parseFloat(acct.unrealizedPL ?? '0'),
        marginUsed: parseFloat(acct.marginUsed ?? '0'),
        marginAvailable: parseFloat(acct.marginAvailable ?? '0'),
        openTradeCount: parseInt(acct.openTradeCount ?? '0', 10),
        currency: acct.currency ?? 'USD',
      };
    } catch (err) {
      log.error({ err }, 'OANDA account summary failed');
      return null;
    }
  }

  async getOpenTrades(): Promise<Array<{
    tradeId: string; instrument: string; units: number; side: 'buy' | 'sell';
    entryPrice: number; unrealizedPl: number; stopLoss?: number; takeProfit?: number;
  }>> {
    try {
      const resp = await this.client.get(
        `/v3/accounts/${this.accountId}/openTrades`,
      );
      return (resp.data.trades ?? []).map((t: any) => {
        const units = parseInt(t.currentUnits, 10);
        return {
          tradeId: t.id,
          instrument: fromInstrument(t.instrument),
          units: Math.abs(units),
          side: units > 0 ? 'buy' as const : 'sell' as const,
          entryPrice: parseFloat(t.price),
          unrealizedPl: parseFloat(t.unrealizedPL ?? '0'),
          stopLoss: t.stopLossOrder ? parseFloat(t.stopLossOrder.price) : undefined,
          takeProfit: t.takeProfitOrder ? parseFloat(t.takeProfitOrder.price) : undefined,
        };
      });
    } catch (err) {
      log.error({ err }, 'OANDA get trades failed');
      return [];
    }
  }

  // ------------------------------------------------------------------
  // Retry with backoff for 429
  // ------------------------------------------------------------------

  private async requestWithRetry(
    method: 'post' | 'put' | 'get',
    url: string,
    data?: unknown,
    retries = 3,
  ) {
    const backoff = [1000, 2000, 4000];
    for (let i = 0; i <= retries; i++) {
      try {
        const resp = await this.client.request({ method, url, data });
        return resp;
      } catch (err: any) {
        if (err?.response?.status === 429 && i < retries) {
          log.warn({ attempt: i + 1 }, 'OANDA rate limited (429), retrying...');
          await new Promise(r => setTimeout(r, backoff[i]));
          continue;
        }
        const errorMsg = err?.response?.data?.errorMessage ?? err.message;
        throw new Error(`OANDA request failed: ${errorMsg}`);
      }
    }
    throw new Error('OANDA request failed after retries');
  }
}
