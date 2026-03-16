# Claude Code Best Practices

Reference: https://github.com/Bigwar6868/claude-code-best-practice

## CLAUDE.md
- Keep under 200 lines per file
- Use `.claude/rules/` to split large instructions (this repo does this)
- Root CLAUDE.md for repo-wide conventions, subdirectory files for specifics
- `.claude.local.md` for personal preferences (gitignored)

## Commands, Agents, Skills
- **Commands** (`.claude/commands/`): User-invoked prompt templates for workflows
- **Agents** (`.claude/agents/`): Autonomous actors in fresh isolated context
- **Skills** (`.claude/skills/`): Configurable knowledge, preloadable, auto-discoverable
- Use commands for workflows, not standalone agents
- Feature-specific agents with skills (progressive disclosure) over general-purpose agents
- Say "use subagents" to throw more compute at a problem

## Planning
- Always start with plan mode for complex tasks
- Write detailed specs to reduce ambiguity before implementation
- Spin up a second Claude to review plans as a staff engineer
- Phase-wise gated plans with tests at each phase

## Context Management
- Manual `/compact` at ~50% context usage (avoid "agent dumb zone")
- `/clear` to reset context when switching tasks
- Break subtasks small enough to complete in under 50% context
- Use `Esc Esc` or `/rewind` to undo when Claude goes off-track

## Prompting Tips
- Challenge Claude: "prove to me this works" and diff between branches
- After mediocre fix: "knowing everything you know now, scrap this and implement the elegant solution"
- Paste bugs, say "fix", don't micromanage
- Use `ultrathink` keyword for high-effort reasoning

## Hooks
- SessionStart hook auto-runs `npm install` + `seed-data` in this repo
- Hooks are deterministic scripts outside the agentic loop
- Configure in `.claude/hooks.json`

## Settings
- Think mode on (to see reasoning)
- Permissions: allow wildcards (e.g., `Bash(npm run *)`) over skip-permissions
- Status line for context awareness
