#!/bin/bash
set -euo pipefail

# ── Install gh CLI if missing ──────────────────────────────────────────────────
if ! command -v gh &>/dev/null; then
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  apt-get update -qq && apt-get install -y -qq gh
fi

# ── Authenticate gh with PAT ─────────────────────────────────────────────────
if [ -n "${GITHUB_TOKEN:-}" ]; then
  echo "$GITHUB_TOKEN" | gh auth login --with-token 2>/dev/null || true
  if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    echo "export GITHUB_TOKEN=$GITHUB_TOKEN" >> "$CLAUDE_ENV_FILE"
  fi
fi

# ── Project setup ────────────────────────────────────────────────────────────
cd "${CLAUDE_PROJECT_DIR:-/home/user/Lmao}/trading-algo"
npm install --prefer-offline --no-audit 2>/dev/null || npm install
npm run seed-data 2>/dev/null || true
