# Global Claude Code Instructions

## Identity
- Working with Lushi (GitHub: Bigwar6868)
- MSc Finance @ University of Exeter
- Focus: e-commerce, cross-border business, web dev, finance
- Communication: direct, no fluff, English by default

## Installed MCP Servers
- **server-memory**: Persist important context across sessions. Use for project notes, decisions, and key findings.
- **server-fetch**: Fetch web pages and APIs. Use for documentation lookups and API testing.
- **server-github**: Interact with GitHub repos, issues, PRs. Use for all GitHub operations.
- **server-sequential-thinking**: Break down complex problems step by step. Use for architecture decisions and debugging.
- **server-exa**: AI-powered web search and crawling. Use for research, market analysis, and finding up-to-date information.
- **server-shadcn**: shadcn/ui component context for React, Vue, Svelte. Use when building UIs with shadcn components.
- **server-alpaca**: Alpaca Trading API integration. Use for stock/ETF/crypto/options trading, portfolio management, market data, and watchlists. Paper trading enabled.

## Coding Standards
- TypeScript over JavaScript when possible
- Conventional commits (feat:, fix:, chore:, docs:, refactor:, test:)
- Feature branches, never commit to main directly
- Use gh CLI for all GitHub operations
- Prefer ESM over CommonJS

## Workflow
- Check project CLAUDE.md before starting any work
- Use server-memory to persist important context
- Use sequential-thinking for complex problems
- Always run tests before committing
- Keep PRs focused and small

## Environment
- OS: Windows 11 with Git Bash (MINGW64)
- Package managers: winget, Chocolatey, npm
- Shell: Git Bash (use Unix-style paths)
- Editor: Cursor (VS Code fork)
