import type { Candle } from './types.js';
import { createModuleLogger } from './logger.js';

const log = createModuleLogger('synthetic-data');

/**
 * Generates realistic synthetic OHLCV candle data.
 * Used as fallback when external APIs are unreachable.
 */
export function generateSyntheticCandles(
  symbol: string,
  count: number,
  opts?: {
    startPrice?: number;
    volatility?: number;
    intervalMs?: number;
  },
): Candle[] {
  const startPrice = opts?.startPrice ?? getDefaultPrice(symbol);
  const volatility = opts?.volatility ?? getDefaultVolatility(symbol);
  const intervalMs = opts?.intervalMs ?? 3_600_000; // 1h default

  const candles: Candle[] = [];
  let price = startPrice;
  let baseTime = Date.now() - count * intervalMs;

  for (let i = 0; i < count; i++) {
    const change = (Math.random() - 0.48) * volatility; // slight upward bias
    const open = price;
    const close = price * (1 + change);

    const highExtra = Math.random() * volatility * 0.5;
    const lowExtra = Math.random() * volatility * 0.5;
    const high = Math.max(open, close) * (1 + highExtra);
    const low = Math.min(open, close) * (1 - lowExtra);

    const baseVolume = getDefaultVolume(symbol);
    const volume = baseVolume * (0.5 + Math.random());

    candles.push({
      timestamp: baseTime + i * intervalMs,
      open: round(open),
      high: round(high),
      low: round(low),
      close: round(close),
      volume: Math.round(volume),
    });

    price = close;
  }

  log.info({ symbol, count }, 'Generated synthetic candle data');
  return candles;
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Reasonable starting prices per symbol */
function getDefaultPrice(symbol: string): number {
  const s = symbol.toUpperCase();

  // Crypto
  if (s.includes('BTC')) return 65000;
  if (s.includes('ETH')) return 3200;
  if (s.includes('SOL')) return 145;
  if (s.includes('BNB')) return 580;
  if (s.includes('XRP')) return 0.62;
  if (s.includes('ADA')) return 0.45;
  if (s.includes('AVAX')) return 36;
  if (s.includes('DOGE')) return 0.15;
  if (s.includes('DOT')) return 7.5;
  if (s.includes('MATIC')) return 0.85;
  if (s.includes('LINK')) return 15;
  if (s.includes('UNI')) return 8.5;
  if (s.includes('ATOM')) return 9;
  if (s.includes('LTC')) return 85;
  if (s.includes('ETC')) return 28;
  if (s.includes('XLM')) return 0.12;
  if (s.includes('NEAR')) return 5.5;
  if (s.includes('APT')) return 9;
  if (s.includes('FIL')) return 6;
  if (s.includes('ARB')) return 1.2;
  if (s.includes('OP')) return 2.5;
  if (s.includes('INJ')) return 25;
  if (s.includes('SUI')) return 1.5;
  if (s.includes('SEI')) return 0.5;
  if (s.includes('TIA')) return 12;
  if (s.includes('AAVE')) return 95;
  if (s.includes('MKR')) return 2800;
  if (s.includes('CRV')) return 0.6;
  if (s.includes('DYDX')) return 2;
  if (s.includes('RUNE')) return 5;
  if (s.includes('SHIB')) return 0.000025;
  if (s.includes('PEPE')) return 0.000012;
  if (s.includes('WIF')) return 2.5;
  if (s.includes('BONK')) return 0.00003;
  if (s.includes('FLOKI')) return 0.00018;

  // Stocks — mega caps
  if (s === 'AAPL') return 178;
  if (s === 'MSFT') return 420;
  if (s === 'GOOGL') return 155;
  if (s === 'AMZN') return 185;
  if (s === 'NVDA') return 880;
  if (s === 'META') return 510;
  if (s === 'TSLA') return 245;
  if (s === 'AVGO') return 170;
  if (s === 'ORCL') return 125;
  if (s === 'CRM') return 275;
  // Semiconductors
  if (s === 'AMD') return 165;
  if (s === 'INTC') return 45;
  if (s === 'QCOM') return 170;
  if (s === 'MU') return 95;
  if (s === 'MRVL') return 72;
  // Finance
  if (s === 'JPM') return 195;
  if (s === 'GS') return 415;
  if (s === 'V') return 280;
  if (s === 'MA') return 460;
  if (s === 'BAC') return 37;
  // Healthcare
  if (s === 'UNH') return 520;
  if (s === 'JNJ') return 160;
  if (s === 'LLY') return 780;
  if (s === 'PFE') return 28;
  if (s === 'ABBV') return 175;
  // Energy
  if (s === 'XOM') return 105;
  if (s === 'CVX') return 155;
  if (s === 'COP') return 115;
  if (s === 'SLB') return 48;
  if (s === 'OXY') return 60;
  // Consumer
  if (s === 'WMT') return 165;
  if (s === 'COST') return 730;
  if (s === 'HD') return 360;
  if (s === 'MCD') return 280;
  if (s === 'NKE') return 95;
  // Industrial
  if (s === 'BA') return 190;
  if (s === 'CAT') return 310;
  if (s === 'LMT') return 450;
  if (s === 'GE') return 160;
  if (s === 'RTX') return 95;
  // ETFs
  if (s === 'SPY') return 520;
  if (s === 'QQQ') return 440;
  if (s === 'IWM') return 200;
  if (s === 'DIA') return 390;
  if (s === 'XLF') return 40;
  if (s === 'XLE') return 85;
  if (s === 'XLK') return 200;
  if (s === 'XLV') return 140;
  if (s === 'EEM') return 42;
  if (s === 'GLD') return 195;
  if (s === 'SLV') return 23;
  if (s === 'USO') return 75;
  if (s === 'TLT') return 92;
  if (s === 'HYG') return 77;

  // Forex
  if (s.includes('EUR') && s.includes('USD')) return 1.085;
  if (s.includes('GBP') && s.includes('USD')) return 1.27;
  if (s.includes('JPY')) return s.startsWith('USD') ? 149.5 : 160;
  if (s.includes('AUD')) return 0.66;
  if (s.includes('CHF')) return 0.88;
  if (s.includes('CAD')) return 1.36;
  if (s.includes('NZD')) return 0.62;
  if (s.includes('MXN')) return 17.2;
  if (s.includes('ZAR')) return 18.5;
  if (s.includes('TRY')) return 32;
  if (s.includes('SGD')) return 1.34;
  if (s.includes('HKD')) return 7.82;

  return 100;
}

/** Default volatility by asset type */
function getDefaultVolatility(symbol: string): number {
  const s = symbol.toUpperCase();
  // Meme coins: very high volatility
  if (s.includes('SHIB') || s.includes('PEPE') || s.includes('WIF') || s.includes('BONK') || s.includes('FLOKI') || s.includes('DOGE')) return 0.05;
  // Crypto: moderate-high
  if (s.includes('/USDT') || s.includes('/BTC')) return 0.025;
  // Forex emerging: higher
  if (s.includes('TRY') || s.includes('ZAR') || s.includes('MXN')) return 0.008;
  // Forex: low
  if (s.includes('/USD') || s.includes('USD/') || s.includes('/EUR') || s.includes('/GBP') || s.includes('/JPY')) return 0.005;
  // Volatile stocks
  if (s === 'TSLA' || s === 'NVDA' || s === 'AMD') return 0.03;
  // ETFs: low
  if (['SPY', 'QQQ', 'DIA', 'IWM', 'XLF', 'XLE', 'XLK', 'XLV', 'TLT', 'HYG', 'GLD', 'SLV'].includes(s)) return 0.012;
  // Stocks: moderate
  return 0.02;
}

function getDefaultVolume(symbol: string): number {
  const s = symbol.toUpperCase();
  if (s.includes('BTC')) return 25000;
  if (s.includes('ETH')) return 150000;
  if (s.includes('SHIB') || s.includes('PEPE') || s.includes('BONK') || s.includes('FLOKI')) return 500000000;
  if (s.includes('/USDT')) return 50000000;
  if (s === 'SPY') return 80000000;
  if (['QQQ', 'IWM', 'DIA'].includes(s)) return 40000000;
  if (s.startsWith('XL') || s === 'EEM' || s === 'GLD' || s === 'TLT') return 15000000;
  if (s.includes('/USD') || s.includes('USD/')) return 0; // forex has no vol
  return 5000000;
}
