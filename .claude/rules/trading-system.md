# Trading System Rules

## Architecture
- Modular "team" design: each module in `trading-algo/src/team/` handles one domain
- `TradingOrchestrator` in `src/index.ts` coordinates all modules
- Event-driven communication via `src/shared/events.ts`

## Asset Classes
- Crypto (35 pairs): BTC, ETH, SOL, BNB, XRP, ADA, AVAX, DOGE + more vs USDT
- Forex (21 pairs): EUR/USD, GBP/USD, USD/JPY, AUD/USD, USD/CHF, USD/CAD + crosses + emerging
- Asset definitions: `src/config/assets.ts`

## Key Modules
| Module | Path | Purpose |
|--------|------|---------|
| Market Analyst | `team/market-analyst/` | OHLCV data fetching + caching |
| Technical Strategist | `team/technical-strategist/` | 4 strategies (momentum, mean-reversion, breakout, multi-indicator) |
| Risk Manager | `team/risk-manager/` | Kelly criterion, ATR stops, position sizing |
| Executor | `team/executor/` | Live order execution |
| Backtester | `team/backtester/` | Historical performance testing |
| Self-Improver | `team/self-improver/` | Genetic algorithm strategy evolution |

## Cloud Mode
- Auto-detected via `config.cloudMode` in `src/config/index.ts`
- Skips network calls, uses synthetic data, extends cache TTL to 24h
- `npm run seed-data` pre-populates cache for all 56 assets
- Override: `CLOUD_MODE=true|false`

## Data Flow
1. MarketAnalyst checks file cache in `data/historical/`
2. If miss: fetch from API (crypto=ccxt/Binance, forex=Alpha Vantage)
3. If API fails or cloud mode: generate synthetic data via `shared/synthetic.ts`
4. Cache result as JSON, emit `market:data` event
