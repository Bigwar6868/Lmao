#!/bin/bash
set -e
CLAUDE_HOME="$HOME/.claude"
CONFIG_REPO="$HOME/.claude-config"
echo "=== Syncing Claude Code Config ==="
cp -f "$CLAUDE_HOME/CLAUDE.md" "$CONFIG_REPO/CLAUDE.md" 2>/dev/null || true
cp -f "$CLAUDE_HOME/settings.json" "$CONFIG_REPO/settings.json" 2>/dev/null || true
claude mcp list > "$CONFIG_REPO/mcp-servers/installed.txt" 2>/dev/null || true
cd "$CONFIG_REPO"
git add -A
git diff --cached --quiet || {
  git commit -m "sync: $(date +%Y-%m-%d_%H:%M) from $(hostname)"
  git push origin main 2>/dev/null || echo "Push failed - set up remote first"
}
echo "Done"
