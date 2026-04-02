import type { Candle } from './types.js';
import { createModuleLogger } from './logger.js';

const log = createModuleLogger('synthetic-data');

/**
 * Market regime types for synthetic data generation.
 * Alternating regimes create realistic patterns that strategies can exploit.
 */
type Regime = 'trending_up' | 'trending_down' | 'mean_reverting' | 'breakout' | 'choppy';

/**
 * Generates realistic synthetic OHLCV candle data with regime-switching.
 * Creates trending, mean-reverting, and breakout patterns that
 * trading strategies can profitably exploit.
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

  // Regime-switching: divide candles into segments with different behavior
  const regimeLength = Math.max(30, Math.floor(count / 8)); // ~60 bars per regime
  let regime: Regime = 'trending_up';
  let regimeBar = 0;
  let regimeMean = price; // anchor for mean-reversion
  let squeezeCountdown = 0; // bars of low-vol before breakout

  // Seed regime sequence deterministically from symbol hash
  const regimes: Regime[] = ['trending_up', 'mean_reverting', 'trending_down', 'choppy', 'breakout', 'trending_up', 'mean_reverting', 'trending_down'];
  let regimeIdx = Math.abs(hashCode(symbol)) % regimes.length;

  for (let i = 0; i < count; i++) {
    // Switch regime periodically
    if (regimeBar >= regimeLength) {
      regimeBar = 0;
      regimeIdx = (regimeIdx + 1) % regimes.length;
      regime = regimes[regimeIdx];
      regimeMean = price;
      if (regime === 'breakout') squeezeCountdown = Math.floor(regimeLength * 0.6);
    }
    regime = regimes[regimeIdx];
    regimeBar++;

    let change: number;
    let volMultiplier = 1.0;
    const baseVolume = getDefaultVolume(symbol);

    switch (regime) {
      case 'trending_up': {
        // Strong uptrend: positive drift + moderate noise
        const drift = volatility * 0.35; // clear upward bias
        change = drift + (Math.random() - 0.5) * volatility * 0.7;
        volMultiplier = 0.8 + Math.random() * 0.6; // normal volume
        break;
      }
      case 'trending_down': {
        // Strong downtrend: negative drift + moderate noise
        const drift = -volatility * 0.30;
        change = drift + (Math.random() - 0.5) * volatility * 0.7;
        volMultiplier = 0.8 + Math.random() * 0.6;
        break;
      }
      case 'mean_reverting': {
        // Price oscillates around regimeMean with mean-reversion pull
        const deviation = (price - regimeMean) / regimeMean;
        const pullback = -deviation * 0.15; // pull back toward mean
        change = pullback + (Math.random() - 0.5) * volatility * 0.8;
        volMultiplier = 0.6 + Math.random() * 0.4; // lower volume
        break;
      }
      case 'breakout': {
        if (squeezeCountdown > 0) {
          // Squeeze phase: very low volatility (Bollinger Band compression)
          change = (Math.random() - 0.5) * volatility * 0.2;
          volMultiplier = 0.3 + Math.random() * 0.3; // very low volume
          squeezeCountdown--;
        } else {
          // Breakout phase: explosive move with high volume
          const direction = Math.random() > 0.4 ? 1 : -1; // slight bullish bias
          change = direction * volatility * (0.5 + Math.random() * 0.8);
          volMultiplier = 2.0 + Math.random() * 2.0; // volume spike
        }
        break;
      }
      case 'choppy':
      default: {
        // Random walk with no clear direction
        change = (Math.random() - 0.5) * volatility;
        volMultiplier = 0.5 + Math.random() * 1.0;
        break;
      }
    }

    const open = price;
    const close = price * (1 + change);

    const highExtra = Math.random() * volatility * 0.5;
    const lowExtra = Math.random() * volatility * 0.5;
    const high = Math.max(open, close) * (1 + highExtra);
    const low = Math.min(open, close) * (1 - lowExtra);

    const volume = baseVolume * volMultiplier;

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

/** Simple string hash for deterministic regime seeding */
function hashCode(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  return hash;
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

  // Commodities
  if (s.includes('WTICO')) return 78;
  if (s.includes('BCO')) return 82;
  if (s.includes('NATGAS')) return 2.8;
  if (s.includes('SOYBN')) return 12.5;
  if (s.includes('CORN')) return 4.8;
  if (s.includes('WHEAT')) return 6.2;
  if (s.includes('SUGAR')) return 0.22;

  // Indices
  if (s.includes('SPX500')) return 5200;
  if (s.includes('NAS100')) return 18200;
  if (s.includes('US30')) return 39500;
  if (s.includes('US2000')) return 2050;
  if (s.includes('UK100')) return 8100;
  if (s.includes('DE30')) return 18400;
  if (s.includes('FR40')) return 8000;
  if (s.includes('EU50')) return 5000;
  if (s.includes('NL25')) return 880;
  if (s.includes('ES35')) return 11200;
  if (s.includes('JP225')) return 39800;
  if (s.includes('AU200')) return 7800;
  if (s.includes('HK33')) return 17500;
  if (s.includes('SG30')) return 3300;
  if (s.includes('CN50')) return 12500;
  if (s.includes('IN50')) return 22000;
  if (s.includes('TWIX')) return 20000;

  // Bonds (price-based, not yield)
  if (s.includes('USB02Y')) return 104;
  if (s.includes('USB05Y')) return 107;
  if (s.includes('USB10Y')) return 112;
  if (s.includes('USB30Y')) return 120;
  if (s.includes('DE10YB')) return 131;
  if (s.includes('UK10YB')) return 98;
  if (s.includes('JP10YB')) return 145;

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
  // Bonds: very low volatility
  if (s.includes('USB') || s.includes('10YB') || s.includes('JP10Y')) return 0.003;
  // Indices: moderate
  if (s.includes('SPX500') || s.includes('NAS100') || s.includes('US30') || s.includes('US2000')) return 0.012;
  if (s.includes('UK100') || s.includes('DE30') || s.includes('FR40') || s.includes('EU50') || s.includes('NL25') || s.includes('ES35')) return 0.012;
  if (s.includes('JP225') || s.includes('AU200') || s.includes('HK33') || s.includes('SG30') || s.includes('CN50') || s.includes('IN50') || s.includes('TWIX')) return 0.015;
  // Commodities: energy high, agricultural moderate
  if (s.includes('WTICO') || s.includes('BCO') || s.includes('NATGAS')) return 0.02;
  if (s.includes('SOYBN') || s.includes('CORN') || s.includes('WHEAT') || s.includes('SUGAR')) return 0.015;
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
