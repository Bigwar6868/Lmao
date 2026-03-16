// ============================================================
// News Sentiment Analyzer — Keyword-based scoring
// ============================================================

import { createModuleLogger } from '../../shared/logger.js';

const logger = createModuleLogger('news-sentiment');

const POSITIVE_WORDS = new Set([
  'rally', 'surge', 'bullish', 'growth', 'breakout', 'profit', 'moon',
  'upgrade', 'buy', 'soar', 'gain', 'boom', 'recover', 'optimism',
  'strong', 'upside', 'outperform', 'beat', 'positive', 'momentum',
  'highs', 'record', 'advance', 'expansion', 'confidence',
]);

const NEGATIVE_WORDS = new Set([
  'crash', 'bearish', 'recession', 'dump', 'sell', 'fear', 'risk',
  'downgrade', 'panic', 'plunge', 'loss', 'decline', 'slump',
  'crisis', 'weak', 'downside', 'underperform', 'miss', 'negative',
  'collapse', 'lows', 'contraction', 'uncertainty', 'volatile',
  'default', 'bankruptcy', 'layoff', 'inflation',
]);

export class NewsSentimentAnalyzer {
  /**
   * Analyze sentiment of a text string using keyword matching.
   *
   * @returns score between -1 (very bearish) and 1 (very bullish)
   */
  analyzeSentiment(text: string): number {
    const words = text
      .toLowerCase()
      .replace(/[^a-z\s]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 0);

    if (words.length === 0) return 0;

    let positiveCount = 0;
    let negativeCount = 0;

    for (const word of words) {
      if (POSITIVE_WORDS.has(word)) positiveCount++;
      if (NEGATIVE_WORDS.has(word)) negativeCount++;
    }

    const raw = (positiveCount - negativeCount) / words.length;
    // Amplify the signal (raw scores are tiny) and clamp
    const amplified = raw * 10;
    const clamped = Math.max(-1, Math.min(1, amplified));

    logger.debug(
      { positiveCount, negativeCount, totalWords: words.length, score: clamped },
      'Text sentiment analyzed',
    );

    return clamped;
  }

  /**
   * Analyze an array of texts and return the average sentiment.
   */
  analyzeMultiple(texts: string[]): number {
    if (texts.length === 0) return 0;
    const scores = texts.map((t) => this.analyzeSentiment(t));
    return scores.reduce((sum, s) => sum + s, 0) / scores.length;
  }
}
