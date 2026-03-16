// ============================================================
// FRED API Client
// ============================================================

import axios from 'axios';
import { config } from '../../config/index.js';
import { createModuleLogger } from '../../shared/logger.js';
import type { MacroIndicator } from '../../shared/types.js';
import type { FredSeriesId } from './types.js';

const logger = createModuleLogger('fred-client');

/** Impact mapping for known FRED series */
const SERIES_IMPACT: Record<string, MacroIndicator['impact']> = {
  FEDFUNDS: 'high',
  CPIAUCSL: 'high',
  GDP: 'high',
  UNRATE: 'high',
  T10Y2Y: 'high',
  VIXCLS: 'medium',
  DGS10: 'medium',
  DGS2: 'medium',
  PAYEMS: 'high',
  UMCSENT: 'medium',
};

/** Reasonable mock values when no API key is available */
const MOCK_DATA: Record<string, { value: number; previousValue: number }> = {
  FEDFUNDS: { value: 5.33, previousValue: 5.33 },
  CPIAUCSL: { value: 314.69, previousValue: 313.05 },
  GDP: { value: 27956.0, previousValue: 27610.0 },
  UNRATE: { value: 3.7, previousValue: 3.8 },
  T10Y2Y: { value: -0.32, previousValue: -0.44 },
  VIXCLS: { value: 18.5, previousValue: 17.2 },
  DGS10: { value: 4.25, previousValue: 4.18 },
  DGS2: { value: 4.57, previousValue: 4.62 },
  PAYEMS: { value: 157200, previousValue: 157000 },
  UMCSENT: { value: 67.4, previousValue: 69.7 },
};

interface FredObservation {
  date: string;
  value: string;
}

interface FredApiResponse {
  observations: FredObservation[];
}

export class FredClient {
  private readonly apiKey: string;
  private readonly baseUrl = 'https://api.stlouisfed.org/fred/series/observations';

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? config.fredApiKey;
  }

  /**
   * Fetch a FRED data series and return as MacroIndicator[].
   * Falls back to mock data when no API key is configured.
   */
  async fetchSeries(seriesId: string, limit = 10): Promise<MacroIndicator[]> {
    if (!this.apiKey) {
      logger.warn({ seriesId }, 'No FRED API key configured — returning mock data');
      return this.getMockData(seriesId);
    }

    try {
      const response = await axios.get<FredApiResponse>(this.baseUrl, {
        params: {
          series_id: seriesId,
          api_key: this.apiKey,
          file_type: 'json',
          sort_order: 'desc',
          limit,
        },
        timeout: 10_000,
      });

      const observations = response.data.observations.filter(
        (obs) => obs.value !== '.',
      );

      if (observations.length === 0) {
        logger.warn({ seriesId }, 'No valid observations returned from FRED');
        return this.getMockData(seriesId);
      }

      return observations.map((obs, idx) => {
        const previousObs = observations[idx + 1];
        return {
          name: seriesId,
          value: parseFloat(obs.value),
          previousValue: previousObs ? parseFloat(previousObs.value) : parseFloat(obs.value),
          date: obs.date,
          source: 'FRED',
          impact: SERIES_IMPACT[seriesId] ?? 'low',
        };
      });
    } catch (error) {
      logger.error({ seriesId, error }, 'Failed to fetch FRED series — falling back to mock');
      return this.getMockData(seriesId);
    }
  }

  /**
   * Convenience: fetch latest single observation for a series.
   */
  async fetchLatest(seriesId: string): Promise<MacroIndicator> {
    const series = await this.fetchSeries(seriesId, 2);
    return series[0]!;
  }

  /**
   * Fetch all key macro series in parallel.
   */
  async fetchAllKey(): Promise<MacroIndicator[]> {
    const keys: FredSeriesId[] = [
      'FEDFUNDS',
      'CPIAUCSL',
      'GDP',
      'UNRATE',
      'T10Y2Y',
      'VIXCLS',
    ];

    const results = await Promise.allSettled(
      keys.map((id) => this.fetchLatest(id)),
    );

    return results
      .filter((r): r is PromiseFulfilledResult<MacroIndicator> => r.status === 'fulfilled')
      .map((r) => r.value);
  }

  // ---- private ----

  private getMockData(seriesId: string): MacroIndicator[] {
    const mock = MOCK_DATA[seriesId];
    if (!mock) {
      return [
        {
          name: seriesId,
          value: 0,
          previousValue: 0,
          date: new Date().toISOString().slice(0, 10),
          source: 'FRED (mock)',
          impact: 'low',
        },
      ];
    }

    return [
      {
        name: seriesId,
        value: mock.value,
        previousValue: mock.previousValue,
        date: new Date().toISOString().slice(0, 10),
        source: 'FRED (mock)',
        impact: SERIES_IMPACT[seriesId] ?? 'low',
      },
    ];
  }
}
