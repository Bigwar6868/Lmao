// ============================================================
// Sentiment Analyst — Local Types
// ============================================================

/** Where the sentiment data originates */
export type SentimentSource =
  | 'news'
  | 'twitter'
  | 'reddit'
  | 'coingecko'
  | 'onchain'
  | 'aggregate';

/** A single news item with optional sentiment annotation */
export interface NewsItem {
  title: string;
  description: string;
  url: string;
  source: string;
  publishedAt: string;
  sentiment?: number; // -1 to 1
}

/** A social media post / data point */
export interface SocialPost {
  platform: SentimentSource;
  content: string;
  author: string;
  timestamp: number;
  engagement: number; // likes + retweets / upvotes
  sentiment?: number; // -1 to 1
}
