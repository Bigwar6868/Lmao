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

function commodity(symbol: string, base: string, quote: string): AssetInfo {
  return { symbol, assetClass: 'commodity', baseCurrency: base, quoteCurrency: quote };
}

function index(symbol: string): AssetInfo {
  return { symbol, assetClass: 'index' };
}

function bond(symbol: string): AssetInfo {
  return { symbol, assetClass: 'bond' };
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
// Commodities — OANDA energy & agricultural CFDs
// ============================================================

export const commodityAssets: AssetInfo[] = [
  // Energy
  commodity('WTICO/USD', 'WTICO', 'USD'),   // WTI Crude Oil
  commodity('BCO/USD', 'BCO', 'USD'),        // Brent Crude Oil
  commodity('NATGAS/USD', 'NATGAS', 'USD'),  // Natural Gas
  // Soft commodities
  commodity('SOYBN/USD', 'SOYBN', 'USD'),   // Soybeans
  commodity('CORN/USD', 'CORN', 'USD'),      // Corn
  commodity('WHEAT/USD', 'WHEAT', 'USD'),    // Wheat
  commodity('SUGAR/USD', 'SUGAR', 'USD'),    // Sugar
];

// ============================================================
// Indices — OANDA global stock index CFDs
// ============================================================

export const indexAssets: AssetInfo[] = [
  // US
  index('SPX500/USD'),     // S&P 500
  index('NAS100/USD'),     // Nasdaq 100
  index('US30/USD'),       // Dow Jones 30
  index('US2000/USD'),     // Russell 2000
  // Europe
  index('UK100/GBP'),      // FTSE 100
  index('DE30/EUR'),       // DAX 30
  index('FR40/EUR'),       // CAC 40
  index('EU50/EUR'),       // Euro Stoxx 50
  index('NL25/EUR'),       // AEX 25
  index('ES35/EUR'),       // IBEX 35
  // Asia-Pacific
  index('JP225/USD'),      // Nikkei 225
  index('AU200/AUD'),      // ASX 200
  index('HK33/HKD'),       // Hang Seng
  index('SG30/SGD'),       // Singapore 30
  index('CN50/USD'),       // FTSE China A50
  index('IN50/USD'),       // India 50 (Nifty)
  index('TWIX/USD'),       // Taiwan Index
];

// ============================================================
// Bonds — OANDA government bond CFDs (treasury yields)
// ============================================================

export const bondAssets: AssetInfo[] = [
  // US Treasuries
  bond('USB02Y/USD'),    // 2-Year T-Note
  bond('USB05Y/USD'),    // 5-Year T-Note
  bond('USB10Y/USD'),    // 10-Year T-Note
  bond('USB30Y/USD'),    // 30-Year T-Bond
  // European
  bond('DE10YB/EUR'),    // German 10-Year Bund
  bond('UK10YB/GBP'),    // UK 10-Year Gilt
  // Japan
  bond('JP10YB/JPY'),    // Japan 10-Year JGB (OANDA supported)
];

// ============================================================
// OANDA-only assets (forex + metals + commodities + indices + bonds)
// ============================================================

/** All OANDA-tradeable assets (excludes crypto) */
export const oandaAssets: AssetInfo[] = [
  ...forexAssets,
  ...metalAssets,
  ...commodityAssets,
  ...indexAssets,
  ...bondAssets,
];

// ============================================================
// Aggregates
// ============================================================

/** All tradeable assets across all classes */
export const allAssets: AssetInfo[] = [
  ...cryptoAssets,
  ...forexAssets,
  ...metalAssets,
  ...commodityAssets,
  ...indexAssets,
  ...bondAssets,
];

/** Quick lookup by symbol */
export const assetBySymbol = new Map<string, AssetInfo>(
  allAssets.map(a => [a.symbol, a]),
);

/** Add custom assets at runtime */
export function addAsset(asset: AssetInfo): void {
  allAssets.push(asset);
  assetBySymbol.set(asset.symbol, asset);
}
