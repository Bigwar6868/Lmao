---
description: Execute a paper trading cycle and report positions
allowed-tools: Bash, Read
---

Execute a paper trading cycle using the Python system:

1. Navigate to `trading-algo-py/` and run a single CEO cycle:
```bash
cd trading-algo-py && python -c "
from main import TradingOrchestrator
orch = TradingOrchestrator()
orch.start_ceo()
result = orch.run_ceo_cycle()
print(f'Cycle {result[\"cycle\"]}: {result.get(\"executed\", 0)} trades, {result.get(\"rejected\", 0)} rejected')
print(f'Risk mode: {result.get(\"risk_mode\", \"?\")}')
print(f'CEO: {result.get(\"ceo_decision\", \"?\")}')

trading = orch._teams.get('trading')
if trading:
    print()
    print(trading.get_portfolio_summary())
"
```

2. Summarize:
   - Signals generated (BUY/SELL) with confidence levels
   - Positions opened or closed
   - Risk mode chosen by CEO
   - Portfolio status (capital, PnL, open positions)
   - Filter/stop activity
