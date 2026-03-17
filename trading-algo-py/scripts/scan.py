"""Scanner — scans all OANDA forex pairs across all strategies and timeframes.

Outputs actionable signals (BUY/SELL with confidence >= threshold).
Designed to run on a schedule (e.g., cron every hour).

Usage:
    python -m scripts.scan
    python -m scripts.scan --timeframe 4h --min-confidence 0.6
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time

from config.settings import config
from config.assets import FOREX_ASSETS
from shared.types import AssetInfo, Candle, MarketData, SignalAction
from team.market_analyst.oanda import OandaDataFetcher
from team.technical_strategist.strategies import get_all_strategies

logging.basicConfig(
    level=config.log_level,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
)
log = logging.getLogger("scanner")


def scan(
    timeframe: str = "1h",
    min_confidence: float = 0.5,
    candle_count: int = 100,
) -> list[dict]:
    """Scan all forex pairs with all strategies and return actionable signals."""
    if not config.has_oanda_credentials:
        log.error("OANDA credentials not set — cannot scan")
        sys.exit(1)

    fetcher = OandaDataFetcher()
    strategies = get_all_strategies()
    signals: list[dict] = []

    log.info(
        "Scanning %d pairs | %d strategies | tf=%s | min_conf=%.0f%%",
        len(FOREX_ASSETS), len(strategies), timeframe, min_confidence * 100,
    )

    for asset in FOREX_ASSETS:
        try:
            candles = fetcher.fetch_candles(asset.symbol, timeframe, count=candle_count)
            if not candles or len(candles) < 30:
                log.warning("Not enough candles for %s — skipping", asset.symbol)
                continue

            market_data = MarketData(
                asset=asset,
                timeframe=timeframe,
                candles=candles,
                last_updated=int(time.time() * 1000),
            )

            for strategy in strategies:
                try:
                    result = strategy.analyze(market_data)
                    for sig in result:
                        if sig.action == SignalAction.HOLD:
                            continue
                        if sig.confidence < min_confidence:
                            continue

                        signals.append({
                            "symbol": sig.asset.symbol,
                            "action": sig.action.value,
                            "confidence": round(sig.confidence, 4),
                            "price": sig.price,
                            "strategy": sig.strategy,
                            "timeframe": sig.timeframe,
                            "reason": sig.reason,
                            "indicators": sig.indicators,
                            "timestamp": sig.timestamp,
                        })
                except Exception as e:
                    log.warning("Strategy %s failed on %s: %s", strategy.config.name, asset.symbol, e)

        except Exception as e:
            log.warning("Failed to fetch %s: %s", asset.symbol, e)

    # Sort by confidence descending
    signals.sort(key=lambda s: s["confidence"], reverse=True)

    log.info("Scan complete — %d actionable signals found", len(signals))
    for s in signals:
        log.info(
            "  %s %s | %.0f%% | %s | %s",
            s["action"], s["symbol"], s["confidence"] * 100, s["strategy"], s["reason"],
        )

    return signals


def main() -> None:
    parser = argparse.ArgumentParser(description="Scan forex pairs for trading signals")
    parser.add_argument("--timeframe", default="1h", help="Candle timeframe (default: 1h)")
    parser.add_argument("--min-confidence", type=float, default=0.5, help="Minimum confidence threshold (default: 0.5)")
    parser.add_argument("--candles", type=int, default=100, help="Number of candles to fetch (default: 100)")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    args = parser.parse_args()

    results = scan(
        timeframe=args.timeframe,
        min_confidence=args.min_confidence,
        candle_count=args.candles,
    )

    if args.json:
        print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
