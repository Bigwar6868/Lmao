// ============================================================
// Sentiment Analyst — Main Module
// ============================================================

import { createModuleLogger } from '../../shared/logger.js';
import { eventBus } from '../../shared/events.js';
import type { SentimentScore } from '../../shared/types.js';
import { NewsSentimentAnalyzer } from './news.js';
import { SocialSentimentAnalyzer } from './social.js';

export { NewsSentimentAnalyzer } from './news.js';
export { SocialSentimentAnalyzer } from './social.js';
export type { SentimentSource, NewsItem, SocialPost } from './types.js';

const logger = createModuleLogger('sentiment-analyst');

/** Symbols that are crypto (checked case-insensitively) */
const CRYPTO_SYMBOLS = new Set([
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE',
  'AVAX', 'DOT', 'MATIC', 'LINK', 'LTC', 'ATOM', 'UNI', 'ARB',
]);

export class SentimentAnalyst {
  private readonly newsAnalyzer: NewsSentimentAnalyzer;
  private readonly socialAnalyzer: SocialSentimentAnalyzer;
  private lastScores: SentimentScore[] = [];

  constructor() {
    this.newsAnalyzer = new NewsSentimentAnalyzer();
    this.socialAnalyzer = new SocialSentimentAnalyzer();
  }

  /**
   * Analyze sentiment for a list of assets.
   *   - Crypto assets: use CoinGecko price momentum
   *   - Stocks/forex: return neutral (no free API available)
   */
  async analyze(assets: string[]): Promise<SentimentScore[]> {
    logger.info({ assets }, 'Analyzing sentiment for assets');

    const promises = assets.map((asset) => this.analyzeOne(asset));
    const results = await Promise.allSettled(promises);

    const scores: SentimentScore[] = results
      .filter((r): r is PromiseFulfilledResult<SentimentScore> => r.status === 'fulfilled')
      .map((r) => r.value);

    this.lastScores = scores;

    // Emit event
    await eventBus.emit('sentiment:update', scores, 'sentiment-analyst');

    logger.info(
      { count: scores.length, overall: this.computeOverall(scores).toFixed(3) },
      'Sentiment analysis complete',
    );

    return scores;
  }

  /**
   * Get the overall sentiment across all recently analyzed assets.
   * Returns a value from -1 (very bearish) to 1 (very bullish).
   */
  async getOverallSentiment(): Promise<number> {
    if (this.lastScores.length === 0) {
      logger.warn('No sentiment data available — returning neutral');
      return 0;
    }
    return this.computeOverall(this.lastScores);
  }

  /**
   * Expose the news analyzer for ad-hoc text analysis.
   */
  get news(): NewsSentimentAnalyzer {
    return this.newsAnalyzer;
  }

  /**
   * Expose the social analyzer for direct use.
   */
  get social(): SocialSentimentAnalyzer {
    return this.socialAnalyzer;
  }

  // ---- private ----

  private async analyzeOne(asset: string): Promise<SentimentScore> {
    const symbol = asset.toUpperCase();

    if (CRYPTO_SYMBOLS.has(symbol)) {
      return this.socialAnalyzer.fetchCryptoSentiment(symbol);
    }

    // Stocks / forex — no free sentiment API, return neutral
    logger.debug({ symbol }, 'No free sentiment source for non-crypto asset — returning neutral');
    return {
      asset: symbol,
      score: 0,
      volume: 0,
      source: 'none',
      timestamp: Date.now(),
    };
  }

  private computeOverall(scores: SentimentScore[]): number {
    if (scores.length === 0) return 0;

    // Volume-weighted average if volumes are available, otherwise simple average
    const totalVolume = scores.reduce((sum, s) => sum + s.volume, 0);

    if (totalVolume > 0) {
      const weighted = scores.reduce((sum, s) => sum + s.score * s.volume, 0);
      return weighted / totalVolume;
    }

    return scores.reduce((sum, s) => sum + s.score, 0) / scores.length;
  }
}
