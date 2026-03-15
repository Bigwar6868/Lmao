#!/bin/bash
set -e
CONFIG_REPO="$HOME/.claude-config"
CLAUDE_HOME="$HOME/.claude"
echo "=== Restoring Claude Code Config ==="
cd "$CONFIG_REPO" && git pull origin main
mkdir -p "$CLAUDE_HOME"
cp -f "$CONFIG_REPO/CLAUDE.md" "$CLAUDE_HOME/CLAUDE.md"
cp -f "$CONFIG_REPO/settings.json" "$CLAUDE_HOME/settings.json"
echo "Config restored. Now re-run MCP server installs:"
cat "$CONFIG_REPO/mcp-servers/installed.txt"
echo ""
echo "Then reinstall plugins via /plugin in Claude Code."
