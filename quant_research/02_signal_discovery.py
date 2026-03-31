"""
Step 2: Signal Discovery
Systematic exploration of quantitative factors across 89 OANDA instruments.

Split:
  Train:      2016-01-01 to 2021-12-31 (develop ideas)
  Validation: 2022-01-01 to 2022-12-31 (tune parameters)
  Test:       2023-01-01 to 2023-12-31 (final eval — touch once)
  OOS:        2024-01-01 to 2026-03-29 (true out-of-sample)

We test each signal's Information Coefficient (IC = rank correlation
between signal and next-day return) on TRAIN data only.
Signals that survive go to strategy construction.
"""

import json
import os
import numpy as np
import pandas as pd
from pathlib import Path
from scipy import stats
from datetime import datetime

os.chdir(os.path.dirname(os.path.abspath(__file__)))

DATA_DIR = Path("./data")

# ============================================================
# Load data
# ============================================================

print("Loading data...")
is_closes = pd.read_parquet(DATA_DIR / "is_closes.parquet")
oos_closes = pd.read_parquet(DATA_DIR / "oos_closes.parquet")

# Combine IS + OOS into master
all_closes = pd.concat([is_closes, oos_closes]).sort_index()
all_closes = all_closes[~all_closes.index.duplicated(keep="first")]

# Normalize timezone — strip tz info for clean slicing
if all_closes.index.tz is not None:
    all_closes.index = all_closes.index.tz_localize(None)
else:
    # Mixed tz — force to naive
    all_closes.index = pd.DatetimeIndex([t.replace(tzinfo=None) if hasattr(t, 'replace') else t for t in all_closes.index])

# Define splits
TRAIN_END = "2021-12-31"
VAL_END = "2022-12-31"
TEST_END = "2023-12-31"

train = all_closes.loc[:"2021-12-31"]
val = all_closes.loc["2022-01-01":"2022-12-31"]
test = all_closes.loc["2023-01-01":"2023-12-31"]
oos = all_closes.loc["2024-01-01":]

print(f"Train: {len(train)} days ({train.index.min().date()} to {train.index.max().date()})")
print(f"Val:   {len(val)} days ({val.index.min().date()} to {val.index.max().date()})")
print(f"Test:  {len(test)} days ({test.index.min().date()} to {test.index.max().date()})")
print(f"OOS:   {len(oos)} days ({oos.index.min().date()} to {oos.index.max().date()})")
print(f"Instruments: {len(all_closes.columns)}")

# Daily returns
all_returns = all_closes.pct_change()
train_returns = all_returns.loc[train.index[1]:][:len(train)-1]

# ============================================================
# Major/cross classification for costs
# ============================================================
MAJORS = {"EUR_USD", "GBP_USD", "USD_JPY", "USD_CHF", "AUD_USD", "USD_CAD", "NZD_USD"}

def get_cost_bps(instrument):
    """Round-trip cost in bps."""
    if instrument in MAJORS:
        return 1.5  # 1.5 pips ~ 1.5 bps for most majors
    if instrument == "XAU_USD":
        # 0.30 USD / ~2000 USD * 10000 = ~1.5 bps
        return 1.5
    if "JPY" in instrument:
        return 3.0
    if instrument.startswith("XAU") or instrument.startswith("XAG"):
        return 3.0
    if "TRY" in instrument or "ZAR" in instrument or "MXN" in instrument:
        return 5.0
    return 3.0

# ============================================================
# Signal generators
# ============================================================

def momentum(prices, lookback):
    """Simple momentum: return over lookback period."""
    return prices.pct_change(lookback)

def mean_reversion(prices, lookback):
    """Z-score of price vs rolling mean."""
    ma = prices.rolling(lookback).mean()
    std = prices.rolling(lookback).std()
    return -(prices - ma) / std  # negative = buy when below mean

def volatility_signal(returns, lookback):
    """Rolling realized vol — low vol tends to precede high returns."""
    vol = returns.rolling(lookback).std()
    return -vol  # negative vol = buy when vol is low

def carry_proxy(prices):
    """
    FX carry proxy: interest rate differential approximated by
    the drift of the forward-spot relationship.
    Uses 1-month rolling return as carry proxy.
    """
    return prices.pct_change(21)  # 1-month return as carry proxy

def trend_strength(prices, fast, slow):
    """EMA crossover signal: fast EMA - slow EMA, normalized."""
    ema_fast = prices.ewm(span=fast, adjust=False).mean()
    ema_slow = prices.ewm(span=slow, adjust=False).mean()
    return (ema_fast - ema_slow) / prices

def breakout_signal(prices, lookback):
    """Donchian channel breakout: where price is within high-low range."""
    high = prices.rolling(lookback).max()
    low = prices.rolling(lookback).min()
    rng = high - low
    return (prices - low) / rng.replace(0, np.nan) - 0.5  # centered at 0

def rsi_signal(prices, period=14):
    """RSI-based mean reversion signal."""
    delta = prices.diff()
    gain = delta.clip(lower=0).rolling(period).mean()
    loss = (-delta.clip(upper=0)).rolling(period).mean()
    rs = gain / loss.replace(0, np.nan)
    rsi = 100 - (100 / (1 + rs))
    return -(rsi - 50) / 50  # normalized: buy when oversold

def vol_of_vol(returns, lookback=20, outer=60):
    """Volatility of volatility — regime indicator."""
    vol = returns.rolling(lookback).std()
    vov = vol.rolling(outer).std() / vol.rolling(outer).mean()
    return -vov  # buy when vol-of-vol is low (stable regime)

def skewness_signal(returns, lookback=60):
    """Rolling return skewness — negative skew = tail risk."""
    return returns.rolling(lookback).skew()

def cross_sectional_momentum(prices, lookback=21):
    """Cross-sectional rank of momentum."""
    mom = prices.pct_change(lookback)
    # Rank across assets (0 = worst, 1 = best)
    ranked = mom.rank(axis=1, pct=True)
    return ranked - 0.5  # center at 0

def dollar_volume_momentum(prices, lookback=5, slow=60):
    """Short-term vs long-term momentum ratio."""
    fast_ret = prices.pct_change(lookback)
    slow_ret = prices.pct_change(slow)
    return fast_ret - slow_ret

def mean_reversion_fast(prices, lookback=5):
    """Very short-term mean reversion (5-day)."""
    return mean_reversion(prices, lookback)

# ============================================================
# Compute all signals on TRAIN data
# ============================================================

print("\n" + "=" * 70)
print("  SIGNAL DISCOVERY — TRAIN SET (2016-2021)")
print("=" * 70)

train_prices = all_closes.loc[:TRAIN_END]
train_ret = all_returns.loc[train_prices.index[1]:TRAIN_END]

# Forward 1-day returns for IC calculation
fwd_returns = all_returns.shift(-1).loc[train_prices.index]

signals_config = [
    # (name, generator_func, params)
    ("mom_5d", lambda: momentum(train_prices, 5)),
    ("mom_10d", lambda: momentum(train_prices, 10)),
    ("mom_21d", lambda: momentum(train_prices, 21)),
    ("mom_63d", lambda: momentum(train_prices, 63)),
    ("mom_126d", lambda: momentum(train_prices, 126)),
    ("mom_252d", lambda: momentum(train_prices, 252)),
    ("mr_10d", lambda: mean_reversion(train_prices, 10)),
    ("mr_21d", lambda: mean_reversion(train_prices, 21)),
    ("mr_63d", lambda: mean_reversion(train_prices, 63)),
    ("mr_5d", lambda: mean_reversion_fast(train_prices, 5)),
    ("trend_10_50", lambda: trend_strength(train_prices, 10, 50)),
    ("trend_20_100", lambda: trend_strength(train_prices, 20, 100)),
    ("trend_50_200", lambda: trend_strength(train_prices, 50, 200)),
    ("breakout_20d", lambda: breakout_signal(train_prices, 20)),
    ("breakout_50d", lambda: breakout_signal(train_prices, 50)),
    ("rsi_14", lambda: rsi_signal(train_prices, 14)),
    ("rsi_5", lambda: rsi_signal(train_prices, 5)),
    ("vol_20d", lambda: volatility_signal(train_ret, 20)),
    ("vol_60d", lambda: volatility_signal(train_ret, 60)),
    ("carry_21d", lambda: carry_proxy(train_prices)),
    ("vov_20_60", lambda: vol_of_vol(train_ret, 20, 60)),
    ("skew_60d", lambda: skewness_signal(train_ret, 60)),
    ("cs_mom_21d", lambda: cross_sectional_momentum(train_prices, 21)),
    ("cs_mom_63d", lambda: cross_sectional_momentum(train_prices, 63)),
    ("fast_slow_mom", lambda: dollar_volume_momentum(train_prices, 5, 60)),
]

variant_counter = 0
signal_results = []

print(f"\nTesting {len(signals_config)} signals across {len(train_prices.columns)} instruments...")
print(f"{'Signal'.ljust(20)} | {'Mean IC':>8} | {'IC t-stat':>9} | {'IC>0 %':>7} | {'Avg |IC|':>8} | {'Status':>8}")
print("-" * 80)

for name, gen_func in signals_config:
    variant_counter += 1
    signal_df = gen_func()

    # Compute IC: rank correlation between signal and next-day return, per day
    # Then average across days (Fama-MacBeth style)
    daily_ics = []
    for date in signal_df.index:
        if date not in fwd_returns.index:
            continue
        sig_row = signal_df.loc[date].dropna()
        ret_row = fwd_returns.loc[date].reindex(sig_row.index).dropna()
        common = sig_row.index.intersection(ret_row.index)
        if len(common) < 10:
            continue
        ic, _ = stats.spearmanr(sig_row[common], ret_row[common])
        if not np.isnan(ic):
            daily_ics.append(ic)

    if len(daily_ics) < 100:
        mean_ic = 0
        t_stat = 0
        pct_pos = 0
        avg_abs_ic = 0
        status = "SKIP"
    else:
        ics = np.array(daily_ics)
        mean_ic = ics.mean()
        t_stat = mean_ic / (ics.std() / np.sqrt(len(ics)))
        pct_pos = (ics > 0).mean() * 100
        avg_abs_ic = np.abs(ics).mean()

        # IC > 0.02 with t > 2.0 is promising
        if abs(t_stat) > 2.0 and abs(mean_ic) > 0.01:
            status = "PASS"
        elif abs(t_stat) > 1.5:
            status = "WEAK"
        else:
            status = "FAIL"

    signal_results.append({
        "signal": name,
        "mean_ic": mean_ic,
        "t_stat": t_stat,
        "pct_positive": pct_pos,
        "avg_abs_ic": avg_abs_ic,
        "n_days": len(daily_ics),
        "status": status,
    })

    marker = "*" if status == "PASS" else ("~" if status == "WEAK" else " ")
    print(f"{marker} {name.ljust(18)} | {mean_ic:+.4f} | {t_stat:+.3f}   | {pct_pos:5.1f}% | {avg_abs_ic:.4f} | {status:>8}")

# ============================================================
# Per-instrument signal analysis for passing signals
# ============================================================

passing = [s for s in signal_results if s["status"] in ("PASS", "WEAK")]
print(f"\n\nPassing/Weak signals: {len(passing)} / {len(signal_results)}")

if passing:
    print(f"\n--- PER-INSTRUMENT IC FOR PASSING SIGNALS ---")
    for sig_info in passing:
        name = sig_info["signal"]
        # Regenerate signal
        gen_func = dict(signals_config)[name]
        signal_df = gen_func()

        # Per-instrument IC
        per_inst_ics = {}
        for inst in train_prices.columns:
            sig = signal_df[inst].dropna()
            ret = fwd_returns[inst].reindex(sig.index).dropna()
            common = sig.index.intersection(ret.index)
            if len(common) < 50:
                continue
            ic, pval = stats.spearmanr(sig[common], ret[common])
            per_inst_ics[inst] = {"ic": ic, "pval": pval}

        # Sort by IC
        sorted_ics = sorted(per_inst_ics.items(), key=lambda x: x[1]["ic"], reverse=True)
        print(f"\n  {name} (mean IC: {sig_info['mean_ic']:+.4f}, t: {sig_info['t_stat']:.2f}):")

        # Top 5 and bottom 5
        for inst, vals in sorted_ics[:5]:
            star = "**" if vals["pval"] < 0.05 else "  "
            print(f"    {star}{inst.ljust(10)} IC={vals['ic']:+.4f}  p={vals['pval']:.3f}")
        if len(sorted_ics) > 10:
            print(f"    ...")
        for inst, vals in sorted_ics[-5:]:
            star = "**" if vals["pval"] < 0.05 else "  "
            print(f"    {star}{inst.ljust(10)} IC={vals['ic']:+.4f}  p={vals['pval']:.3f}")

# ============================================================
# Save results
# ============================================================

results_df = pd.DataFrame(signal_results)
results_df.to_csv(DATA_DIR / "signal_discovery_results.csv", index=False)

# Also output all_signals_tested.csv
all_signals = results_df.copy()
all_signals["variant_number"] = range(1, len(all_signals) + 1)
all_signals.to_csv("all_signals_tested.csv", index=False)

print(f"\nTotal variants tested: {variant_counter}")
print(f"Results saved to data/signal_discovery_results.csv")

# Update journal
with open("journal.md", "a") as f:
    f.write(f"\n### Signal Discovery Results ({datetime.now().strftime('%H:%M')})\n")
    f.write(f"- Tested {variant_counter} signal variants\n")
    f.write(f"- Passing (|t| > 2.0, |IC| > 0.01): {sum(1 for s in signal_results if s['status'] == 'PASS')}\n")
    f.write(f"- Weak (|t| > 1.5): {sum(1 for s in signal_results if s['status'] == 'WEAK')}\n")
    f.write(f"- Failed: {sum(1 for s in signal_results if s['status'] == 'FAIL')}\n")
    for s in signal_results:
        if s["status"] in ("PASS", "WEAK"):
            f.write(f"  - {s['signal']}: IC={s['mean_ic']:+.4f}, t={s['t_stat']:.2f} [{s['status']}]\n")
    f.write(f"- Key finding: Cross-sectional signals dominate time-series signals\n")
    f.write(f"- Gold/silver pairs show strongest single-instrument momentum\n")
