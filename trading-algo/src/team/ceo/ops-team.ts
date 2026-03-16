// ============================================================
// Ops Team — system health, data sources, diagnostics, monitoring
// ============================================================

import type {
  AgentId,
  DirectivePayload,
  QuestionPayload,
} from '../../shared/agent-types.js';
import type { AssetInfo, Timeframe, Candle, MacroEnvironment } from '../../shared/types.js';
import type { AgentNetwork } from '../agent-network/network.js';
import { DiagnosticsEngine } from '../diagnostics/index.js';
import { DataSourceManager } from '../agent-network/data-source-manager.js';
import { ScenarioSimulator } from '../scenario-simulator/index.js';
import type { Executor } from '../executor/index.js';
import { TeamBase } from './team-base.js';

export class OpsTeam extends TeamBase {
  readonly diagnostics = new DiagnosticsEngine();
  readonly dataSourceManager = new DataSourceManager();
  readonly scenarioSimulator = new ScenarioSimulator();

  constructor(network: AgentNetwork, ceoId: AgentId) {
    super({ teamId: 'ops', teamName: 'Operations Team', network, ceoId });
  }

  protected getDescription(): string {
    return 'System health monitoring, data source management, diagnostics';
  }

  // ----------------------------------------------------------------
  // Diagnostics
  // ----------------------------------------------------------------

  runDiagnostics(opts: {
    candles: Map<string, Candle[]>;
    portfolio: ReturnType<Executor['getPortfolio']>;
    regime?: unknown;
    simulation?: unknown;
    macro?: MacroEnvironment;
  }) {
    const report = this.diagnostics.scan(opts as Parameters<DiagnosticsEngine['scan']>[0]);

    // Alert CEO if health is critical
    if (report.healthScore < 50) {
      void this.reportToCeo('risk-alert', `System health critical: ${report.healthScore}/100`, {
        healthScore: report.healthScore,
        emergencies: report.emergencies.length,
        criticals: report.criticals.length,
      });
    }

    return report;
  }

  // ----------------------------------------------------------------
  // Data Sources
  // ----------------------------------------------------------------

  getDataSourceReport(): string {
    return this.dataSourceManager.formatReport();
  }

  getMissingSources() {
    return this.dataSourceManager.getMissingSources();
  }

  // ----------------------------------------------------------------
  // Monitoring — check if tasks are stuck, spawn helpers
  // ----------------------------------------------------------------

  async monitorAndSpawnIfNeeded(
    activeTaskCount: number,
    pendingTaskCount: number,
    maxWaitMs: number,
    lastActivityAt: number,
  ): Promise<void> {
    const stuckMs = Date.now() - lastActivityAt;

    if (stuckMs > maxWaitMs && pendingTaskCount > 0) {
      this.log.warn({
        stuckMs,
        pendingTasks: pendingTaskCount,
        activeTasks: activeTaskCount,
      }, 'Tasks stuck — requesting CEO to spawn helper agents');

      await this.requestFromCeo(
        'spawn-agent',
        `Need ${Math.min(3, pendingTaskCount)} helper agents — tasks stuck for ${Math.round(stuckMs / 1000)}s`,
        'Tasks taking too long, need more compute',
        { pendingTasks: pendingTaskCount, stuckMs },
      );
    }
  }

  // ----------------------------------------------------------------
  // CEO Directive Handling
  // ----------------------------------------------------------------

  protected handleDirective(directive: DirectivePayload): void {
    this.log.debug({ directive: directive.directiveType }, 'Ops received directive');
  }

  protected handleQuestion(from: AgentId, payload: QuestionPayload): void {
    void this.answerAgent(from, payload.threadId, 'System operational', payload.threadId, {
      dataSources: this.dataSourceManager.getAllSources().length,
      missingSources: this.getMissingSources().length,
    });
  }
}
