import { createModuleLogger } from '../../shared/logger.js';
import type { StrategyDNA, PerformanceMetrics } from '../../shared/types.js';

const log = createModuleLogger('onnx-export');

/** ONNX export metadata */
export interface ONNXExportConfig {
  strategyName: string;
  inputFeatures: string[];
  outputClasses: string[];        // ['BUY', 'SELL', 'HOLD']
  modelType: 'linear' | 'tree' | 'neural';
  dna: StrategyDNA;
  metrics: PerformanceMetrics;
}

/** Exported model description (for MT5 integration) */
export interface ONNXModelDescriptor {
  name: string;
  version: string;
  features: Array<{ name: string; type: 'float32'; shape: number[] }>;
  outputs: Array<{ name: string; type: 'float32'; shape: number[] }>;
  dna: Record<string, number>;
  mt5Code: string;              // Generated MQL5 code snippet
  performance: {
    sharpe: number;
    winRate: number;
    maxDrawdown: number;
  };
  exportedAt: number;
}

/**
 * ONNX Export Module (Optional)
 *
 * Generates model descriptors and MQL5 integration code for MetaTrader 5.
 * MT5 natively supports ONNX models since build 3230+.
 *
 * This module doesn't create actual ONNX files (needs onnxruntime),
 * but generates the configuration and MQL5 boilerplate needed to
 * integrate the trading strategies into an MT5 Expert Advisor.
 */
export class ONNXExporter {
  private exports: ONNXModelDescriptor[] = [];

  /**
   * Generate model descriptor for a strategy.
   */
  exportStrategy(config: ONNXExportConfig): ONNXModelDescriptor {
    const descriptor: ONNXModelDescriptor = {
      name: `trading_algo_${config.strategyName}`,
      version: `gen${config.dna.generation}_${Date.now()}`,
      features: config.inputFeatures.map(name => ({
        name,
        type: 'float32' as const,
        shape: [1],
      })),
      outputs: [
        { name: 'action', type: 'float32' as const, shape: [3] },      // BUY/SELL/HOLD probs
        { name: 'confidence', type: 'float32' as const, shape: [1] },
      ],
      dna: { ...config.dna.params },
      mt5Code: this.generateMQL5Code(config),
      performance: {
        sharpe: config.metrics.sharpeRatio,
        winRate: config.metrics.winRate,
        maxDrawdown: config.metrics.maxDrawdownPct,
      },
      exportedAt: Date.now(),
    };

    this.exports.push(descriptor);
    log.info({ strategy: config.strategyName, features: config.inputFeatures.length }, 'Strategy exported for ONNX/MT5');
    return descriptor;
  }

  /**
   * Get list of standard input features for FX strategies.
   */
  getStandardFeatures(strategyName: string): string[] {
    const common = ['rsi_14', 'ema_fast', 'ema_slow', 'ema_trend_200', 'atr_14', 'bb_upper', 'bb_lower', 'bb_bandwidth', 'volume_ratio'];

    const strategySpecific: Record<string, string[]> = {
      momentum: [...common, 'macd_histogram', 'ema_crossover', 'trend_distance'],
      'mean-reversion': [...common, 'bb_zscore', 'rsi_oversold', 'rsi_overbought', 'ou_halflife'],
      breakout: [...common, 'bb_squeeze', 'volume_spike', 'trend_alignment'],
      'multi-indicator': [...common, 'vote_buy_score', 'vote_sell_score', 'consensus_pct'],
      carry: ['rate_differential', 'daily_carry', 'vol_adjusted_carry'],
    };

    return strategySpecific[strategyName] ?? common;
  }

  /**
   * Generate MQL5 Expert Advisor code snippet for MT5 integration.
   */
  private generateMQL5Code(config: ONNXExportConfig): string {
    const features = config.inputFeatures;
    const featureCount = features.length;

    return `//+------------------------------------------------------------------+
//| ${config.strategyName}_EA.mq5 — Auto-generated from Trading Algo  |
//| Strategy: ${config.strategyName} (Gen ${config.dna.generation})        |
//| Sharpe: ${config.metrics.sharpeRatio.toFixed(2)} | WinRate: ${(config.metrics.winRate * 100).toFixed(1)}% |
//+------------------------------------------------------------------+
#resource "\\\\Models\\\\${config.strategyName}_model.onnx" as uchar OnnxModel[]

#include <Trade\\Trade.mqh>
CTrade trade;

long onnxHandle = INVALID_HANDLE;
input double LotSize = 0.01;
input int    MagicNumber = ${Math.floor(Math.random() * 90000) + 10000};

//--- Feature buffer
float features[${featureCount}];
float output_action[3];  // BUY, SELL, HOLD probabilities
float output_conf[1];    // confidence

int OnInit() {
   onnxHandle = OnnxCreateFromBuffer(OnnxModel, ONNX_DEFAULT);
   if(onnxHandle == INVALID_HANDLE) {
      Print("Failed to load ONNX model");
      return INIT_FAILED;
   }

   // Set input/output shapes
   long inputShape[] = {1, ${featureCount}};
   OnnxSetInputShape(onnxHandle, 0, inputShape);
   long outputShape1[] = {1, 3};
   OnnxSetOutputShape(onnxHandle, 0, outputShape1);
   long outputShape2[] = {1, 1};
   OnnxSetOutputShape(onnxHandle, 1, outputShape2);

   trade.SetExpertMagicNumber(MagicNumber);
   return INIT_SUCCEEDED;
}

void OnTick() {
   // Compute features from market data
   ComputeFeatures();

   // Run inference
   if(!OnnxRun(onnxHandle, ONNX_DEFAULT, features, output_action, output_conf))
      return;

   float confidence = output_conf[0];
   if(confidence < 0.55) return;  // MIN_CONFIDENCE threshold

   // Find best action
   int bestAction = 0;
   float bestProb = output_action[0];
   for(int i = 1; i < 3; i++) {
      if(output_action[i] > bestProb) {
         bestProb = output_action[i];
         bestAction = i;
      }
   }

   // Execute
   if(bestAction == 0 && PositionsTotal() == 0)       // BUY
      trade.Buy(LotSize, _Symbol);
   else if(bestAction == 1 && PositionsTotal() == 0)   // SELL
      trade.Sell(LotSize, _Symbol);
}

void ComputeFeatures() {
   // TODO: Compute ${featureCount} features from indicator values
${features.map((f, i) => `   // features[${i}] = ${f}`).join('\n')}
}

void OnDeinit(const int reason) {
   if(onnxHandle != INVALID_HANDLE) OnnxRelease(onnxHandle);
}
`;
  }

  /** Get all exports */
  getExports(): ONNXModelDescriptor[] {
    return [...this.exports];
  }

  /** Format report */
  static formatReport(exports: ONNXModelDescriptor[]): string {
    if (exports.length === 0) return '\nNo ONNX exports available.\n';

    const lines: string[] = ['\n=== ONNX/MT5 EXPORTS ===\n'];
    for (const e of exports) {
      lines.push(
        `  ${e.name} v${e.version.slice(0, 20)} | ${e.features.length} features | SR: ${e.performance.sharpe.toFixed(2)} | WR: ${(e.performance.winRate * 100).toFixed(0)}%`,
      );
    }
    return lines.join('\n');
  }
}
