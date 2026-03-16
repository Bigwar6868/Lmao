// ============================================================
// Evolution Team — backtests, evolves strategies, detects decay
// ============================================================

import type {
  AgentId,
  DirectivePayload,
  QuestionPayload,
} from '../../shared/agent-types.js';
import type { AssetInfo, Timeframe, Strategy, Candle } from '../../shared/types.js';
import type { AgentNetwork } from '../agent-network/network.js';
import { Backtester } from '../backtester/index.js';
import { SelfImprover } from '../self-improver/index.js';
import { DecayDetector } from '../agent-network/decay-detector.js';
import { OverfitGuard } from '../agent-network/overfit-guard.js';
import type { AgentSpawner } from '../agent-network/spawner.js';
import { TeamBase } from './team-base.js';

export class EvolutionTeam extends TeamBase {
  readonly backtester = new Backtester();
  readonly selfImprover = new SelfImprover();
  readonly decayDetector = new DecayDetector();
  readonly overfitGuard = new OverfitGuard();

  constructor(network: AgentNetwork, ceoId: AgentId) {
    super({ teamId: 'evolution', teamName: 'Evolution Team', network, ceoId });
  }

  protected getDescription(): string {
    return 'Backtests strategies, evolves DNA via genetic algorithm, detects decay';
  }

  async initialize(): Promise<void> {
    await this.selfImprover.initialize();
    this.log.info('Evolution team initialized');
  }

  // ----------------------------------------------------------------
  // Evolution — runs internally, no external API
  // ----------------------------------------------------------------

  async evolveStrategy(
    strategy: Strategy,
    candles: Candle[],
    asset: AssetInfo,
    timeframe: Timeframe,
  ) {
    const result = await this.selfImprover.evolveStrategy(strategy, candles, asset, timeframe);

    // Report to CEO
    await this.reportToCeo('analysis',
      `Evolution: ${strategy.name} gen ${result.bestDna.generation} — ${result.improved ? 'IMPROVED' : 'no change'}`,
      { strategy: strategy.name, improved: result.improved, fitness: result.bestDna.fitness },
    );

    return result;
  }

  async runBacktest(
    strategy: Strategy,
    candles: Candle[],
    asset: AssetInfo,
    timeframe: Timeframe,
  ) {
    return this.backtester.backtest(strategy, candles, asset, timeframe);
  }

  async runAllBacktests(
    strategies: Strategy[],
    candles: Candle[],
    asset: AssetInfo,
    timeframe: Timeframe,
  ) {
    const results = await this.backtester.compareStrategies(strategies, candles, asset, timeframe);
    for (const result of results) {
      await this.selfImprover.recordResult(result);
    }
    return results;
  }

  getLeaderboard(): string {
    return this.selfImprover.getLeaderboard();
  }

  async save(): Promise<void> {
    await this.selfImprover.save();
  }

  // ----------------------------------------------------------------
  // Decay Detection
  // ----------------------------------------------------------------

  analyzeDecay() {
    return this.decayDetector.analyzeAll();
  }

  // ----------------------------------------------------------------
  // CEO Directive Handling
  // ----------------------------------------------------------------

  protected handleDirective(directive: DirectivePayload): void {
    switch (directive.directiveType) {
      case 'evolve': {
        this.log.info({ params: directive.params }, 'CEO requested evolution');
        // Would trigger evolution cycle for specified strategy
        break;
      }
      default:
        this.log.debug({ directive: directive.directiveType }, 'Unhandled directive');
    }
  }

  protected handleQuestion(from: AgentId, payload: QuestionPayload): void {
    void this.answerAgent(from, payload.threadId, this.selfImprover.getLeaderboard(), payload.threadId);
  }
}
