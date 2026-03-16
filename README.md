# Trading Algorithm System

A self-evolving multi-asset trading algorithm with a **multi-agent debate system** built in TypeScript. Covers crypto, stocks, and forex with autonomous agents that propose, challenge, and vote on trades before execution.

## Prerequisites

- **Node.js** >= 20.0.0 (check with `node -v`)
- **npm** (comes with Node.js)
- **Git**

### Install Node.js (if needed)

**macOS:**
```bash
# Using Homebrew
brew install node

# Or using nvm (recommended)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 20
nvm use 20
```

**Windows:**
```bash
# Using winget
winget install OpenJS.NodeJS.LTS

# Or using Chocolatey
choco install nodejs-lts
```

## Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/Bigwar6868/Lmao.git
cd Lmao

# 2. Checkout the feature branch
git checkout claude/trading-algorithm-repo-pmnQ1

# 3. Install dependencies
cd trading-algo
npm install

# 4. Copy env config
cp .env.example .env

# 5. Run tests to verify everything works
npm run test

# 6. Run the system
npm run dev
```

## Environment Variables

Copy `.env.example` to `.env` and fill in your API keys:

```bash
cp .env.example .env
```

| Variable | Required | Free? | Description |
|----------|----------|-------|-------------|
| `ALPHA_VANTAGE_API_KEY` | Optional | Yes (25 req/day) | Stock + forex data. Get key at [alphavantage.co](https://www.alphavantage.co/support/#api-key) |
| `FRED_API_KEY` | Optional | Yes (unlimited) | Macro economic data. Get key at [fred.stlouisfed.org](https://fred.stlouisfed.org/docs/api/api_key.html) |
| `ALPACA_API_KEY` | Optional | Yes (paper) | Stock/crypto trading. Sign up at [alpaca.markets](https://alpaca.markets/) |
| `ALPACA_SECRET` | Optional | Yes (paper) | Alpaca secret key |
| `BINANCE_API_KEY` | Optional | Yes | Crypto exchange data. Sign up at [binance.com](https://www.binance.com/) |
| `BINANCE_SECRET` | Optional | Yes | Binance secret key |

**No API keys?** No problem. The system auto-generates synthetic market data when keys are missing or when running in cloud mode.

```env
# .env — minimal config (works without any API keys)
TRADING_MODE=paper
LOG_LEVEL=info
INITIAL_CAPITAL=10000
```

## Scripts

```bash
npm run dev           # Show system info and available commands
npm run paper-trade   # Multi-agent paper trading (debate + consensus)
npm run backtest      # Backtest all strategies against historical data
npm run analyze       # Run market analysis only
npm run evolve        # Evolve strategy DNA (genetic algorithm)
npm run diagnose      # Full diagnostic scan (swarm + governance + decay)
npm run scan          # Scan all assets for best opportunities
npm run seed-data     # Pre-populate cache with synthetic data
npm run test          # Run unit tests (vitest, 32 tests)
npm run test:watch    # Run tests in watch mode
npm run build         # Compile TypeScript to dist/
```

### Paper Trading with Options

```bash
# Default: 1h timeframe, 60min intervals, all assets
npm run paper-trade

# Custom: 4h timeframe, 30min intervals, crypto only
npm run paper-trade -- 4h 30 crypto

# Options: timeframe | interval (minutes) | asset class (crypto/stocks/forex/all)
npm run paper-trade -- 1h 120 stocks
```

### Backtesting

```bash
# Backtest all strategies on all 109 assets
npm run backtest

# Backtest specific asset class
npm run backtest -- 1h crypto
npm run backtest -- 1d stocks
```

## Asset Coverage

| Class | Count | Examples |
|-------|-------|---------|
| **Crypto** | 35 pairs | BTC, ETH, SOL, BNB, XRP, ADA, AVAX, DOGE, LINK, UNI... (vs USDT) |
| **Stocks** | 54 tickers | AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA, SPY, QQQ, GLD... |
| **Forex** | 20 pairs | EUR/USD, GBP/USD, USD/JPY, AUD/USD, EUR/GBP, GBP/JPY... |

**109 total assets** scanned each cycle.

## Architecture

### System A: Trading Engine

The core trading engine uses a modular "team" design:

| Module | Role |
|--------|------|
| **Market Analyst** | Fetches OHLCV data for crypto (ccxt), stocks, and forex (Alpha Vantage) |
| **Technical Strategist** | 4 strategies: Momentum, Mean-Reversion, Breakout, Multi-Indicator |
| **Risk Manager** | Kelly criterion sizing, ATR-based stops, portfolio correlation checks |
| **Executor** | Paper and live order execution |
| **Backtester** | Historical performance testing with Sharpe, Sortino, drawdown, win rate |
| **Self-Improver** | Genetic algorithm evolving strategy parameters (mutation, crossover, selection) |
| **Regime Detector** | Classifies market regimes (trending bull/bear, range-bound, high volatility, crisis) |
| **Macro Economist** | FRED data, economic calendar (FOMC, CPI, jobs), geopolitical risk |
| **Sentiment Analyst** | News headline sentiment + social momentum scoring |
| **Scenario Simulator** | What-if analysis under different market scenarios |
| **Opportunity Scanner** | Ranks all signals by composite score, selects diversified portfolio |
| **Diagnostics** | System health checks, data quality monitoring |

### System B: Multi-Agent Network

8 autonomous trading agents (2 per strategy) that debate before any trade executes:

| Module | Role |
|--------|------|
| **AgentNetwork** | Message bus for broadcast/unicast between agents |
| **TradingAgent** | Autonomous wrapper — proposes, doubts, supports, tracks reputation |
| **ConsensusEngine** | Reputation-weighted voting to resolve trade debates |
| **AgentSpawner** | Spawns children from top performers, retires bad agents |
| **SkillManager** | Agents auto-learn trading patterns and create reusable plugins |
| **DataSourceManager** | Agents discover missing data and request human API keys |
| **OverfitGuard** | Walk-forward validation prevents curve-fitting |
| **ExplainabilityEngine** | XAI audit trail — explains every decision in plain English |
| **DecayDetector** | Detects when a strategy loses effectiveness over time |
| **GovernanceEngine** | Kill switch, circuit breakers, daily loss limits, human override |

### How the Multi-Agent Cycle Works

```
1. All 8 agents analyze 109 assets independently
2. Agents propose trades (broadcast to all)
3. Other agents DOUBT or SUPPORT proposals
   - RSI overbought? Agent raises doubt
   - EMA misaligned? Agent challenges
   - High confidence? Agent supports
4. ConsensusEngine resolves debates
   - Reputation-weighted voting
   - High-rep agents can VETO bad trades
   - Only approved trades pass through
5. GovernanceEngine checks safety
   - Kill switch / circuit breakers
   - Daily loss limits
   - Human approval for large trades
6. RiskManager sizes the position
7. Executor places the order
8. Outcomes update agent reputation
   - Winners gain reputation (up to 100)
   - Losers lose reputation (down to 0)
   - Below 30 → probation (DNA mutated)
   - Below 15 → retired (replaced by spawn)
9. Top performers spawn children with mutated DNA
10. Cycle repeats
```

## Project Structure

```
trading-algo/
├── src/
│   ├── index.ts                        # TradingOrchestrator (main entry)
│   ├── config/
│   │   ├── index.ts                    # All config + cloud mode detection
│   │   └── assets.ts                   # 109 asset definitions
│   ├── shared/
│   │   ├── types.ts                    # Core types (Candle, Signal, Strategy, Order)
│   │   ├── agent-types.ts              # Multi-agent types (AgentMessage, DebateSession)
│   │   ├── events.ts                   # EventBus (pub/sub)
│   │   ├── logger.ts                   # Pino logger
│   │   ├── utils.ts                    # Helpers
│   │   └── synthetic.ts               # Synthetic data generator
│   ├── scripts/                        # CLI entry points
│   │   ├── paper-trade.ts              # npm run paper-trade
│   │   ├── backtest.ts                 # npm run backtest
│   │   ├── evolve.ts                   # npm run evolve
│   │   ├── analyze.ts                  # npm run analyze
│   │   ├── diagnose.ts                 # npm run diagnose
│   │   ├── scan.ts                     # npm run scan
│   │   └── seed-data.ts               # npm run seed-data
│   └── team/
│       ├── market-analyst/             # Data fetching (crypto/stocks/forex)
│       ├── technical-strategist/       # Indicators + 4 strategies
│       │   └── strategies/
│       │       ├── momentum.ts         # EMA + RSI trend following
│       │       ├── mean-reversion.ts   # Bollinger + RSI reversion
│       │       ├── breakout.ts         # Price breakout + volume
│       │       └── multi-indicator.ts  # MACD + RSI + EMA ensemble
│       ├── risk-manager/               # Kelly, stops, position sizing
│       ├── executor/                   # Paper + live execution
│       ├── backtester/                 # Backtest engine + metrics
│       ├── self-improver/              # Genetic algorithm evolution
│       ├── regime-detector/            # Market regime classification
│       ├── macro-economist/            # FRED, calendar, geopolitical
│       ├── sentiment-analyst/          # News + social sentiment
│       ├── scenario-simulator/         # What-if analysis
│       ├── opportunity-scanner/        # Signal ranking
│       ├── diagnostics/                # Health checks
│       └── agent-network/              # MULTI-AGENT SYSTEM
│           ├── index.ts                # AgentSwarm orchestrator
│           ├── network.ts              # AgentNetwork message bus
│           ├── trading-agent.ts        # TradingAgent (autonomous)
│           ├── consensus.ts            # ConsensusEngine (debate resolver)
│           ├── spawner.ts              # AgentSpawner (lifecycle)
│           ├── skill-manager.ts        # SkillManager (auto-learning)
│           ├── data-source-manager.ts  # DataSourceManager
│           ├── overfit-guard.ts        # Walk-forward validation
│           ├── explainability.ts       # XAI audit trail
│           ├── decay-detector.ts       # Strategy decay detection
│           └── governance.ts           # Kill switch + circuit breakers
├── tests/                              # Unit tests (vitest)
│   ├── backtester.test.ts
│   ├── indicators.test.ts
│   ├── predictive.test.ts
│   └── risk-manager.test.ts
├── data/                               # Runtime data (gitignored)
│   ├── historical/                     # Cached OHLCV data
│   ├── journal/                        # Evolution logs
│   └── results/                        # Performance rankings
├── package.json
├── tsconfig.json
└── .env.example
```

## Strategy Evolution

Strategies evolve using a genetic algorithm:

- **Population**: 15 parameter sets per strategy
- **Mutation rate**: 15% (1-3 params perturbed by +/-15%)
- **Selection**: Tournament selection (pick 2 random, keep fitter)
- **Crossover**: Uniform crossover (each param randomly from parent1 or parent2)
- **Elitism**: Top 2 survive unchanged each generation
- **Fitness**: `(sharpeRatio * winRate * 100) / maxDrawdownPct`

Evolution logs: `data/journal/evolution-log.json` and `data/journal/learnings.md`.

## Risk Management

- **Position sizing**: Kelly criterion (capped at half-Kelly)
- **Stop-loss**: ATR-based dynamic stops (default 2x ATR)
- **Take-profit**: ATR-based targets (default 3x ATR)
- **Portfolio limits**: Max 80% exposure, max 10% single position
- **Correlation check**: Max 0.7 correlation between positions
- **Daily loss circuit breaker**: Halts trading after $500 / 5% daily loss
- **Kill switch**: Emergency stop all trading
- **Human approval**: Required for trades above $5,000

## Cloud Mode

Auto-detected when running in Claude Code cloud sandbox:

- Skips network calls (APIs unreachable)
- Uses synthetic data with 24h cache TTL
- All trading logic runs normally

```bash
# Force cloud mode on/off
CLOUD_MODE=true npm run paper-trade
CLOUD_MODE=false npm run paper-trade
```

## Tech Stack

| Tool | Purpose |
|------|---------|
| **TypeScript** | Language (strict mode, ESM) |
| **Node.js 20+** | Runtime |
| **ccxt** | Crypto exchange data (Binance) |
| **Alpaca** | Stock/crypto trading (paper mode) |
| **Alpha Vantage** | Stock + forex OHLCV data |
| **trading-signals** | Technical indicators |
| **pino** | Structured logging |
| **vitest** | Unit testing |
| **dotenv** | Environment config |
| **tsx** | TypeScript execution (no build step) |

## Troubleshooting

**`npm install` fails on macOS (Apple Silicon):**
```bash
# Some native modules need Rosetta
arch -x86_64 npm install
# Or install with node-gyp
xcode-select --install
npm install
```

**`npm run test` fails:**
```bash
# Make sure you're in the right directory
cd trading-algo
npm install
npm run test
```

**No market data / all synthetic:**
This is normal without API keys. The system works fully with synthetic data. Add API keys to `.env` for real market data.

**Port conflicts / process hanging:**
```bash
# Kill any stuck node processes
pkill -f "tsx src"
```

## License

Private repository. All rights reserved.
