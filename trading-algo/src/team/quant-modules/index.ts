// ============================================================
// Quant Modules — barrel export
// ============================================================

// HIGH-IMPACT (always active)
export { ICDecayTracker } from './ic-decay-tracker.js';
export type { ICHealthReport } from './ic-decay-tracker.js';

export { HMMRegimeDetector } from './hmm-regime.js';
export type { HMMRegimeResult, HMMState } from './hmm-regime.js';

export { StatisticalValidator } from './statistical-validation.js';
export type { WFEResult, DeflatedSharpeResult } from './statistical-validation.js';

export { OUHalfLifeFilter } from './ou-halflife.js';
export type { HalfLifeResult } from './ou-halflife.js';

// MEDIUM-IMPACT (optional — AI decides)
export { FactorCrowdingDetector } from './factor-crowding.js';
export type { CrowdingReport } from './factor-crowding.js';

export { SessionSpreadModel } from './session-spread.js';
export type { SpreadEstimate } from './session-spread.js';

export { COTPositioning } from './cot-positioning.js';
export type { COTSignal } from './cot-positioning.js';

export { ONNXExporter } from './onnx-export.js';
export type { ONNXModelDescriptor } from './onnx-export.js';

export { CarryFactor } from './carry-factor.js';
export type { CarrySignal } from './carry-factor.js';

// Module Manager (AI decision layer)
export { QuantModuleManager } from './manager.js';
export type { ModuleDecision, QuantReport } from './manager.js';
