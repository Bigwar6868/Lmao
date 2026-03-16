# Trading Algorithm System

A self-evolving multi-asset trading algorithm built in TypeScript. Covers crypto, stocks, and forex with genetic strategy optimization, backtesting, paper trading, and risk management.

## Architecture

The system uses a modular "team" design where each component handles a specific domain:

| Module | Role |
|---|---|
| **Market Analyst** | Fetches and processes OHLCV data for crypto (ccxt), stocks, and forex |
| **Technical Strategist** | Runs 4 strategies: Momentum, Mean-Reversion, Breakout, Multi-Indicator |
| **Risk Manager** | Kelly criterion sizing, ATR-based stops, portfolio correlation checks |
| **Executor** | Paper and live order execution (Alpaca integration) |
| **Backtester** | Historical performance testing with Sharpe, win rate, max drawdown metrics |
| **Self-Improver** | Genetic algorithm that evolves strategy parameters over time |
| **Regime Detector** | Identifies market regimes (trending, ranging, volatile) |
| **Macro Economist** | Tracks FRED data, economic calendar, geopolitical events |
| **Sentiment Analyst** | News and social media sentiment scoring |
| **Diagnostics** | System health checks and performance monitoring |

The `TradingOrchestrator` coordinates all modules through analysis cycles, trading cycles, backtests, and evolution runs.

## Asset Coverage

- **Crypto** (8 pairs): BTC, ETH, SOL, BNB, XRP, ADA, AVAX, DOGE (vs USDT)
- **Stocks** (8): AAPL, MSFT, GOOGL, AMZN, TSLA, NVDA, META, SPY
- **Forex** (6 pairs): EUR/USD, GBP/USD, USD/JPY, AUD/USD, USD/CAD, NZD/USD

## Getting Started

```bash
cd trading-algo
npm install
```

Copy `.env.example` to `.env` and fill in your API keys:

```bash
cp .env.example .env
```

## Scripts

```bash
npm run dev           # Run the main orchestrator
npm run backtest      # Backtest all strategies against historical data
npm run paper-trade   # Execute a live paper trading cycle
npm run analyze       # Run market analysis only
npm run evolve        # Evolve strategy parameters (genetic algorithm)
npm run diagnose      # Full system diagnostic scan
npm run seed-data     # Pre-populate cache with synthetic data (cloud mode)
npm run test          # Run unit tests (vitest)
```

## Cloud Mode (Claude Code Web/Mobile)

The system auto-detects when running in a Claude Code cloud sandbox and activates **cloud mode**:

- **Skips network calls** — no waiting for API timeouts (Binance, Alpha Vantage, FRED are unreachable)
- **Extended cache TTL** — 24 hours instead of 1 hour, so seeded data stays valid
- **Stale cache reuse** — even expired cache is used instead of discarded
- **Auto-seeds on session start** — the SessionStart hook runs `npm run seed-data` to populate all 22 assets

### How it works

1. On session start, `seed-data` generates synthetic OHLCV data for all assets
2. All fetchers detect `cloudMode` and return synthetic data immediately (no network delay)
3. The cache layer accepts stale data rather than re-fetching
4. Trading logic, strategies, backtesting, and evolution all run normally

### Seeding real data in cloud

Claude Code (the AI) can replace synthetic data with real prices:

```
"Fetch the current BTC price and seed the cache with real data"
```

Claude will use WebFetch to get real market data from public APIs, then write JSON files directly to `data/historical/` — the algo reads from cache on the next run.

### Manual override

```bash
CLOUD_MODE=true npm run paper-trade    # Force cloud mode
CLOUD_MODE=false npm run paper-trade   # Force local mode (try network)
```

## Strategy Evolution

Strategies evolve using a genetic algorithm:

- **Population**: 25 parameter sets per strategy
- **Mutation rate**: 15%
- **Generation interval**: 24 hours
- **Selection**: Tournament selection based on Sharpe ratio, win rate, and drawdown

Evolution logs are saved to `data/journal/evolution-log.json` and learnings to `data/journal/learnings.md`.

## Risk Management

- Position sizing via Kelly criterion (capped at half-Kelly)
- ATR-based dynamic stop-losses and take-profits
- Portfolio-level correlation checks to avoid concentrated exposure
- Max drawdown circuit breaker (configurable, default 15%)
- Per-trade risk limit (default 2% of portfolio)

## Tech Stack

- **Runtime**: Node.js + TypeScript (ESM)
- **Exchange**: ccxt (crypto), Alpaca (stocks)
- **Indicators**: trading-signals
- **Testing**: vitest
- **Logging**: pino
- **Scheduling**: node-cron

## Project Structure

```
trading-algo/
├── src/
│   ├── index.ts                    # Main orchestrator
│   ├── config/                     # Configuration & asset definitions
│   ├── shared/                     # Types, logger, events, utilities
│   ├── scripts/                    # CLI entry points
│   └── team/                       # Core modules
│       ├── backtester/             # Backtesting engine & metrics
│       ├── executor/               # Paper & live trading
│       ├── technical-strategist/   # Indicators, signals, strategies
│       ├── risk-manager/           # Position sizing & stops
│       ├── market-analyst/         # Data fetching (crypto/stocks/forex)
│       ├── macro-economist/        # Macro environment analysis
│       ├── sentiment-analyst/      # News & social sentiment
│       ├── self-improver/          # Strategy evolution & journaling
│       ├── regime-detector/        # Market regime detection
│       ├── scenario-simulator/     # Scenario analysis
│       └── diagnostics/            # System health checks
├── tests/                          # Unit tests
├── data/                           # Runtime data (gitignored)
│   ├── historical/                 # Cached OHLCV data
│   ├── journal/                    # Evolution logs & learnings
│   └── results/                    # Performance history & rankings
└── package.json
```

## MCP Servers

The repo includes configuration for these Claude Code MCP servers:

- **server-memory** — Persist context across sessions
- **server-github** — GitHub API integration
- **server-fetch** — HTTP client for APIs
- **server-sequential-thinking** — Structured problem-solving
- **server-exa** — AI-powered web search
- **server-shadcn** — shadcn/ui components
- **server-alpaca** — Alpaca Trading API (paper trading)

## License

Private repository. All rights reserved.
