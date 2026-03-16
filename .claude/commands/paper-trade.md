---
description: Execute a paper trading cycle and report positions
allowed-tools: Bash, Read
---

Execute a paper trading cycle:

1. Navigate to the trading-algo directory
2. Run `npm run seed-data` first to ensure cache is populated
3. Run `npm run paper-trade`
4. Summarize the results:
   - Trading mode and active strategies
   - Signals generated (BUY/SELL/HOLD) with confidence levels
   - Positions opened or closed
   - Current portfolio status
   - Risk metrics (drawdown, exposure)
