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

  // Timeouts — prevent agents from hanging indefinitely
  agentAnalyzeTimeoutMs: 10_000,      // max time per agent.analyze() call
  networkMessageTimeoutMs: 5_000,      // max time per message handler
  tradingCycleTimeoutMs: 120_000,      // max time for a full trading cycle
  processWatchdogMs: 180_000,          // force-exit if main() hangs

  // Auto-trading (24/7 mode)
  autoTradeCycleMs: Number(process.env.AUTO_TRADE_CYCLE_MS ?? 60_000),       // 1 min between cycles
  autoTradeReviewInterval: Number(process.env.AUTO_TRADE_REVIEW_INTERVAL ?? 10), // review every N cycles
  autoTradeEvolveInterval: Number(process.env.AUTO_TRADE_EVOLVE_INTERVAL ?? 50), // evolve every N cycles

  // Agent Loop (autonomous 24/7 agents)
  agentLoopTickMs: Number(process.env.AGENT_LOOP_TICK_MS ?? 2_000),         // loop tick interval
  agentIdleCooldownMs: Number(process.env.AGENT_IDLE_COOLDOWN_MS ?? 30_000), // min between idle explorations
  agentExploreProbability: Number(process.env.AGENT_EXPLORE_PROB ?? 0.2),    // chance of exploring when idle

  // Ollama / Local LLM (CEO brain + messaging analysis)
  ollamaCeoEndpoint: process.env.OLLAMA_CEO_ENDPOINT ?? process.env.OLLAMA_ENDPOINT ?? '',
  ollamaCeoModel: process.env.OLLAMA_CEO_MODEL ?? process.env.OLLAMA_MODEL ?? 'MiniMax-M1-80k',
  ollamaEndpoint: process.env.OLLAMA_ENDPOINT ?? '',
  ollamaModel: process.env.OLLAMA_MODEL ?? 'llama3',
  ollamaTemperature: Number(process.env.OLLAMA_TEMPERATURE ?? 0.3),
  ollamaTimeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS ?? 60_000),
} as const;
