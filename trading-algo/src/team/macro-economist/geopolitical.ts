// ============================================================
// Geopolitical Risk Analyzer — VIX-based rule engine
// ============================================================

import { createModuleLogger } from '../../shared/logger.js';
import { FredClient } from './fred.js';
import type { GeopoliticalRisk } from './types.js';

const logger = createModuleLogger('geopolitical-analyzer');

export class GeopoliticalAnalyzer {
  private readonly fred: FredClient;

  constructor(fred?: FredClient) {
    this.fred = fred ?? new FredClient();
  }

  /**
   * Get a numeric risk score (0–100) derived from the VIX level.
   */
  async getRiskScore(): Promise<number> {
    const risk = await this.assess();
    return risk.score;
  }

  /**
   * Get a categorical risk level.
   */
  async getRiskLevel(): Promise<'low' | 'medium' | 'high' | 'extreme'> {
    const risk = await this.assess();
    return risk.level;
  }

  /**
   * Full risk assessment including VIX level.
   */
  async assess(): Promise<GeopoliticalRisk> {
    const vixIndicator = await this.fred.fetchLatest('VIXCLS');
    const vix = vixIndicator.value;

    const { score, level } = this.scoreFromVix(vix);

    logger.info({ vix, score, level }, 'Geopolitical risk assessed');

    return {
      score,
      level,
      vixLevel: vix,
      timestamp: Date.now(),
    };
  }

  // ---- private ----

  private scoreFromVix(vix: number): { score: number; level: GeopoliticalRisk['level'] } {
    if (vix < 15) {
      return { score: 20, level: 'low' };
    }
    if (vix <= 25) {
      return { score: 50, level: 'medium' };
    }
    if (vix <= 35) {
      return { score: 75, level: 'high' };
    }
    return { score: 90, level: 'extreme' };
  }
}
