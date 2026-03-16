---
description: Run backtests on all trading strategies and report results
allowed-tools: Bash, Read
---

Run a full backtest of the trading algorithm system:

1. Navigate to the trading-algo directory
2. Run `npm run backtest`
3. Read the output and summarize:
   - Which strategies performed best (highest Sharpe ratio)
   - Win rates for each strategy
   - Max drawdown across all strategies
   - Any strategies that need attention
4. If results are saved to `data/journal/learnings.md`, read and include key learnings
