---
description: Fetch real market prices via WebFetch and seed the cache for cloud mode
allowed-tools: Bash, Read, Write, WebFetch
---

Fetch real market data and seed the trading algorithm cache:

1. Use WebFetch to get current prices from public APIs:
   - Crypto: fetch from CoinGecko API (`https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,binancecoin,ripple,cardano,avalanche-2,dogecoin&vs_currencies=usd`)
   - Stocks: fetch from a public quote API
2. For each asset, generate realistic OHLCV data using the fetched current price as the latest close
3. Write JSON files to `trading-algo/data/historical/` matching the MarketData format:
   ```json
   {
     "asset": { "symbol": "BTC/USDT", "assetClass": "crypto", "exchange": "binance", "baseCurrency": "BTC", "quoteCurrency": "USDT" },
     "timeframe": "1h",
     "candles": [{ "timestamp": ..., "open": ..., "high": ..., "low": ..., "close": ..., "volume": ... }],
     "lastUpdated": ...
   }
   ```
4. Confirm all files written and run `npm run paper-trade` to verify
