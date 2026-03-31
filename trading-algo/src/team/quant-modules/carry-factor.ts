import type { Signal, AssetInfo, Candle, Timeframe } from '../../shared/types.js';
import { createModuleLogger } from '../../shared/logger.js';
import { generateId } from '../../shared/utils.js';

const log = createModuleLogger('carry-factor');

/** Interest rate data for a currency */
interface CurrencyRate {
  currency: string;
  rate: number;           // annual interest rate (e.g., 0.05 = 5%)
  lastUpdated: number;
}

/** Carry signal for a pair */
export interface CarrySignal {
  symbol: string;
  rateDifferential: number;    // annualized rate diff
  dailyCarry: number;          // daily carry in % of notional
  signal: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  reason: string;
}

/**
 * Carry Factor Module (Optional)
 *
 * The carry trade: go long high-yield currencies, short low-yield ones.
 * Exploits the Forward Premium Puzzle (violation of UIP).
 *
 * Historical performance: Sharpe 0.54-0.82 (Lustig et al. 2011)
 * WARNING: Severe negative skewness — "picking up nickels in front of a steamroller"
 *
 * This module:
 * 1. Maintains interest rate table for major currencies
 * 2. Computes carry signals from rate differentials
 * 3. Generates Signal objects compatible with the trading pipeline
 */
export class CarryFactor {
  /** Currency → annual interest rate */
  private rates = new Map<string, CurrencyRate>();

  /** Minimum rate differential to generate a signal (annualized) */
  private readonly minDifferential = 0.01; // 1%

  /** Maximum confidence for carry signals (keep conservative due to crash risk) */
  private readonly maxConfidence = 0.7;

  constructor() {
    // Seed with approximate central bank rates (as of early 2026)
    this.seedDefaultRates();
  }

  /**
   * Update interest rate for a currency.
   */
  setRate(currency: string, annualRate: number): void {
    this.rates.set(currency, {
      currency,
      rate: annualRate,
      lastUpdated: Date.now(),
    });
    log.debug({ currency, rate: (annualRate * 100).toFixed(2) + '%' }, 'Rate updated');
  }

  /**
   * Generate carry signal for a currency pair.
   */
  getCarrySignal(symbol: string): CarrySignal {
    const [base, quote] = this.parsePair(symbol);
    const baseRate = this.rates.get(base);
    const quoteRate = this.rates.get(quote);

    if (!baseRate || !quoteRate) {
      return {
        symbol,
        rateDifferential: 0,
        dailyCarry: 0,
        signal: 'HOLD',
        confidence: 0,
        reason: `Missing rate data for ${!baseRate ? base : quote}`,
      };
    }

    const diff = baseRate.rate - quoteRate.rate;
    const dailyCarry = diff / 365;
    const absDiff = Math.abs(diff);

    let signal: CarrySignal['signal'] = 'HOLD';
    if (diff > this.minDifferential) {
      signal = 'BUY'; // Long base (higher yield), short quote (lower yield)
    } else if (diff < -this.minDifferential) {
      signal = 'SELL'; // Short base (lower yield), long quote (higher yield)
    }

    // Confidence: scales with rate differential, capped at maxConfidence
    // 1% diff → 0.3 confidence, 5% diff → 0.7 confidence
    const confidence = signal !== 'HOLD'
      ? Math.min(this.maxConfidence, 0.2 + (absDiff / 0.08) * 0.5)
      : 0;

    const reason = signal === 'HOLD'
      ? `Rate differential too small (${(diff * 100).toFixed(2)}%) — no carry trade`
      : `Carry ${signal}: ${base} ${(baseRate.rate * 100).toFixed(2)}% vs ${quote} ${(quoteRate.rate * 100).toFixed(2)}% (diff: ${(diff * 100).toFixed(2)}%)`;

    return { symbol, rateDifferential: diff, dailyCarry, signal, confidence, reason };
  }

  /**
   * Generate full Signal objects for the trading pipeline.
   * Only generates for pairs with meaningful carry.
   */
  generateSignals(
    assets: AssetInfo[],
    candles: Map<string, Candle[]>,
    timeframe: Timeframe,
  ): Signal[] {
    const signals: Signal[] = [];

    for (const asset of assets) {
      if (asset.assetClass !== 'forex') continue;

      const carry = this.getCarrySignal(asset.symbol);
      if (carry.signal === 'HOLD') continue;

      const assetCandles = candles.get(asset.symbol);
      const price = assetCandles && assetCandles.length > 0
        ? assetCandles[assetCandles.length - 1].close
        : 0;

      if (price === 0) continue;

      signals.push({
        asset,
        action: carry.signal,
        confidence: carry.confidence,
        price,
        timestamp: Date.now(),
        strategy: 'carry',
        timeframe,
        indicators: {
          rateDifferential: carry.rateDifferential,
          dailyCarry: carry.dailyCarry,
        },
        reason: carry.reason,
      });
    }

    log.info({ signals: signals.length }, 'Carry signals generated');
    return signals;
  }

  /**
   * Get carry boost/penalty for an existing signal.
   * If the signal direction aligns with carry, boost confidence.
   */
  getCarryModifier(symbol: string, direction: 'BUY' | 'SELL'): number {
    const carry = this.getCarrySignal(symbol);
    if (carry.signal === 'HOLD') return 1.0;

    const aligned = carry.signal === direction;
    if (aligned) return 1 + carry.confidence * 0.1; // up to +7% confidence boost
    return 1 - carry.confidence * 0.05; // small penalty for counter-carry trades
  }

  /**
   * Seed with approximate central bank rates.
   */
  private seedDefaultRates(): void {
    const rates: Record<string, number> = {
      USD: 0.0450, // Fed funds rate
      EUR: 0.0325, // ECB main refinancing rate
      GBP: 0.0450, // BoE bank rate
      JPY: 0.0050, // BoJ policy rate
      AUD: 0.0410, // RBA cash rate
      CAD: 0.0350, // BoC overnight rate
      CHF: 0.0100, // SNB policy rate
      NZD: 0.0425, // RBNZ OCR
      NOK: 0.0400, // Norges Bank
      SEK: 0.0325, // Riksbank
      PLN: 0.0575, // NBP
      MXN: 0.0950, // Banxico
      ZAR: 0.0800, // SARB
      TRY: 0.4500, // TCMB
      SGD: 0.0350, // MAS
      CNH: 0.0350, // PBoC
      HUF: 0.0650, // MNB
      CZK: 0.0425, // CNB
      THB: 0.0225, // BoT
      TWD: 0.0200, // CBC
      XAU: 0.0000, // Gold has no yield
      XAG: 0.0000, // Silver has no yield
    };

    for (const [ccy, rate] of Object.entries(rates)) {
      this.setRate(ccy, rate);
    }
    log.info({ currencies: Object.keys(rates).length }, 'Seeded default interest rates');
  }

  private parsePair(symbol: string): [string, string] {
    if (symbol.includes('/')) {
      const parts = symbol.split('/');
      return [parts[0], parts[1]];
    }
    if (symbol.length === 6) return [symbol.slice(0, 3), symbol.slice(3)];
    return [symbol, 'USD'];
  }

  /** Format carry table */
  static formatReport(signals: CarrySignal[]): string {
    const active = signals.filter(s => s.signal !== 'HOLD');
    if (active.length === 0) return '\nNo carry signals.\n';

    const lines: string[] = ['\n=== CARRY FACTOR ===\n'];
    active.sort((a, b) => Math.abs(b.rateDifferential) - Math.abs(a.rateDifferential));
    for (const s of active) {
      const dir = s.signal === 'BUY' ? 'LONG' : 'SHORT';
      lines.push(
        `  [${dir.padEnd(5)}] ${s.symbol.padEnd(12)} diff: ${(s.rateDifferential * 100).toFixed(2)}% | daily: ${(s.dailyCarry * 10000).toFixed(2)}bps | conf: ${(s.confidence * 100).toFixed(0)}%`,
      );
    }
    return lines.join('\n');
  }
}
