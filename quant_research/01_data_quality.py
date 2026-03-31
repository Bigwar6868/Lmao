"""
Step 1: Data Quality Verification
Load all OANDA daily candles, check for gaps, outliers, and build master dataset.
"""

import json
import os
import numpy as np
import pandas as pd
from pathlib import Path
from datetime import datetime

IS_DIR = Path("../trading-algo/data/oanda-daily-insample")
OOS_DIR = Path("../trading-algo/data/oanda-daily-oos")
OUT_DIR = Path("./data")
OUT_DIR.mkdir(exist_ok=True)

# Major pairs for lower transaction cost tier
MAJORS = {
    "EUR_USD", "GBP_USD", "USD_JPY", "USD_CHF", "AUD_USD", "USD_CAD", "NZD_USD"
}

def load_oanda_json(filepath):
    """Load OANDA JSON candle file into DataFrame."""
    with open(filepath) as f:
        data = json.load(f)

    rows = []
    for bar in data.get("candles", []):
        if not bar.get("complete"):
            continue
        mid = bar.get("mid", {})
        rows.append({
            "time": pd.Timestamp(bar["time"]),
            "open": float(mid.get("o", 0)),
            "high": float(mid.get("h", 0)),
            "low": float(mid.get("l", 0)),
            "close": float(mid.get("c", 0)),
            "volume": int(bar.get("volume", 0)),
        })

    df = pd.DataFrame(rows)
    if len(df) > 0:
        df = df.set_index("time").sort_index()
    return df


def check_quality(df, instrument):
    """Run quality checks on a single instrument's data."""
    issues = []

    if len(df) < 100:
        issues.append(f"Too few candles: {len(df)}")
        return issues

    # 1. Check for zero/negative prices
    for col in ["open", "high", "low", "close"]:
        zeros = (df[col] <= 0).sum()
        if zeros > 0:
            issues.append(f"{col} has {zeros} zero/negative values")

    # 2. Check OHLC consistency (high >= open,close,low; low <= open,close,high)
    bad_hl = ((df["high"] < df["low"]) | (df["high"] < df["open"]) |
              (df["high"] < df["close"]) | (df["low"] > df["open"]) |
              (df["low"] > df["close"])).sum()
    if bad_hl > 0:
        issues.append(f"{bad_hl} bars with inconsistent OHLC")

    # 3. Check for duplicate timestamps
    dupes = df.index.duplicated().sum()
    if dupes > 0:
        issues.append(f"{dupes} duplicate timestamps")

    # 4. Check for extreme daily returns (>10% for FX is very suspicious)
    returns = df["close"].pct_change().dropna()
    extreme = (returns.abs() > 0.10).sum()
    if extreme > 0:
        max_ret = returns.abs().max()
        issues.append(f"{extreme} days with |return| > 10% (max: {max_ret:.2%})")

    # 5. Check for gaps (missing weekdays)
    # FX trades Mon-Fri, so weekend gaps are normal
    bdays = pd.bdate_range(df.index.min(), df.index.max())
    # Allow some missing days (holidays) but flag >5% missing
    expected = len(bdays)
    actual = len(df)
    missing_pct = 1 - actual / max(expected, 1)
    if missing_pct > 0.10:
        issues.append(f"Missing {missing_pct:.1%} of expected business days ({actual}/{expected})")

    # 6. Check for stale prices (same close for 5+ consecutive days)
    stale = (df["close"].diff().abs() < 1e-10).rolling(5).sum()
    max_stale = stale.max()
    if max_stale >= 5:
        issues.append(f"Stale prices detected: {int(max_stale)} consecutive identical closes")

    return issues


def compute_pip_value(instrument):
    """Return pip value for cost calculations."""
    if instrument in MAJORS:
        return 0.0001  # standard pip
    if "JPY" in instrument:
        return 0.01
    if instrument.startswith("XAU"):
        return 0.01  # gold pip
    if instrument.startswith("XAG"):
        return 0.001
    return 0.0001  # default


def compute_cost_per_trade(instrument, price):
    """Compute round-trip cost as fraction of price."""
    if instrument in MAJORS:
        # 1.5 pips RT
        pip = compute_pip_value(instrument)
        return 1.5 * pip / price
    elif instrument == "XAU_USD":
        # 0.30 USD RT
        return 0.30 / price
    elif instrument.startswith("XAU") or instrument.startswith("XAG"):
        # 3.0 pips equivalent
        pip = compute_pip_value(instrument)
        return 3.0 * pip / price
    else:
        # Cross pairs: 3.0 pips RT
        pip = compute_pip_value(instrument)
        return 3.0 * pip / price


def main():
    print("=" * 70)
    print("  DATA QUALITY VERIFICATION")
    print("=" * 70)

    all_instruments = []
    quality_report = []

    # Process in-sample data
    print("\n--- IN-SAMPLE (2016-2024) ---")
    is_files = sorted(IS_DIR.glob("*.json"))

    is_data = {}
    for f in is_files:
        instrument = f.stem
        df = load_oanda_json(f)
        if len(df) == 0:
            print(f"  {instrument}: NO DATA")
            continue

        is_data[instrument] = df
        issues = check_quality(df, instrument)

        # Compute stats
        returns = df["close"].pct_change().dropna()
        avg_price = df["close"].mean()
        cost_frac = compute_cost_per_trade(instrument, avg_price)

        status = "PASS" if len(issues) == 0 else f"WARN ({len(issues)})"
        quality_report.append({
            "instrument": instrument,
            "candles": len(df),
            "start": str(df.index.min().date()),
            "end": str(df.index.max().date()),
            "mean_return": returns.mean(),
            "vol": returns.std(),
            "sharpe_raw": returns.mean() / returns.std() * np.sqrt(252) if returns.std() > 0 else 0,
            "cost_frac": cost_frac,
            "cost_bps": cost_frac * 10000,
            "status": status,
            "issues": "; ".join(issues) if issues else "clean",
        })

    # Process OOS data
    print("\n--- OUT-OF-SAMPLE (2025-2026) ---")
    oos_files = sorted(OOS_DIR.glob("*.json"))

    oos_data = {}
    for f in oos_files:
        instrument = f.stem
        df = load_oanda_json(f)
        if len(df) == 0:
            continue
        oos_data[instrument] = df

    # Summary
    print(f"\n  In-sample instruments: {len(is_data)}")
    print(f"  Out-of-sample instruments: {len(oos_data)}")

    # Build quality report DataFrame
    qdf = pd.DataFrame(quality_report)

    # Print summary
    print(f"\n  Quality check results:")
    clean = (qdf["status"] == "PASS").sum()
    warn = (qdf["status"] != "PASS").sum()
    print(f"    PASS: {clean} | WARN: {warn}")

    if warn > 0:
        print(f"\n  Instruments with issues:")
        for _, row in qdf[qdf["status"] != "PASS"].iterrows():
            print(f"    {row['instrument']}: {row['issues']}")

    # Print cost analysis
    print(f"\n  Transaction cost summary (round-trip, bps):")
    for tier, instruments in [("Majors", MAJORS),
                               ("All", set(qdf["instrument"]))]:
        tier_df = qdf[qdf["instrument"].isin(instruments)]
        if len(tier_df) > 0:
            print(f"    {tier}: mean={tier_df['cost_bps'].mean():.1f}bps, "
                  f"range={tier_df['cost_bps'].min():.1f}-{tier_df['cost_bps'].max():.1f}bps")

    # Return characteristics
    print(f"\n  Return characteristics (daily, in-sample):")
    print(f"    Mean daily return: {qdf['mean_return'].mean():.6f}")
    print(f"    Mean daily vol:    {qdf['vol'].mean():.4f}")
    print(f"    Mean raw Sharpe:   {qdf['sharpe_raw'].mean():.2f}")

    # Top/bottom by raw Sharpe
    print(f"\n  Top 10 by raw Sharpe (in-sample, before costs):")
    top10 = qdf.nlargest(10, "sharpe_raw")
    for _, row in top10.iterrows():
        print(f"    {row['instrument'].ljust(10)} SR={row['sharpe_raw']:+.2f}  vol={row['vol']:.4f}  cost={row['cost_bps']:.1f}bps")

    print(f"\n  Bottom 10 by raw Sharpe (in-sample):")
    bot10 = qdf.nsmallest(10, "sharpe_raw")
    for _, row in bot10.iterrows():
        print(f"    {row['instrument'].ljust(10)} SR={row['sharpe_raw']:+.2f}  vol={row['vol']:.4f}  cost={row['cost_bps']:.1f}bps")

    # Save master data as parquet for faster loading
    print(f"\n  Saving master datasets...")

    # Combine all IS close prices into a single DataFrame
    is_closes = pd.DataFrame({inst: df["close"] for inst, df in is_data.items()})
    is_closes.to_parquet(OUT_DIR / "is_closes.parquet")

    oos_closes = pd.DataFrame({inst: df["close"] for inst, df in oos_data.items()})
    oos_closes.to_parquet(OUT_DIR / "oos_closes.parquet")

    # Save full OHLCV
    for period, data_dict in [("is", is_data), ("oos", oos_data)]:
        for inst, df in data_dict.items():
            df.to_parquet(OUT_DIR / f"{period}_{inst}.parquet")

    # Save quality report
    qdf.to_csv(OUT_DIR / "quality_report.csv", index=False)

    print(f"  Saved {len(is_data)} IS + {len(oos_data)} OOS instruments to {OUT_DIR}/")
    print(f"\n  DATA QUALITY VERIFICATION COMPLETE")


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    main()
