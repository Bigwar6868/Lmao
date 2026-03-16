import type { AssetInfo } from '../shared/types.js';

/** Crypto assets — traded via CCXT on Binance */
export const cryptoAssets: AssetInfo[] = [
  { symbol: 'BTC/USDT', assetClass: 'crypto', exchange: 'binance', baseCurrency: 'BTC', quoteCurrency: 'USDT' },
  { symbol: 'ETH/USDT', assetClass: 'crypto', exchange: 'binance', baseCurrency: 'ETH', quoteCurrency: 'USDT' },
  { symbol: 'SOL/USDT', assetClass: 'crypto', exchange: 'binance', baseCurrency: 'SOL', quoteCurrency: 'USDT' },
  { symbol: 'BNB/USDT', assetClass: 'crypto', exchange: 'binance', baseCurrency: 'BNB', quoteCurrency: 'USDT' },
  { symbol: 'XRP/USDT', assetClass: 'crypto', exchange: 'binance', baseCurrency: 'XRP', quoteCurrency: 'USDT' },
  { symbol: 'ADA/USDT', assetClass: 'crypto', exchange: 'binance', baseCurrency: 'ADA', quoteCurrency: 'USDT' },
  { symbol: 'AVAX/USDT', assetClass: 'crypto', exchange: 'binance', baseCurrency: 'AVAX', quoteCurrency: 'USDT' },
  { symbol: 'DOGE/USDT', assetClass: 'crypto', exchange: 'binance', baseCurrency: 'DOGE', quoteCurrency: 'USDT' },
];

/** Stock assets — traded via Alpha Vantage / Alpaca */
export const stockAssets: AssetInfo[] = [
  { symbol: 'AAPL', assetClass: 'stock', exchange: 'nasdaq' },
  { symbol: 'MSFT', assetClass: 'stock', exchange: 'nasdaq' },
  { symbol: 'GOOGL', assetClass: 'stock', exchange: 'nasdaq' },
  { symbol: 'AMZN', assetClass: 'stock', exchange: 'nasdaq' },
  { symbol: 'TSLA', assetClass: 'stock', exchange: 'nasdaq' },
  { symbol: 'NVDA', assetClass: 'stock', exchange: 'nasdaq' },
  { symbol: 'META', assetClass: 'stock', exchange: 'nasdaq' },
  { symbol: 'SPY', assetClass: 'stock', exchange: 'nyse' },
];

/** Forex pairs — traded via Alpha Vantage */
export const forexAssets: AssetInfo[] = [
  { symbol: 'EUR/USD', assetClass: 'forex', baseCurrency: 'EUR', quoteCurrency: 'USD' },
  { symbol: 'GBP/USD', assetClass: 'forex', baseCurrency: 'GBP', quoteCurrency: 'USD' },
  { symbol: 'USD/JPY', assetClass: 'forex', baseCurrency: 'USD', quoteCurrency: 'JPY' },
  { symbol: 'AUD/USD', assetClass: 'forex', baseCurrency: 'AUD', quoteCurrency: 'USD' },
  { symbol: 'USD/CHF', assetClass: 'forex', baseCurrency: 'USD', quoteCurrency: 'CHF' },
  { symbol: 'USD/CAD', assetClass: 'forex', baseCurrency: 'USD', quoteCurrency: 'CAD' },
];

/** All tradeable assets */
export const allAssets: AssetInfo[] = [...cryptoAssets, ...stockAssets, ...forexAssets];
