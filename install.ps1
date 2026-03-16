# ============================================================
# Trading Algorithm System — Windows Installer (PowerShell)
# Usage: irm https://raw.githubusercontent.com/Bigwar6868/Lmao/claude/trading-algorithm-repo-pmnQ1/install.ps1 | iex
# ============================================================

$ErrorActionPreference = "Stop"

$REPO = "Bigwar6868/Lmao"
$BRANCH = "claude/trading-algorithm-repo-pmnQ1"
$DIR = "Lmao"
$MIN_NODE = 20

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  Trading Algorithm System - Installer" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# -- Check Node.js --
function Check-Node {
    try {
        $nodeVersion = (node -v) -replace 'v', ''
        $major = [int]($nodeVersion.Split('.')[0])
        if ($major -lt $MIN_NODE) {
            Write-Host "[!] Node.js $MIN_NODE+ required. You have v$nodeVersion." -ForegroundColor Red
            Write-Host "    Install: winget install OpenJS.NodeJS.LTS" -ForegroundColor Yellow
            exit 1
        }
        Write-Host "[+] Node.js v$nodeVersion detected" -ForegroundColor Green
    }
    catch {
        Write-Host "[!] Node.js not found." -ForegroundColor Red
        Write-Host "    Install: winget install OpenJS.NodeJS.LTS" -ForegroundColor Yellow
        Write-Host "    Or download: https://nodejs.org/" -ForegroundColor Yellow
        exit 1
    }
}

# -- Check Git --
function Check-Git {
    try {
        $gitVersion = (git --version)
        Write-Host "[+] $gitVersion detected" -ForegroundColor Green
    }
    catch {
        Write-Host "[!] Git not found. Install: https://git-scm.com/" -ForegroundColor Red
        exit 1
    }
}

# -- Clone --
function Clone-Repo {
    if (Test-Path $DIR) {
        Write-Host "[+] Directory '$DIR' exists - pulling latest..." -ForegroundColor Green
        Set-Location $DIR
        git fetch origin $BRANCH
        git checkout $BRANCH
        git pull origin $BRANCH
    }
    else {
        Write-Host "[+] Cloning $REPO (branch: $BRANCH)..." -ForegroundColor Green
        git clone -b $BRANCH "https://github.com/$REPO.git" $DIR
        Set-Location $DIR
    }
}

# -- Install Dependencies --
function Install-Deps {
    Write-Host "[+] Installing dependencies..." -ForegroundColor Green
    Set-Location trading-algo
    npm install --silent
    Write-Host "[+] Dependencies installed" -ForegroundColor Green
}

# -- Setup .env --
function Setup-Env {
    if (-not (Test-Path .env)) {
        Copy-Item .env.example .env
        Write-Host "[+] Created .env from .env.example" -ForegroundColor Green
        Write-Host "    Edit trading-algo\.env to add your API keys (optional)" -ForegroundColor Yellow
    }
    else {
        Write-Host "[+] .env already exists - skipping" -ForegroundColor Green
    }
}

# -- Run Tests --
function Run-Tests {
    Write-Host "[+] Running tests..." -ForegroundColor Green
    npm run test
    if ($LASTEXITCODE -eq 0) {
        Write-Host "[+] All tests passed" -ForegroundColor Green
    }
    else {
        Write-Host "[!] Some tests failed - check output above" -ForegroundColor Yellow
    }
}

# -- Done --
function Print-Done {
    $currentDir = Get-Location
    Write-Host ""
    Write-Host "==========================================" -ForegroundColor Cyan
    Write-Host "  Setup Complete!" -ForegroundColor Cyan
    Write-Host "==========================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  cd $currentDir" -ForegroundColor White
    Write-Host ""
    Write-Host "  npm run paper-trade   # Multi-agent paper trading" -ForegroundColor White
    Write-Host "  npm run backtest      # Backtest all strategies" -ForegroundColor White
    Write-Host "  npm run scan          # Scan for opportunities" -ForegroundColor White
    Write-Host "  npm run diagnose      # Full diagnostic report" -ForegroundColor White
    Write-Host "  npm run evolve        # Evolve strategy DNA" -ForegroundColor White
    Write-Host "  npm run test          # Run 32 unit tests" -ForegroundColor White
    Write-Host ""
    Write-Host "  (Optional) Add API keys to .env for real data:" -ForegroundColor Yellow
    Write-Host "  - Alpha Vantage: https://www.alphavantage.co/support/#api-key" -ForegroundColor Yellow
    Write-Host "  - Alpaca:        https://alpaca.markets/" -ForegroundColor Yellow
    Write-Host "  - FRED:          https://fred.stlouisfed.org/docs/api/api_key.html" -ForegroundColor Yellow
    Write-Host ""
}

# -- Main --
Check-Node
Check-Git
Clone-Repo
Install-Deps
Setup-Env
Run-Tests
Print-Done
