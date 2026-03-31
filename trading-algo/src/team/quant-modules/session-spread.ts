import type { AssetInfo } from '../../shared/types.js';
import { createModuleLogger } from '../../shared/logger.js';

const log = createModuleLogger('session-spread');

/** Trading session */
export type TradingSession = 'asian' | 'london' | 'ny' | 'london_ny_overlap';

/** Spread estimate for a trade */
export interface SpreadEstimate {
  symbol: string;
  session: TradingSession;
  estimatedSpreadPips: number;
  estimatedSpreadPct: number;       // as % of price
  costPerTrade: number;             // estimated $ cost per standard lot
  isHighSpreadPeriod: boolean;
  recommendation: 'trade' | 'caution' | 'avoid';
}

/**
 * Session-Aware Spread Model (Optional Module)
 *
 * Estimates bid-ask spread costs based on:
 * 1. Current trading session (Asian wider, London/NY tighter)
 * 2. Pair liquidity tier (major, minor, exotic)
 * 3. Time-of-day adjustments
 *
 * Research: EUR/USD spreads range 0.1-0.3 pips during London/NY overlap
 * to 1.5-2.0 pips during Asian session, spiking to 5-10 pips during news.
 */
export class SessionSpreadModel {
  /** Base spreads by pair type and session (in pips) */
  private readonly spreadTable: Record<string, Record<TradingSession, number>> = {
    // Majors
    'EUR/USD': { asian: 1.5, london: 0.3, ny: 0.5, london_ny_overlap: 0.1 },
    'GBP/USD': { asian: 2.0, london: 0.5, ny: 0.8, london_ny_overlap: 0.3 },
    'USD/JPY': { asian: 1.0, london: 0.5, ny: 0.5, london_ny_overlap: 0.2 },
    'USD/CHF': { asian: 2.0, london: 0.8, ny: 1.0, london_ny_overlap: 0.5 },
    'AUD/USD': { asian: 1.0, london: 0.8, ny: 1.0, london_ny_overlap: 0.5 },
    'USD/CAD': { asian: 2.0, london: 1.0, ny: 0.8, london_ny_overlap: 0.5 },
    'NZD/USD': { asian: 1.5, london: 1.0, ny: 1.2, london_ny_overlap: 0.8 },
    // Metals
    'XAU/USD': { asian: 3.0, london: 1.5, ny: 1.5, london_ny_overlap: 1.0 },
    'XAG/USD': { asian: 5.0, london: 2.5, ny: 3.0, london_ny_overlap: 2.0 },
  };

  /** Default spreads by liquidity tier */
  private readonly tierDefaults: Record<string, Record<TradingSession, number>> = {
    major:  { asian: 1.5, london: 0.5, ny: 0.7, london_ny_overlap: 0.3 },
    minor:  { asian: 3.0, london: 1.5, ny: 2.0, london_ny_overlap: 1.0 },
    exotic: { asian: 10.0, london: 5.0, ny: 6.0, london_ny_overlap: 4.0 },
    metal:  { asian: 4.0, london: 2.0, ny: 2.0, london_ny_overlap: 1.5 },
  };

  /** Exotic pairs that get wide spreads */
  private readonly exoticSymbols = new Set([
    'USD/TRY', 'USD/ZAR', 'USD/THB', 'USD/TWD', 'USD/MXN', 'USD/PLN',
    'USD/HUF', 'USD/CZK', 'USD/NOK', 'USD/SEK', 'USD/SGD', 'USD/CNH',
    'EUR/PLN', 'EUR/NOK', 'EUR/SEK', 'GBP/PLN', 'CHF/ZAR', 'CAD/SGD',
    'NZD/SGD', 'NZD/CHF',
  ]);

  /**
   * Detect current trading session from UTC hour.
   */
  getCurrentSession(utcHour?: number): TradingSession {
    const hour = utcHour ?? new Date().getUTCHours();

    // London: 7-16 UTC, NY: 12-21 UTC
    if (hour >= 12 && hour < 16) return 'london_ny_overlap';
    if (hour >= 7 && hour < 17) return 'london';
    if (hour >= 12 && hour < 21) return 'ny';
    return 'asian'; // 21-7 UTC
  }

  /**
   * Estimate spread for a given asset in the current session.
   */
  estimate(asset: AssetInfo, price: number, utcHour?: number): SpreadEstimate {
    const session = this.getCurrentSession(utcHour);
    const symbol = asset.symbol;

    // Look up specific pair spread, fall back to tier default
    let spreadPips: number;
    if (this.spreadTable[symbol]) {
      spreadPips = this.spreadTable[symbol][session];
    } else {
      const tier = this.getTier(asset);
      spreadPips = this.tierDefaults[tier][session];
    }

    // Convert pips to percentage of price
    const pipValue = this.getPipValue(asset);
    const spreadInPrice = spreadPips * pipValue;
    const spreadPct = price > 0 ? (spreadInPrice / price) * 100 : 0;

    // Cost per standard lot (100,000 units for FX)
    const lotSize = asset.assetClass === 'forex' ? 100_000 : 100; // 100 oz for gold
    const costPerTrade = spreadInPrice * lotSize;

    const isHighSpread = session === 'asian' || this.exoticSymbols.has(symbol);

    let recommendation: SpreadEstimate['recommendation'] = 'trade';
    if (spreadPct > 0.1) recommendation = 'avoid';   // >0.1% spread = too expensive
    else if (spreadPct > 0.05) recommendation = 'caution';  // 0.05-0.1% = be careful

    return {
      symbol,
      session,
      estimatedSpreadPips: spreadPips,
      estimatedSpreadPct: spreadPct,
      costPerTrade,
      isHighSpreadPeriod: isHighSpread,
      recommendation,
    };
  }

  /**
   * Should we trade this asset right now?
   * Returns a cost multiplier (1 = normal, >1 = expensive).
   */
  getCostMultiplier(asset: AssetInfo, price: number): number {
    const est = this.estimate(asset, price);
    // Normalize: 0.01% spread = 1.0x, 0.1% = 3.0x
    return Math.max(1, 1 + (est.estimatedSpreadPct - 0.01) * 20);
  }

  private getTier(asset: AssetInfo): string {
    if (asset.symbol.includes('XAU') || asset.symbol.includes('XAG') ||
        asset.symbol.includes('XPT') || asset.symbol.includes('XPD') ||
        asset.symbol.includes('XCU')) return 'metal';
    if (this.exoticSymbols.has(asset.symbol)) return 'exotic';
    const majors = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CHF', 'AUD/USD', 'USD/CAD', 'NZD/USD'];
    if (majors.includes(asset.symbol)) return 'major';
    return 'minor';
  }

  private getPipValue(asset: AssetInfo): number {
    const sym = asset.symbol;
    // JPY pairs: 1 pip = 0.01
    if (sym.includes('JPY')) return 0.01;
    // Gold: 1 pip = 0.1
    if (sym.includes('XAU')) return 0.1;
    // Silver: 1 pip = 0.01
    if (sym.includes('XAG')) return 0.01;
    // Standard FX: 1 pip = 0.0001
    return 0.0001;
  }

  /** Format report */
  static formatReport(estimates: SpreadEstimate[]): string {
    if (estimates.length === 0) return '\nNo spread estimates.\n';

    const lines: string[] = ['\n=== SESSION SPREAD MODEL ===\n'];
    lines.push(`  Session: ${estimates[0]?.session.toUpperCase()}\n`);

    const byRec = { trade: [] as SpreadEstimate[], caution: [] as SpreadEstimate[], avoid: [] as SpreadEstimate[] };
    for (const e of estimates) byRec[e.recommendation].push(e);

    if (byRec.trade.length > 0) {
      lines.push('  Tradeable:');
      for (const e of byRec.trade.slice(0, 10)) {
        lines.push(`    [OK] ${e.symbol.padEnd(12)} ${e.estimatedSpreadPips.toFixed(1)} pips (${e.estimatedSpreadPct.toFixed(3)}%)`);
      }
    }
    if (byRec.caution.length > 0) {
      lines.push('  Caution (wide spreads):');
      for (const e of byRec.caution) {
        lines.push(`    [!!] ${e.symbol.padEnd(12)} ${e.estimatedSpreadPips.toFixed(1)} pips (${e.estimatedSpreadPct.toFixed(3)}%)`);
      }
    }
    if (byRec.avoid.length > 0) {
      lines.push('  Avoid (spreads too wide):');
      for (const e of byRec.avoid) {
        lines.push(`    [XX] ${e.symbol.padEnd(12)} ${e.estimatedSpreadPips.toFixed(1)} pips (${e.estimatedSpreadPct.toFixed(3)}%)`);
      }
    }

    return lines.join('\n');
  }
}
