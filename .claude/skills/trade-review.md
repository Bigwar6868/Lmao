---
description: Review closed trades, sync OANDA, update agent reputation
allowed-tools: Bash, Read
---

Run the Post-Trade Reviewer to sync closed trades and update agent performance:

1. Run from `trading-algo-py/`:
```bash
cd trading-algo-py && python -c "
from team.risk_manager.journal import TradeJournal, PostTradeReviewer, ExecutionQualityMonitor

# Trade journal stats
journal = TradeJournal()
stats = journal.get_stats()
print('=== TRADE JOURNAL ===')
print(f'Total trades: {stats[\"total\"]}')
print(f'Wins: {stats[\"wins\"]} | Losses: {stats[\"losses\"]}')
print(f'Win rate: {stats[\"win_rate\"]:.0%}')
print(f'Total PnL: \${stats[\"total_pnl\"]:.2f}')

# Recent trades
recent = journal.get_recent(10)
if recent:
    print()
    print('Recent trades:')
    for t in recent:
        print(f'  {t}')

# Execution quality
monitor = ExecutionQualityMonitor()
print()
print(monitor.format_report())
"
```

2. If the journal CSV exists, also read it:
```bash
head -20 trading-algo-py/data/journal/trades.csv 2>/dev/null || echo "No trade journal yet"
```

3. Summarize:
   - Win rate and PnL performance
   - Best/worst trades
   - Execution quality (slippage)
   - Which agents are performing well vs poorly
