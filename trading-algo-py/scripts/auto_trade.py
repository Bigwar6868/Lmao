"""OANDA auto-trader — scans for signals and executes trades with TP/SL.

Combines the scanner and executor into a single automated pipeline:
1. Scan all forex pairs for signals
2. Filter by confidence, position limits, and duplicate checks
3. Execute via OANDA with ATR-based TP/SL
4. Log all decisions

Usage:
    python -m scripts.auto_trade
    python -m scripts.auto_trade --max-positions 15 --min-confidence 0.6
    MAX_POSITIONS=15 python -m scripts.auto_trade
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import time

from config.settings import config
from config.assets import FOREX_ASSETS
from shared.types import MarketData, SignalAction, Portfolio
from team.market_analyst.oanda import OandaDataFetcher
from team.technical_strategist.strategies import get_all_strategies
from team.risk_manager.risk import RiskManager
from team.executor.oanda import OandaExecutor

logging.basicConfig(
    level=config.log_level,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
)
log = logging.getLogger("auto-trader")

# Configurable via env or CLI
DEFAULT_MAX_POSITIONS = int(os.environ.get("MAX_POSITIONS", "15"))
DEFAULT_MIN_CONFIDENCE = float(os.environ.get("MIN_CONFIDENCE", "0.55"))
DEFAULT_TIMEFRAME = os.environ.get("TRADE_TIMEFRAME", "1h")


def run(
    max_positions: int = DEFAULT_MAX_POSITIONS,
    min_confidence: float = DEFAULT_MIN_CONFIDENCE,
    timeframe: str = DEFAULT_TIMEFRAME,
    dry_run: bool = False,
) -> dict:
    """Run a single auto-trade cycle.

    Returns:
        Summary dict with scan results, trades placed, and skipped reasons.
    """
    if not config.has_oanda_credentials:
        log.error("OANDA credentials not set")
        sys.exit(1)

    fetcher = OandaDataFetcher()
    executor = OandaExecutor()
    risk_mgr = RiskManager()
    strategies = get_all_strategies()

    summary = {
        "signals_found": 0,
        "trades_placed": 0,
        "trades_skipped": 0,
        "skipped_reasons": [],
        "errors": [],
    }

    # ── 1. Check current positions ──────────────────────────────
    open_trades = executor.get_open_trades()
    current_count = len(open_trades)
    open_instruments = {t["instrument"].replace("/", "_") for t in open_trades}

    log.info(
        "Positions: %d/%d | Open: %s",
        current_count, max_positions,
        ", ".join(t["instrument"] for t in open_trades) or "none",
    )

    if current_count >= max_positions:
        msg = f"At max positions ({current_count}/{max_positions}) — skipping scan"
        log.info(msg)
        summary["skipped_reasons"].append(msg)
        return summary

    slots_available = max_positions - current_count

    # ── 2. Get portfolio for risk sizing ────────────────────────
    portfolio = executor.get_portfolio()

    # ── 3. Scan all pairs ───────────────────────────────────────
    candidates = []

    for asset in FOREX_ASSETS:
        instrument = asset.symbol.replace("/", "_")

        # Skip if already have a position in this instrument
        if instrument in open_instruments:
            continue

        try:
            candles = fetcher.fetch_candles(asset.symbol, timeframe, count=100)
            if not candles or len(candles) < 30:
                continue

            market_data = MarketData(
                asset=asset,
                timeframe=timeframe,
                candles=candles,
                last_updated=int(time.time() * 1000),
            )

            for strategy in strategies:
                try:
                    signals = strategy.analyze(market_data)
                    for sig in signals:
                        if sig.action == SignalAction.HOLD:
                            continue
                        if sig.confidence < min_confidence:
                            continue

                        summary["signals_found"] += 1

                        # Risk assessment (includes ATR-based SL/TP)
                        risk = risk_mgr.assess(sig, market_data, portfolio)
                        if not risk.approved:
                            reason = f"{sig.asset.symbol} {sig.action.value} rejected: {risk.reason}"
                            log.info("  SKIP %s", reason)
                            summary["skipped_reasons"].append(reason)
                            summary["trades_skipped"] += 1
                            continue

                        candidates.append({
                            "signal": sig,
                            "risk": risk,
                            "market_data": market_data,
                        })
                except Exception as e:
                    log.warning("Strategy %s on %s: %s", strategy.config.name, asset.symbol, e)

        except Exception as e:
            summary["errors"].append(f"{asset.symbol}: {e}")
            log.warning("Fetch %s failed: %s", asset.symbol, e)

    # Sort by confidence * risk_reward
    candidates.sort(
        key=lambda c: c["signal"].confidence * c["risk"].risk_reward_ratio,
        reverse=True,
    )

    # ── 4. Execute top candidates ───────────────────────────────
    executed_instruments: set[str] = set()

    for candidate in candidates:
        if summary["trades_placed"] >= slots_available:
            log.info("Filled all %d available slots", slots_available)
            break

        sig = candidate["signal"]
        risk = candidate["risk"]
        instrument = sig.asset.symbol.replace("/", "_")

        # One trade per instrument per cycle
        if instrument in executed_instruments:
            continue

        log.info(
            "  TRADE %s %s | conf=%.0f%% | R:R=%.2f | SL=%.5f | TP=%.5f | size=%.2f",
            sig.action.value, sig.asset.symbol,
            sig.confidence * 100, risk.risk_reward_ratio,
            risk.stop_loss_price, risk.take_profit_price,
            risk.recommended_size,
        )

        if dry_run:
            log.info("  [DRY RUN] Would execute — skipping")
            summary["trades_placed"] += 1
            executed_instruments.add(instrument)
            continue

        try:
            order = executor.execute_order(sig, risk)
            log.info(
                "  FILLED %s %s @ %.5f (order=%s)",
                order.side.value, order.asset.symbol,
                order.filled_price, order.broker_order_id,
            )
            summary["trades_placed"] += 1
            executed_instruments.add(instrument)
        except Exception as e:
            error_msg = f"Execute {sig.asset.symbol} failed: {e}"
            log.error("  %s", error_msg)
            summary["errors"].append(error_msg)

    # ── 5. Summary ──────────────────────────────────────────────
    log.info(
        "Cycle complete — signals=%d, placed=%d, skipped=%d, errors=%d",
        summary["signals_found"], summary["trades_placed"],
        summary["trades_skipped"], len(summary["errors"]),
    )

    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description="OANDA auto-trader with TP/SL")
    parser.add_argument(
        "--max-positions", type=int, default=DEFAULT_MAX_POSITIONS,
        help=f"Max concurrent positions (default: {DEFAULT_MAX_POSITIONS}, env: MAX_POSITIONS)",
    )
    parser.add_argument(
        "--min-confidence", type=float, default=DEFAULT_MIN_CONFIDENCE,
        help=f"Minimum signal confidence (default: {DEFAULT_MIN_CONFIDENCE}, env: MIN_CONFIDENCE)",
    )
    parser.add_argument(
        "--timeframe", default=DEFAULT_TIMEFRAME,
        help=f"Candle timeframe (default: {DEFAULT_TIMEFRAME}, env: TRADE_TIMEFRAME)",
    )
    parser.add_argument("--dry-run", action="store_true", help="Scan and assess but don't execute")
    args = parser.parse_args()

    log.info(
        "Auto-trader starting | max_positions=%d | min_conf=%.0f%% | tf=%s | dry_run=%s",
        args.max_positions, args.min_confidence * 100, args.timeframe, args.dry_run,
    )

    run(
        max_positions=args.max_positions,
        min_confidence=args.min_confidence,
        timeframe=args.timeframe,
        dry_run=args.dry_run,
    )


if __name__ == "__main__":
    main()
