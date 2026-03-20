"""Sentiment Analyst -- news keyword scoring and CoinGecko price-momentum proxy."""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field

import requests

from shared.events import event_bus

log = logging.getLogger(__name__)

# ============================================================
# Types
# ============================================================


@dataclass
class SentimentResult:
    asset: str
    score: float          # -1 (very bearish) to 1 (very bullish)
    volume: float         # trading volume (USD) if available
    source: str           # e.g. "coingecko", "none"
    timestamp: int = 0    # epoch ms


# ============================================================
# Constants
# ============================================================

CRYPTO_SYMBOLS: set[str] = {
    "BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "DOGE",
    "AVAX", "DOT", "MATIC", "LINK", "LTC", "ATOM", "UNI", "ARB",
}

SYMBOL_TO_COINGECKO: dict[str, str] = {
    "BTC": "bitcoin",
    "ETH": "ethereum",
    "SOL": "solana",
    "BNB": "binancecoin",
    "XRP": "ripple",
    "ADA": "cardano",
    "DOGE": "dogecoin",
    "AVAX": "avalanche-2",
    "DOT": "polkadot",
    "MATIC": "matic-network",
    "LINK": "chainlink",
    "LTC": "litecoin",
    "ATOM": "cosmos",
    "UNI": "uniswap",
    "ARB": "arbitrum",
}

POSITIVE_WORDS: set[str] = {
    "rally", "surge", "bullish", "growth", "breakout", "profit", "moon",
    "upgrade", "buy", "soar", "gain", "boom", "recover", "optimism",
    "strong", "upside", "outperform", "beat", "positive", "momentum",
    "highs", "record", "advance", "expansion", "confidence",
}

NEGATIVE_WORDS: set[str] = {
    "crash", "bearish", "recession", "dump", "sell", "fear", "risk",
    "downgrade", "panic", "plunge", "loss", "decline", "slump",
    "crisis", "weak", "downside", "underperform", "miss", "negative",
    "collapse", "lows", "contraction", "uncertainty", "volatile",
    "default", "bankruptcy", "layoff", "inflation",
}


# ============================================================
# News Sentiment Analyzer (keyword-based)
# ============================================================

class NewsSentimentAnalyzer:
    """Keyword-based sentiment scoring for text."""

    def analyze_sentiment(self, text: str) -> float:
        """Return a score between -1 (bearish) and 1 (bullish)."""
        words = re.sub(r"[^a-z\s]", "", text.lower()).split()
        if not words:
            return 0.0

        positive_count = sum(1 for w in words if w in POSITIVE_WORDS)
        negative_count = sum(1 for w in words if w in NEGATIVE_WORDS)

        raw = (positive_count - negative_count) / len(words)
        amplified = raw * 10
        clamped = max(-1.0, min(1.0, amplified))

        log.debug(
            "Text sentiment: pos=%d neg=%d total=%d score=%.3f",
            positive_count, negative_count, len(words), clamped,
        )
        return clamped

    def analyze_multiple(self, texts: list[str]) -> float:
        """Average sentiment across multiple texts."""
        if not texts:
            return 0.0
        scores = [self.analyze_sentiment(t) for t in texts]
        return sum(scores) / len(scores)


# ============================================================
# Social Sentiment Analyzer (CoinGecko price-momentum proxy)
# ============================================================

class SocialSentimentAnalyzer:
    """Uses CoinGecko 24h price change as a sentiment proxy for crypto."""

    BASE_URL = "https://api.coingecko.com/api/v3"

    def fetch_crypto_sentiment(self, symbol: str) -> SentimentResult:
        """Fetch crypto sentiment via CoinGecko price momentum."""
        coin_id = SYMBOL_TO_COINGECKO.get(symbol.upper(), symbol.lower())
        try:
            resp = requests.get(
                f"{self.BASE_URL}/coins/{coin_id}",
                params={
                    "localization": "false",
                    "tickers": "false",
                    "market_data": "true",
                    "community_data": "false",
                    "developer_data": "false",
                    "sparkline": "false",
                },
                timeout=10,
            )
            resp.raise_for_status()
            data = resp.json()

            market_data = data.get("market_data", {})
            change_24h: float = market_data.get("price_change_percentage_24h", 0) or 0
            change_7d: float = market_data.get("price_change_percentage_7d", 0) or 0
            volume: float = (market_data.get("total_volume") or {}).get("usd", 0) or 0

            # Convert percentage change to sentiment score (-1 to 1)
            sentiment_day = max(-1.0, min(1.0, change_24h / 10))
            sentiment_week = max(-1.0, min(1.0, change_7d / 20))

            # Weight 24h more heavily
            score = sentiment_day * 0.7 + sentiment_week * 0.3

            log.info(
                "Crypto sentiment %s: 24h=%.2f%% 7d=%.2f%% score=%.3f",
                symbol, change_24h, change_7d, score,
            )

            return SentimentResult(
                asset=symbol.upper(),
                score=round(score, 3),
                volume=round(volume),
                source="coingecko",
                timestamp=int(time.time() * 1000),
            )
        except Exception:
            log.error("Failed to fetch CoinGecko data for %s -- returning neutral", symbol)
            return SentimentResult(
                asset=symbol.upper(),
                score=0.0,
                volume=0.0,
                source="coingecko",
                timestamp=int(time.time() * 1000),
            )


# ============================================================
# Sentiment Analyst (aggregator)
# ============================================================

class SentimentAnalyst:
    """Aggregates news and social sentiment for a list of assets."""

    def __init__(self) -> None:
        self._news_analyzer = NewsSentimentAnalyzer()
        self._social_analyzer = SocialSentimentAnalyzer()
        self._last_scores: list[SentimentResult] = []

    # -- public properties --

    @property
    def news(self) -> NewsSentimentAnalyzer:
        return self._news_analyzer

    @property
    def social(self) -> SocialSentimentAnalyzer:
        return self._social_analyzer

    # -- public methods --

    def analyze(self, assets: list[str]) -> list[SentimentResult]:
        """Analyze sentiment for *assets* and return per-asset scores."""
        log.info("Analyzing sentiment for %d assets", len(assets))

        scores: list[SentimentResult] = []
        for asset in assets:
            try:
                scores.append(self._analyze_one(asset))
            except Exception:
                log.exception("Sentiment analysis failed for %s", asset)

        self._last_scores = scores

        event_bus.emit("sentiment:update", scores, "sentiment-analyst")

        overall = self._compute_overall(scores)
        log.info("Sentiment complete: count=%d overall=%.3f", len(scores), overall)
        return scores

    def get_overall_sentiment(self) -> float:
        """Overall sentiment (-1 to 1) across last analyzed assets."""
        if not self._last_scores:
            log.warning("No sentiment data available -- returning neutral")
            return 0.0
        return self._compute_overall(self._last_scores)

    # -- private --

    def _analyze_one(self, asset: str) -> SentimentResult:
        symbol = asset.upper()
        if symbol in CRYPTO_SYMBOLS:
            return self._social_analyzer.fetch_crypto_sentiment(symbol)

        log.debug("No free sentiment source for %s -- returning neutral", symbol)
        return SentimentResult(
            asset=symbol,
            score=0.0,
            volume=0.0,
            source="none",
            timestamp=int(time.time() * 1000),
        )

    @staticmethod
    def _compute_overall(scores: list[SentimentResult]) -> float:
        if not scores:
            return 0.0
        total_volume = sum(s.volume for s in scores)
        if total_volume > 0:
            return sum(s.score * s.volume for s in scores) / total_volume
        return sum(s.score for s in scores) / len(scores)
