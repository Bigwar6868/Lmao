// ============================================================
// Research Team — market data, analysis, opportunities
// ============================================================

import type {
  AgentId,
  DirectivePayload,
  QuestionPayload,
  RequestPayload,
} from '../../shared/agent-types.js';
import type { AssetInfo, Timeframe, MarketData, MacroEnvironment, Signal } from '../../shared/types.js';
import type { AgentBrain, BrainContext } from '../../shared/agent-brain.js';
import type { AgentNetwork } from '../agent-network/network.js';
import { MarketAnalyst } from '../market-analyst/index.js';
import { MacroEconomist } from '../macro-economist/index.js';
import { SentimentAnalyst } from '../sentiment-analyst/index.js';
import { TechnicalStrategist } from '../technical-strategist/index.js';
import { OpportunityScanner } from '../opportunity-scanner/index.js';
import { RegimeDetector } from '../regime-detector/index.js';
import { TeamBase } from './team-base.js';

export class ResearchTeam extends TeamBase {
  readonly marketAnalyst = new MarketAnalyst();
  readonly macroEconomist = new MacroEconomist();
  readonly sentimentAnalyst = new SentimentAnalyst();
  readonly strategist = new TechnicalStrategist();
  readonly scanner = new OpportunityScanner();
  readonly regimeDetector = new RegimeDetector();

  constructor(network: AgentNetwork, ceoId: AgentId) {
    super({ teamId: 'research', teamName: 'Research Team', network, ceoId });
  }

  protected getDescription(): string {
    return 'Fetches market data, analyzes macro/sentiment, scans opportunities';
  }

  // ----------------------------------------------------------------
  // Data Fetching — serves Trading team requests
  // ----------------------------------------------------------------

  async fetchAllData(
    assets: AssetInfo[],
    timeframe: Timeframe,
  ): Promise<Map<string, MarketData>> {
    const marketDataMap = new Map<string, MarketData>();

    for (const asset of assets) {
      try {
        const data = await this.marketAnalyst.fetchMarketData(asset, timeframe);
        if (data.candles.length > 0) {
          marketDataMap.set(asset.symbol, data);
        }
      } catch (err) {
        this.log.warn({ asset: asset.symbol, error: (err as Error).message }, 'Data fetch failed');
      }
    }

    return marketDataMap;
  }

  async getMacroEnvironment(): Promise<MacroEnvironment> {
    return this.macroEconomist.getEnvironment();
  }

  // ----------------------------------------------------------------
  // Analysis
  // ----------------------------------------------------------------

  async analyzeAll(
    marketDataMap: Map<string, MarketData>,
    macro?: MacroEnvironment,
  ): Promise<Signal[]> {
    const allSignals: Signal[] = [];
    for (const [, data] of marketDataMap) {
      const signals = await this.strategist.analyzeAll(data, macro);
      allSignals.push(...signals);
    }
    return allSignals;
  }

  detectRegime(marketDataMap: Map<string, MarketData>, macro?: MacroEnvironment) {
    const firstCandles = [...marketDataMap.values()][0]?.candles;
    if (!firstCandles || firstCandles.length === 0) return undefined;
    return this.regimeDetector.detect(firstCandles, macro);
  }

  scanOpportunities(signals: Signal[], marketDataMap: Map<string, MarketData>) {
    return this.scanner.scan(signals, marketDataMap);
  }

  getStrategies() {
    return this.strategist.getStrategies();
  }

  // ----------------------------------------------------------------
  // Broad Research Data — Geopolitics, Policy, Global Macro
  // ----------------------------------------------------------------

  /**
   * Get geopolitical risk factors for a specific asset symbol.
   */
  getGeopoliticalFactorsForAsset(symbol: string) {
    return this.macroEconomist.getGeopoliticalFactorsForAsset(symbol);
  }

  /**
   * Get recent policy changes from central banks and regulators.
   */
  getPolicyChanges(market?: 'crypto' | 'stocks' | 'forex') {
    return this.macroEconomist.getPolicyChanges(market);
  }

  /**
   * Get global macro snapshots for all tracked regions (US, EU, China, Japan, UK).
   */
  getGlobalMacro() {
    return this.macroEconomist.getGlobalMacro();
  }

  /**
   * Get macro data for a specific region.
   */
  getRegionMacro(region: string) {
    return this.macroEconomist.getRegionMacro(region);
  }

  /**
   * Get overall global central bank policy direction.
   */
  getGlobalPolicyBias() {
    return this.macroEconomist.getGlobalPolicyBias();
  }

  /**
   * Get upcoming economic calendar events.
   */
  getUpcomingEvents() {
    return this.macroEconomist.getUpcomingEvents();
  }

  /**
   * Check if we're near a high-impact event.
   */
  isHighImpactPeriod() {
    return this.macroEconomist.isHighImpactPeriod();
  }

  /**
   * Full geopolitical + macro report.
   */
  async getGeopoliticalReport() {
    return this.macroEconomist.getGeopoliticalReport();
  }

  // ----------------------------------------------------------------
  // Brain Context & Idle Exploration
  // ----------------------------------------------------------------

  private latestMarketData?: Map<string, MarketData>;
  private latestSignals?: Signal[];
  private latestMacro?: MacroEnvironment;

  /** Store context from the last cycle for brain/loop usage */
  updateBrainContext(marketData: Map<string, MarketData>, signals: Signal[], macro?: MacroEnvironment): void {
    this.latestMarketData = marketData;
    this.latestSignals = signals;
    this.latestMacro = macro;
  }

  protected override getBrainContext(): BrainContext {
    return {
      mission: this.getMission(),
      prompt: this.currentPrompt,
      marketData: this.latestMarketData,
      signals: this.latestSignals,
      macro: this.latestMacro,
    };
  }

  /** When idle, explore data sources and look for regime shifts */
  protected override async handleIdleExplore(brain: AgentBrain, ctx: BrainContext): Promise<void> {
    // Think about what data to explore
    const thought = brain.think('What data should I explore proactively?', ctx);

    // Check for regime transitions
    if (ctx.marketData?.size) {
      const regime = this.detectRegime(ctx.marketData, ctx.macro);
      if (regime && regime.confidence > 0.7) {
        await this.reportToCeo('analysis', `Regime detection: ${regime.regime} (${(regime.confidence * 100).toFixed(0)}% confidence)`, {
          regime: regime.regime,
          confidence: regime.confidence,
          recommendedStrategies: regime.recommendedStrategies,
        });
      }
    }

    // Check macro conditions proactively
    if (this.isHighImpactPeriod()) {
      await this.startDiscussion(
        'high-impact-event',
        'Upcoming high-impact event detected — all teams should be cautious',
      );
    }
  }

  // ----------------------------------------------------------------
  // CEO Directive Handling
  // ----------------------------------------------------------------

  protected handleDirective(directive: DirectivePayload): void {
    switch (directive.directiveType) {
      case 'research': {
        const topic = directive.params.topic as string;
        this.log.info({ topic }, 'CEO requested research');
        // Research team would analyze the topic and report back
        void this.reportToCeo('analysis', `Research on: ${topic}`, directive.params);
        break;
      }
      case 'focus-assets': {
        this.log.info({ assets: directive.params.assets }, 'CEO updated focus assets');
        break;
      }
      default:
        this.log.debug({ directive: directive.directiveType }, 'Unhandled directive');
    }
  }

  // ----------------------------------------------------------------
  // Inter-Team Request Handling
  // ----------------------------------------------------------------

  protected handleInterTeamRequest(from: AgentId, payload: RequestPayload): void {
    if (payload.requestType === 'new-data-source') {
      const assets = payload.data.assets as string[] | undefined;
      this.log.info({ from: from.slice(0, 8), assets }, 'Data request from another team');
      // Would trigger data fetching for requested assets
    }
  }

  protected handleQuestion(from: AgentId, payload: QuestionPayload): void {
    // Answer questions about market data, regime, etc.
    this.log.debug({ from: from.slice(0, 8), question: payload.question }, 'Question from another team');
    void this.answerAgent(from, payload.threadId, 'Research team data available on request', payload.threadId);
  }
}
