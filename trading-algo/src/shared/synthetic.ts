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
  const volatility = opts?.volatility ?? 0.02;
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
  if (s.includes('BTC')) return 65000;
  if (s.includes('ETH')) return 3200;
  if (s.includes('SOL')) return 145;
  if (s.includes('BNB')) return 580;
  if (s.includes('XRP')) return 0.62;
  if (s.includes('ADA')) return 0.45;
  if (s.includes('AVAX')) return 36;
  if (s.includes('DOGE')) return 0.15;
  if (s.includes('AAPL')) return 178;
  if (s.includes('MSFT')) return 420;
  if (s.includes('GOOGL')) return 155;
  if (s.includes('AMZN')) return 185;
  if (s.includes('TSLA')) return 245;
  if (s.includes('NVDA')) return 880;
  if (s.includes('META')) return 510;
  if (s.includes('SPY')) return 520;
  if (s.includes('EUR')) return 1.085;
  if (s.includes('GBP')) return 1.27;
  if (s.includes('JPY')) return 149.5;
  if (s.includes('AUD')) return 0.66;
  if (s.includes('CHF')) return 0.88;
  if (s.includes('CAD')) return 1.36;
  return 100;
}

function getDefaultVolume(symbol: string): number {
  const s = symbol.toUpperCase();
  if (s.includes('BTC')) return 25000;
  if (s.includes('ETH')) return 150000;
  if (s.includes('SPY')) return 80000000;
  if (s.includes('/USD') || s.includes('USD/')) return 0; // forex has no vol
  return 5000000;
}
