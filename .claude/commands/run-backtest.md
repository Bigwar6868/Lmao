---
description: Run backtests on all trading strategies and report results
allowed-tools: Bash, Read
---

Run a full backtest of the Python trading system:

1. Navigate to `trading-algo-py/` and run backtests:
```bash
cd trading-algo-py && python main.py backtest
```

2. Summarize:
   - Which strategies performed best (highest return %, Sharpe ratio)
   - Win rates for each strategy
   - Max drawdown across all strategies
   - Number of trades per strategy
   - Any strategies with negative returns that need attention
