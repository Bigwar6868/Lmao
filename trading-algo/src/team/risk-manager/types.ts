// ============================================================
// Risk Manager Types
// ============================================================

export interface RiskLimits {
  maxPositionSizePct: number;
  maxDrawdownPct: number;
  maxCorrelation: number;
  maxSectorExposure: number;
  maxOpenPositions: number;
  maxExposurePerAsset: number;
}

export interface PositionRisk {
  positionId: string;
  symbol: string;
  exposurePct: number;
  unrealizedPnlPct: number;
  distanceToStopPct: number;
  distanceToTakeProfitPct: number;
  riskRewardRatio: number;
}

export interface PortfolioRisk {
  totalExposurePct: number;
  currentDrawdownPct: number;
  openPositionCount: number;
  exposureByAsset: Map<string, number>;
  positionRisks: PositionRisk[];
  isDrawdownBreached: boolean;
  isExposureBreached: boolean;
}
