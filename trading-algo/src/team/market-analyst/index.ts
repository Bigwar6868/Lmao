import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AssetInfo, Candle, MarketData, Timeframe } from '../../shared/types.js';
import { config } from '../../config/index.js';
import { eventBus } from '../../shared/events.js';
import { createModuleLogger } from '../../shared/logger.js';
import { CryptoDataFetcher } from './crypto.js';
import { ForexDataFetcher } from './forex.js';
import { OandaDataFetcher } from './oanda.js';

const log = createModuleLogger('MarketAnalyst');

const SOURCE = 'MarketAnalyst';

/** Map system Timeframe to Alpha Vantage intraday intervals */
const TIMEFRAME_TO_AV_INTERVAL: Record<string, '5min' | '15min' | '60min'> = {
  '5m': '5min',
  '15m': '15min',
  '1h': '60min',
};

/**
 * Coordinates crypto and forex data fetchers.
 * Provides file-based caching and emits events when new data arrives.
 */
export class MarketAnalyst {
  private crypto: CryptoDataFetcher;
  private forex: ForexDataFetcher;
  private oanda: OandaDataFetcher | null;
  private cacheDir: string;

  constructor() {
    this.crypto = new CryptoDataFetcher();
    this.forex  = new ForexDataFetcher();
    // Use OANDA for forex data when a token is configured
    this.oanda  = config.oandaApiToken ? new OandaDataFetcher() : null;
    this.cacheDir = join(config.dataDir, 'historical');
    log.info({ oandaEnabled: !!this.oanda }, 'MarketAnalyst initialised');
  }

  // ----------------------------------------------------------------
  // Cache helpers
  // ----------------------------------------------------------------

  /**
   * Build a deterministic cache file path from request parameters.
   */
  private cachePath(asset: AssetInfo, timeframe: Timeframe): string {
    const safeSymbol = asset.symbol.replace(/[^a-zA-Z0-9]/g, '_');
    return join(this.cacheDir, `${asset.assetClass}_${safeSymbol}_${timeframe}.json`);
  }

  /**
   * Try to read cached data. Returns null when cache is disabled,
   * the file doesn't exist, or the TTL has expired.
   */
  private async readCache(
    asset: AssetInfo,
    timeframe: Timeframe,
  ): Promise<MarketData | null> {
    if (!config.cacheEnabled) return null;

    const path = this.cachePath(asset, timeframe);

    try {
      const raw = await readFile(path, 'utf-8');
      const cached = JSON.parse(raw) as MarketData;

      const age = Date.now() - cached.lastUpdated;
      if (age > config.cacheTtlMs) {
        // In cloud mode, use stale cache rather than making network calls that will fail
        if (config.cloudMode) {
          log.info({ path, ageHours: Math.round(age / 3_600_000) }, 'Cloud mode — using stale cache');
          return cached;
        }
        log.debug({ path }, 'Cache expired');
        return null;
      }

      log.info({ symbol: asset.symbol, timeframe }, 'Cache hit');
      return cached;
    } catch {
      // File doesn't exist or is malformed — treat as cache miss
      return null;
    }
  }

  /**
   * Write market data to the cache directory as JSON.
   */
  private async writeCache(data: MarketData): Promise<void> {
    if (!config.cacheEnabled) return;

    const path = this.cachePath(data.asset, data.timeframe);

    try {
      await mkdir(this.cacheDir, { recursive: true });
      await writeFile(path, JSON.stringify(data, null, 2), 'utf-8');
      log.debug({ path }, 'Cache written');
    } catch (err) {
      log.warn({ err, path }, 'Failed to write cache');
    }
  }

  // ----------------------------------------------------------------
  // Fetchers per asset class
  // ----------------------------------------------------------------

  private async fetchCrypto(
    asset: AssetInfo,
    timeframe: Timeframe,
  ): Promise<Candle[]> {
    return this.crypto.fetchOHLCV(asset.symbol, timeframe);
  }

  private async fetchForex(
    asset: AssetInfo,
    timeframe: Timeframe,
  ): Promise<Candle[]> {
    // Prefer OANDA when configured — better rate limits and intraday coverage
    if (this.oanda) {
      return this.oanda.fetchCandles(asset.symbol, timeframe);
    }

    const from = asset.baseCurrency ?? asset.symbol.split('/')[0]!;
    const to = asset.quoteCurrency ?? asset.symbol.split('/')[1]!;
    const avInterval = TIMEFRAME_TO_AV_INTERVAL[timeframe];

    if (timeframe === '1d' || timeframe === '1w') {
      return this.forex.fetchDaily(from, to);
    }

    if (avInterval) {
      return this.forex.fetchIntraday(from, to, avInterval);
    }

    log.warn(
      { symbol: asset.symbol, timeframe },
      'Unsupported forex timeframe, falling back to daily',
    );
    return this.forex.fetchDaily(from, to);
  }

  // ----------------------------------------------------------------
  // Public API
  // ----------------------------------------------------------------

  /**
   * Fetch market data for a single asset, using cache when available.
   * Emits a 'market:data' event on success.
   */
  async fetchMarketData(
    asset: AssetInfo,
    timeframe: Timeframe,
  ): Promise<MarketData> {
    // Check cache first
    const cached = await this.readCache(asset, timeframe);
    if (cached) return cached;

    log.info({ symbol: asset.symbol, assetClass: asset.assetClass, timeframe }, 'Fetching market data');

    let candles: Candle[];

    switch (asset.assetClass) {
      case 'crypto':
        candles = await this.fetchCrypto(asset, timeframe);
        break;
      case 'forex':
        candles = await this.fetchForex(asset, timeframe);
        break;
      default:
        throw new Error(`Unsupported asset class: ${String(asset.assetClass)}`);
    }

    const marketData: MarketData = {
      asset,
      timeframe,
      candles,
      lastUpdated: Date.now(),
    };

    // Persist to cache and emit event
    await this.writeCache(marketData);
    await eventBus.emit('market:data', marketData, SOURCE);

    log.info(
      { symbol: asset.symbol, timeframe, candleCount: candles.length },
      'Market data ready',
    );

    return marketData;
  }

  /**
   * Fetch market data for multiple assets. Requests are executed
   * sequentially to respect API rate limits.
   */
  async fetchAll(
    assets: AssetInfo[],
    timeframe: Timeframe,
  ): Promise<MarketData[]> {
    const results: MarketData[] = [];

    for (const asset of assets) {
      try {
        const data = await this.fetchMarketData(asset, timeframe);
        results.push(data);
      } catch (err) {
        log.error({ symbol: asset.symbol, err }, 'Failed to fetch market data');
      }
    }

    return results;
  }
}
