# Coding Standards

## TypeScript
- TypeScript over JavaScript, always
- ESM imports (`import`/`export`), never CommonJS (`require`)
- Strict mode enabled
- Use `type` imports for type-only imports

## Git
- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`
- Feature branches only, never commit to main
- Use `gh` CLI for all GitHub operations
- Keep PRs focused and small

## Testing
- Vitest for unit tests in `trading-algo/tests/`
- Always run `npm run test` before committing
- Test files mirror source structure: `tests/backtester.test.ts` → `src/team/backtester/`

## Project Scripts
```
npm run dev           # Main orchestrator
npm run backtest      # Backtest all strategies
npm run live-trade    # Live trading cycle
npm run analyze       # Market analysis only
npm run evolve        # Evolve strategy parameters
npm run diagnose      # System diagnostics
npm run seed-data     # Seed cache (cloud mode)
npm run test          # Run unit tests
```

## Dependencies
- `ccxt` — Crypto exchange data
- `trading-signals` — Technical indicators
- `axios` — HTTP client
- `pino` — Logging
- `vitest` — Testing
