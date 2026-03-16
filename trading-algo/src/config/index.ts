import 'dotenv/config';

/**
 * Detect cloud sandbox: CLOUD_MODE env var, or auto-detect by checking
 * for common sandbox indicators (no HOME set, running as root in container).
 */
function detectCloudMode(): boolean {
  if (process.env.CLOUD_MODE === 'true') return true;
  if (process.env.CLOUD_MODE === 'false') return false;
  // Auto-detect: Claude Code cloud sandbox runs as root with limited networking
  const isContainer = process.getuid?.() === 0 && !process.env.USER;
  return isContainer;
}

const cloudMode = detectCloudMode();

export const config = {
  // Cloud
  cloudMode,

  // API Keys
  alphaVantageKey: process.env.ALPHA_VANTAGE_API_KEY ?? 'demo',
  fredApiKey: process.env.FRED_API_KEY ?? '',
  binanceApiKey: process.env.BINANCE_API_KEY ?? '',
  binanceSecret: process.env.BINANCE_SECRET ?? '',
  bybitApiKey: process.env.BYBIT_API_KEY ?? '',
  bybitSecret: process.env.BYBIT_SECRET ?? '',
  alpacaApiKey: process.env.ALPACA_API_KEY ?? '',
  alpacaSecret: process.env.ALPACA_SECRET ?? '',
  alpacaPaper: process.env.ALPACA_PAPER !== 'false',

  // Trading
  tradingMode: (process.env.TRADING_MODE ?? 'paper') as 'paper' | 'live',
  defaultTimeframe: process.env.DEFAULT_TIMEFRAME ?? '1h',
  initialCapital: Number(process.env.INITIAL_CAPITAL ?? 10000),
  maxPositionSizePct: Number(process.env.MAX_POSITION_SIZE_PCT ?? 5),
  maxDrawdownPct: Number(process.env.MAX_DRAWDOWN_PCT ?? 20),

  // System
  logLevel: process.env.LOG_LEVEL ?? 'info',

  // Risk defaults
  kellyFraction: 0.5, // Half-Kelly
  defaultStopLossAtr: 2.0,
  defaultTakeProfitAtr: 3.0,
  maxCorrelation: 0.7,
  maxSectorExposure: 0.3,

  // Evolution
  populationSize: 15,
  mutationRate: 0.15,
  elitismCount: 2,
  generationInterval: 24 * 60 * 60 * 1000, // 24h

  // Data — works in both ESM (import.meta.url) and CJS (bundled) mode
  dataDir: (() => {
    try { return new URL('../../data', import.meta.url).pathname; }
    catch { return require('node:path').resolve(__dirname, '../../data'); }
  })(),
  cacheEnabled: true,
  cacheTtlMs: cloudMode ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000, // 24h in cloud, 1h local
  networkTimeoutMs: cloudMode ? 2_000 : 10_000, // fast fail in cloud
} as const;
