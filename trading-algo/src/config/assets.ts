import type { AssetInfo } from '../shared/types.js';
import { OandaDataFetcher } from '../team/market-analyst/oanda.js';

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
export const allAssets: AssetInfo[] = [...cryptoAssets, ...forexAssets];

/** Quick lookup by symbol */
export const assetBySymbol = new Map<string, AssetInfo>(
  allAssets.map(a => [a.symbol, a]),
);

/** Add custom assets at runtime */
export function addAsset(asset: AssetInfo): void {
  allAssets.push(asset);
  assetBySymbol.set(asset.symbol, asset);
}

/**
 * Fetch all tradeable instruments from OANDA and merge into allAssets.
 * Safe to call multiple times — deduplicates by symbol.
 * Returns the number of newly added assets (0 if OANDA is unavailable).
 */
export async function loadOandaAssets(): Promise<number> {
  const fetcher = new OandaDataFetcher();
  const instruments = await fetcher.getInstruments();
  if (instruments.length === 0) return 0;

  let added = 0;
  for (const asset of instruments) {
    if (!assetBySymbol.has(asset.symbol)) {
      addAsset(asset);
      added++;
    }
  }
  return added;
}
