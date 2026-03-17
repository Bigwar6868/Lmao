# Trading Algo — Module Guide

## Directory Map
```
src/
├── index.ts                         # TradingOrchestrator — main entry
├── config/
│   ├── index.ts                     # All config (API keys, trading params, cloud mode)
│   └── assets.ts                    # Asset definitions (cryptoAssets, forexAssets)
├── shared/
│   ├── types.ts                     # Candle, MarketData, Signal, AssetInfo interfaces
│   ├── events.ts                    # EventBus — decoupled inter-module communication
│   ├── logger.ts                    # Pino logger factory
│   ├── utils.ts                     # Shared utilities
│   └── synthetic.ts                 # Synthetic OHLCV data generator (cloud fallback)
├── scripts/                         # CLI entry points (backtest, paper-trade, etc.)
└── team/                            # Core trading modules
    ├── market-analyst/              # Data fetching + caching (crypto/forex)
    ├── technical-strategist/        # Indicators + 4 strategy implementations
    ├── risk-manager/                # Kelly criterion, stops, position sizing
    ├── executor/                    # Paper + live order execution
    ├── backtester/                  # Historical performance engine
    ├── self-improver/               # Genetic algorithm evolution
    ├── regime-detector/             # Market regime classification
    ├── macro-economist/             # FRED, calendar, geopolitical
    ├── sentiment-analyst/           # News + social sentiment
    ├── scenario-simulator/          # What-if analysis
    └── diagnostics/                 # System health checks
```

## Key Interfaces (in shared/types.ts)
- `Candle` — OHLCV data point
- `MarketData` — Asset + timeframe + candles array
- `Signal` — Trading signal (BUY/SELL/HOLD + confidence)
- `AssetInfo` — Asset metadata (symbol, class, exchange)

## Testing
```bash
npm run test          # Runs vitest — 4 test files, 32 tests
```
Test files: `backtester.test.ts`, `indicators.test.ts`, `predictive.test.ts`, `risk-manager.test.ts`
