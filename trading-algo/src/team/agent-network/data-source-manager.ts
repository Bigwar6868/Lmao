// ============================================================
// DataSourceManager — agents can discover and request data
// ============================================================

import { createModuleLogger } from '../../shared/logger.js';
import { eventBus } from '../../shared/events.js';

const log = createModuleLogger('data-source-mgr');

/** A data source the system knows about */
export interface DataSource {
  id: string;
  name: string;
  type: 'price' | 'fundamental' | 'sentiment' | 'macro' | 'alternative';
  provider: string;
  url?: string;
  apiKeyEnv?: string;         // env var name for the API key
  available: boolean;         // is this source currently usable?
  reason?: string;            // why unavailable
  requestedBy?: string;       // agent that requested it
  addedAt: number;
}

/** A request from an agent for a new data source */
export interface DataRequest {
  id: string;
  agentId: string;
  agentName: string;
  sourceType: DataSource['type'];
  description: string;
  reason: string;              // why the agent needs this
  suggestedProviders: string[];
  status: 'pending' | 'approved' | 'rejected' | 'fulfilled';
  humanResponse?: string;      // response from human operator
  createdAt: number;
  resolvedAt?: number;
}

/**
 * Manages data sources for the trading system.
 * Agents can:
 *  - Query available data sources
 *  - Request new data sources (prompts human for API key)
 *  - Report data quality issues
 */
export class DataSourceManager {
  private sources: DataSource[] = [];
  private pendingRequests: DataRequest[] = [];
  private completedRequests: DataRequest[] = [];
  private humanCallback: ((request: DataRequest) => Promise<string | null>) | null = null;

  constructor() {
    // Seed with known data sources
    this.sources = [
      {
        id: 'binance', name: 'Binance', type: 'price', provider: 'ccxt',
        apiKeyEnv: 'BINANCE_API_KEY', available: !!process.env.BINANCE_API_KEY,
        reason: process.env.BINANCE_API_KEY ? undefined : 'No API key set',
        addedAt: Date.now(),
      },
      {
        id: 'alpha-vantage', name: 'Alpha Vantage', type: 'price', provider: 'alpha-vantage',
        url: 'https://www.alphavantage.co',
        apiKeyEnv: 'ALPHA_VANTAGE_API_KEY', available: process.env.ALPHA_VANTAGE_API_KEY !== 'demo',
        reason: process.env.ALPHA_VANTAGE_API_KEY === 'demo' ? 'Using demo key — limited' : undefined,
        addedAt: Date.now(),
      },
      {
        id: 'alpaca', name: 'Alpaca', type: 'price', provider: 'alpaca',
        url: 'https://alpaca.markets',
        apiKeyEnv: 'ALPACA_API_KEY', available: !!process.env.ALPACA_API_KEY,
        reason: process.env.ALPACA_API_KEY ? undefined : 'No API key set',
        addedAt: Date.now(),
      },
      {
        id: 'fred', name: 'FRED (Federal Reserve)', type: 'macro', provider: 'fred',
        url: 'https://fred.stlouisfed.org',
        apiKeyEnv: 'FRED_API_KEY', available: !!process.env.FRED_API_KEY,
        reason: process.env.FRED_API_KEY ? undefined : 'No API key set',
        addedAt: Date.now(),
      },
      {
        id: 'synthetic', name: 'Synthetic Data', type: 'price', provider: 'internal',
        available: true, addedAt: Date.now(),
      },
    ];

    log.info({
      total: this.sources.length,
      available: this.sources.filter(s => s.available).length,
    }, 'DataSourceManager initialized');
  }

  // ----------------------------------------------------------------
  // Agent queries
  // ----------------------------------------------------------------

  /** Get all available data sources */
  getAvailableSources(type?: DataSource['type']): DataSource[] {
    return this.sources.filter(s =>
      s.available && (type ? s.type === type : true),
    );
  }

  /** Get all sources, including unavailable */
  getAllSources(): DataSource[] {
    return [...this.sources];
  }

  /** Check if a specific source is available */
  isAvailable(sourceId: string): boolean {
    return this.sources.find(s => s.id === sourceId)?.available ?? false;
  }

  /** Get sources that are missing/unavailable */
  getMissingSources(): DataSource[] {
    return this.sources.filter(s => !s.available);
  }

  // ----------------------------------------------------------------
  // Agent requests for new data
  // ----------------------------------------------------------------

  /**
   * An agent requests a new data source.
   * The request is queued for human approval.
   */
  async requestDataSource(
    agentId: string,
    agentName: string,
    sourceType: DataSource['type'],
    description: string,
    reason: string,
    suggestedProviders: string[] = [],
  ): Promise<DataRequest> {
    const request: DataRequest = {
      id: `req-${Date.now()}-${agentId.slice(0, 6)}`,
      agentId,
      agentName,
      sourceType,
      description,
      reason,
      suggestedProviders,
      status: 'pending',
      createdAt: Date.now(),
    };

    this.pendingRequests.push(request);

    log.info({
      agent: agentName,
      type: sourceType,
      description,
      reason,
      providers: suggestedProviders,
    }, 'Agent requested new data source');

    // If a human callback is registered, ask immediately
    if (this.humanCallback) {
      const response = await this.humanCallback(request);
      if (response) {
        request.status = 'approved';
        request.humanResponse = response;
        request.resolvedAt = Date.now();
        this.completedRequests.push(request);
        this.pendingRequests = this.pendingRequests.filter(r => r.id !== request.id);
      }
    }

    // Emit event so the system can notify the human
    void eventBus.emit('system:error', {
      level: 'info',
      message: `Agent "${agentName}" requests ${sourceType} data: ${description}`,
      request,
    }, 'data-source-manager');

    return request;
  }

  /**
   * Register a callback for when agents request human input.
   * In a CLI context, this would prompt the user.
   */
  onHumanInput(callback: (request: DataRequest) => Promise<string | null>): void {
    this.humanCallback = callback;
  }

  /**
   * Human approves a request and provides an API key or config.
   */
  fulfillRequest(requestId: string, apiKey: string, sourceConfig?: Partial<DataSource>): void {
    const request = this.pendingRequests.find(r => r.id === requestId);
    if (!request) return;

    // Set the env var
    if (sourceConfig?.apiKeyEnv) {
      process.env[sourceConfig.apiKeyEnv] = apiKey;
    }

    // Add the new source
    const newSource: DataSource = {
      id: sourceConfig?.id ?? `custom-${Date.now()}`,
      name: sourceConfig?.name ?? request.description,
      type: request.sourceType,
      provider: sourceConfig?.provider ?? request.suggestedProviders[0] ?? 'custom',
      url: sourceConfig?.url,
      apiKeyEnv: sourceConfig?.apiKeyEnv,
      available: true,
      requestedBy: request.agentName,
      addedAt: Date.now(),
    };

    this.sources.push(newSource);
    request.status = 'fulfilled';
    request.resolvedAt = Date.now();
    this.completedRequests.push(request);
    this.pendingRequests = this.pendingRequests.filter(r => r.id !== requestId);

    log.info({
      source: newSource.name,
      requestedBy: request.agentName,
    }, 'Data source request fulfilled');
  }

  /** Reject a request */
  rejectRequest(requestId: string, reason: string): void {
    const request = this.pendingRequests.find(r => r.id === requestId);
    if (!request) return;

    request.status = 'rejected';
    request.humanResponse = reason;
    request.resolvedAt = Date.now();
    this.completedRequests.push(request);
    this.pendingRequests = this.pendingRequests.filter(r => r.id !== requestId);
  }

  // ----------------------------------------------------------------
  // Reports
  // ----------------------------------------------------------------

  /** Get pending requests that need human attention */
  getPendingRequests(): DataRequest[] {
    return [...this.pendingRequests];
  }

  /** Format a report of data source status */
  formatReport(): string {
    const lines: string[] = ['\n=== DATA SOURCES ===\n'];

    lines.push('Available:');
    for (const s of this.sources.filter(s => s.available)) {
      lines.push(`  + ${s.name} (${s.type}) — ${s.provider}`);
    }

    const missing = this.sources.filter(s => !s.available);
    if (missing.length > 0) {
      lines.push('\nUnavailable (need API key):');
      for (const s of missing) {
        lines.push(`  - ${s.name} (${s.type}) — set ${s.apiKeyEnv ?? 'API key'} | ${s.reason ?? ''}`);
      }
    }

    if (this.pendingRequests.length > 0) {
      lines.push('\nPending agent requests:');
      for (const r of this.pendingRequests) {
        lines.push(`  ? [${r.agentName}] needs ${r.sourceType}: ${r.description}`);
        lines.push(`    Reason: ${r.reason}`);
        if (r.suggestedProviders.length > 0) {
          lines.push(`    Suggested: ${r.suggestedProviders.join(', ')}`);
        }
      }
    }

    return lines.join('\n');
  }
}
