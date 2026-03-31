"""
Step 3: Deep Signal Search
First pass found no PASS signals. Now testing:
1. Time-series (per-instrument) momentum/MR — not cross-sectional
2. Combo signals (momentum + vol filter)
3. Regime-conditional signals
4. Longer holding periods (5-day, 21-day forward returns)
5. Gold/metals specifically (showed highest raw Sharpe)
"""

import json
import os
import numpy as np
import pandas as pd
from pathlib import Path
from scipy import stats
import warnings
warnings.filterwarnings("ignore")

os.chdir(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = Path("./data")

# Load
is_closes = pd.read_parquet(DATA_DIR / "is_closes.parquet")
oos_closes = pd.read_parquet(DATA_DIR / "oos_closes.parquet")
all_closes = pd.concat([is_closes, oos_closes]).sort_index()
all_closes = all_closes[~all_closes.index.duplicated(keep="first")]
if all_closes.index.tz is not None:
    all_closes.index = all_closes.index.tz_localize(None)
else:
    all_closes.index = pd.DatetimeIndex([t.replace(tzinfo=None) if hasattr(t, 'replace') else t for t in all_closes.index])

all_returns = all_closes.pct_change()
train_prices = all_closes.loc[:"2021-12-31"]
train_ret = all_returns.loc[train_prices.index[1]:"2021-12-31"]

MAJORS = {"EUR_USD", "GBP_USD", "USD_JPY", "USD_CHF", "AUD_USD", "USD_CAD", "NZD_USD"}
GOLD = [c for c in all_closes.columns if c.startswith("XAU")]
SILVER = [c for c in all_closes.columns if c.startswith("XAG")]
METALS = GOLD + SILVER

# Cost in return terms per instrument
def get_cost(inst):
    if inst in MAJORS: return 0.00015  # 1.5 pips
    if inst == "XAU_USD": return 0.30 / 2000  # ~1.5 bps
    if "JPY" in inst: return 0.0003
    if inst.startswith("XAU") or inst.startswith("XAG"): return 0.0003
    if "TRY" in inst or "ZAR" in inst or "MXN" in inst: return 0.0005
    return 0.0003

variant_counter = 25  # continuing from previous script
results_all = []

def hr(title):
    print("\n" + "=" * 70)
    print(f"  {title}")
    print("=" * 70)

# ============================================================
# TIME-SERIES SIGNAL TESTING (per-instrument IC)
# ============================================================
hr("TIME-SERIES SIGNALS (per-instrument)")

def ts_test(signal_name, signal_series, fwd_ret_series, instrument, holding=1):
    """Test a single instrument's time-series signal.
    Returns IC, t-stat, n_obs."""
    sig = signal_series.dropna()
    fwd = fwd_ret_series.reindex(sig.index).dropna()
    common = sig.index.intersection(fwd.index)
    if len(common) < 100:
        return None
    ic, pval = stats.spearmanr(sig[common], fwd[common])
    n = len(common)
    t = ic * np.sqrt(n - 2) / np.sqrt(1 - ic**2) if abs(ic) < 1 else 0
    return {"instrument": instrument, "signal": signal_name, "ic": ic,
            "t_stat": t, "pval": pval, "n": n, "holding": holding}

# Forward returns for different holding periods
fwd_1d = all_returns.shift(-1).loc[train_prices.index]
fwd_5d = all_closes.pct_change(5).shift(-5).loc[train_prices.index]
fwd_21d = all_closes.pct_change(21).shift(-21).loc[train_prices.index]

ts_signals = {
    "mom_5d": lambda p: p.pct_change(5),
    "mom_21d": lambda p: p.pct_change(21),
    "mom_63d": lambda p: p.pct_change(63),
    "mr_zscore_10": lambda p: -(p - p.rolling(10).mean()) / p.rolling(10).std(),
    "mr_zscore_21": lambda p: -(p - p.rolling(21).mean()) / p.rolling(21).std(),
    "mr_zscore_63": lambda p: -(p - p.rolling(63).mean()) / p.rolling(63).std(),
    "rsi_14": lambda p: _rsi(p, 14),
    "ema_cross_10_50": lambda p: (p.ewm(span=10).mean() - p.ewm(span=50).mean()) / p,
    "ema_cross_20_100": lambda p: (p.ewm(span=20).mean() - p.ewm(span=100).mean()) / p,
    "breakout_20": lambda p: (p - p.rolling(20).min()) / (p.rolling(20).max() - p.rolling(20).min()),
    "vol_ratio_5_60": lambda p: p.pct_change().rolling(5).std() / p.pct_change().rolling(60).std(),
    "range_pct": lambda p: (p.rolling(20).max() - p.rolling(20).min()) / p,
}

def _rsi(prices, period):
    delta = prices.diff()
    gain = delta.clip(lower=0).rolling(period).mean()
    loss = (-delta.clip(upper=0)).rolling(period).mean()
    rs = gain / loss.replace(0, np.nan)
    rsi = 100 - (100 / (1 + rs))
    return -(rsi - 50) / 50

ts_results = []

for sig_name, sig_func in ts_signals.items():
    variant_counter += 1
    for inst in train_prices.columns:
        prices = train_prices[inst].dropna()
        if len(prices) < 100:
            continue
        sig = sig_func(prices)

        for holding, fwd in [("1d", fwd_1d), ("5d", fwd_5d), ("21d", fwd_21d)]:
            result = ts_test(f"{sig_name}_h{holding}", sig, fwd[inst], inst, holding)
            if result:
                ts_results.append(result)

ts_df = pd.DataFrame(ts_results)

# Aggregate: which signal × holding combos have the most instruments with |t| > 2?
print(f"\nTested {variant_counter} variants total")
print(f"\nSignal × Holding: count of instruments with |t| > 2.0:")
print(f"{'Signal'.ljust(25)} | {'N sig':>5} | {'Mean IC':>8} | {'Median IC':>9} | {'% IC>0':>7}")
print("-" * 70)

sig_holding_groups = ts_df.groupby("signal")
for name, group in sorted(sig_holding_groups, key=lambda x: -x[1]["ic"].abs().mean()):
    n_sig = (group["t_stat"].abs() > 2.0).sum()
    mean_ic = group["ic"].mean()
    median_ic = group["ic"].median()
    pct_pos = (group["ic"] > 0).mean() * 100
    marker = "*" if n_sig > 15 else " "
    print(f"{marker} {name.ljust(23)} | {n_sig:5} | {mean_ic:+.4f} | {median_ic:+.4f} | {pct_pos:5.1f}%")

    results_all.append({
        "signal": name, "mean_ic": mean_ic, "t_stat": 0, "n_significant": n_sig,
        "pct_positive": pct_pos, "status": "PASS" if n_sig > 20 else ("WEAK" if n_sig > 10 else "FAIL")
    })

# ============================================================
# GOLD/METALS FOCUSED ANALYSIS
# ============================================================
hr("GOLD/METALS FOCUSED ANALYSIS")

gold_results = ts_df[ts_df["instrument"].isin(METALS)]
print(f"\nMetals instruments: {len(METALS)}")
print(f"\nTop signals for metals (by mean IC):")

metal_agg = gold_results.groupby("signal").agg(
    mean_ic=("ic", "mean"),
    n_sig=("t_stat", lambda x: (x.abs() > 2.0).sum()),
    n_total=("ic", "count"),
)
metal_agg = metal_agg.sort_values("mean_ic", ascending=False)

print(f"{'Signal'.ljust(25)} | {'Mean IC':>8} | {'N sig (|t|>2)':>13} | {'N total':>7}")
print("-" * 60)
for name, row in metal_agg.head(15).iterrows():
    marker = "*" if row["n_sig"] > 5 else " "
    print(f"{marker} {name.ljust(23)} | {row['mean_ic']:+.4f} | {int(row['n_sig']):13} | {int(row['n_total']):7}")

# ============================================================
# COMBO SIGNALS: Momentum + Vol filter
# ============================================================
hr("COMBO SIGNALS")

combo_results = []
combo_counter = 0

for inst in train_prices.columns:
    prices = train_prices[inst].dropna()
    if len(prices) < 252:
        continue
    ret = prices.pct_change()

    # Signal 1: Momentum + Low Vol (buy momentum when vol is declining)
    mom_21 = prices.pct_change(21)
    vol_20 = ret.rolling(20).std()
    vol_declining = (vol_20 < vol_20.rolling(20).mean()).astype(float)
    combo_1 = mom_21 * vol_declining

    # Signal 2: Mean reversion + High Vol (revert harder in high vol)
    mr_z = -(prices - prices.rolling(21).mean()) / prices.rolling(21).std()
    vol_high = (vol_20 > vol_20.rolling(60).mean()).astype(float)
    combo_2 = mr_z * vol_high

    # Signal 3: Trend + confirming momentum
    ema_cross = (prices.ewm(span=20).mean() - prices.ewm(span=50).mean()) / prices
    mom_confirmed = (ema_cross * mom_21 > 0).astype(float)  # same direction
    combo_3 = ema_cross * mom_confirmed

    for sig_name, sig in [("mom_lowvol", combo_1), ("mr_highvol", combo_2), ("trend_confirmed", combo_3)]:
        for holding, fwd in [("1d", fwd_1d), ("5d", fwd_5d), ("21d", fwd_21d)]:
            result = ts_test(f"{sig_name}_h{holding}", sig, fwd[inst], inst, holding)
            if result:
                combo_results.append(result)

combo_counter += 3
variant_counter += combo_counter

combo_df = pd.DataFrame(combo_results)
if len(combo_df) > 0:
    combo_agg = combo_df.groupby("signal").agg(
        mean_ic=("ic", "mean"),
        n_sig=("t_stat", lambda x: (x.abs() > 2.0).sum()),
        pct_pos=("ic", lambda x: (x > 0).mean() * 100),
    )
    combo_agg = combo_agg.sort_values("mean_ic", ascending=False)

    print(f"\n{'Signal'.ljust(25)} | {'Mean IC':>8} | {'N sig':>5} | {'% IC>0':>7}")
    print("-" * 55)
    for name, row in combo_agg.iterrows():
        marker = "*" if row["n_sig"] > 15 else " "
        print(f"{marker} {name.ljust(23)} | {row['mean_ic']:+.4f} | {int(row['n_sig']):5} | {row['pct_pos']:5.1f}%")

        results_all.append({
            "signal": name, "mean_ic": row["mean_ic"], "t_stat": 0,
            "n_significant": int(row["n_sig"]), "pct_positive": row["pct_pos"],
            "status": "PASS" if row["n_sig"] > 20 else ("WEAK" if row["n_sig"] > 10 else "FAIL")
        })

# ============================================================
# CARRY TRADE: Long high-yielders, short low-yielders
# ============================================================
hr("CARRY TRADE ANALYSIS")

# FX carry = interest rate differential
# We proxy this with 3-month rolling return (price drift)
# Sort instruments by carry, go long top quartile, short bottom quartile
carry = train_prices.pct_change(63)  # 3-month return as carry proxy

# For each day, rank instruments by carry
carry_rank = carry.rank(axis=1, pct=True)

# Long top 25%, short bottom 25%
long_mask = (carry_rank >= 0.75).astype(float)
short_mask = (carry_rank <= 0.25).astype(float)
carry_signal = long_mask - short_mask

# Portfolio return: equal-weight long/short
carry_port_ret = (carry_signal.shift(1) * all_returns.loc[train_prices.index]).mean(axis=1)
carry_port_ret = carry_port_ret.dropna()

# Sharpe
carry_sharpe = carry_port_ret.mean() / carry_port_ret.std() * np.sqrt(252)
carry_total = (1 + carry_port_ret).cumprod().iloc[-1] - 1

print(f"\n  Carry trade portfolio (long high, short low):")
print(f"  Train Sharpe (before costs): {carry_sharpe:.2f}")
print(f"  Train total return: {carry_total:.2%}")
print(f"  Daily mean: {carry_port_ret.mean():.6f}")
print(f"  Daily vol:  {carry_port_ret.std():.4f}")

# Apply costs: 2 round trips per rebalance (monthly = ~12/year)
n_trades_per_year = 12  # monthly rebalance
avg_cost = 3.0 * 0.0001  # 3 pips average cross pair
annual_cost = n_trades_per_year * avg_cost * 2  # long + short
daily_cost = annual_cost / 252
carry_sharpe_net = (carry_port_ret.mean() - daily_cost) / carry_port_ret.std() * np.sqrt(252)
print(f"  Train Sharpe (after costs): {carry_sharpe_net:.2f}")

variant_counter += 1
results_all.append({
    "signal": "carry_ls_portfolio", "mean_ic": carry_port_ret.mean() * 10000,
    "t_stat": carry_sharpe, "n_significant": 0,
    "pct_positive": (carry_port_ret > 0).mean() * 100,
    "status": "PASS" if carry_sharpe_net > 0.5 else ("WEAK" if carry_sharpe_net > 0.3 else "FAIL")
})

# ============================================================
# GOLD TREND FOLLOWING (dedicated analysis)
# ============================================================
hr("GOLD TREND FOLLOWING — DEDICATED ANALYSIS")

for inst in GOLD + ["XAG_USD"]:
    if inst not in train_prices.columns:
        continue
    p = train_prices[inst].dropna()
    r = p.pct_change().dropna()

    # Simple: long when price > 200-day MA
    ma200 = p.rolling(200).mean()
    signal_200ma = (p > ma200).astype(float)
    strat_ret = (signal_200ma.shift(1) * r).dropna()

    sharpe = strat_ret.mean() / strat_ret.std() * np.sqrt(252) if strat_ret.std() > 0 else 0
    total_ret = (1 + strat_ret).cumprod().iloc[-1] - 1
    buy_hold_ret = (1 + r.loc[strat_ret.index]).cumprod().iloc[-1] - 1
    n_trades = signal_200ma.diff().abs().sum() / 2

    # Cost
    cost_per_trade = get_cost(inst)
    annual_trades = n_trades / (len(strat_ret) / 252)
    net_daily_cost = annual_trades * cost_per_trade / 252
    sharpe_net = (strat_ret.mean() - net_daily_cost) / strat_ret.std() * np.sqrt(252) if strat_ret.std() > 0 else 0

    print(f"\n  {inst}:")
    print(f"    200-MA trend: SR={sharpe:.2f} (net: {sharpe_net:.2f}), total={total_ret:.2%}, B&H={buy_hold_ret:.2%}")
    print(f"    Trades: {n_trades:.0f} ({annual_trades:.1f}/yr), cost/trade={cost_per_trade:.5f}")

    variant_counter += 1
    results_all.append({
        "signal": f"gold_200ma_{inst}", "mean_ic": sharpe,
        "t_stat": sharpe_net, "n_significant": 1 if sharpe_net > 0.5 else 0,
        "pct_positive": (strat_ret > 0).mean() * 100,
        "status": "PASS" if sharpe_net > 0.5 else ("WEAK" if sharpe_net > 0.3 else "FAIL")
    })

    # Also test with dual EMA
    for fast, slow in [(20, 50), (10, 50), (50, 200)]:
        ema_f = p.ewm(span=fast).mean()
        ema_s = p.ewm(span=slow).mean()
        sig = (ema_f > ema_s).astype(float)
        strat_ret2 = (sig.shift(1) * r).dropna()
        sr2 = strat_ret2.mean() / strat_ret2.std() * np.sqrt(252) if strat_ret2.std() > 0 else 0
        n_tr2 = sig.diff().abs().sum() / 2
        ann_tr2 = n_tr2 / (len(strat_ret2) / 252)
        net_cost2 = ann_tr2 * cost_per_trade / 252
        sr2_net = (strat_ret2.mean() - net_cost2) / strat_ret2.std() * np.sqrt(252) if strat_ret2.std() > 0 else 0
        tot2 = (1 + strat_ret2).cumprod().iloc[-1] - 1
        print(f"    EMA({fast}/{slow}): SR={sr2:.2f} (net: {sr2_net:.2f}), total={tot2:.2%}, trades={n_tr2:.0f}")

        variant_counter += 1
        results_all.append({
            "signal": f"gold_ema_{fast}_{slow}_{inst}", "mean_ic": sr2,
            "t_stat": sr2_net, "n_significant": 1 if sr2_net > 0.5 else 0,
            "pct_positive": (strat_ret2 > 0).mean() * 100,
            "status": "PASS" if sr2_net > 0.5 else ("WEAK" if sr2_net > 0.3 else "FAIL")
        })

# ============================================================
# Summary
# ============================================================
hr("DEEP SEARCH SUMMARY")

results_df = pd.DataFrame(results_all)
n_pass = (results_df["status"] == "PASS").sum()
n_weak = (results_df["status"] == "WEAK").sum()
n_fail = (results_df["status"] == "FAIL").sum()

print(f"\n  Total variants tested: {variant_counter}")
print(f"  PASS: {n_pass} | WEAK: {n_weak} | FAIL: {n_fail}")

if n_pass > 0 or n_weak > 0:
    print(f"\n  Promising signals:")
    for _, row in results_df[results_df["status"].isin(["PASS", "WEAK"])].iterrows():
        print(f"    {row['signal']}: status={row['status']}")

results_df.to_csv("all_signals_tested.csv", index=False)

# Update journal
with open("journal.md", "a") as f:
    from datetime import datetime
    f.write(f"\n### Deep Signal Search ({datetime.now().strftime('%H:%M')})\n")
    f.write(f"- Total variants: {variant_counter}\n")
    f.write(f"- PASS: {n_pass}, WEAK: {n_weak}, FAIL: {n_fail}\n")
    f.write(f"- Time-series signals tested per instrument × holding period\n")
    f.write(f"- Combo signals (momentum+vol, MR+vol, trend+confirmation)\n")
    f.write(f"- Carry trade portfolio\n")
    f.write(f"- Gold/metals trend following with MA and EMA variants\n")
    for _, row in results_df[results_df["status"].isin(["PASS", "WEAK"])].iterrows():
        f.write(f"  - {row['signal']}: [{row['status']}]\n")

print(f"\nResults saved. Proceeding to strategy construction for passing signals.")
