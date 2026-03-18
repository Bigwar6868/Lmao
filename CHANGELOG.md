# Changelog

All notable changes to the Trading Algorithm System are documented here.
Format: [version] — date — summary

---

## [2.1.0] — 2026-03-18

### Features
- Console messages for every trade and evolution event (real-time visibility)
- Test-runner hook with mutation logging on every commit
- Session-start hook with gh CLI install and GitHub auth
- Dynamic OANDA instrument discovery at startup
- Trailing stops, conflict resolution, position eviction
- OANDA v20 connector for forex data and live execution
- Auto-strategy selector — picks best strategy per asset from backtest results
- Full ICT playbook: Silver Bullet, ICT 2022, enhanced SMC strategies
- SMC/ICT Smart Money Concepts trading strategy
- Auto-evolution system with persistence, bounds, multi-asset support
- Telegram bot for monitoring and controlling trades
- Scanner and auto-trader scripts with ATR-based TP/SL

### Fixes
- Guard SL/TP direction validity before sending to OANDA
- Auto-trader timeout — cache signals, fire-and-forget brain call

---

## [2.0.1] — 2025-12-01

### Fixes
- TP/SL with correct price precision per instrument
- Route live portfolio/P&L queries to OANDA instead of paper trader
- Align OANDA integration with official v20 development guide

---

## [2.0.0] — 2025-11-01

### Features
- OANDA v20 REST API integration for forex trading
- Rewrite trading system in TypeScript (migrated from Python)
- IC Markets cTrader integration (Python prototype)

---

## [1.0.0] — 2025-06-01

### Features
- Initial multi-asset trading algorithm (crypto + forex)
- 4 core strategies: momentum, mean-reversion, breakout, multi-indicator
- Kelly criterion risk manager with ATR stops
- Paper trading executor
- Backtesting engine
- Genetic algorithm self-improver
- Cloud mode with synthetic data fallback
