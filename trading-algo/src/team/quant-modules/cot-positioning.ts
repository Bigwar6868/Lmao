import { createModuleLogger } from '../../shared/logger.js';

const log = createModuleLogger('cot-positioning');

/** COT positioning data for a currency */
export interface COTData {
  currency: string;
  nonCommercialLong: number;
  nonCommercialShort: number;
  netPositioning: number;          // long - short
  percentileRank: number;          // 0-100 vs 3-year history
  timestamp: number;
}

/** COT signal for a pair */
export interface COTSignal {
  symbol: string;
  baseCOT: COTData | null;
  quoteCOT: COTData | null;
  signal: 'bullish' | 'bearish' | 'neutral';
  strength: number;                // 0-1
  reason: string;
}

/**
 * COT Positioning Module (Optional)
 *
 * Uses CFTC Commitment of Traders data as a contrarian signal.
 * When speculative positioning is extreme (>80th percentile over 3 years),
 * it signals potential reversal — typically leading by 2-4 weeks.
 *
 * In cloud mode, uses synthetic/estimated positioning data.
 */
export class COTPositioning {
  /** Currency → historical net positioning (for percentile calc) */
  private history = new Map<string, number[]>();
  private readonly historyWindow = 156; // ~3 years of weekly data

  /** Latest COT data per currency */
  private latestData = new Map<string, COTData>();

  /** Extreme positioning threshold (percentile) */
  private readonly extremeThreshold = 80;

  /**
   * Update COT data for a currency.
   * In practice, call weekly with CFTC data.
   */
  update(currency: string, longContracts: number, shortContracts: number): void {
    const net = longContracts - shortContracts;
    const hist = this.history.get(currency) ?? [];
    hist.push(net);
    if (hist.length > this.historyWindow) hist.splice(0, hist.length - this.historyWindow);
    this.history.set(currency, hist);

    // Percentile rank
    const sorted = [...hist].sort((a, b) => a - b);
    const rank = sorted.findIndex(v => v >= net);
    const percentile = (rank / sorted.length) * 100;

    this.latestData.set(currency, {
      currency,
      nonCommercialLong: longContracts,
      nonCommercialShort: shortContracts,
      netPositioning: net,
      percentileRank: percentile,
      timestamp: Date.now(),
    });

    log.debug({ currency, net, percentile: percentile.toFixed(0) }, 'COT updated');
  }

  /**
   * Seed with synthetic positioning data (for cloud mode).
   */
  seedSynthetic(): void {
    const currencies = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD', 'MXN', 'BRL'];
    for (const ccy of currencies) {
      // Generate ~3 years of synthetic weekly positioning
      let net = 0;
      for (let i = 0; i < this.historyWindow; i++) {
        net += (Math.random() - 0.5) * 10000;
        net *= 0.95; // mean-revert
        const hist = this.history.get(ccy) ?? [];
        hist.push(Math.round(net));
        this.history.set(ccy, hist);
      }
      // Set latest
      const hist = this.history.get(ccy)!;
      const latest = hist[hist.length - 1];
      this.update(ccy, Math.max(0, latest), Math.max(0, -latest));
    }
    log.info('Seeded synthetic COT data for 10 currencies');
  }

  /**
   * Generate COT signal for a currency pair.
   */
  getSignal(symbol: string): COTSignal {
    const [base, quote] = this.parsePair(symbol);
    const baseCOT = this.latestData.get(base) ?? null;
    const quoteCOT = this.latestData.get(quote) ?? null;

    if (!baseCOT && !quoteCOT) {
      return { symbol, baseCOT: null, quoteCOT: null, signal: 'neutral', strength: 0, reason: 'No COT data available' };
    }

    let signal: COTSignal['signal'] = 'neutral';
    let strength = 0;
    const reasons: string[] = [];

    // Contrarian logic: extreme bullish positioning → bearish signal (and vice versa)
    if (baseCOT) {
      if (baseCOT.percentileRank > this.extremeThreshold) {
        // Specs extremely long base currency → bearish for pair (contrarian)
        reasons.push(`${base} specs extremely long (${baseCOT.percentileRank.toFixed(0)}th pct) — contrarian bearish`);
        strength += (baseCOT.percentileRank - this.extremeThreshold) / (100 - this.extremeThreshold);
        signal = 'bearish';
      } else if (baseCOT.percentileRank < (100 - this.extremeThreshold)) {
        reasons.push(`${base} specs extremely short (${baseCOT.percentileRank.toFixed(0)}th pct) — contrarian bullish`);
        strength += ((100 - this.extremeThreshold) - baseCOT.percentileRank) / (100 - this.extremeThreshold);
        signal = 'bullish';
      }
    }

    if (quoteCOT) {
      const quoteSignal = quoteCOT.percentileRank > this.extremeThreshold ? 'bullish' : // extreme long quote = bullish for pair (contrarian sell quote)
        quoteCOT.percentileRank < (100 - this.extremeThreshold) ? 'bearish' : 'neutral';

      if (quoteSignal !== 'neutral') {
        reasons.push(`${quote} specs ${quoteCOT.percentileRank > this.extremeThreshold ? 'extremely long' : 'extremely short'} (${quoteCOT.percentileRank.toFixed(0)}th pct)`);
        strength += Math.abs(quoteCOT.percentileRank - 50) / 50 * 0.5;
      }

      // Combine: if both agree, stronger signal
      if (quoteSignal === signal) strength *= 1.3;
      else if (quoteSignal !== 'neutral' && signal !== 'neutral' && quoteSignal !== signal) {
        signal = 'neutral'; // conflicting
        strength *= 0.3;
      } else if (signal === 'neutral') {
        signal = quoteSignal;
      }
    }

    strength = Math.min(1, strength);

    return {
      symbol,
      baseCOT,
      quoteCOT,
      signal,
      strength,
      reason: reasons.length > 0 ? reasons.join('; ') : 'No extreme positioning',
    };
  }

  /**
   * Get confidence modifier for a signal direction.
   * If COT agrees with trade direction: boost. If disagrees: penalize.
   */
  getConfidenceModifier(symbol: string, tradeDirection: 'BUY' | 'SELL'): number {
    const cotSignal = this.getSignal(symbol);
    if (cotSignal.signal === 'neutral' || cotSignal.strength < 0.3) return 1.0;

    const agrees = (cotSignal.signal === 'bullish' && tradeDirection === 'BUY') ||
                   (cotSignal.signal === 'bearish' && tradeDirection === 'SELL');

    if (agrees) return 1 + cotSignal.strength * 0.15; // up to +15%
    return 1 - cotSignal.strength * 0.2; // up to -20%
  }

  private parsePair(symbol: string): [string, string] {
    // Handle both "EUR/USD" and "EURUSD" formats
    if (symbol.includes('/')) {
      const parts = symbol.split('/');
      return [parts[0], parts[1]];
    }
    if (symbol.length === 6) return [symbol.slice(0, 3), symbol.slice(3)];
    return [symbol, 'USD'];
  }

  /** Format report */
  static formatReport(signals: COTSignal[]): string {
    const extreme = signals.filter(s => s.signal !== 'neutral');
    if (extreme.length === 0) return '\nNo extreme COT positioning detected.\n';

    const lines: string[] = ['\n=== COT POSITIONING ===\n'];
    for (const s of extreme) {
      const icon = s.signal === 'bullish' ? 'BULL' : 'BEAR';
      lines.push(`  [${icon}] ${s.symbol.padEnd(12)} strength: ${(s.strength * 100).toFixed(0)}% — ${s.reason}`);
    }
    return lines.join('\n');
  }
}
