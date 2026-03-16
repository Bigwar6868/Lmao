// ============================================================
// Social Sentiment Analyzer — CoinGecko price momentum proxy
// ============================================================

import axios from 'axios';
import { createModuleLogger } from '../../shared/logger.js';
import type { SentimentScore } from '../../shared/types.js';

const logger = createModuleLogger('social-sentiment');

/** Map common trading symbols to CoinGecko IDs */
const SYMBOL_TO_COINGECKO: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  BNB: 'binancecoin',
  XRP: 'ripple',
  ADA: 'cardano',
  DOGE: 'dogecoin',
  AVAX: 'avalanche-2',
  DOT: 'polkadot',
  MATIC: 'matic-network',
  LINK: 'chainlink',
  LTC: 'litecoin',
  ATOM: 'cosmos',
  UNI: 'uniswap',
  ARB: 'arbitrum',
};

interface CoinGeckoResponse {
  market_data?: {
    price_change_percentage_24h?: number;
    price_change_percentage_7d?: number;
    total_volume?: Record<string, number>;
    current_price?: Record<string, number>;
  };
}

export class SocialSentimentAnalyzer {
  private readonly baseUrl = 'https://api.coingecko.com/api/v3';

  /**
   * Fetch crypto sentiment using CoinGecko 24h price change as a proxy.
   * Positive price momentum = bullish sentiment, negative = bearish.
   */
  async fetchCryptoSentiment(symbol: string): Promise<SentimentScore> {
    const id = SYMBOL_TO_COINGECKO[symbol.toUpperCase()] ?? symbol.toLowerCase();

    try {
      const response = await axios.get<CoinGeckoResponse>(
        `${this.baseUrl}/coins/${id}`,
        {
          params: {
            localization: false,
            tickers: false,
            market_data: true,
            community_data: false,
            developer_data: false,
            sparkline: false,
          },
          timeout: 10_000,
        },
      );

      const marketData = response.data.market_data;
      const change24h = marketData?.price_change_percentage_24h ?? 0;
      const change7d = marketData?.price_change_percentage_7d ?? 0;
      const volume = marketData?.total_volume?.['usd'] ?? 0;

      // Convert percentage change to sentiment score (-1 to 1)
      // A 10% move maps roughly to the extremes
      const sentimentFromDay = Math.max(-1, Math.min(1, change24h / 10));
      const sentimentFromWeek = Math.max(-1, Math.min(1, change7d / 20));

      // Weight 24h more heavily
      const score = sentimentFromDay * 0.7 + sentimentFromWeek * 0.3;

      logger.info(
        { symbol, change24h, change7d, score: score.toFixed(3) },
        'Crypto sentiment fetched from CoinGecko',
      );

      return {
        asset: symbol.toUpperCase(),
        score: Math.round(score * 1000) / 1000,
        volume: Math.round(volume),
        source: 'coingecko',
        timestamp: Date.now(),
      };
    } catch (error) {
      logger.error({ symbol, error }, 'Failed to fetch CoinGecko data — returning neutral');
      return {
        asset: symbol.toUpperCase(),
        score: 0,
        volume: 0,
        source: 'coingecko',
        timestamp: Date.now(),
      };
    }
  }
}
