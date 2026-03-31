# Executive Summary — Quant Research

## Scope
- **Universe**: 89 OANDA instruments (68 FX pairs + 21 precious metals)
- **In-sample**: 2016-01-01 to 2021-12-31 (Train)
- **Validation**: 2022-01-01 to 2022-12-31
- **Test**: 2023-01-01 to 2023-12-31 (touched once, final)
- **Out-of-sample**: 2024-01-01 to 2026-03-29 (untouched — no strategy qualified)
- **Data**: Real OANDA mid-price daily candles via v20 API

## Research Statistics
- **Total signals explored**: 25 cross-sectional + 12 time-series signals
- **Total strategy variants tested**: 102
- **Signal types**: momentum (6 lookbacks), mean-reversion (4 lookbacks), trend (3 EMA combos), breakout (2), RSI (2), volatility (2), carry, vol-of-vol, skewness, cross-sectional momentum, combo signals (3), gold trend-following (~48 variants across 10 gold-cross pairs)

## What Came Closest

### FX Mean-Reversion (Z-score 42-day, threshold 2.0) — WEAK/FAILED
- **Train (2016-2021)**: SR=0.36, +6.03%, DD=-5.90%, 1,109 trades
- **Validation (2022)**: SR=-0.40, -1.41% — **degraded significantly**
- **Test (2023)**: SR=1.00, +2.20%, DD=-1.20%, 179 trades, PF=1.19
- **Failed**: PF=1.19 (threshold: 1.2), max month concentration 55.5% (threshold: 40%)
- **Verdict**: The signal is real but too weak and inconsistent. Validation failure indicates parameter instability. Test set recovery may be luck.
- **Why it almost works**: FX pairs are anchored by interest rate differentials and central bank policy. Extreme deviations do revert. But the edge is thin — ~2 bps/day before costs, and costs eat 30-50% of returns.

### Gold Multi-Cross Trend Following — FAILED
- **Train (2016-2021)**: SR=0.49, +29.9%, DD=-16.8% across 10 gold-currency pairs
- **Validation (2022)**: SR=0.25, +1.90%
- **Test (2023)**: SR=0.16, +1.09%, DD=-7.50%, 26 trades — **severe degradation**
- **Failed**: SR=0.16 (threshold: 0.5), PF=1.03 (threshold: 1.2), trades=26 (<30)
- **Why it failed**: Gold's 2016-2021 trend was unusually persistent (central bank buying, COVID). 2022-2023 was choppy. The strategy is not trend-following gold — it's just long gold with a filter. In a mean-reverting gold regime, it underperforms.

## What Definitively Failed
- **Carry trade**: SR=0.03 before costs, -0.14 after. The carry premium in FX is dead or captured by institutional flows.
- **Short-term momentum (1-21 day)**: Negative IC everywhere. FX exhibits strong short-term reversal, not continuation.
- **Cross-sectional momentum**: Mean IC=-0.017 with t=-1.66. Slightly negative — the "momentum" in FX is actually reversal.
- **Breakout signals**: No edge after costs.
- **RSI/mean-reversion at daily horizon**: IC positive but too small to overcome costs with daily trading.

## Key Insights

### What This Data Can Support
1. **FX mean-reversion exists** at the 1-6 week horizon, but the edge is ~1-3 bps/day — barely above transaction costs for major pairs, and below costs for crosses.
2. **Gold trend-following works** in trending regimes but is not robust across regime changes.
3. **Per-instrument signals are stronger than cross-sectional** — each pair has its own dynamics.
4. **Metals show the strongest raw Sharpe** ratios (gold: SR 0.8-1.1 in-sample) but this is largely buy-and-hold drift, not a tradeable edge.

### What This Data Cannot Support
1. **10% daily returns** — physically impossible in FX. Even the best strategies produce ~0-5 bps/day.
2. **High-frequency strategies** on daily data — we need tick or minute data for meaningful HFT analysis.
3. **Crypto strategies** — OANDA doesn't offer crypto. Need separate exchange data.
4. **Strategy combinations** that reliably produce SR>0.5 after costs on this universe.

## Honest Assessment
After testing 102 variants across 89 instruments with 9 years of real data, **no strategy survives the strict viability thresholds** (SR>0.5, PF>1.2, DD<20%, trades>30, no single-month >40% PnL, multi-asset).

The closest candidate (FX MR) missed by a hair on PF and month concentration. With further research on optimal universe selection, adaptive lookbacks, or regime conditioning, it might be salvageable — but that risks overfitting.

## Recommended Next Steps
1. **Hourly data**: Test same signals on 1h candles — more data points and potentially stronger intraday mean-reversion.
2. **Regime filtering**: Apply HMM or vol regime detection to switch between trend-following (gold in trending regimes) and mean-reversion (FX in range regimes).
3. **Real carry data**: Use actual interest rate differentials (from FRED/central banks) instead of price-based carry proxies.
4. **Crypto addition**: Add BTC, ETH, SOL via Binance for momentum strategies — crypto has stronger momentum than FX.
5. **Ensemble approach**: Combine multiple WEAK signals (FX MR + gold trend + vol filter) — diversification may lift the portfolio-level Sharpe above threshold even if individual signals are weak.
6. **Transaction cost reduction**: Use limit orders instead of market orders to reduce slippage. Focus on major pairs only (1.5 pips vs 3.0+ for crosses).

## Integrity Notes
- Test set was touched exactly once per strategy. Neither was re-optimized.
- Gold trend test failure is final — that track is dead per protocol.
- FX MR test is dead — it failed PF and month concentration.
- All results are net of realistic transaction costs.
- Strategy variant counter: 102 (Benjamini-Hochberg adjusted significance level: ~0.005)
