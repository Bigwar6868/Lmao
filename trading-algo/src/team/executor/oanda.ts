import axios, { type AxiosInstance } from 'axios';
import { randomUUID } from 'node:crypto';
import type { Signal, RiskAssessment, Order, Position, Portfolio, AssetInfo } from '../../shared/types.js';
import { config } from '../../config/index.js';
import { createModuleLogger } from '../../shared/logger.js';

const log = createModuleLogger('OandaExecutor');

const PRACTICE_URL = 'https://api-fxpractice.oanda.com';
const LIVE_URL     = 'https://api-fxtrade.oanda.com';

/** Retry backoff for HTTP 429 responses (seconds). */
const RETRY_BACKOFF_MS = [1_000, 2_000, 4_000];

/** JPY pairs need 3 decimal places; most forex pairs need 5. */
const JPY_PAIRS = new Set([
  'USD_JPY', 'EUR_JPY', 'GBP_JPY', 'AUD_JPY', 'NZD_JPY',
  'CAD_JPY', 'CHF_JPY', 'SGD_JPY', 'HKD_JPY', 'TRY_JPY',
]);

function pricePrecision(instrument: string): number {
  if (JPY_PAIRS.has(instrument)) return 3;
  if (instrument.startsWith('XAU') || instrument.startsWith('XAG')) return 2;
  if (instrument.startsWith('XPT') || instrument.startsWith('XPD')) return 1;
  return 5;
}

function formatPrice(price: number, instrument: string): string {
  return price.toFixed(pricePrecision(instrument));
}

interface OandaTrade {
  id: string;
  instrument: string;
  currentUnits: string;
  price: string;
  unrealizedPL?: string;
  realizedPL?: string;
  openTime?: string;
  stopLossOrder?: { price: string };
  takeProfitOrder?: { price: string };
}

interface OandaPosition {
  instrument: string;
  long?: { units: string; unrealizedPL?: string };
  short?: { units: string; unrealizedPL?: string };
  marginUsed?: string;
}

/**
 * Executes live trades via the OANDA v20 REST API.
 *
 * Follows OANDA best practices:
 * - Persistent Keep-Alive connection via axios
 * - Retry on HTTP 429 with exponential back-off
 * - stopLossOnFill / takeProfitOnFill include timeInForce: "GTC"
 * - Safety net: verifies SL/TP exist on the trade after fill
 * - Positive units = BUY, negative units = SELL
 */
export class OandaExecutor {
  private readonly client: AxiosInstance;
  private readonly accountId: string;

  constructor(apiToken?: string, accountId?: string, isLive?: boolean) {
    const token  = apiToken   ?? config.oandaApiToken;
    const acctId = accountId  ?? config.oandaAccountId;
    const live   = isLive     ?? config.oandaIsLive;

    this.accountId = acctId;

    this.client = axios.create({
      baseURL: live ? LIVE_URL : PRACTICE_URL,
      timeout: 15_000,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept-Datetime-Format': 'UNIX',
      },
    });

    log.info({ live }, 'OandaExecutor initialised');
  }

  // ----------------------------------------------------------------
  // Internal helpers
  // ----------------------------------------------------------------

  private toInstrument(symbol: string): string {
    return symbol.replace('/', '_');
  }

  /** Retry on HTTP 429 with exponential back-off. */
  private async requestWithRetry<T>(
    method: 'get' | 'post' | 'put',
    url: string,
    payload?: unknown,
  ): Promise<T> {
    for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
      try {
        const resp = await (method === 'get'
          ? this.client.get<T>(url)
          : method === 'post'
          ? this.client.post<T>(url, payload)
          : this.client.put<T>(url, payload));
        return resp.data;
      } catch (err: unknown) {
        const status = (err as { response?: { status?: number } }).response?.status;
        if (status === 429 && attempt < RETRY_BACKOFF_MS.length) {
          const wait = RETRY_BACKOFF_MS[attempt]!;
          log.warn({ attempt, waitMs: wait }, 'OANDA rate limited (429) — retrying');
          await new Promise<void>((resolve) => setTimeout(resolve, wait));
        } else {
          throw err;
        }
      }
    }
    throw new Error('OANDA: max retries exceeded');
  }

  // ----------------------------------------------------------------
  // Order execution
  // ----------------------------------------------------------------

  /**
   * Place a market order on OANDA.
   * Positive units = BUY, negative units = SELL.
   */
  async executeOrder(signal: Signal, risk: RiskAssessment): Promise<Order> {
    const instrument = this.toInstrument(signal.asset.symbol);

    // Convert position size to OANDA integer units (1 lot = 100,000 units)
    const lotSize = signal.price > 0 ? risk.recommendedSize / signal.price : 0;
    let units = Math.round(lotSize * 100_000);
    if (signal.action === 'SELL') units = -units;

    const orderBody: Record<string, unknown> = {
      order: {
        type:         'MARKET',
        instrument,
        units:        String(units),
        timeInForce:  'FOK',
        positionFill: 'DEFAULT',
        clientExtensions: {
          comment: `algo:${signal.strategy}`,
          tag:     signal.strategy,
        },
        ...(risk.stopLossPrice > 0 &&
          (signal.action === 'BUY'
            ? risk.stopLossPrice < signal.price
            : risk.stopLossPrice > signal.price) && {
          stopLossOnFill: {
            price:       formatPrice(risk.stopLossPrice, instrument),
            timeInForce: 'GTC',
          },
        }),
        ...(risk.takeProfitPrice > 0 &&
          (signal.action === 'BUY'
            ? risk.takeProfitPrice > signal.price
            : risk.takeProfitPrice < signal.price) && {
          takeProfitOnFill: {
            price:       formatPrice(risk.takeProfitPrice, instrument),
            timeInForce: 'GTC',
          },
        }),
      },
    };

    try {
      const data = await this.requestWithRetry<Record<string, unknown>>(
        'post',
        `/v3/accounts/${this.accountId}/orders`,
        orderBody,
      );

      const fillTx   = (data['orderFillTransaction']  ?? {}) as Record<string, unknown>;
      const createTx = (data['orderCreateTransaction'] ?? {}) as Record<string, unknown>;
      const tradeOpened = (fillTx['tradeOpened'] ?? {}) as Record<string, unknown>;
      const tradeId  = String(tradeOpened['tradeID'] ?? '');
      const filledPrice = parseFloat(String(fillTx['price'] ?? signal.price));

      // Safety net: verify SL/TP were attached; fix if not
      if (tradeId && (risk.stopLossPrice > 0 || risk.takeProfitPrice > 0)) {
        await this.ensureSlTp(
          tradeId,
          instrument,
          risk.stopLossPrice  > 0 ? risk.stopLossPrice  : undefined,
          risk.takeProfitPrice > 0 ? risk.takeProfitPrice : undefined,
          signal.action,
          filledPrice,
        );
      }

      const order: Order = {
        id:             randomUUID().slice(0, 8),
        asset:          signal.asset,
        side:           signal.action === 'BUY' ? 'buy' : 'sell',
        type:           'market',
        quantity:       Math.abs(units) / 100_000,
        price:          signal.price,
        status:         'filled',
        filledPrice,
        filledQuantity: Math.abs(units) / 100_000,
        createdAt:      Date.now(),
        filledAt:       Date.now(),
        strategy:       signal.strategy,
      };

      log.info(
        {
          action: signal.action,
          symbol: signal.asset.symbol,
          units:  Math.abs(units),
          price:  filledPrice,
          tradeId,
          sl: risk.stopLossPrice  > 0 ? formatPrice(risk.stopLossPrice,  instrument) : 'none',
          tp: risk.takeProfitPrice > 0 ? formatPrice(risk.takeProfitPrice, instrument) : 'none',
        },
        'OANDA order filled',
      );

      return order;
    } catch (err: unknown) {
      const body = (err as { response?: { data?: { errorMessage?: string } } }).response?.data?.errorMessage
        ?? (err as Error).message;
      throw new Error(`OANDA order failed: ${body}`);
    }
  }

  /**
   * Safety net: verify SL/TP are present on a trade; attach them if missing.
   * OANDA can silently reject stopLossOnFill/takeProfitOnFill due to price
   * precision mismatches, so this runs after every fill.
   */
  private async ensureSlTp(
    tradeId: string,
    instrument: string,
    stopLoss?: number,
    takeProfit?: number,
    side: 'BUY' | 'SELL' = 'BUY',
    entryPrice = 0,
  ): Promise<void> {
    try {
      const data = await this.requestWithRetry<{ trade: Record<string, unknown> }>(
        'get',
        `/v3/accounts/${this.accountId}/trades/${tradeId}`,
      );
      const trade = data.trade;

      const body: Record<string, unknown> = {};

      const validSl = stopLoss !== undefined && stopLoss > 0 &&
        (entryPrice === 0 || (side === 'BUY' ? stopLoss < entryPrice : stopLoss > entryPrice));
      const validTp = takeProfit !== undefined && takeProfit > 0 &&
        (entryPrice === 0 || (side === 'BUY' ? takeProfit > entryPrice : takeProfit < entryPrice));

      if (validSl && !trade['stopLossOrder']) {
        body['stopLoss'] = { price: formatPrice(stopLoss!, instrument), timeInForce: 'GTC' };
        log.warn({ tradeId, sl: formatPrice(stopLoss!, instrument) }, 'SL missing — attaching');
      }
      if (validTp && !trade['takeProfitOrder']) {
        body['takeProfit'] = { price: formatPrice(takeProfit!, instrument), timeInForce: 'GTC' };
        log.warn({ tradeId, tp: formatPrice(takeProfit!, instrument) }, 'TP missing — attaching');
      }

      if (Object.keys(body).length > 0) {
        await this.requestWithRetry(
          'put',
          `/v3/accounts/${this.accountId}/trades/${tradeId}/orders`,
          body,
        );
        log.info({ tradeId }, 'SL/TP attached to trade');
      } else {
        log.debug({ tradeId }, 'SL/TP confirmed on trade');
      }
    } catch (err) {
      log.error({ tradeId, error: (err as Error).message }, 'Failed to verify/attach SL/TP');
    }
  }

  // ----------------------------------------------------------------
  // Order / trade management
  // ----------------------------------------------------------------

  async cancelOrder(orderId: string): Promise<boolean> {
    try {
      await this.requestWithRetry(
        'put',
        `/v3/accounts/${this.accountId}/orders/${orderId}/cancel`,
      );
      log.info({ orderId }, 'OANDA order cancelled');
      return true;
    } catch (err) {
      log.error({ orderId, error: (err as Error).message }, 'OANDA cancel failed');
      return false;
    }
  }

  /** Close a trade fully or partially. units = "ALL" or integer string. */
  async closeTrade(tradeId: string, units = 'ALL'): Promise<boolean> {
    try {
      await this.requestWithRetry(
        'put',
        `/v3/accounts/${this.accountId}/trades/${tradeId}/close`,
        { units },
      );
      log.info({ tradeId, units }, 'OANDA trade closed');
      return true;
    } catch (err) {
      log.error({ tradeId, error: (err as Error).message }, 'OANDA close trade failed');
      return false;
    }
  }

  /** Close all long or short positions for an instrument. */
  async closePosition(symbol: string, side: 'long' | 'short'): Promise<boolean> {
    const instrument = this.toInstrument(symbol);
    const body = side === 'long'
      ? { longUnits: 'ALL' }
      : { shortUnits: 'ALL' };

    try {
      await this.requestWithRetry(
        'put',
        `/v3/accounts/${this.accountId}/positions/${instrument}/close`,
        body,
      );
      log.info({ symbol, side }, 'OANDA position closed');
      return true;
    } catch (err) {
      log.error({ symbol, error: (err as Error).message }, 'OANDA close position failed');
      return false;
    }
  }

  /** Modify stop loss and/or take profit on an open trade. */
  async modifyTradeSlTp(
    tradeId: string,
    instrument: string,
    stopLoss?: number,
    takeProfit?: number,
  ): Promise<boolean> {
    const inst = this.toInstrument(instrument);
    const body: Record<string, unknown> = {};
    if (stopLoss  !== undefined) body['stopLoss']   = { price: formatPrice(stopLoss,  inst) };
    if (takeProfit !== undefined) body['takeProfit'] = { price: formatPrice(takeProfit, inst) };
    if (!Object.keys(body).length) return true;

    try {
      await this.requestWithRetry(
        'put',
        `/v3/accounts/${this.accountId}/trades/${tradeId}/orders`,
        body,
      );
      log.info({ tradeId }, 'OANDA trade SL/TP updated');
      return true;
    } catch (err) {
      log.error({ tradeId, error: (err as Error).message }, 'OANDA modify trade failed');
      return false;
    }
  }

  // ----------------------------------------------------------------
  // Account & portfolio queries
  // ----------------------------------------------------------------

  async getOpenTrades(): Promise<OandaTrade[]> {
    try {
      const data = await this.requestWithRetry<{ trades: OandaTrade[] }>(
        'get',
        `/v3/accounts/${this.accountId}/openTrades`,
      );
      return data.trades ?? [];
    } catch (err) {
      log.error({ error: (err as Error).message }, 'OANDA get trades failed');
      return [];
    }
  }

  async getOpenPositions(): Promise<OandaPosition[]> {
    try {
      const data = await this.requestWithRetry<{ positions: OandaPosition[] }>(
        'get',
        `/v3/accounts/${this.accountId}/openPositions`,
      );
      return data.positions ?? [];
    } catch (err) {
      log.error({ error: (err as Error).message }, 'OANDA get positions failed');
      return [];
    }
  }

  async getAccountBalance(): Promise<Record<string, number | string> | null> {
    try {
      const data = await this.requestWithRetry<{ account: Record<string, unknown> }>(
        'get',
        `/v3/accounts/${this.accountId}/summary`,
      );
      const acct = data.account;
      return {
        balance:         parseFloat(String(acct['balance']         ?? 0)),
        unrealizedPl:    parseFloat(String(acct['unrealizedPL']    ?? 0)),
        realizedPl:      parseFloat(String(acct['realizedPL']      ?? 0)),
        nav:             parseFloat(String(acct['NAV']             ?? 0)),
        marginUsed:      parseFloat(String(acct['marginUsed']      ?? 0)),
        marginAvailable: parseFloat(String(acct['marginAvailable'] ?? 0)),
        openTradeCount:  parseInt  (String(acct['openTradeCount']  ?? 0), 10),
        currency:        String    (acct['currency']               ?? 'USD'),
      };
    } catch (err) {
      log.error({ error: (err as Error).message }, 'OANDA account balance failed');
      return null;
    }
  }

  /** Build a Portfolio from live OANDA account data. */
  async getPortfolio(): Promise<Portfolio> {
    const acct = await this.getAccountBalance();
    if (!acct) {
      return { capital: 0, availableCapital: 0, positions: [], totalPnl: 0, totalPnlPct: 0, maxDrawdown: 0, lastUpdated: Date.now() };
    }

    const trades = await this.getOpenTrades();
    const positions: Position[] = trades.map((t) => {
      const units    = parseInt(t.currentUnits, 10);
      const asset: AssetInfo = {
        symbol:     t.instrument.replace('_', '/'),
        assetClass: 'forex',
      };
      return {
        id:            t.id,
        asset,
        side:          units > 0 ? 'buy' : 'sell',
        entryPrice:    parseFloat(t.price),
        currentPrice:  parseFloat(t.price),
        quantity:      Math.abs(units) / 100_000,
        stopLoss:      t.stopLossOrder   ? parseFloat(t.stopLossOrder.price)   : undefined,
        takeProfit:    t.takeProfitOrder ? parseFloat(t.takeProfitOrder.price) : undefined,
        unrealizedPnl: parseFloat(t.unrealizedPL ?? '0'),
        realizedPnl:   parseFloat(t.realizedPL   ?? '0'),
        status:        'open',
        openedAt:      t.openTime ? new Date(t.openTime).getTime() : Date.now(),
        strategy:      '-',
      };
    });

    const nav         = Number(acct['nav']         ?? acct['balance'] ?? 0);
    const balance     = Number(acct['balance']     ?? 0);
    const unrealized  = Number(acct['unrealizedPl'] ?? 0);
    const realized    = Number(acct['realizedPl']   ?? 0);

    return {
      capital:          nav,
      availableCapital: Number(acct['marginAvailable'] ?? 0),
      positions,
      totalPnl:         unrealized + realized,
      totalPnlPct:      balance > 0 ? ((nav - balance + realized) / balance) * 100 : 0,
      maxDrawdown:      0,
      lastUpdated:      Date.now(),
    };
  }

  getSummary(acct: Record<string, number | string>): string {
    const nav      = Number(acct['nav']          ?? acct['balance'] ?? 0);
    const unreal   = Number(acct['unrealizedPl'] ?? 0);
    const real     = Number(acct['realizedPl']   ?? 0);
    const cur      = String(acct['currency']     ?? 'USD');
    const open     = Number(acct['openTradeCount'] ?? 0);
    const margin   = Number(acct['marginUsed']   ?? 0);

    return (
      `OANDA: ${cur} ${nav.toFixed(2)} NAV | ` +
      `Unrealised: ${cur} ${unreal.toFixed(2)} | ` +
      `Realised: ${cur} ${real.toFixed(2)} | ` +
      `Open: ${open} | ` +
      `Margin: ${cur} ${margin.toFixed(2)}`
    );
  }
}
