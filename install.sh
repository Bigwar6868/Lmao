#!/usr/bin/env bash
# ============================================================
# Trading Algorithm System — One-Line Installer
# Usage: curl -fsSL https://github.com/Bigwar6868/Lmao/releases/latest/download/install.sh | bash
# ============================================================

set -euo pipefail

REPO="Bigwar6868/Lmao"
BRANCH="main"
DIR="Lmao"
MIN_NODE=20

echo ""
echo "=========================================="
echo "  Trading Algorithm System — Installer"
echo "=========================================="
echo ""

# ── Check Node.js ──────────────────────────────
check_node() {
  if ! command -v node &>/dev/null; then
    echo "[!] Node.js not found."
    echo ""
    if [[ "$OSTYPE" == "darwin"* ]]; then
      echo "Install with Homebrew:"
      echo "  brew install node"
      echo ""
      echo "Or with nvm:"
      echo "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"
      echo "  nvm install 20"
    elif [[ "$OSTYPE" == "msys"* || "$OSTYPE" == "cygwin"* ]]; then
      echo "Install with winget:"
      echo "  winget install OpenJS.NodeJS.LTS"
    else
      echo "Install Node.js 20+: https://nodejs.org/"
    fi
    exit 1
  fi

  NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VER" -lt "$MIN_NODE" ]; then
    echo "[!] Node.js $MIN_NODE+ required. You have $(node -v)."
    echo "    Upgrade: https://nodejs.org/"
    exit 1
  fi
  echo "[+] Node.js $(node -v) detected"
}

# ── Check Git ──────────────────────────────────
check_git() {
  if ! command -v git &>/dev/null; then
    echo "[!] Git not found. Install: https://git-scm.com/"
    exit 1
  fi
  echo "[+] Git $(git --version | awk '{print $3}') detected"
}

# ── Clone ──────────────────────────────────────
clone_repo() {
  if [ -d "$DIR" ]; then
    echo "[+] Directory '$DIR' exists — pulling latest..."
    cd "$DIR"
    git fetch origin "$BRANCH"
    git checkout "$BRANCH"
    git pull origin "$BRANCH"
  else
    echo "[+] Cloning $REPO (branch: $BRANCH)..."
    git clone -b "$BRANCH" "https://github.com/$REPO.git" "$DIR"
    cd "$DIR"
  fi
}

# ── Install Dependencies ──────────────────────
install_deps() {
  echo "[+] Installing dependencies..."
  cd trading-algo
  npm install --silent
  echo "[+] Dependencies installed"
}

# ── Setup .env ─────────────────────────────────
setup_env() {
  if [ ! -f .env ]; then
    cp .env.example .env
    echo "[+] Created .env from .env.example"
    echo "    Edit trading-algo/.env to add your API keys (optional)"
  else
    echo "[+] .env already exists — skipping"
  fi
}

# ── Run Tests ──────────────────────────────────
run_tests() {
  echo "[+] Running tests..."
  if npm run test 2>&1 | tail -5; then
    echo "[+] All tests passed"
  else
    echo "[!] Some tests failed — check output above"
  fi
}

# ── Done ───────────────────────────────────────
print_done() {
  echo ""
  echo "=========================================="
  echo "  Setup Complete!"
  echo "=========================================="
  echo ""
  echo "  cd $(pwd)"
  echo ""
  echo "  npm run paper-trade   # Multi-agent paper trading"
  echo "  npm run backtest      # Backtest all strategies"
  echo "  npm run scan          # Scan for opportunities"
  echo "  npm run diagnose      # Full diagnostic report"
  echo "  npm run evolve        # Evolve strategy DNA"
  echo "  npm run test          # Run 32 unit tests"
  echo ""
  echo "  (Optional) Add API keys to .env for real data:"
  echo "  - Alpha Vantage: https://www.alphavantage.co/support/#api-key"
  echo "  - Alpaca:        https://alpaca.markets/"
  echo "  - FRED:          https://fred.stlouisfed.org/docs/api/api_key.html"
  echo ""
}

# ── Main ───────────────────────────────────────
main() {
  check_node
  check_git
  clone_repo
  install_deps
  setup_env
  run_tests
  print_done
}

main
