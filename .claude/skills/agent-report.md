---
description: Report on all trading agents — reputation, win rate, trades, status
allowed-tools: Bash, Read
---

Show agent performance across the trading system:

1. Run from `trading-algo-py/`:
```bash
cd trading-algo-py && python -c "
from main import TradingOrchestrator

orch = TradingOrchestrator(auto_select=False)
orch.start_ceo()

trading = orch._teams.get('trading')
spawner = orch.spawner

print('=== AGENT PERFORMANCE REPORT ===')
print(f'Total agents: {len(spawner.agents)}')
print(f'With brains: {len(spawner._brains)}')
print(f'With loops: {len(spawner._loops)}')
print()

# Sort by reputation
agents = sorted(spawner.agents.values(), key=lambda a: a.reputation, reverse=True)

print(f'{\"Agent\":<35s} {\"Rep\":>5s} {\"Status\":<10s} {\"Signals\":>7s} {\"Wins\":>5s} {\"Loss\":>5s} {\"WR\":>5s} {\"PnL\":>8s} {\"Trades\":>6s}')
print('-' * 95)

for agent in agents:
    h = agent.history
    total = h.successful_trades + h.failed_trades
    wr = (h.successful_trades / total * 100) if total > 0 else 0
    active = agent.get_active_trade_count()
    print(f'{agent.name:<35s} {agent.reputation:5.1f} {agent.status:<10s} {h.total_signals:7d} {h.successful_trades:5d} {h.failed_trades:5d} {wr:4.0f}% {h.total_pnl:8.2f} {active:6d}')

# Summary
active_count = sum(1 for a in agents if a.status == 'active')
probation_count = sum(1 for a in agents if a.status == 'probation')
retired_count = sum(1 for a in agents if a.status == 'retired')
print()
print(f'Active: {active_count} | Probation: {probation_count} | Retired: {retired_count}')

# Best/worst
if agents:
    best = agents[0]
    worst = agents[-1]
    print(f'Best: {best.name} (rep={best.reputation:.1f})')
    print(f'Worst: {worst.name} (rep={worst.reputation:.1f})')
"
```

2. Summarize:
   - Which agents are performing best (highest reputation + win rate)
   - Any agents on probation or close to retirement
   - Which strategies are producing the best agents
   - Active trade count per agent
