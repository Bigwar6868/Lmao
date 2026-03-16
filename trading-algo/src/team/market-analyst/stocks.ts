import axios from 'axios';
import type { Candle } from '../../shared/types.js';
import { config } from '../../config/index.js';
import { createModuleLogger } from '../../shared/logger.js';
import { generateSyntheticCandles } from '../../shared/synthetic.js';

const log = createModuleLogger('StockDataFetcher');

const AV_BASE = 'https://www.alphavantage.co/query';

/**
 * Alpha Vantage free tier allows 5 API calls per minute.
 * We enforce a 13-second gap between requests to stay safely under the limit.
 */
const AV_RATE_LIMIT_MS = 13_000;

type IntradayInterval = '5min' | '15min' | '60min';

interface AlphaVantageTimeSeries {
  [datetime: string]: {
    '1. open': string;
    '2. high': string;
    '3. low': string;
    '4. close': string;
    '5. volume': string;
  };
}

/**
 * Fetches stock price data from Alpha Vantage.
 */
export class StockDataFetcher {
  private apiKey: string;
  private lastRequestTime = 0;

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? config.alphaVantageKey;
    log.info('StockDataFetcher initialised');
  }

  /**
   * Wait if necessary to respect the 5 calls/minute rate limit.
   */
  private async throttle(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestTime;
    if (elapsed < AV_RATE_LIMIT_MS) {
      const wait = AV_RATE_LIMIT_MS - elapsed;
      log.debug({ waitMs: wait }, 'Throttling Alpha Vantage request');
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    this.lastRequestTime = Date.now();
  }

  /**
   * Parse an Alpha Vantage time-series object into sorted Candle[].
   */
  private parseTimeSeries(series: AlphaVantageTimeSeries): Candle[] {
    const candles: Candle[] = [];

    for (const [datetime, values] of Object.entries(series)) {
      candles.push({
        timestamp: new Date(datetime).getTime(),
        open: parseFloat(values['1. open']),
        high: parseFloat(values['2. high']),
        low: parseFloat(values['3. low']),
        close: parseFloat(values['4. close']),
        volume: parseFloat(values['5. volume']),
      });
    }

    // Oldest first
    candles.sort((a, b) => a.timestamp - b.timestamp);
    return candles;
  }

  /**
   * Fetch daily candle data for a stock symbol.
   *
   * @param symbol - Ticker symbol, e.g. "AAPL"
   */
  async fetchDaily(symbol: string): Promise<Candle[]> {
    await this.throttle();
    log.info({ symbol }, 'Fetching daily stock data');

    try {
      const { data } = await axios.get(AV_BASE, {
        params: {
          function: 'TIME_SERIES_DAILY',
          symbol,
          outputsize: 'compact',
          apikey: this.apiKey,
        },
        timeout: 10_000,
      });

      const seriesKey = 'Time Series (Daily)';
      const series: AlphaVantageTimeSeries | undefined = data[seriesKey];

      if (!series) {
        const note: string = data['Note'] ?? data['Information'] ?? 'Unknown error';
        log.warn({ symbol, note }, 'Alpha Vantage returned no data — using synthetic');
        return generateSyntheticCandles(symbol, 100, { intervalMs: 86_400_000 });
      }

      const candles = this.parseTimeSeries(series);
      log.info({ symbol, count: candles.length }, 'Daily stock data fetched');
      return candles;
    } catch (err) {
      log.warn({ symbol, error: (err as Error).message }, 'Stock API failed — using synthetic data');
      return generateSyntheticCandles(symbol, 100, { intervalMs: 86_400_000 });
    }
  }

  /**
   * Fetch intraday candle data for a stock symbol.
   *
   * @param symbol   - Ticker symbol, e.g. "AAPL"
   * @param interval - Candle interval: '5min', '15min', or '60min'
   */
  async fetchIntraday(
    symbol: string,
    interval: IntradayInterval,
  ): Promise<Candle[]> {
    await this.throttle();
    log.info({ symbol, interval }, 'Fetching intraday stock data');

    const intervalMs: Record<string, number> = { '5min': 300_000, '15min': 900_000, '60min': 3_600_000 };

    try {
      const { data } = await axios.get(AV_BASE, {
        params: {
          function: 'TIME_SERIES_INTRADAY',
          symbol,
          interval,
          outputsize: 'compact',
          apikey: this.apiKey,
        },
        timeout: 10_000,
      });

      const seriesKey = `Time Series (${interval})`;
      const series: AlphaVantageTimeSeries | undefined = data[seriesKey];

      if (!series) {
        const note: string = data['Note'] ?? data['Information'] ?? 'Unknown error';
        log.warn({ symbol, interval, note }, 'Alpha Vantage returned no data — using synthetic');
        return generateSyntheticCandles(symbol, 100, { intervalMs: intervalMs[interval] ?? 3_600_000 });
      }

      const candles = this.parseTimeSeries(series);
      log.info({ symbol, interval, count: candles.length }, 'Intraday stock data fetched');
      return candles;
    } catch (err) {
      log.warn({ symbol, error: (err as Error).message }, 'Stock intraday API failed — using synthetic data');
      return generateSyntheticCandles(symbol, 100, { intervalMs: intervalMs[interval] ?? 3_600_000 });
    }
  }
}
