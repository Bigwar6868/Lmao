/**
 * Cross-Sectional Momentum Strategy
 *
 * Based on Menkhoff, Sarno, Schmeling, Schrimpf (2012) —
 * "Currency Momentum Strategies," Journal of Financial Economics.
 *
 * Unlike TSMOM (which looks at each asset's own past returns),
 * cross-sectional momentum ranks all assets and goes long winners,
 * short losers — a market-neutral approach.
 *
 * Key findings:
 * - 1-month formation period is optimal for FX (not 12-1 month like equities)
 * - Spread of ~10% p.a. between winners and losers
 * - NOT explained by carry, business cycle, or liquidity risk
 * - Low correlation with TSMOM — good diversifier
 *
 * Implementation:
 * 1. Compute 1-month trailing return for each asset
 * 2. Rank assets by return
 * 3. Signal BUY for top quintile (winners), SELL for bottom quintile (losers)
 * 4. HOLD for middle assets
 *
 * Note: This strategy needs multiple assets analyzed together,
 * but since the TechnicalStrategist calls analyze() per-asset,
 * we track returns internally and emit signals based on relative rank.
 */

import type {
  MarketData,
  MacroEnvironment,
  Signal,
  Strategy,
  StrategyConfig,
  StrategyDNA,
} from '../../../shared/types.js';
import { generateId } from '../../../shared/utils.js';
import { createModuleLogger } from '../../../shared/logger.js';
import { EMA, ATR } from '../indicators.js';
import { generateSignal } from '../signals.js';

const log = createModuleLogger('strategy:cross-momentum');

/** Tracks trailing returns across all assets for cross-sectional ranking */
interface AssetReturn {
  symbol: string;
  trailingReturn: number;
  updatedAt: number;
}

export class CrossMomentumStrategy implements Strategy {
  name = 'cross-momentum';
  config: StrategyConfig;
  dna: StrategyDNA;

  /** Internal state: trailing returns for all assets seen */
  private assetReturns = new Map<string, AssetReturn>();
  /** Staleness threshold — ignore returns older than 2 hours */
  private readonly STALE_MS = 2 * 60 * 60 * 1000;

  constructor(config?: Partial<StrategyConfig>) {
    this.config = {
      name: this.name,
      enabled: true,
      params: {},
      assetClasses: ['crypto', 'forex'],
      timeframes: ['1h', '4h', '1d'],
      ...config,
    };
    this.dna = this.getDefaultDNA();
  }

  getDefaultDNA(): StrategyDNA {
    return {
      id: generateId(),
      name: this.name,
      generation: 0,
      parentId: null,
      params: {
        // Lookback for return calculation (bars)
        returnLookback: 480, // ~20 days on 1h

        // Ranking thresholds (percentile)
        topPctile: 0.20,     // Top 20% = winners (BUY)
        bottomPctile: 0.20,  // Bottom 20% = losers (SELL)

        // Minimum assets to form cross-section
        // In live trading, this should be 5+. In backtest (single asset), set to 1.
        minAssets: 3,

        // Trend filter
        trendEmaPeriod: 50,
        requireTrend: 1,

        // Confidence scaling
        baseConfidence: 0.45,
        rankBoost: 0.20,     // Bonus for being at extreme rank
      },
      fitness: 0,
      createdAt: Date.now(),
      mutations: ['genesis'],
    };
  }

  async analyze(data: MarketData, _macro?: MacroEnvironment): Promise<Signal[]> {
    const { candles, asset, timeframe } = data;
    const p = this.dna.params;

    // Adjust lookback for timeframe
    const lookback = this.adjustForTimeframe(Math.round(p['returnLookback'] ?? 720), timeframe);
    const minCandles = lookback + 10;

    if (candles.length < minCandles) {
      return [];
    }

    const lastIdx = candles.length - 1;
    const price = candles[lastIdx].close;

    // 1. Compute trailing return for this asset
    const pastPrice = candles[lastIdx - lookback].close;
    const trailingReturn = (price - pastPrice) / pastPrice;

    // Store in cross-section map
    this.assetReturns.set(asset.symbol, {
      symbol: asset.symbol,
      trailingReturn,
      updatedAt: Date.now(),
    });

    // 2. Clean stale entries
    const now = Date.now();
    for (const [sym, ret] of this.assetReturns) {
      if (now - ret.updatedAt > this.STALE_MS) {
        this.assetReturns.delete(sym);
      }
    }

    // 3. Check if we have enough assets for cross-sectional ranking
    const minAssets = Math.round(p['minAssets'] ?? 5);
    if (this.assetReturns.size < minAssets) {
      return [generateSignal(asset, 'HOLD', 0, price, this.name, timeframe, {},
        `Cross-section too small (${this.assetReturns.size}/${minAssets}) — need more assets`)];
    }

    // 4. Rank all assets by trailing return
    const allReturns = [...this.assetReturns.values()].sort((a, b) => b.trailingReturn - a.trailingReturn);
    const rank = allReturns.findIndex(r => r.symbol === asset.symbol);
    const percentileRank = rank / (allReturns.length - 1); // 0 = best, 1 = worst

    const topPctile = p['topPctile'] ?? 0.20;
    const bottomPctile = p['bottomPctile'] ?? 0.20;

    // 5. Determine action based on rank
    let action: 'BUY' | 'SELL' | 'HOLD';
    let rankLabel: string;

    if (percentileRank <= topPctile) {
      action = 'BUY';
      rankLabel = 'winner';
    } else if (percentileRank >= 1 - bottomPctile) {
      action = 'SELL';
      rankLabel = 'loser';
    } else {
      return [generateSignal(asset, 'HOLD', 0, price, this.name, timeframe, {},
        `Cross-momentum: ${asset.symbol} ranked ${rank + 1}/${allReturns.length} — middle of pack`)];
    }

    // 6. Trend filter (optional)
    const requireTrend = (p['requireTrend'] ?? 1) > 0;
    if (requireTrend) {
      const trendEma = EMA(candles, Math.round(p['trendEmaPeriod'] ?? 50)).values;
      const trendVal = trendEma[lastIdx];
      if (trendVal) {
        if (action === 'BUY' && price < trendVal * 0.998) {
          return [generateSignal(asset, 'HOLD', 0, price, this.name, timeframe, {},
            'Cross-momentum winner but below trend EMA')];
        }
        if (action === 'SELL' && price > trendVal * 1.002) {
          return [generateSignal(asset, 'HOLD', 0, price, this.name, timeframe, {},
            'Cross-momentum loser but above trend EMA')];
        }
      }
    }

    // 7. Confidence — based on rank extremity and return magnitude
    const baseConf = p['baseConfidence'] ?? 0.45;
    const rankBoost = p['rankBoost'] ?? 0.20;
    const extremity = action === 'BUY'
      ? (topPctile - percentileRank) / topPctile
      : (percentileRank - (1 - bottomPctile)) / bottomPctile;

    const confidence = Math.min(0.90, Math.max(0.40,
      baseConf +
      extremity * rankBoost +
      Math.min(0.10, Math.abs(trailingReturn) * 2),
    ));

    const reason = `Cross-momentum ${action} (${rankLabel}): ${asset.symbol} ranked ${rank + 1}/${allReturns.length}, ret=${(trailingReturn * 100).toFixed(2)}%`;

    return [generateSignal(asset, action, confidence, price, this.name, timeframe, {
      trailingReturn,
      rank: rank + 1,
      totalAssets: allReturns.length,
      percentileRank,
    }, reason)];
  }

  /** Adjust bar-based lookback for different timeframes */
  private adjustForTimeframe(bars1h: number, timeframe: string): number {
    switch (timeframe) {
      case '1h': return bars1h;
      case '4h': return Math.round(bars1h / 4);
      case '1d': return Math.round(bars1h / 24);
      default: return bars1h;
    }
  }
}
