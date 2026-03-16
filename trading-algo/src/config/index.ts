import 'dotenv/config';

export const config = {
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

  // Data
  dataDir: new URL('../../data', import.meta.url).pathname,
  cacheEnabled: true,
  cacheTtlMs: 60 * 60 * 1000, // 1 hour
} as const;
