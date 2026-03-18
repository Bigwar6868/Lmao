Auto-select the best trading strategy for each asset based on backtest performance:

1. Navigate to `trading-algo-py/`
2. Run `PYTHONPATH=. python -c "from main import *; selection = select_best_strategies(); print_selection_report(selection)"`
3. Read the output and summarize:
   - Which strategy was selected for each asset
   - The strategy frequency breakdown (how many assets use each strategy)
   - Any assets where the top strategy has weak metrics (Sharpe < 1.0 or win rate < 30%)
4. The system will now auto-use these selections during `paper-trade` and `auto_trade.py`
5. To refresh: run a new backtest first (`/run-backtest`), then re-run this command

Note: Auto-selection is ON by default in the orchestrator and auto-trader.
To disable: pass `--no-auto-select` to auto_trade.py or `auto_select=False` to TradingOrchestrator.
