/**
 * CapitalAllocationService — loads the desk's inputs from the EXISTING engines
 * (latest persisted scan candidates, the user's ledger holdings with observed
 * prices, regime, circuit breaker, market status / freshness), runs the pure
 * allocation engine, and persists an immutable CapitalPlan + CapitalAllocation
 * rows. Simulations run the same engine without persisting.
 *
 * It owns no stock-picking logic. It never re-runs a scan.
 */

import { AppDataSource } from "../../config/database";
import { CapitalAllocation, CapitalPlan, DailyCapitalDecisionSnapshot } from "../../entities";
import { LedgerService, PriceLookup } from "../ledger/LedgerService";
import { marketDataService } from "../market/MarketDataService";
import { liveMarketDataProvider } from "../shortterm/LiveMarketDataProvider";
import { regimeService } from "../shortterm/RegimeService";
import { riskControlService } from "../shortterm/RiskControlService";
import { SHORT_TERM_VERSION } from "../shortterm/types";
import { buildCapitalPlan } from "./capitalAllocation";
import { resolveRiskProfile, RiskProfile } from "./riskProfiles";
import {
  CAPITAL_POLICY_VERSION,
  CapitalCandidateInput,
  CapitalHoldingInput,
  CapitalHorizon,
  CapitalPlanResult,
  EnvLabel,
  FreshnessContract,
  GlobalContextInput,
  MarketContextInput,
  RiskProfileName,
} from "./types";
import { INDIA_SECTOR_PROXIES } from "../global/globalUniverse";

export interface DeskRequest {
  accountId: string;
  capitalAvailableInr: number;
  riskProfile: RiskProfileName;
  horizon: CapitalHorizon;
  maxPositions?: number;
  profileOverrides?: Partial<RiskProfile>;
  /** Persist as an immutable plan (true for /today, false for /simulate). */
  persist: boolean;
  kind?: "REQUEST" | "SNAPSHOT";
}

export interface GlobalDiagnostics {
  snapshotAt: string | null;
  globalDataAsOf: string | null;
  indiaDataAsOf: string | null;
  scanned: number;
  valid: number;
  byRegion: Record<string, { valid: number; total: number }>;
  byAssetClass: Record<string, { valid: number; total: number }>;
  regime: string | null;
  regimeScore: number | null;
  transmission: string | null;
  indiaRegime: string | null;
  sectorImpacts: Array<{ sector: string; name: string; label: string; reason: string }>;
  activeShocks: string[];
  note: string;
}

export interface ScanCoverage {
  global: GlobalDiagnostics;
  asOf: string | null;
  scanned: number;
  dataValid: number;
  liquid: number;
  technicalScreen: number;
  researchQualified: number;
  shortTermSetups: number;
  passedGates: number;
  riskQualified: number;
  modelHealthQualified: number;
  engineQualified: number;
  capitalAllocations: number;
  zeroBecause: string[];
  note: string;
}

export interface DeskResponse extends CapitalPlanResult {
  coverage: ScanCoverage;
  planId: string | null;
  persisted: boolean;
  modelHealth: { shortTermModel: string; note: string };
  evidence: { candidatesSource: string; scanRunIds: string[]; scanRunAt: string | null; note: string };
}

const quoteLookup: PriceLookup = async (yahooTicker) => {
  try {
    const q = await marketDataService.getQuote(yahooTicker);
    return { current: q.price, asOf: q.asOf, marketState: q.marketState ?? null, source: "yahoo-quote (may be a cached prior close outside market hours)" };
  } catch {
    return null;
  }
};

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const r2 = (v: number): number => Math.round(v * 100) / 100;

/** Map a persisted ShortTermCandidateView payload onto the desk's input slice. Nothing is derived; only read. */
export function candidateFromPayload(p: Record<string, unknown>, extras: { evidenceScore?: number | null; aiCapAction?: CapitalCandidateInput["aiCapAction"]; tradeability?: CapitalCandidateInput["tradeability"] } = {}): CapitalCandidateInput {
  const plan = (p.plan ?? {}) as Record<string, unknown>;
  const ev = (p.ev ?? null) as Record<string, unknown> | null;
  const se = (p.setupEvidence ?? null) as Record<string, unknown> | null;
  const fc = (p.forecast ?? {}) as Record<string, unknown>;
  const gates = (p.gates ?? {}) as Record<string, unknown>;
  const feats = (p.features ?? {}) as Record<string, unknown>;
  return {
    ticker: str(p.ticker),
    name: str(p.name, str(p.ticker)),
    sector: typeof p.sector === "string" ? p.sector : null,
    currentPrice: num(p.currentPrice),
    action: str(p.action, "NO_SETUP"),
    tier: str(p.tier, "D"),
    qualified: p.qualified === true,
    modelHealth: str(p.modelHealth, "SHADOW"),
    freshnessV2: str(p.freshnessV2, "STALE"),
    setupType: str(p.setupType, "NO_SETUP"),
    rank: num(p.rank),
    rankingScore: num(p.rankingScore),
    gateFailures: arr<{ gate: string; current: string; required: string }>(gates.failures),
    ceilingReasons: arr<string>(p.ceilingReasons),
    whyNotEntry: arr<string>(p.whyNotEntry),
    plan: {
      entryType: str(plan.entryType, "NONE"),
      entryZoneLow: num(plan.entryZoneLow),
      entryZoneHigh: num(plan.entryZoneHigh),
      entryTriggerPrice: num(plan.entryTriggerPrice),
      initialStop: num(plan.initialStop),
      target1: num(plan.target1),
      target2: num(plan.target2),
      target3: num(plan.target3),
      rewardRiskToTarget1: num(plan.rewardRiskToTarget1),
      expectedHoldingDays: num(plan.expectedHoldingDays) ?? 7,
      invalidationPrice: num(plan.invalidationPrice),
      invalidationReason: typeof plan.invalidationReason === "string" ? plan.invalidationReason : null,
      atr14: num(plan.atr14),
      advInr: num(plan.advInr),
      transactionCostPct: num(plan.transactionCostPct),
      estimatedSlippagePct: num(plan.estimatedSlippagePct),
    },
    ev: ev ? { ev80LowerPct: num(ev.ev80LowerPct), meanEvAfterCostsPct: num(ev.meanEvAfterCostsPct), expectedR: num(ev.expectedR) } : null,
    setupEvidence: se ? { evidenceStrength: str(se.evidenceStrength, "D"), usableForEntry: se.usableForEntry === true } : null,
    probability: { status: str(fc.probabilityStatus, "UNCALIBRATED"), targetBeforeStop: str(fc.probabilityStatus) === "AVAILABLE" ? num(fc.probabilityTargetBeforeStop) : null },
    relVolume: num(feats.relVolume),
    tradeability: extras.tradeability ?? null,
    aiCapAction: extras.aiCapAction ?? null,
    evidenceScore: extras.evidenceScore ?? null,
    decisionSnapshotId: null,
  };
}

export class CapitalAllocationService {
  private readonly ledger = new LedgerService();

  /** Latest NSE-universe scan run + latest sub-₹100 wide run; candidates deduped (radar first). */
  async loadCandidates(): Promise<{ candidates: CapitalCandidateInput[]; byTicker: Map<string, { c: CapitalCandidateInput; asOf: string }>; runIds: string[]; runAt: string | null; source: string }> {
    const runs: Array<{ id: string; created_at: string; universe: string | null }> = await AppDataSource.query(
      `SELECT DISTINCT ON (COALESCE(diagnostics->>'universe','NSE_UNIVERSE')) id, created_at, diagnostics->>'universe' AS universe
         FROM short_term_scan_runs
        ORDER BY COALESCE(diagnostics->>'universe','NSE_UNIVERSE'), created_at DESC`
    );
    const rank = (u: string | null) => (u === "WIDE_SUB100" ? 2 : u === "BROAD_SCAN" ? 1 : 0);
    const ordered = [...runs].sort((a, b) => rank(a.universe) - rank(b.universe));
    const byTicker = new Map<string, { c: CapitalCandidateInput; asOf: string }>();
    const candidates: CapitalCandidateInput[] = [];
    for (const run of ordered) {
      const rows: Array<{ ticker: string; payload: Record<string, unknown>; created_at: string }> = await AppDataSource.query(
        `SELECT ticker, payload, created_at FROM short_term_candidates WHERE scan_run_id = $1 ORDER BY rank NULLS LAST, ranking_score DESC NULLS LAST`,
        [run.id]
      );
      let dossiers = new Map<string, { cap: string | null; score: number | null }>();
      if (run.universe === "WIDE_SUB100") {
        try {
          const d: Array<{ ticker: string; cap: string | null }> = await AppDataSource.query(
            `SELECT DISTINCT ON (ticker) ticker, ai_dossier->>'capAction' AS cap FROM wide_shadow_predictions WHERE ai_dossier IS NOT NULL ORDER BY ticker, created_at DESC`
          );
          dossiers = new Map(d.map((x) => [x.ticker, { cap: x.cap, score: null }]));
        } catch {
          /* dossier table optional */
        }
      }
      for (const r of rows) {
        if (byTicker.has(r.ticker)) continue;
        const cap = dossiers.get(r.ticker)?.cap;
        const c = candidateFromPayload(r.payload ?? {}, {
          aiCapAction: cap === "AFFIRM" || cap === "CAP_TO_WATCH" || cap === "CAP_TO_NO_TRADE" ? cap : null,
        });
        if (!c.ticker) continue;
        byTicker.set(r.ticker, { c, asOf: new Date(r.created_at).toISOString() });
        candidates.push(c);
      }
    }
    return {
      candidates,
      byTicker,
      runIds: ordered.map((r) => r.id),
      runAt: ordered.length ? new Date(ordered[0].created_at).toISOString() : null,
      source: ordered.map((r) => r.universe ?? "NSE_UNIVERSE").join(" + ") || "none",
    };
  }

  async loadHoldings(accountId: string, byTicker: Map<string, { c: CapitalCandidateInput; asOf: string }>): Promise<CapitalHoldingInput[]> {
    const h = await this.ledger.getPositions(accountId, quoteLookup);
    const out: CapitalHoldingInput[] = [];
    for (const p of h.positions) {
      if (p.status !== "OPEN" || p.qty <= 0) continue;
      const ev = byTicker.get(p.ticker) ?? byTicker.get(`${p.ticker}.NS`) ?? null;
      let evidence = ev?.c ?? null;
      if (!evidence) {
        // Fall back to the latest candidate row for this ticker from ANY run.
        const rows: Array<{ payload: Record<string, unknown>; created_at: string }> = await AppDataSource.query(
          `SELECT payload, created_at FROM short_term_candidates WHERE ticker = $1 ORDER BY created_at DESC LIMIT 1`,
          [p.ticker]
        );
        if (rows.length) {
          evidence = candidateFromPayload(rows[0].payload ?? {});
          out.push({
            ticker: p.ticker,
            name: p.name,
            qty: p.qty,
            sector: evidence.sector,
            investedInr: Number(p.costBasis),
            price: p.price.current,
            priceAsOf: p.price.asOf,
            markedValueInr: p.markedValue != null ? Number(p.markedValue) : null,
            evidence,
            evidenceAsOf: new Date(rows[0].created_at).toISOString(),
          });
          continue;
        }
      }
      out.push({
        ticker: p.ticker,
        name: p.name,
        qty: p.qty,
        sector: evidence?.sector ?? null,
        investedInr: Number(p.costBasis),
        price: p.price.current,
        priceAsOf: p.price.asOf,
        markedValueInr: p.markedValue != null ? Number(p.markedValue) : null,
        evidence,
        evidenceAsOf: ev?.asOf ?? null,
      });
    }
    return out;
  }

  async loadMarket(scanRunAt: string | null): Promise<MarketContextInput & { featureCutoffAt: string | null }> {
    const [regime, breaker, status] = await Promise.all([
      regimeService.detect(),
      riskControlService.circuitBreaker().catch(() => ({ canEnter: true, reasons: ["circuit breaker unavailable — treated as open, logged"] })),
      liveMarketDataProvider.getMarketStatus().catch(() => ({ session: "CLOSED" as const, istTime: "", tradingDay: false, lastCompletedSession: null })),
    ]);
    const lastBar = status.lastCompletedSession;
    const fresh = await liveMarketDataProvider.getDataFreshness(lastBar ? `${lastBar}T15:30:00+05:30` : null).catch(() => null);
    const quoteType: FreshnessContract["quoteType"] =
      !fresh || fresh.state === "STALE" ? "STALE" : status.session === "OPEN" ? "DELAYED_INTRADAY" : "EOD_FINAL";
    const freshness: FreshnessContract = {
      quoteTimestamp: fresh?.lastUpdate ?? null,
      quoteType,
      marketState: status.session,
      latestCompletedBarDate: lastBar,
      providerDelay: fresh?.providerNote ?? "provider freshness unavailable",
      featureCutoffAt: scanRunAt,
    };
    const b = breaker as { canEnter: boolean; reasons?: string[]; state?: string };
    const global = await this.loadGlobal();
    return {
      regime: regime.regime,
      regimeReasons: regime.reasons,
      breakerCanEnter: b.canEnter,
      breakerReason: b.canEnter ? null : (b.reasons ?? []).join("; ") || b.state || "tripped",
      freshness,
      featureCutoffAt: scanRunAt,
      global,
    };
  }

  /** Latest immutable global snapshot → desk context. Sector labels are keyed by NSE industry via the sector proxies. */
  async loadGlobal(): Promise<GlobalContextInput | null> {
    try {
      const { globalIntelligenceService } = await import("../global/GlobalIntelligenceService");
      const snap = await globalIntelligenceService.latest();
      if (!snap) return null;
      const sectorLabels: Record<string, EnvLabel> = {};
      // Combine the measured global impact with the domestic sector regime (M2),
      // taking the more cautious label. Context only — never a veto.
      let domestic = new Map<string, EnvLabel>();
      try {
        const { sectorIntelligenceService } = await import("../global/SectorIntelligenceService");
        const { sectorStateToEnv } = await import("../global/sectorIntelligence");
        domestic = new Map((await sectorIntelligenceService.latestStored()).map((r) => [r.sector, sectorStateToEnv(r.state as never)]));
      } catch {
        /* domestic sector regimes optional */
      }
      const { combineEnv } = await import("../global/sectorIntelligence");
      for (const sec of snap.sectors) {
        const label = combineEnv(sec.label, domestic.get(sec.sector) ?? "NEUTRAL");
        const proxy = INDIA_SECTOR_PROXIES.find((p) => p.key === sec.sector);
        for (const ind of proxy?.industries ?? []) sectorLabels[ind] = label;
        sectorLabels[sec.sector] = label;
      }
      const evidence = await globalIntelligenceService.regimeEvidence(snap.regime.regime);
      return { regime: snap.regime.regime, regimeReasons: snap.regime.reasons, transmission: snap.transmission.label, transmissionReasons: snap.transmission.reasons, evidence, sectorLabels, globalDataAsOf: snap.globalDataAsOf, indiaDataAsOf: snap.indiaDataAsOf };
    } catch {
      return null;
    }
  }

  async plan(req: DeskRequest): Promise<DeskResponse> {
    const profile = resolveRiskProfile(req.riskProfile, req.profileOverrides);
    const { candidates, byTicker, runIds, runAt, source } = await this.loadCandidates();
    const holdings = await this.loadHoldings(req.accountId, byTicker);
    const market = await this.loadMarket(runAt);
    const asOf = new Date().toISOString();
    const result = buildCapitalPlan({
      asOf,
      capitalAvailableInr: req.capitalAvailableInr,
      holdings,
      candidates,
      market,
      profile,
      horizon: req.horizon,
      maxPositions: req.maxPositions,
    });
    const healthy = candidates.filter((c) => c.modelHealth === "HEALTHY").length;
    const modelHealth = {
      shortTermModel: healthy > 0 ? "HEALTHY for some setups" : candidates.length ? "no setup is HEALTHY (shadow / degraded)" : "unknown — no candidates",
      note: "Live authority requires ≥20 independent resolved shadow trades with positive conservative expectancy per setup. Probabilities are shown only when calibrated (today: never).",
    };
    let planId: string | null = null;
    if (req.persist) planId = await this.persist(req, result, market.featureCutoffAt, holdings);
    const coverage = await this.coverage(result.allocations.length);
    return {
      ...result,
      coverage,
      planId,
      persisted: req.persist,
      modelHealth,
      evidence: {
        candidatesSource: source,
        scanRunIds: runIds,
        scanRunAt: runAt,
        note: "Candidates are the engine's last persisted scan; the desk re-sizes them for your capital and profile. Nothing was re-scanned or re-forecast.",
      },
    };
  }

  /** Market-scan coverage: the broad scan's funnel, so a 0-allocation day is explainable end to end. */
  private async coverage(allocations: number): Promise<ScanCoverage> {
    const globalDiag = await this.globalDiagnostics();
    const empty: ScanCoverage = { global: globalDiag, asOf: null, scanned: 0, dataValid: 0, liquid: 0, technicalScreen: 0, researchQualified: 0, shortTermSetups: 0, passedGates: 0, riskQualified: 0, modelHealthQualified: 0, engineQualified: 0, capitalAllocations: allocations, zeroBecause: ["no broad scan has run yet"], note: "Run POST /api/universe/scan or wait for the 20:25 job." };
    try {
      const { marketOpportunityScanner } = await import("../universe/MarketOpportunityScanner");
      const f = await marketOpportunityScanner.latestFunnel();
      if (!f) return empty;
      const g = (stage: string) => f.stages.find((s) => s.stage === stage);
      const setups: Array<{ n: string }> = await AppDataSource.query(`SELECT COUNT(*)::text n FROM opportunity_candidates WHERE scan_id = $1 AND setup_type IS NOT NULL AND setup_type NOT IN ('NO_SETUP','HIGH_EVENT_RISK','LATE_TREND','FAILED_BREAKOUT')`, [f.scanId]);
      return {
        global: globalDiag,
        asOf: f.asOf,
        scanned: g("UNIVERSE")?.entered ?? 0,
        dataValid: g("DATA_VALIDATION")?.passed ?? 0,
        liquid: g("LIQUIDITY")?.passed ?? 0,
        technicalScreen: g("TECHNICAL")?.passed ?? 0,
        researchQualified: g("FUNDAMENTAL_EVENT")?.passed ?? 0,
        shortTermSetups: Number(setups[0]?.n ?? 0),
        passedGates: g("DECISION_GATES")?.passed ?? 0,
        riskQualified: g("RISK")?.passed ?? 0,
        modelHealthQualified: g("MODEL_HEALTH")?.passed ?? 0,
        engineQualified: g("MONEY_DESK")?.passed ?? 0,
        capitalAllocations: allocations,
        zeroBecause: f.zeroBecause,
        note: `Broad scan as of ${f.asOf} (regime ${f.regime ?? "unknown"}); the radar (151) and sub-₹100 lanes are evaluated in addition.`,
      };
    } catch {
      return empty;
    }
  }

  private async globalDiagnostics(): Promise<GlobalDiagnostics> {
    const empty: GlobalDiagnostics = { snapshotAt: null, globalDataAsOf: null, indiaDataAsOf: null, scanned: 0, valid: 0, byRegion: {}, byAssetClass: {}, regime: null, regimeScore: null, transmission: null, indiaRegime: null, sectorImpacts: [], activeShocks: [], note: "no global snapshot yet — run POST /api/global/snapshot or wait for the 08:40 job" };
    try {
      const { globalIntelligenceService } = await import("../global/GlobalIntelligenceService");
      const s = await globalIntelligenceService.latest();
      if (!s) return empty;
      return { snapshotAt: s.cutoffUtc, globalDataAsOf: s.globalDataAsOf, indiaDataAsOf: s.indiaDataAsOf, scanned: s.coverage.scanned, valid: s.coverage.valid, byRegion: s.coverage.byRegion, byAssetClass: s.coverage.byAssetClass, regime: s.regime.regime, regimeScore: s.regime.score, transmission: s.transmission.label, indiaRegime: s.india.regime, sectorImpacts: s.sectors.map((x) => ({ sector: x.sector, name: x.name, label: x.label, reason: x.reasons[0] })), activeShocks: s.transmission.activeShocks, note: `Global snapshot ${s.cutoffUtc} for India session ${s.indiaSessionDate}; regime and transmission are context and a risk input, never a veto.` };
    } catch {
      return empty;
    }
  }

  private async persist(req: DeskRequest, result: CapitalPlanResult, featureCutoffAt: string | null, holdings: CapitalHoldingInput[]): Promise<string> {
    const planRepo = AppDataSource.getRepository(CapitalPlan);
    const allocRepo = AppDataSource.getRepository(CapitalAllocation);
    const planDate = result.asOf.slice(0, 10);
    const plan = await planRepo.save(
      planRepo.create({
        accountId: req.accountId,
        kind: req.kind ?? "REQUEST",
        asOf: new Date(result.asOf),
        planDate,
        capitalAvailableInr: result.cash.capitalAvailableInr.toFixed(2),
        capitalInvestedInr: result.cash.capitalInvestedInr.toFixed(2),
        cashReserveInr: result.cash.cashReserveInr.toFixed(2),
        recommendedDeploymentInr: result.cash.recommendedDeploymentInr.toFixed(2),
        riskBudgetInr: result.cash.riskBudgetInr.toFixed(2),
        riskProfile: result.riskProfile,
        horizon: result.horizon,
        maxPositions: result.maxPositions,
        marketRegime: result.regime.regime,
        decisionPolicyVersion: CAPITAL_POLICY_VERSION,
        modelVersion: SHORT_TERM_VERSION,
        featureCutoffAt: featureCutoffAt ? new Date(featureCutoffAt) : null,
        freshness: result.freshness as unknown as Record<string, unknown>,
        summary: result.summary,
        result: { ...result, holdingsSnapshot: holdings } as unknown as Record<string, unknown>,
      })
    );
    const rows: Partial<CapitalAllocation>[] = [];
    for (const a of [...result.allocations, ...result.conditional]) {
      rows.push({
        capitalPlanId: plan.id,
        accountId: req.accountId,
        planDate,
        ticker: a.ticker,
        action: a.action,
        recommendedAmountInr: a.recommendedAmountInr.toFixed(2),
        recommendedQty: a.recommendedQuantity,
        maxAmountInr: a.maxAmountInr.toFixed(2),
        pctOfCapital: a.percentageOfCapital.toFixed(2),
        entryPrice: String(a.entryPrice),
        entryZoneLow: a.entryZoneLow != null ? String(a.entryZoneLow) : null,
        entryZoneHigh: a.entryZoneHigh != null ? String(a.entryZoneHigh) : null,
        entryType: a.entryType,
        stopPrice: String(a.stopPrice),
        target1: String(a.target1),
        target2: a.target2 != null ? String(a.target2) : null,
        target3: a.target3 != null ? String(a.target3) : null,
        expectedHoldingSessions: a.expectedHoldingSessions,
        riskAmountInr: a.riskAmountInr.toFixed(2),
        rewardRisk: a.rewardRisk.toFixed(3),
        evAfterCostsPct: a.evAfterCostsPct != null ? a.evAfterCostsPct.toFixed(3) : null,
        evidenceScore: a.evidenceScore != null ? a.evidenceScore.toFixed(1) : null,
        evidenceTier: a.evidenceTier,
        setupType: a.setupType,
        decisionStatus: a.action === "ALLOCATE" ? "QUALIFIED" : "CONDITIONAL",
        reasonCodes: a.reasonCodes,
        riskReasons: a.riskReasons,
        invalidationReasons: a.invalidationReasons,
        detail: { sizingConstraints: a.sizingConstraints, changesIf: a.changesIf, probability: a.probability, sector: a.sector, regime: result.regime.regime, horizon: result.horizon, riskProfile: result.riskProfile },
        modelVersion: SHORT_TERM_VERSION,
        decisionSnapshotId: a.decisionSnapshotId,
      });
    }
    for (const w of [...result.withdrawals, ...result.holds]) {
      rows.push({
        capitalPlanId: plan.id,
        accountId: req.accountId,
        planDate,
        ticker: w.ticker,
        action: w.action,
        recommendedAmountInr: w.recommendedRemainingInr != null ? w.recommendedRemainingInr.toFixed(2) : null,
        recommendedQty: w.qtyToSell,
        decisionStatus: w.action,
        reasonCodes: w.reasonCodes,
        riskReasons: w.reasons,
        invalidationReasons: w.invalidation,
        detail: { currentValueInr: w.currentValueInr, investedInr: w.investedInr, pnlInr: w.pnlInr, amountToWithdrawInr: w.amountToWithdrawInr, trailStopPrice: w.trailStopPrice, evidenceAsOf: w.evidenceAsOf },
        modelVersion: SHORT_TERM_VERSION,
        decisionSnapshotId: null,
      });
    }
    if (result.allocations.length === 0) {
      rows.push({
        capitalPlanId: plan.id,
        accountId: req.accountId,
        planDate,
        ticker: "CASH",
        action: "CASH",
        recommendedAmountInr: result.cash.recommendedCashInr.toFixed(2),
        decisionStatus: "NO_NEW_ALLOCATION",
        reasonCodes: [],
        riskReasons: result.cash.whyCash,
        invalidationReasons: [],
        detail: null,
        modelVersion: SHORT_TERM_VERSION,
        decisionSnapshotId: null,
      });
    }
    if (rows.length) await allocRepo.save(rows.map((r) => allocRepo.create(r)));
    return plan.id;
  }

  /** One immutable snapshot per account per session; a repeat call the same day is a no-op. */
  async dailySnapshot(accountId: string, opts: { capitalAvailableInr: number; riskProfile: RiskProfileName; horizon: CapitalHorizon }): Promise<{ created: boolean; snapshotId: string | null; planId: string | null }> {
    const repo = AppDataSource.getRepository(DailyCapitalDecisionSnapshot);
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const existing = await repo.findOne({ where: { accountId, snapshotDate: today } });
    if (existing) return { created: false, snapshotId: existing.id, planId: existing.capitalPlanId };
    const plan = await this.plan({ accountId, ...opts, persist: true, kind: "SNAPSHOT" });
    const snap = await repo.save(
      repo.create({
        accountId,
        snapshotDate: today,
        capitalPlanId: plan.planId as string,
        riskProfile: plan.riskProfile,
        marketRegime: plan.regime.regime,
        modelVersions: { shortTerm: SHORT_TERM_VERSION, capitalPolicy: CAPITAL_POLICY_VERSION, desk: plan.version },
        featureCutoffAt: plan.freshness.featureCutoffAt ? new Date(plan.freshness.featureCutoffAt) : null,
        freshness: plan.freshness as unknown as Record<string, unknown>,
        state: {
          capital: plan.cash,
          holdings: plan.holds.concat(plan.withdrawals),
          regime: plan.regime,
          candidatesEvaluated: plan.candidatesEvaluated,
          allocations: plan.allocations,
          conditional: plan.conditional,
          withdrawals: plan.withdrawals,
          rejected: plan.rejected.map((r) => ({ ticker: r.ticker, reasonCodes: r.reasonCodes })),
        },
      })
    );
    return { created: true, snapshotId: snap.id, planId: plan.planId };
  }

  async history(accountId: string, limit = 20): Promise<Array<{ id: string; kind: string; asOf: string; riskProfile: string; horizon: string; summary: string; deploymentInr: number; cashInr: number; regime: string }>> {
    const rows: CapitalPlan[] = await AppDataSource.getRepository(CapitalPlan).find({ where: { accountId }, order: { asOf: "DESC" }, take: Math.min(100, limit) });
    return rows.map((p) => ({
      id: p.id,
      kind: p.kind,
      asOf: new Date(p.asOf).toISOString(),
      riskProfile: p.riskProfile,
      horizon: p.horizon,
      summary: p.summary,
      deploymentInr: r2(Number(p.recommendedDeploymentInr)),
      cashInr: r2(Number(p.capitalAvailableInr) - Number(p.recommendedDeploymentInr)),
      regime: p.marketRegime,
    }));
  }
}

export const capitalAllocationService = new CapitalAllocationService();
