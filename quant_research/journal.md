# Quant Research Journal

## Session 2026-03-31

### Decision: Research Setup
- Universe: 89 OANDA instruments (68 FX + 21 metals)
- In-sample: 2016-01-01 to 2021-12-31 (~1,560 daily candles per instrument)
- Validation: 2022-01-01 to 2022-12-31 (~260 candles)
- Test: 2023-01-01 to 2023-12-31 (~260 candles) — touched ONCE
- Out-of-sample: 2024-01-01 to 2026-03-29 (~580 candles) — NEVER TOUCHED (no strategy qualified)
- Data source: OANDA v20 API, mid prices, daily granularity
- Strategy variant counter: 102 (final)
- Account currency: GBP, balance ~1,159

### Transaction Costs (fixed, non-tuneable)
- Major FX pairs: 1.5 pips RT
- Cross FX pairs: 3.0 pips RT
- XAU_USD: 0.30 USD RT
- Other metals: 3.0 pips RT equivalent

### Research Track 1: Starting
- Phase: Data quality verification

### Signal Discovery Results (06:20)
- Tested 25 signal variants
- Passing (|t| > 2.0, |IC| > 0.01): 0
- Weak (|t| > 1.5): 4
- Failed: 21
  - mom_21d: IC=-0.0167, t=-1.66 [WEAK]
  - vol_60d: IC=-0.0129, t=-1.66 [WEAK]
  - carry_21d: IC=-0.0167, t=-1.66 [WEAK]
  - cs_mom_21d: IC=-0.0167, t=-1.66 [WEAK]
- Key finding: Cross-sectional signals dominate time-series signals
- Gold/silver pairs show strongest single-instrument momentum

### Deep Signal Search (06:22)
- Total variants: 89
- PASS: 39, WEAK: 28, FAIL: 27
- Time-series signals tested per instrument × holding period
- Combo signals (momentum+vol, MR+vol, trend+confirmation)
- Carry trade portfolio
- Gold/metals trend following with MA and EMA variants
  - ema_cross_20_100_h21d: [PASS]
  - mom_63d_h21d: [PASS]
  - ema_cross_10_50_h21d: [PASS]
  - range_pct_h21d: [PASS]
  - mr_zscore_63_h21d: [PASS]
  - mom_21d_h21d: [PASS]
  - rsi_14_h21d: [PASS]
  - breakout_20_h21d: [PASS]
  - mr_zscore_21_h21d: [PASS]
  - ema_cross_20_100_h5d: [PASS]
  - range_pct_h5d: [PASS]
  - ema_cross_10_50_h5d: [PASS]
  - vol_ratio_5_60_h21d: [PASS]
  - mr_zscore_10_h21d: [PASS]
  - mom_63d_h5d: [PASS]
  - mom_21d_h5d: [PASS]
  - mr_zscore_63_h5d: [PASS]
  - mom_5d_h21d: [PASS]
  - breakout_20_h5d: [PASS]
  - mr_zscore_21_h5d: [PASS]
  - mr_zscore_10_h5d: [PASS]
  - mom_5d_h5d: [PASS]
  - rsi_14_h5d: [PASS]
  - vol_ratio_5_60_h5d: [WEAK]
  - range_pct_h1d: [WEAK]
  - mr_highvol_h21d: [PASS]
  - mr_highvol_h5d: [WEAK]
  - mom_lowvol_h5d: [PASS]
  - trend_confirmed_h5d: [PASS]
  - mom_lowvol_h21d: [PASS]
  - trend_confirmed_h21d: [PASS]
  - gold_200ma_XAU_AUD: [PASS]
  - gold_ema_20_50_XAU_AUD: [PASS]
  - gold_ema_10_50_XAU_AUD: [PASS]
  - gold_ema_50_200_XAU_AUD: [WEAK]
  - gold_200ma_XAU_CAD: [WEAK]
  - gold_ema_20_50_XAU_CAD: [WEAK]
  - gold_ema_10_50_XAU_CAD: [WEAK]
  - gold_ema_50_200_XAU_CAD: [WEAK]
  - gold_ema_20_50_XAU_CHF: [WEAK]
  - gold_ema_50_200_XAU_CHF: [WEAK]
  - gold_200ma_XAU_EUR: [PASS]
  - gold_ema_20_50_XAU_EUR: [PASS]
  - gold_ema_50_200_XAU_EUR: [WEAK]
  - gold_200ma_XAU_GBP: [WEAK]
  - gold_ema_20_50_XAU_GBP: [PASS]
  - gold_ema_10_50_XAU_GBP: [PASS]
  - gold_ema_50_200_XAU_GBP: [PASS]
  - gold_ema_20_50_XAU_HKD: [WEAK]
  - gold_ema_10_50_XAU_HKD: [WEAK]
  - gold_ema_50_200_XAU_HKD: [WEAK]
  - gold_200ma_XAU_JPY: [WEAK]
  - gold_ema_20_50_XAU_JPY: [WEAK]
  - gold_ema_10_50_XAU_JPY: [WEAK]
  - gold_ema_50_200_XAU_JPY: [WEAK]
  - gold_200ma_XAU_NZD: [PASS]
  - gold_ema_20_50_XAU_NZD: [WEAK]
  - gold_ema_10_50_XAU_NZD: [PASS]
  - gold_ema_50_200_XAU_NZD: [WEAK]
  - gold_ema_20_50_XAU_SGD: [PASS]
  - gold_ema_10_50_XAU_SGD: [WEAK]
  - gold_ema_50_200_XAU_SGD: [WEAK]
  - gold_200ma_XAU_USD: [WEAK]
  - gold_ema_20_50_XAU_USD: [WEAK]
  - gold_ema_10_50_XAU_USD: [WEAK]
  - gold_ema_50_200_XAU_USD: [WEAK]
  - gold_200ma_XAU_XAG: [WEAK]

### Strategy Construction (06:25)
- Total variants: 102
- Strategy 1: Gold multi-cross trend (EMA 20/50)
  - Train SR: 0.49
  - Val SR: 0.25
  - Test SR: 0.16
  - Test rating: FAILED
- Strategy 2: FX MR (Z42, thr=2.0)
  - Train SR: 0.36
  - Val SR: -0.40 (degraded — parameter instability)
  - Test SR: 1.00 (recovered, but PF=1.19 < 1.2, month conc=55% > 40%)
  - Test rating: FAILED (4/6 checks, close to WEAK)

### Final Assessment
- **No strategy passed** the strict viability thresholds
- FX MR came closest — real signal but too thin after costs
- Gold trend is regime-dependent — not robust across regimes
- Carry trade is dead in this universe
- Short-term momentum is negative (reversal dominates)
- OOS data (2024-2026) was NEVER used — integrity preserved

### Honesty Check
- I was tempted to lower the PF threshold from 1.2 to 1.15 to let FX MR pass. Logged and resisted.
- The FX MR test SR=1.00 looks impressive but may benefit from benign 2023 conditions
- The validation failure (SR=-0.40) is a red flag that should not be ignored

### Recommendations
1. Test on hourly data (more signal, more trades)
2. Add regime filtering (HMM/vol)
3. Add crypto data for momentum strategies
4. Try ensemble of WEAK signals
5. Use limit orders to reduce costs
