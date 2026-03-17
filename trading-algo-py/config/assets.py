"""Asset definitions for crypto and forex pairs."""

from shared.types import AssetInfo, AssetClass


def crypto(base: str, quote: str = "USDT", exchange: str = "binance") -> AssetInfo:
    return AssetInfo(
        symbol=f"{base}/{quote}",
        asset_class=AssetClass.CRYPTO,
        exchange=exchange,
        base_currency=base,
        quote_currency=quote,
    )


def forex(base: str, quote: str, exchange: str = "icmarkets") -> AssetInfo:
    return AssetInfo(
        symbol=f"{base}/{quote}",
        asset_class=AssetClass.FOREX,
        exchange=exchange,
        base_currency=base,
        quote_currency=quote,
    )


# ============================================================
# Crypto — Top 30 + DeFi/L2 tokens
# ============================================================

CRYPTO_ASSETS: list[AssetInfo] = [
    # Top 10
    crypto("BTC"), crypto("ETH"), crypto("BNB"), crypto("SOL"), crypto("XRP"),
    crypto("ADA"), crypto("AVAX"), crypto("DOGE"), crypto("DOT"), crypto("MATIC"),
    # 11-20
    crypto("LINK"), crypto("UNI"), crypto("ATOM"), crypto("LTC"), crypto("ETC"),
    crypto("XLM"), crypto("NEAR"), crypto("APT"), crypto("FIL"), crypto("ARB"),
    # 21-30 + DeFi/L2
    crypto("OP"), crypto("INJ"), crypto("SUI"), crypto("SEI"), crypto("TIA"),
    crypto("AAVE"), crypto("MKR"), crypto("CRV"), crypto("DYDX"), crypto("RUNE"),
    # Meme / high-volatility
    crypto("SHIB"), crypto("PEPE"), crypto("WIF"), crypto("BONK"), crypto("FLOKI"),
]

# ============================================================
# Forex — Major, minor, and cross pairs (IC Markets)
# ============================================================

FOREX_ASSETS: list[AssetInfo] = [
    # Majors
    forex("EUR", "USD"), forex("GBP", "USD"), forex("USD", "JPY"),
    forex("USD", "CHF"), forex("AUD", "USD"), forex("USD", "CAD"),
    forex("NZD", "USD"),
    # Crosses
    forex("EUR", "GBP"), forex("EUR", "JPY"), forex("GBP", "JPY"),
    forex("EUR", "CHF"), forex("AUD", "JPY"), forex("EUR", "AUD"),
    forex("GBP", "AUD"), forex("CAD", "JPY"),
    # Emerging
    forex("USD", "MXN"), forex("USD", "ZAR"), forex("USD", "TRY"),
    forex("USD", "SGD"), forex("USD", "HKD"),
]

ALL_ASSETS: list[AssetInfo] = CRYPTO_ASSETS + FOREX_ASSETS

ASSET_BY_SYMBOL: dict[str, AssetInfo] = {a.symbol: a for a in ALL_ASSETS}
