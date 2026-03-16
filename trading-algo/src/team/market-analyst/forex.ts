import axios from 'axios';
import type { Candle } from '../../shared/types.js';
import { config } from '../../config/index.js';
import { createModuleLogger } from '../../shared/logger.js';
import { generateSyntheticCandles } from '../../shared/synthetic.js';

const log = createModuleLogger('ForexDataFetcher');

const AV_BASE = 'https://www.alphavantage.co/query';

/** Same 5 calls/minute limit as stock endpoints */
const AV_RATE_LIMIT_MS = 13_000;

interface AlphaVantageForexSeries {
  [datetime: string]: {
    '1. open': string;
    '2. high': string;
    '3. low': string;
    '4. close': string;
  };
}

/**
 * Fetches forex price data from Alpha Vantage FX endpoints.
 */
export class ForexDataFetcher {
  private apiKey: string;
  private lastRequestTime = 0;

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? config.alphaVantageKey;
    log.info('ForexDataFetcher initialised');
  }

  private async throttle(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestTime;
    if (elapsed < AV_RATE_LIMIT_MS) {
      const wait = AV_RATE_LIMIT_MS - elapsed;
      log.debug({ waitMs: wait }, 'Throttling Alpha Vantage forex request');
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    this.lastRequestTime = Date.now();
  }

  /**
   * Parse Alpha Vantage forex time-series into Candle[].
   * Forex endpoints do not include volume, so volume is set to 0.
   */
  private parseTimeSeries(series: AlphaVantageForexSeries): Candle[] {
    const candles: Candle[] = [];

    for (const [datetime, values] of Object.entries(series)) {
      candles.push({
        timestamp: new Date(datetime).getTime(),
        open: parseFloat(values['1. open']),
        high: parseFloat(values['2. high']),
        low: parseFloat(values['3. low']),
        close: parseFloat(values['4. close']),
        volume: 0,
      });
    }

    candles.sort((a, b) => a.timestamp - b.timestamp);
    return candles;
  }

  /**
   * Fetch daily forex candle data.
   *
   * @param fromCurrency - Base currency, e.g. "EUR"
   * @param toCurrency   - Quote currency, e.g. "USD"
   */
  async fetchDaily(
    fromCurrency: string,
    toCurrency: string,
  ): Promise<Candle[]> {
    await this.throttle();
    const pair = `${fromCurrency}/${toCurrency}`;
    log.info({ pair }, 'Fetching daily forex data');

    try {
      const { data } = await axios.get(AV_BASE, {
        params: {
          function: 'FX_DAILY',
          from_symbol: fromCurrency,
          to_symbol: toCurrency,
          outputsize: 'compact',
          apikey: this.apiKey,
        },
        timeout: 10_000,
      });

      const seriesKey = 'Time Series FX (Daily)';
      const series: AlphaVantageForexSeries | undefined = data[seriesKey];

      if (!series) {
        const note: string = data['Note'] ?? data['Information'] ?? 'Unknown error';
        log.warn({ pair, note }, 'Alpha Vantage returned no forex data — using synthetic');
        return generateSyntheticCandles(pair, 100, { intervalMs: 86_400_000, volatility: 0.005 });
      }

      const candles = this.parseTimeSeries(series);
      log.info({ pair, count: candles.length }, 'Daily forex data fetched');
      return candles;
    } catch (err) {
      log.warn({ pair, error: (err as Error).message }, 'Forex API failed — using synthetic data');
      return generateSyntheticCandles(pair, 100, { intervalMs: 86_400_000, volatility: 0.005 });
    }
  }

  /**
   * Fetch intraday forex candle data.
   *
   * @param fromCurrency - Base currency, e.g. "EUR"
   * @param toCurrency   - Quote currency, e.g. "USD"
   * @param interval     - Candle interval, e.g. "5min", "15min", "60min"
   */
  async fetchIntraday(
    fromCurrency: string,
    toCurrency: string,
    interval: string,
  ): Promise<Candle[]> {
    await this.throttle();
    const pair = `${fromCurrency}/${toCurrency}`;
    log.info({ pair, interval }, 'Fetching intraday forex data');

    const intervalMsMap: Record<string, number> = { '5min': 300_000, '15min': 900_000, '60min': 3_600_000 };

    try {
      const { data } = await axios.get(AV_BASE, {
        params: {
          function: 'FX_INTRADAY',
          from_symbol: fromCurrency,
          to_symbol: toCurrency,
          interval,
          outputsize: 'compact',
          apikey: this.apiKey,
        },
        timeout: 10_000,
      });

      const seriesKey = `Time Series FX (Intraday)`;
      const series: AlphaVantageForexSeries | undefined =
        data[seriesKey] ?? data[`Time Series FX (${interval})`];

      if (!series) {
        const note: string = data['Note'] ?? data['Information'] ?? 'Unknown error';
        log.warn({ pair, interval, note }, 'Alpha Vantage returned no forex data — using synthetic');
        return generateSyntheticCandles(pair, 100, { intervalMs: intervalMsMap[interval] ?? 3_600_000, volatility: 0.005 });
      }

      const candles = this.parseTimeSeries(series);
      log.info({ pair, interval, count: candles.length }, 'Intraday forex data fetched');
      return candles;
    } catch (err) {
      log.warn({ pair, error: (err as Error).message }, 'Forex intraday API failed — using synthetic data');
      return generateSyntheticCandles(pair, 100, { intervalMs: intervalMsMap[interval] ?? 3_600_000, volatility: 0.005 });
    }
  }
}
