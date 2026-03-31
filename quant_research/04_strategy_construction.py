"""
Step 4: Strategy Construction & Validation

Two strategy tracks identified from signal discovery:
1. Gold multi-cross trend following (long gold vs multiple currencies when trend is up)
2. FX mean-reversion at 21-day horizon (z-score based)

Process:
- Construct on TRAIN (2016-2021)
- Tune on VALIDATION (2022)
- Final eval on TEST (2023) — touch ONCE
- If passes, verify on OOS (2024-2026)
"""

import os
import numpy as np
import pandas as pd
from pathlib import Path
from scipy import stats
import warnings
warnings.filterwarnings("ignore")

os.chdir(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = Path("./data")

# Load master data
is_closes = pd.read_parquet(DATA_DIR / "is_closes.parquet")
oos_closes = pd.read_parquet(DATA_DIR / "oos_closes.parquet")
all_closes = pd.concat([is_closes, oos_closes]).sort_index()
all_closes = all_closes[~all_closes.index.duplicated(keep="first")]
if all_closes.index.tz is not None:
    all_closes.index = all_closes.index.tz_localize(None)
else:
    all_closes.index = pd.DatetimeIndex([t.replace(tzinfo=None) for t in all_closes.index])

all_returns = all_closes.pct_change()

# Splits
train = all_closes.loc[:"2021-12-31"]
val = all_closes.loc["2022-01-01":"2022-12-31"]
test = all_closes.loc["2023-01-01":"2023-12-31"]
oos = all_closes.loc["2024-01-01":]

MAJORS = {"EUR_USD", "GBP_USD", "USD_JPY", "USD_CHF", "AUD_USD", "USD_CAD", "NZD_USD"}
GOLD = [c for c in all_closes.columns if c.startswith("XAU") and c != "XAU_XAG"]

def get_cost(inst):
    if inst in MAJORS: return 0.00015
    if inst == "XAU_USD": return 0.30 / 2000
    if "JPY" in inst: return 0.0003
    if inst.startswith("XAU") or inst.startswith("XAG"): return 0.0003
    if "TRY" in inst or "ZAR" in inst or "MXN" in inst: return 0.0005
    return 0.0003

def hr(title):
    print("\n" + "=" * 70)
    print(f"  {title}")
    print("=" * 70)

def backtest_strategy(prices, returns, instruments, entry_func, exit_func,
                      cost_func=get_cost, label="strategy"):
    """
    Generic backtester.
    entry_func(prices, inst) -> Series of positions (-1, 0, +1)
    Returns dict of metrics.
    """
    all_pnl = []
    all_trades = 0
    per_inst_results = {}

    for inst in instruments:
        if inst not in prices.columns:
            continue
        p = prices[inst].dropna()
        r = returns[inst].reindex(p.index).dropna()
        if len(p) < 50:
            continue

        pos = entry_func(prices, inst)
        pos = pos.reindex(r.index).fillna(0)

        # Apply exit rules
        if exit_func:
            pos = exit_func(pos, prices[inst], r)

        # PnL
        strat_ret = (pos.shift(1) * r).dropna()
        if len(strat_ret) == 0:
            continue

        # Transaction costs
        trades = pos.diff().abs()
        cost = get_cost(inst)
        costs = trades * cost
        net_ret = strat_ret - costs

        # Metrics
        n_trades = int(trades.sum() / 2)
        if net_ret.std() == 0 or len(net_ret) < 20:
            continue

        sharpe = net_ret.mean() / net_ret.std() * np.sqrt(252)
        total_ret = (1 + net_ret).cumprod().iloc[-1] - 1

        # Max drawdown
        cum = (1 + net_ret).cumprod()
        peak = cum.cummax()
        dd = (cum - peak) / peak
        max_dd = dd.min()

        # Win rate
        daily_wins = (net_ret > 0).sum()
        daily_total = (net_ret != 0).sum()
        win_rate = daily_wins / max(daily_total, 1)

        # Profit factor
        gains = net_ret[net_ret > 0].sum()
        losses = abs(net_ret[net_ret < 0].sum())
        pf = gains / losses if losses > 0 else float("inf")

        # Monthly PnL concentration
        monthly_pnl = net_ret.resample("ME").sum()
        max_month_pct = monthly_pnl.max() / max(monthly_pnl.sum(), 1e-10) if monthly_pnl.sum() > 0 else 1.0

        per_inst_results[inst] = {
            "sharpe": sharpe, "total_ret": total_ret, "max_dd": max_dd,
            "n_trades": n_trades, "win_rate": win_rate, "pf": pf,
            "max_month_pct": max_month_pct,
        }
        all_pnl.append(net_ret)
        all_trades += n_trades

    if not all_pnl:
        return None

    # Portfolio: equal-weight across instruments
    port_ret = pd.concat(all_pnl, axis=1).mean(axis=1)
    port_cum = (1 + port_ret).cumprod()
    port_peak = port_cum.cummax()
    port_dd = ((port_cum - port_peak) / port_peak).min()

    port_sharpe = port_ret.mean() / port_ret.std() * np.sqrt(252)
    port_total = port_cum.iloc[-1] - 1

    gains = port_ret[port_ret > 0].sum()
    losses = abs(port_ret[port_ret < 0].sum())
    port_pf = gains / losses if losses > 0 else float("inf")

    monthly = port_ret.resample("ME").sum()
    max_month = monthly.max() / max(monthly.sum(), 1e-10) if monthly.sum() > 0 else 1.0

    return {
        "label": label,
        "sharpe": port_sharpe,
        "total_ret": port_total,
        "max_dd": port_dd,
        "n_trades": all_trades,
        "n_instruments": len(per_inst_results),
        "pf": port_pf,
        "max_month_pct": max_month,
        "per_inst": per_inst_results,
        "port_ret": port_ret,
    }


# ============================================================
# STRATEGY 1: Gold Multi-Cross Trend Following
# ============================================================
hr("STRATEGY 1: GOLD MULTI-CROSS TREND FOLLOWING")

print("""
  Rationale: Gold has a persistent positive trend (real asset, inflation hedge,
  central bank buying). By holding gold when its trend is up (price > EMA),
  we capture the upside while avoiding drawdowns. Trading gold priced in
  multiple currencies diversifies the FX risk and captures the strongest
  trend at any given time.

  Signal: Long gold when EMA(fast) > EMA(slow), flat otherwise.
  Portfolio: Equal-weight across gold-currency pairs.
  Costs: ~3 pips per cross pair, ~0.30 USD for XAU/USD.
""")

variant_counter = 89  # from previous

# Train phase: test parameter combinations
print("--- TRAIN (2016-2021) ---")
train_r = all_returns.loc[train.index[1]:"2021-12-31"]

best_train = None
for fast, slow in [(10, 50), (20, 50), (20, 100), (50, 200)]:
    def gold_entry(prices, inst, f=fast, s=slow):
        p = prices[inst].dropna()
        ema_f = p.ewm(span=f).mean()
        ema_s = p.ewm(span=s).mean()
        return (ema_f > ema_s).astype(float)

    result = backtest_strategy(train, train_r, GOLD, gold_entry, None,
                                label=f"gold_ema_{fast}_{slow}")
    variant_counter += 1

    if result:
        print(f"  EMA({fast}/{slow}): SR={result['sharpe']:.2f}, "
              f"ret={result['total_ret']:.2%}, DD={result['max_dd']:.2%}, "
              f"trades={result['n_trades']}, PF={result['pf']:.2f}")
        if best_train is None or result["sharpe"] > best_train["sharpe"]:
            best_train = result
            best_params = (fast, slow)

print(f"\n  Best train: EMA({best_params[0]}/{best_params[1]}), SR={best_train['sharpe']:.2f}")

# Validation phase
print("\n--- VALIDATION (2022) ---")
val_r = all_returns.loc["2022-01-01":"2022-12-31"]

def gold_entry_best(prices, inst, f=best_params[0], s=best_params[1]):
    p = prices[inst].dropna()
    ema_f = p.ewm(span=f).mean()
    ema_s = p.ewm(span=s).mean()
    return (ema_f > ema_s).astype(float)

# Need to use prices including pre-2022 for EMA warmup
val_prices = all_closes.loc[:"2022-12-31"]
val_result = backtest_strategy(val_prices, val_r, GOLD, gold_entry_best, None,
                                label=f"gold_ema_{best_params[0]}_{best_params[1]}_val")

if val_result:
    print(f"  Val: SR={val_result['sharpe']:.2f}, ret={val_result['total_ret']:.2%}, "
          f"DD={val_result['max_dd']:.2%}, trades={val_result['n_trades']}, "
          f"PF={val_result['pf']:.2f}")
    print(f"\n  Per-instrument (validation):")
    for inst, m in sorted(val_result["per_inst"].items(), key=lambda x: -x[1]["sharpe"]):
        print(f"    {inst.ljust(10)} SR={m['sharpe']:+.2f}  ret={m['total_ret']:+.2%}  DD={m['max_dd']:.2%}  trades={m['n_trades']}")


# ============================================================
# STRATEGY 2: FX Mean-Reversion (21-day z-score)
# ============================================================
hr("STRATEGY 2: FX MEAN-REVERSION (21-DAY Z-SCORE)")

print("""
  Rationale: FX pairs exhibit short-term mean-reversion at the 1-3 week horizon.
  When a pair deviates significantly from its rolling mean (high z-score),
  it tends to revert. This is consistent with central bank policy anchoring,
  mean-reverting interest rate differentials, and overreaction to news.

  Signal: Buy when z-score < -threshold, sell when > +threshold.
  Exit: When z-score crosses zero (mean).
  Universe: Major and cross pairs (excluding exotics with high costs).
""")

# Filter universe: exclude exotic/illiquid pairs
MR_UNIVERSE = [c for c in all_closes.columns
               if not c.startswith("XAU") and not c.startswith("XAG")
               and "TRY" not in c and "ZAR" not in c and "MXN" not in c
               and "THB" not in c and "HUF" not in c and "CZK" not in c
               and "PLN" not in c and "CNH" not in c and "HKD" not in c
               and "DKK" not in c and "SEK" not in c and "NOK" not in c
               and "TWD" not in c and "INR" not in c and "SAR" not in c]

print(f"  Universe: {len(MR_UNIVERSE)} instruments")

# Train
print("\n--- TRAIN (2016-2021) ---")

best_mr_train = None
for lookback in [10, 21, 42]:
    for threshold in [1.0, 1.5, 2.0]:
        def mr_entry(prices, inst, lb=lookback, thr=threshold):
            p = prices[inst].dropna()
            ma = p.rolling(lb).mean()
            std = p.rolling(lb).std()
            z = (p - ma) / std
            pos = pd.Series(0.0, index=p.index)
            pos[z < -thr] = 1.0   # buy oversold
            pos[z > thr] = -1.0   # sell overbought
            # Hold until z crosses zero
            for i in range(1, len(pos)):
                if pos.iloc[i] == 0:
                    pos.iloc[i] = pos.iloc[i-1]
                    if pos.iloc[i-1] > 0 and z.iloc[i] > 0:
                        pos.iloc[i] = 0  # exit long
                    elif pos.iloc[i-1] < 0 and z.iloc[i] < 0:
                        pos.iloc[i] = 0  # exit short
            return pos

        result = backtest_strategy(train, train_r, MR_UNIVERSE, mr_entry, None,
                                    label=f"mr_z{lookback}_t{threshold}")
        variant_counter += 1

        if result:
            print(f"  Z({lookback}, thr={threshold}): SR={result['sharpe']:.2f}, "
                  f"ret={result['total_ret']:.2%}, DD={result['max_dd']:.2%}, "
                  f"trades={result['n_trades']}, PF={result['pf']:.2f}, "
                  f"inst={result['n_instruments']}")
            if best_mr_train is None or result["sharpe"] > best_mr_train["sharpe"]:
                best_mr_train = result
                best_mr_params = (lookback, threshold)

if best_mr_train:
    print(f"\n  Best train MR: Z({best_mr_params[0]}, thr={best_mr_params[1]}), "
          f"SR={best_mr_train['sharpe']:.2f}")

    # Validation
    print("\n--- VALIDATION (2022) ---")
    lb, thr = best_mr_params

    def mr_entry_best(prices, inst, lb=lb, thr=thr):
        p = prices[inst].dropna()
        ma = p.rolling(lb).mean()
        std = p.rolling(lb).std()
        z = (p - ma) / std
        pos = pd.Series(0.0, index=p.index)
        pos[z < -thr] = 1.0
        pos[z > thr] = -1.0
        for i in range(1, len(pos)):
            if pos.iloc[i] == 0:
                pos.iloc[i] = pos.iloc[i-1]
                if pos.iloc[i-1] > 0 and z.iloc[i] > 0:
                    pos.iloc[i] = 0
                elif pos.iloc[i-1] < 0 and z.iloc[i] < 0:
                    pos.iloc[i] = 0
        return pos

    val_prices_mr = all_closes.loc[:"2022-12-31"]
    mr_val = backtest_strategy(val_prices_mr, val_r, MR_UNIVERSE, mr_entry_best, None,
                                label=f"mr_z{lb}_t{thr}_val")

    if mr_val:
        print(f"  Val: SR={mr_val['sharpe']:.2f}, ret={mr_val['total_ret']:.2%}, "
              f"DD={mr_val['max_dd']:.2%}, trades={mr_val['n_trades']}, "
              f"PF={mr_val['pf']:.2f}")

# ============================================================
# STRATEGY 3: Combined — Gold Trend + FX MR
# ============================================================
hr("STRATEGY 3: COMBINED (GOLD TREND + FX MR)")

print("  Equal-weight combination of gold trend and FX mean-reversion.")

if best_train and best_mr_train and val_result and mr_val:
    # Portfolio on validation
    combined_val = pd.concat([val_result["port_ret"], mr_val["port_ret"]], axis=1)
    combined_val = combined_val.mean(axis=1).dropna()

    combo_sr = combined_val.mean() / combined_val.std() * np.sqrt(252)
    combo_total = (1 + combined_val).cumprod().iloc[-1] - 1
    cum = (1 + combined_val).cumprod()
    combo_dd = ((cum - cum.cummax()) / cum.cummax()).min()

    print(f"\n  Combined (validation): SR={combo_sr:.2f}, ret={combo_total:.2%}, DD={combo_dd:.2%}")


# ============================================================
# TEST SET — FINAL EVALUATION (TOUCH ONCE)
# ============================================================
hr("TEST SET EVALUATION — 2023 (FINAL, TOUCH ONCE)")

test_r = all_returns.loc["2023-01-01":"2023-12-31"]
test_prices_full = all_closes.loc[:"2023-12-31"]

print("\n  Strategy 1: Gold Trend Following")
gold_test = backtest_strategy(test_prices_full, test_r, GOLD, gold_entry_best, None,
                               label="gold_trend_test")
if gold_test:
    print(f"    SR={gold_test['sharpe']:.2f}, ret={gold_test['total_ret']:.2%}, "
          f"DD={gold_test['max_dd']:.2%}, trades={gold_test['n_trades']}, "
          f"PF={gold_test['pf']:.2f}, max_month%={gold_test['max_month_pct']:.1%}")

    print(f"\n    Per-instrument (test):")
    for inst, m in sorted(gold_test["per_inst"].items(), key=lambda x: -x[1]["sharpe"]):
        print(f"      {inst.ljust(10)} SR={m['sharpe']:+.2f}  ret={m['total_ret']:+.2%}  DD={m['max_dd']:.2%}")

if best_mr_train:
    print(f"\n  Strategy 2: FX Mean-Reversion (Z{best_mr_params[0]}, thr={best_mr_params[1]})")
    mr_test = backtest_strategy(test_prices_full, test_r, MR_UNIVERSE, mr_entry_best, None,
                                 label="mr_test")
    if mr_test:
        print(f"    SR={mr_test['sharpe']:.2f}, ret={mr_test['total_ret']:.2%}, "
              f"DD={mr_test['max_dd']:.2%}, trades={mr_test['n_trades']}, "
              f"PF={mr_test['pf']:.2f}, max_month%={mr_test['max_month_pct']:.1%}")

# Combined test
if gold_test and mr_test:
    combined_test = pd.concat([gold_test["port_ret"], mr_test["port_ret"]], axis=1)
    combined_test = combined_test.mean(axis=1).dropna()
    combo_sr_test = combined_test.mean() / combined_test.std() * np.sqrt(252)
    combo_total_test = (1 + combined_test).cumprod().iloc[-1] - 1
    cum_test = (1 + combined_test).cumprod()
    combo_dd_test = ((cum_test - cum_test.cummax()) / cum_test.cummax()).min()
    gains_t = combined_test[combined_test > 0].sum()
    losses_t = abs(combined_test[combined_test < 0].sum())
    combo_pf_test = gains_t / losses_t if losses_t > 0 else float("inf")

    print(f"\n  Strategy 3: Combined")
    print(f"    SR={combo_sr_test:.2f}, ret={combo_total_test:.2%}, "
          f"DD={combo_dd_test:.2%}, PF={combo_pf_test:.2f}")

# ============================================================
# VIABILITY CHECK AGAINST THRESHOLDS
# ============================================================
hr("VIABILITY CHECK")

def check_viability(result, label):
    if result is None:
        print(f"  {label}: NO RESULT")
        return "FAILED"

    checks = {
        "Sharpe > 0.5": result["sharpe"] > 0.5,
        "PF > 1.2": result["pf"] > 1.2,
        "MaxDD < 20%": abs(result["max_dd"]) < 0.20,
        "Trades > 30": result["n_trades"] > 30,
        "Max month < 40%": result.get("max_month_pct", 0) < 0.40,
        "Multi-asset (>= 2)": result["n_instruments"] >= 2,
    }

    passed = sum(checks.values())
    total = len(checks)

    print(f"\n  {label}:")
    for check, ok in checks.items():
        status = "PASS" if ok else "FAIL"
        print(f"    [{status}] {check}")

    if passed == total:
        margin = min(
            (result["sharpe"] - 0.5) / 0.5,
            (result["pf"] - 1.2) / 1.2,
        )
        if margin > 0.2:
            rating = "STRONG"
        else:
            rating = "MODERATE"
    elif passed >= total - 1:
        rating = "WEAK"
    else:
        rating = "FAILED"

    print(f"    VERDICT: {rating} ({passed}/{total} checks passed)")
    return rating

gold_rating = check_viability(gold_test, "Gold Trend Following (test)")
mr_rating = check_viability(mr_test, "FX Mean-Reversion (test)") if best_mr_train else "FAILED"

# ============================================================
# OOS CHECK (only for STRONG/MODERATE)
# ============================================================
if gold_rating in ("STRONG", "MODERATE"):
    hr("OUT-OF-SAMPLE VERIFICATION — 2024-2026")

    oos_r = all_returns.loc["2024-01-01":]
    oos_prices_full = all_closes

    gold_oos = backtest_strategy(oos_prices_full, oos_r, GOLD, gold_entry_best, None,
                                  label="gold_trend_oos")
    if gold_oos:
        print(f"\n  Gold Trend OOS: SR={gold_oos['sharpe']:.2f}, "
              f"ret={gold_oos['total_ret']:.2%}, DD={gold_oos['max_dd']:.2%}, "
              f"trades={gold_oos['n_trades']}, PF={gold_oos['pf']:.2f}")
        print(f"\n  Per-instrument (OOS):")
        for inst, m in sorted(gold_oos["per_inst"].items(), key=lambda x: -x[1]["sharpe"]):
            print(f"    {inst.ljust(10)} SR={m['sharpe']:+.2f}  ret={m['total_ret']:+.2%}  DD={m['max_dd']:.2%}")

        oos_rating = check_viability(gold_oos, "Gold Trend Following (OOS)")

# ============================================================
# Save summary
# ============================================================
hr("SUMMARY")

print(f"\n  Total variants tested: {variant_counter}")
print(f"  Gold trend rating (test): {gold_rating}")
print(f"  MR rating (test): {mr_rating}")

# Update journal
with open("journal.md", "a") as f:
    from datetime import datetime
    f.write(f"\n### Strategy Construction ({datetime.now().strftime('%H:%M')})\n")
    f.write(f"- Total variants: {variant_counter}\n")
    f.write(f"- Strategy 1: Gold multi-cross trend (EMA {best_params[0]}/{best_params[1]})\n")
    f.write(f"  - Train SR: {best_train['sharpe']:.2f}\n")
    f.write(f"  - Val SR: {val_result['sharpe']:.2f}\n") if val_result else None
    f.write(f"  - Test SR: {gold_test['sharpe']:.2f}\n") if gold_test else None
    f.write(f"  - Test rating: {gold_rating}\n")
    if best_mr_train:
        f.write(f"- Strategy 2: FX MR (Z{best_mr_params[0]}, thr={best_mr_params[1]})\n")
        f.write(f"  - Train SR: {best_mr_train['sharpe']:.2f}\n")
        if mr_val:
            f.write(f"  - Val SR: {mr_val['sharpe']:.2f}\n")
        f.write(f"  - Test rating: {mr_rating}\n")
