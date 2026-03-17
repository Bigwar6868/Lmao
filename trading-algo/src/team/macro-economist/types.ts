// ============================================================
// Macro Economist — Local Types
// ============================================================

/** Common FRED series IDs used for macro analysis */
export type FredSeriesId =
  | 'FEDFUNDS'   // Federal Funds Effective Rate
  | 'CPIAUCSL'   // Consumer Price Index for All Urban Consumers
  | 'GDP'        // Gross Domestic Product
  | 'UNRATE'     // Unemployment Rate
  | 'T10Y2Y'     // 10-Year Treasury Minus 2-Year Treasury (Yield Curve)
  | 'VIXCLS'     // CBOE Volatility Index
  | 'DGS10'      // 10-Year Treasury Constant Maturity Rate
  | 'DGS2'       // 2-Year Treasury Constant Maturity Rate
  | 'PAYEMS'     // Total Nonfarm Payrolls
  | 'UMCSENT';   // University of Michigan Consumer Sentiment

/** A scheduled economic event */
export interface EconomicEvent {
  name: string;
  description: string;
  impact: 'high' | 'medium' | 'low';
  /** Typical day-of-month or schedule description */
  schedule: string;
  /** Next estimated date (ISO string) */
  nextDate: string;
  /** Source institution */
  source: string;
}

/** Geopolitical risk assessment */
export interface GeopoliticalRisk {
  score: number;          // 0–100
  level: 'low' | 'medium' | 'high' | 'extreme';
  vixLevel: number;
  factors: GeopoliticalFactor[];
  timestamp: number;
}

/** A specific geopolitical risk factor */
export interface GeopoliticalFactor {
  category: 'conflict' | 'sanctions' | 'trade-war' | 'election' | 'policy' | 'energy' | 'pandemic' | 'debt-crisis';
  region: string;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  affectedAssets: string[];      // e.g., ['USD/JPY', 'BTC/USDT', 'oil']
  marketImpact: 'bullish' | 'bearish' | 'volatile' | 'neutral';
}

/** Policy change event */
export interface PolicyChange {
  country: string;
  institution: string;           // e.g., 'Federal Reserve', 'ECB', 'PBoC'
  type: 'monetary' | 'fiscal' | 'regulatory' | 'trade';
  description: string;
  impact: 'hawkish' | 'dovish' | 'neutral' | 'restrictive' | 'expansionary';
  affectedMarkets: string[];     // e.g., ['crypto', 'forex']
  effectiveDate: string;
  severity: 'low' | 'medium' | 'high';
}

/** Global macro data source */
export interface GlobalMacroSnapshot {
  region: string;
  indicators: Record<string, number>;
  policyStance: 'hawkish' | 'dovish' | 'neutral';
  growthOutlook: 'expanding' | 'slowing' | 'contracting' | 'recovering';
  inflationTrend: 'rising' | 'falling' | 'stable' | 'sticky';
  timestamp: number;
}
