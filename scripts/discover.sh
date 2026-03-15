#!/bin/bash
echo "=== Discovering New Claude Code Plugins & MCP Servers ==="
echo ""
echo "--- Top MCP Servers (by stars) ---"
curl -s "https://api.github.com/search/repositories?q=mcp+server+claude&sort=stars&per_page=10" | jq '.items[] | "\(.stargazers_count) stars - \(.full_name): \(.description)"'
echo ""
echo "--- Plugin Marketplaces ---"
curl -s "https://api.github.com/search/repositories?q=claude+code+plugin+marketplace&sort=stars&per_page=5" | jq '.items[] | "\(.stargazers_count) stars - \(.full_name): \(.description)"'
echo ""
echo "Review above and install anything useful via Claude Code."
