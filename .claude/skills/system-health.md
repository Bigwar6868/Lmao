---
description: Full system health check — diagnostics, filters, margin, execution quality
allowed-tools: Bash, Read
---

Run a comprehensive system health check across all teams:

1. Run from `trading-algo-py/`:
```bash
cd trading-algo-py && python -c "
from main import TradingOrchestrator
from team.risk_manager.filters import TradeFilterEngine
from team.risk_manager.journal import TradeJournal, ExecutionQualityMonitor
from shared.types import Portfolio

orch = TradingOrchestrator(auto_select=False)

# 1. System diagnostics
print('=== SYSTEM DIAGNOSTICS ===')
report = orch.diagnostics.scan()
from team.diagnostics import DiagnosticsEngine
print(DiagnosticsEngine.format_report(report))

# 2. Filter engine status
print('\n=== TRADE FILTERS ===')
engine = TradeFilterEngine()
dummy_portfolio = Portfolio(capital=10000, available_capital=8000, positions=[], total_pnl=0, total_pnl_pct=0, max_drawdown=0, last_updated=0)
print(engine.format_status(dummy_portfolio))

# 3. Execution quality
print('\n=== EXECUTION QUALITY ===')
monitor = ExecutionQualityMonitor()
print(monitor.format_report())

# 4. Trade journal
print('\n=== TRADE JOURNAL ===')
journal = TradeJournal()
stats = journal.get_stats()
print(f'Total: {stats[\"total\"]} | Wins: {stats[\"wins\"]} | Losses: {stats[\"losses\"]} | WR: {stats[\"win_rate\"]:.0%} | PnL: \${stats[\"total_pnl\"]:.2f}')

# 5. Config check
from config.settings import config
print('\n=== CONFIG ===')
print(f'Mode: {config.trading_mode} | Cloud: {config.cloud_mode}')
print(f'Capital: \${config.initial_capital} | Max position: {config.max_position_size_pct}%')
print(f'Leverage: 1:{config.default_leverage} (max 1:{config.max_leverage})')
print(f'Margin call: {config.margin_call_level}% | Stop-out: {config.margin_stop_out_level}%')
print(f'Max drawdown: {config.max_drawdown_pct}%')
"
```

2. Summarize:
   - Overall system health (healthy/degraded/critical)
   - Any filters that are blocking trades (daily loss hit, cooldowns active)
   - Execution quality issues (high slippage)
   - Config sanity check
