---
description: Show quant engine dashboard — z-scores, alerts, signals across all assets
allowed-tools: Bash, Read
---

Run the Quant Engine on all assets and display the dashboard:

1. Run from `trading-algo-py/`:
```bash
cd trading-algo-py && python -c "
from team.quant_engine import QuantEngine
from team.market_analyst.analyst import MarketAnalyst
from config.assets import ALL_ASSETS

analyst = MarketAnalyst()
engine = QuantEngine()

print('Feeding market data...')
data_list = analyst.fetch_all(ALL_ASSETS, '1h')
for data in data_list:
    engine.feed_market_data(data)
engine.compute_pair_metrics()

# Dashboard
print(QuantEngine.format_dashboard(engine.get_all_snapshots(), engine.get_pair_snapshots()))

# Alerts
alerts = engine.get_recent_alerts(20)
if alerts:
    print(f'\n=== Alerts ({len(alerts)}) ===')
    for a in alerts:
        print(f'  [{a.alert_type}] {a.symbol}: {a.direction} ({a.value:.2f} vs {a.threshold:.2f}) — {a.details}')

# Signals
signals = []
for asset in ALL_ASSETS:
    signals.extend(engine.generate_signals(asset))
signals.extend(engine.generate_pair_signals())
if signals:
    print(f'\n=== Quant Signals ({len(signals)}) ===')
    for s in sorted(signals, key=lambda x: x.confidence, reverse=True)[:20]:
        print(f'  {s.action.value:4s} {s.asset.symbol:<12s} conf={s.confidence:.2f} [{s.strategy}] {s.reason}')
else:
    print('\nNo quant signals generated')
"
```

2. Summarize:
   - Which pairs have extreme z-scores (mean reversion opportunities)
   - Active alerts and their direction
   - Top quant signals by confidence
   - Any pair spread anomalies
