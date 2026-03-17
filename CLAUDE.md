# CLAUDE.md — Trading Algorithm System

## Identity
- Working with Lushi (GitHub: Bigwar6868)
- MSc Finance @ University of Exeter
- Focus: e-commerce, cross-border business, web dev, finance
- Communication: direct, no fluff, English by default

## Project Overview
Self-evolving multi-asset trading algorithm (crypto/forex) in TypeScript.
- Entry point: `trading-algo/src/index.ts`
- Config: `trading-algo/src/config/index.ts`
- Tests: `trading-algo/tests/` (vitest)

## Quick Reference
```bash
cd trading-algo
npm run test          # Always run before committing
npm run backtest      # Test strategies
npm run paper-trade   # Paper trading cycle
npm run seed-data     # Seed cache (cloud)
npm run diagnose      # System diagnostics
```

## Rules
Detailed rules are split into `.claude/rules/`:
- `trading-system.md` — Architecture, modules, data flow, cloud mode
- `coding-standards.md` — TypeScript, git, testing, dependencies
- `mcp-servers.md` — Installed servers and when to use them

## Commands
Custom commands in `.claude/commands/`:
- `/run-backtest` — Full backtest with analysis
- `/paper-trade` — Paper trading cycle
- `/seed-real-data` — Fetch real prices via WebFetch for cloud mode

## Workflow
1. Check this file and rules before starting work
2. Use server-memory to persist important context
3. Use sequential-thinking for complex problems
4. Always run tests before committing
5. Keep PRs focused and small
6. Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`
7. Feature branches only, never commit to main
8. TypeScript + ESM, always

## Cloud Mode
The system auto-detects Claude Code cloud sandbox:
- Skips network calls (Binance, Alpha Vantage unreachable)
- Uses synthetic data or cached data
- 24h cache TTL instead of 1h
- SessionStart hook auto-seeds 22 assets
- Use `/seed-real-data` to populate with real prices via WebFetch

## Environment
- OS: Windows 11 with Git Bash (MINGW64) / Claude Code Cloud
- Package managers: winget, Chocolatey, npm
- Shell: Git Bash (use Unix-style paths)
- Editor: Cursor (VS Code fork)
