---
description: Fetch real market prices via WebFetch and seed the cache for cloud mode
allowed-tools: Bash, Read, Write, WebFetch
---

Fetch real market data and seed the Python trading algorithm cache:

1. Use WebFetch to get current prices from public APIs:
   - Crypto: fetch from CoinGecko API (`https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,binancecoin,ripple,cardano,avalanche-2,dogecoin&vs_currencies=usd`)
   - Stocks: fetch from a public quote API
2. For each asset, generate realistic OHLCV data using the fetched current price as the latest close
3. Write JSON files to `trading-algo-py/data/historical/` matching the MarketData format:
   ```json
   {
     "asset": {"symbol": "BTC/USDT", "asset_class": "crypto", "exchange": "binance", "base_currency": "BTC", "quote_currency": "USDT"},
     "timeframe": "1h",
     "candles": [{"timestamp": ..., "open": ..., "high": ..., "low": ..., "close": ..., "volume": ...}],
     "last_updated": ...
   }
   ```
4. Verify with:
```bash
cd trading-algo-py && python -c "
from team.market_analyst.analyst import MarketAnalyst
from config.assets import ALL_ASSETS
analyst = MarketAnalyst()
data = analyst.fetch_all(ALL_ASSETS[:5], '1h')
for d in data:
    print(f'{d.asset.symbol}: {len(d.candles)} candles, last={d.candles[-1].close:.4f}')
"
```
