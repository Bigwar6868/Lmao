import type { AssetInfo } from '../shared/types.js';

// ============================================================
// Helper factories
// ============================================================

function crypto(base: string, quote = 'USDT', exchange = 'binance'): AssetInfo {
  return { symbol: `${base}/${quote}`, assetClass: 'crypto', exchange, baseCurrency: base, quoteCurrency: quote };
}

function stock(symbol: string, exchange = 'nasdaq'): AssetInfo {
  return { symbol, assetClass: 'stock', exchange };
}

function forex(base: string, quote: string): AssetInfo {
  return { symbol: `${base}/${quote}`, assetClass: 'forex', baseCurrency: base, quoteCurrency: quote };
}

// ============================================================
// Crypto — Top 30 by market cap + major DeFi/L2 tokens
// ============================================================

export const cryptoAssets: AssetInfo[] = [
  // Top 10
  crypto('BTC'), crypto('ETH'), crypto('BNB'), crypto('SOL'), crypto('XRP'),
  crypto('ADA'), crypto('AVAX'), crypto('DOGE'), crypto('DOT'), crypto('MATIC'),
  // 11-20
  crypto('LINK'), crypto('UNI'), crypto('ATOM'), crypto('LTC'), crypto('ETC'),
  crypto('XLM'), crypto('NEAR'), crypto('APT'), crypto('FIL'), crypto('ARB'),
  // 21-30 + DeFi/L2
  crypto('OP'), crypto('INJ'), crypto('SUI'), crypto('SEI'), crypto('TIA'),
  crypto('AAVE'), crypto('MKR'), crypto('CRV'), crypto('DYDX'), crypto('RUNE'),
  // Meme / high-volatility
  crypto('SHIB'), crypto('PEPE'), crypto('WIF'), crypto('BONK'), crypto('FLOKI'),
];

// ============================================================
// Stocks — S&P 500 leaders + sector ETFs + international
// ============================================================

export const stockAssets: AssetInfo[] = [
  // Mega caps (Mag 7 + top tech)
  stock('AAPL'), stock('MSFT'), stock('GOOGL'), stock('AMZN'), stock('NVDA'),
  stock('META'), stock('TSLA'), stock('AVGO'), stock('ORCL'), stock('CRM'),
  // Semiconductors
  stock('AMD'), stock('INTC'), stock('QCOM'), stock('MU'), stock('MRVL'),
  // Finance
  stock('JPM'), stock('GS'), stock('V'), stock('MA'), stock('BAC'),
  // Healthcare
  stock('UNH'), stock('JNJ'), stock('LLY'), stock('PFE'), stock('ABBV'),
  // Energy
  stock('XOM'), stock('CVX'), stock('COP'), stock('SLB'), stock('OXY'),
  // Consumer
  stock('WMT'), stock('COST'), stock('HD'), stock('MCD'), stock('NKE'),
  // Industrial / Defense
  stock('BA'), stock('CAT'), stock('LMT'), stock('GE'), stock('RTX'),
  // ETFs — broad market
  stock('SPY', 'nyse'), stock('QQQ'), stock('IWM', 'nyse'), stock('DIA', 'nyse'),
  // ETFs — sector
  stock('XLF', 'nyse'), stock('XLE', 'nyse'), stock('XLK', 'nyse'), stock('XLV', 'nyse'),
  // ETFs — international / commodities
  stock('EEM', 'nyse'), stock('GLD', 'nyse'), stock('SLV', 'nyse'), stock('USO', 'nyse'),
  // Volatility / bonds
  stock('TLT'), stock('HYG', 'nyse'),
];

// ============================================================
// Forex — Major, minor, and cross pairs
// ============================================================

export const forexAssets: AssetInfo[] = [
  // Majors
  forex('EUR', 'USD'), forex('GBP', 'USD'), forex('USD', 'JPY'),
  forex('USD', 'CHF'), forex('AUD', 'USD'), forex('USD', 'CAD'),
  forex('NZD', 'USD'),
  // Crosses
  forex('EUR', 'GBP'), forex('EUR', 'JPY'), forex('GBP', 'JPY'),
  forex('EUR', 'CHF'), forex('AUD', 'JPY'), forex('EUR', 'AUD'),
  forex('GBP', 'AUD'), forex('CAD', 'JPY'),
  // Emerging
  forex('USD', 'MXN'), forex('USD', 'ZAR'), forex('USD', 'TRY'),
  forex('USD', 'SGD'), forex('USD', 'HKD'),
];

// ============================================================
// Aggregates
// ============================================================

/** All tradeable assets across all classes */
export const allAssets: AssetInfo[] = [...cryptoAssets, ...stockAssets, ...forexAssets];

/** Quick lookup by symbol */
export const assetBySymbol = new Map<string, AssetInfo>(
  allAssets.map(a => [a.symbol, a]),
);

/** Add custom assets at runtime */
export function addAsset(asset: AssetInfo): void {
  allAssets.push(asset);
  assetBySymbol.set(asset.symbol, asset);
}
