---
description: Optimize z-score parameters for forex pairs using statistical tests
allowed-tools: Bash, Read
---

Run the Z-Score Optimizer to find optimal entry/exit thresholds per pair:

1. Run from `trading-algo-py/`. For all forex pairs:
```bash
cd trading-algo-py && python main.py optimize-zscore
```

   Or for specific pairs:
```bash
cd trading-algo-py && python main.py optimize-zscore EUR/USD GBP/USD
```

2. The optimizer runs:
   - ADF stationarity test
   - Shapiro-Wilk normality test
   - Ljung-Box autocorrelation test
   - Hurst exponent (regime detection)
   - OU process half-life
   - Grid search over window sizes and thresholds
   - Bootstrap confidence intervals for Sharpe ratio

3. Results saved to `data/zscore_optimization/zscore_params.json`

4. Summarize:
   - Which pairs have statistically valid z-score parameters
   - Optimal entry/exit thresholds per pair
   - Sharpe ratios and confidence intervals
   - Any pairs that failed stationarity tests (should be excluded)
