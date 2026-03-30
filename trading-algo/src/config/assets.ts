import type { AssetInfo } from '../shared/types.js';

// ============================================================
// Helper factories
// ============================================================

function crypto(base: string, quote = 'USDT', exchange = 'binance'): AssetInfo {
  return { symbol: `${base}/${quote}`, assetClass: 'crypto', exchange, baseCurrency: base, quoteCurrency: quote };
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
// Forex — All OANDA tradeable pairs (majors, minors, crosses, exotics)
// ============================================================

export const forexAssets: AssetInfo[] = [
  // ---- Majors (7) ----
  forex('EUR', 'USD'), forex('GBP', 'USD'), forex('USD', 'JPY'),
  forex('USD', 'CHF'), forex('AUD', 'USD'), forex('USD', 'CAD'),
  forex('NZD', 'USD'),

  // ---- EUR crosses (11) ----
  forex('EUR', 'GBP'), forex('EUR', 'JPY'), forex('EUR', 'CHF'),
  forex('EUR', 'AUD'), forex('EUR', 'CAD'), forex('EUR', 'NZD'),
  forex('EUR', 'SEK'), forex('EUR', 'NOK'), forex('EUR', 'DKK'),
  forex('EUR', 'TRY'), forex('EUR', 'ZAR'),

  // ---- GBP crosses (8) ----
  forex('GBP', 'JPY'), forex('GBP', 'CHF'), forex('GBP', 'AUD'),
  forex('GBP', 'CAD'), forex('GBP', 'NZD'), forex('GBP', 'SGD'),
  forex('GBP', 'ZAR'), forex('GBP', 'PLN'),

  // ---- AUD crosses (5) ----
  forex('AUD', 'JPY'), forex('AUD', 'NZD'), forex('AUD', 'CAD'),
  forex('AUD', 'CHF'), forex('AUD', 'SGD'),

  // ---- NZD crosses (4) ----
  forex('NZD', 'JPY'), forex('NZD', 'CHF'), forex('NZD', 'CAD'),
  forex('NZD', 'SGD'),

  // ---- CAD crosses (3) ----
  forex('CAD', 'JPY'), forex('CAD', 'CHF'), forex('CAD', 'SGD'),

  // ---- CHF crosses (2) ----
  forex('CHF', 'JPY'), forex('CHF', 'ZAR'),

  // ---- USD exotics (16) ----
  forex('USD', 'MXN'), forex('USD', 'ZAR'), forex('USD', 'TRY'),
  forex('USD', 'SGD'), forex('USD', 'HKD'), forex('USD', 'SEK'),
  forex('USD', 'NOK'), forex('USD', 'DKK'), forex('USD', 'PLN'),
  forex('USD', 'CZK'), forex('USD', 'HUF'), forex('USD', 'THB'),
  forex('USD', 'INR'), forex('USD', 'SAR'), forex('USD', 'CNH'),
  forex('USD', 'TWD'),

  // ---- SGD crosses (1) ----
  forex('SGD', 'JPY'),

  // ---- HKD crosses (1) ----
  forex('HKD', 'JPY'),

  // ---- TRY crosses (1) ----
  forex('TRY', 'JPY'),
];

// ============================================================
// Metals — All OANDA precious metals
// ============================================================

export const metalAssets: AssetInfo[] = [
  // Gold
  forex('XAU', 'USD'), forex('XAU', 'EUR'), forex('XAU', 'GBP'),
  forex('XAU', 'AUD'), forex('XAU', 'CHF'), forex('XAU', 'CAD'),
  forex('XAU', 'JPY'), forex('XAU', 'NZD'), forex('XAU', 'SGD'),
  forex('XAU', 'HKD'),
  // Silver
  forex('XAG', 'USD'), forex('XAG', 'EUR'), forex('XAG', 'GBP'),
  forex('XAG', 'AUD'), forex('XAG', 'CHF'), forex('XAG', 'CAD'),
  forex('XAG', 'JPY'), forex('XAG', 'NZD'), forex('XAG', 'SGD'),
  forex('XAG', 'HKD'),
  // Platinum
  forex('XPT', 'USD'),
  // Palladium
  forex('XPD', 'USD'),
  // Copper
  forex('XCU', 'USD'),
];

// ============================================================
// Aggregates
// ============================================================

/** All tradeable assets across all classes */
export const allAssets: AssetInfo[] = [...cryptoAssets, ...forexAssets, ...metalAssets];

/** Quick lookup by symbol */
export const assetBySymbol = new Map<string, AssetInfo>(
  allAssets.map(a => [a.symbol, a]),
);

/** Add custom assets at runtime */
export function addAsset(asset: AssetInfo): void {
  allAssets.push(asset);
  assetBySymbol.set(asset.symbol, asset);
}
