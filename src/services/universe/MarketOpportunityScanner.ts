/**
 * MarketOpportunityScanner — the multi-stage funnel over the security master.
 *
 *  UNIVERSE (tradable tiers)  →  DATA VALIDATION  →  LIQUIDITY  →  TECHNICAL SCREEN (stage-1, close-only, cheap)
 *  →  FUNDAMENTAL / EVENT SCREEN (stored evidence only)  →  SHORT-TERM SETUP ENGINE (the existing ScanService,
 *  unchanged)  →  EXISTING DECISION GATES  →  RISK / MODEL HEALTH  →  Money Desk (reads the persisted run).
 *
 * Nothing here bypasses the engine: the setup engine, gates, tiers and health
 * are the same code the radar runs; this service only decides WHICH symbols
 * reach it and records every stage count and every rejection reason so a
 * "0 recommendations" day is fully explained. Counts are configurable; none
 * is a mandatory quota.
 */

import { AppDataSource } from "../../config/database";
import { OpportunityCandidate, OpportunityScan } from "../../entities";
import { UniverseStock } from "../../data/nseUniverse";
import { marketDataService } from "../market/MarketDataService";
import { regimeService } from "../shortterm/RegimeService";
import { shortTermScanService } from "../shortterm/ScanService";
import { ShortTermCandidateView, ShortTermHorizon } from "../shortterm/types";
import { computeStageOneFeatures, detectSignals, liquidityScore, riskScore, SeriesPoint, StageOneFeatures, technicalScore } from "./opportunityFeatures";

export const BROAD_SCAN_LABEL = "BROAD_SCAN";
export const SCANNER_VERSION = "opportunity-scanner-v1";

export interface ScannerConfig {
  tiers: Array<"A" | "B" | "C">;
  minSessions: number;
  minMedianValueInr: number;
  technicalKeep: number; // after the technical screen
  researchKeep: number; // after the fundamental/event screen → setup engine
  horizon: ShortTermHorizon;
  /** Log qualified setups to the radar's shadow ledger only for these tiers (liquid names; never penny stocks). */
  shadowTiers: Array<"A" | "B">;
  maxSetupEngine: number; // hard cap on Yahoo fetches per run
}
export const DEFAULT_SCANNER_CONFIG: ScannerConfig = {
  tiers: ["A", "B"],
  minSessions: 60,
  minMedianValueInr: 2e7,
  technicalKeep: Number(process.env.BROAD_SCAN_TECHNICAL_KEEP ?? 250),
  researchKeep: Number(process.env.BROAD_SCAN_RESEARCH_KEEP ?? 100),
  horizon: "5-10d",
  shadowTiers: (process.env.BROAD_SCAN_SHADOW_TIERS ?? "A").split(",").filter((t): t is "A" | "B" => t === "A" || t === "B"),
  maxSetupEngine: Number(process.env.BROAD_SCAN_MAX_SETUP ?? 150),
};

export type Stage = "UNIVERSE" | "DATA_VALIDATION" | "LIQUIDITY" | "TECHNICAL" | "FUNDAMENTAL_EVENT" | "SETUP_ENGINE" | "DECISION_GATES" | "RISK" | "MODEL_HEALTH" | "MONEY_DESK";
export interface StageCount {
  stage: Stage;
  entered: number;
  passed: number;
  reasons: Record<string, number>;
}
export interface ScanFunnel {
  scanId: string;
  asOf: string;
  regime: string | null;
  stages: StageCount[];
  finalQualified: number;
  zeroBecause: string[];
  durationMs: number;
  scanRunId: string | null;
}

interface Row {
  symbol: string;
  yahoo: string;
  name: string;
  sector: string | null;
  tier: string;
  cap: string;
  f: StageOneFeatures | null;
  signals: string[];
  technical: number | null;
  liquidity: number | null;
  risk: number | null;
  fundamental: number | null;
  event: number | null;
  researchEvidence: number | null;
  stageReached: Stage;
  rejectedAt: Stage | null;
  reasons: string[];
  view: ShortTermCandidateView | null;
}

const inc = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);

export class MarketOpportunityScanner {
  async run(cfgIn: Partial<ScannerConfig> = {}): Promise<ScanFunnel> {
    const cfg: ScannerConfig = { ...DEFAULT_SCANNER_CONFIG, ...cfgIn };
    const t0 = Date.now();
    const scanRepo = AppDataSource.getRepository(OpportunityScan);
    const [{ d: asOf }]: Array<{ d: string }> = await AppDataSource.query(`SELECT to_char(MAX(trade_date),'YYYY-MM-DD') d FROM nse_delivery`);
    const regime = await regimeService.detect().catch(() => null);
    const scan = await scanRepo.save(scanRepo.create({ asOf, universeLabel: BROAD_SCAN_LABEL, status: "running", config: cfg as unknown as Record<string, unknown>, regime: regime?.regime ?? null }));
    const stages: StageCount[] = [];
    const stage = (s: Stage): StageCount => {
      const c: StageCount = { stage: s, entered: 0, passed: 0, reasons: {} };
      stages.push(c);
      return c;
    };
    try {
      // ── UNIVERSE ──
      const sU = stage("UNIVERSE");
      const master: Array<{ symbol: string; yahoo_ticker: string; company_name: string; industry: string | null; sector: string | null; liquidity_tier: string; market_cap_bucket: string }> = await AppDataSource.query(
        `SELECT symbol, yahoo_ticker, company_name, industry, sector, liquidity_tier, market_cap_bucket FROM security_master
          WHERE is_active AND is_tradable AND instrument_type = 'EQUITY' AND liquidity_tier = ANY($1)`,
        [cfg.tiers]
      );
      sU.entered = master.length;
      sU.passed = master.length;
      const rows: Row[] = master.map((m) => ({ symbol: m.symbol, yahoo: m.yahoo_ticker, name: m.company_name, sector: m.sector ?? m.industry, tier: m.liquidity_tier, cap: m.market_cap_bucket, f: null, signals: [], technical: null, liquidity: null, risk: null, fundamental: null, event: null, researchEvidence: null, stageReached: "UNIVERSE", rejectedAt: null, reasons: [], view: null }));
      const bySymbol = new Map(rows.map((r) => [r.symbol, r]));

      // ── DATA VALIDATION + stage-1 features (one set-based query) ──
      const sD = stage("DATA_VALIDATION");
      sD.entered = rows.length;
      const series: Array<{ symbol: string; d: string; close: string; qty: string; val: string; deliv: string | null }> = await AppDataSource.query(
        `SELECT symbol, trade_date::text AS d, close_price::text AS close, traded_qty::text AS qty, (turnover_lacs*1e5)::text AS val, deliv_pct::text AS deliv
           FROM nse_delivery WHERE series = 'EQ' AND trade_date > $1::date - 400 AND trade_date <= $1::date AND symbol = ANY($2) ORDER BY symbol, trade_date`,
        [asOf, rows.map((r) => r.symbol)]
      );
      const grouped = new Map<string, SeriesPoint[]>();
      for (const p of series) {
        if (!grouped.has(p.symbol)) grouped.set(p.symbol, []);
        grouped.get(p.symbol)!.push({ date: p.d, close: Number(p.close), volume: Number(p.qty), valueInr: Number(p.val), delivPct: p.deliv != null ? Number(p.deliv) : null });
      }
      let nifty: Map<string, number> | null = null;
      try {
        nifty = new Map((await marketDataService.getNiftyBars("2y")).map((b) => [b.date, b.adjustedClose ?? b.close]));
      } catch {
        /* relative strength becomes null, flagged in features */
      }
      for (const r of rows) {
        const s = grouped.get(r.symbol) ?? [];
        if (s.length < cfg.minSessions) {
          reject(r, "DATA_VALIDATION", `fewer than ${cfg.minSessions} sessions`, sD);
          continue;
        }
        if (s[s.length - 1].date !== asOf) {
          reject(r, "DATA_VALIDATION", "no trade on the latest session (stale)", sD);
          continue;
        }
        const f = computeStageOneFeatures(s, asOf, nifty);
        if (!f) {
          reject(r, "DATA_VALIDATION", "features unavailable", sD);
          continue;
        }
        r.f = f;
        r.stageReached = "DATA_VALIDATION";
        sD.passed += 1;
      }

      // ── LIQUIDITY ──
      const sL = stage("LIQUIDITY");
      for (const r of rows.filter((x) => x.rejectedAt == null)) {
        sL.entered += 1;
        const f = r.f as StageOneFeatures;
        r.liquidity = liquidityScore(f.medianValue20Inr, f.delivPct20);
        if (f.medianValue20Inr < cfg.minMedianValueInr) {
          reject(r, "LIQUIDITY", `median traded value ₹${(f.medianValue20Inr / 1e7).toFixed(1)}cr < ₹${(cfg.minMedianValueInr / 1e7).toFixed(0)}cr`, sL);
          continue;
        }
        r.stageReached = "LIQUIDITY";
        sL.passed += 1;
      }

      // ── TECHNICAL SCREEN ──
      const sT = stage("TECHNICAL");
      const tech = rows.filter((x) => x.rejectedAt == null);
      sT.entered = tech.length;
      for (const r of tech) {
        const f = r.f as StageOneFeatures;
        r.signals = detectSignals(f);
        r.technical = technicalScore(f);
        r.risk = riskScore(f);
      }
      tech.sort((a, b) => (b.technical ?? 0) + b.signals.length * 5 - ((a.technical ?? 0) + a.signals.length * 5));
      tech.forEach((r, i) => {
        if (i < cfg.technicalKeep && (r.signals.length > 0 || (r.technical ?? 0) >= 50)) {
          r.stageReached = "TECHNICAL";
          sT.passed += 1;
        } else reject(r, "TECHNICAL", r.signals.length === 0 ? "no setup signal (breakout/pullback/momentum/mean-reversion)" : `below technical keep (${cfg.technicalKeep})`, sT);
      });

      // ── FUNDAMENTAL / EVENT SCREEN (stored evidence; missing data is recorded, not punished) ──
      const sF = stage("FUNDAMENTAL_EVENT");
      const survivors = rows.filter((x) => x.rejectedAt == null);
      sF.entered = survivors.length;
      await this.attachFundamentalEvidence(survivors);
      survivors.sort((a, b) => evidenceOrder(b) - evidenceOrder(a));
      survivors.forEach((r, i) => {
        if (r.event != null && r.event <= 10) reject(r, "FUNDAMENTAL_EVENT", "adverse event evidence (regulatory / surveillance / material negative)", sF);
        else if (i < cfg.researchKeep) {
          r.stageReached = "FUNDAMENTAL_EVENT";
          sF.passed += 1;
        } else reject(r, "FUNDAMENTAL_EVENT", `below research keep (${cfg.researchKeep})`, sF);
      });

      // ── SHORT-TERM SETUP ENGINE (existing ScanService — unchanged) ──
      const sS = stage("SETUP_ENGINE");
      const toEngine = rows.filter((x) => x.rejectedAt == null).slice(0, cfg.maxSetupEngine);
      sS.entered = toEngine.length;
      let scanRunId: string | null = null;
      if (toEngine.length) {
        const universe: UniverseStock[] = toEngine.map((r) => ({ ticker: r.yahoo, name: r.name, sector: r.sector ?? "Unclassified" }));
        const shadow = toEngine.every((r) => cfg.shadowTiers.includes(r.tier as "A" | "B"));
        const result = await shortTermScanService.scan(
          { horizon: cfg.horizon, limit: 0, aiDepth: "LOCAL_ONLY" },
          { universe, label: BROAD_SCAN_LABEL, persistAll: true, shadow, returnAll: true }
        );
        scanRunId = result.scanRunId;
        const views = new Map((result.all ?? []).map((v) => [v.ticker, v]));
        for (const r of toEngine) {
          const v = views.get(r.yahoo);
          if (!v) {
            reject(r, "SETUP_ENGINE", "engine skipped (bars unavailable or < 60 bars from provider)", sS);
            continue;
          }
          r.view = v;
          r.stageReached = "SETUP_ENGINE";
          sS.passed += 1;
        }
      }

      // ── EXISTING DECISION GATES → RISK → MODEL HEALTH (read from the engine's own verdicts) ──
      const sG = stage("DECISION_GATES");
      const sR = stage("RISK");
      const sM = stage("MODEL_HEALTH");
      const sMD = stage("MONEY_DESK");
      for (const r of rows.filter((x) => x.view)) {
        const v = r.view as ShortTermCandidateView;
        sG.entered += 1;
        const failures = v.gates?.failures ?? [];
        if (!v.gates?.passed) {
          for (const f of failures) inc(sG.reasons, f.gate);
          r.rejectedAt = "DECISION_GATES";
          r.reasons.push(...failures.map((f) => `${f.gate}: ${f.current} (needs ${f.required})`));
          r.stageReached = "DECISION_GATES";
          continue;
        }
        sG.passed += 1;
        sR.entered += 1;
        const riskFail = failures.find((f) => f.gate === "portfolio risk" || f.gate === "volatility" || f.gate === "slippage");
        if (riskFail || v.riskLevel === "HIGH") {
          inc(sR.reasons, riskFail ? riskFail.gate : "risk level HIGH");
          r.rejectedAt = "RISK";
          r.reasons.push(riskFail ? `${riskFail.gate}: ${riskFail.current}` : "risk level HIGH");
          r.stageReached = "RISK";
          continue;
        }
        sR.passed += 1;
        sM.entered += 1;
        if (v.modelHealth !== "HEALTHY" || v.tier !== "A") {
          inc(sM.reasons, v.modelHealth !== "HEALTHY" ? `model health ${v.modelHealth}` : `evidence tier ${v.tier}`);
          r.rejectedAt = "MODEL_HEALTH";
          r.reasons.push(v.modelHealth !== "HEALTHY" ? `short-term model health ${v.modelHealth} (needs HEALTHY)` : `setup evidence tier ${v.tier} (needs A)`);
          r.stageReached = "MODEL_HEALTH";
          continue;
        }
        sM.passed += 1;
        sMD.entered += 1;
        if (v.qualified && v.action === "ENTRY_CONFIRMED") {
          sMD.passed += 1;
          r.stageReached = "MONEY_DESK";
        } else {
          inc(sMD.reasons, v.action);
          r.rejectedAt = "MONEY_DESK";
          r.reasons.push(`action ${v.action} (needs ENTRY_CONFIRMED)`, ...(v.whyNotEntry ?? []));
          r.stageReached = "MONEY_DESK";
        }
      }

      // ── persist candidates (every symbol that entered the universe, with its stage and reasons) ──
      await this.persistCandidates(scan.id, asOf, rows, scanRunId);
      const zeroBecause = this.explainZero(stages);
      scan.status = "success";
      scan.finishedAt = new Date();
      scan.stages = stages as unknown as Array<Record<string, unknown>>;
      scan.scanRunId = scanRunId;
      scan.notes = zeroBecause.join(" | ");
      await scanRepo.save(scan);
      return { scanId: scan.id, asOf, regime: regime?.regime ?? null, stages, finalQualified: sMD.passed, zeroBecause, durationMs: Date.now() - t0, scanRunId };
    } catch (err) {
      scan.status = "failed";
      scan.finishedAt = new Date();
      scan.stages = stages as unknown as Array<Record<string, unknown>>;
      scan.notes = err instanceof Error ? err.message : String(err);
      await scanRepo.save(scan);
      throw err;
    }
  }

  /** Fundamental + event evidence from STORED data only (intelligence_metrics, stock_knowledge). Missing → null. */
  private async attachFundamentalEvidence(rows: Row[]): Promise<void> {
    if (!rows.length) return;
    const tickers = rows.flatMap((r) => [r.yahoo, r.symbol]);
    const metrics: Array<{ ticker: string; metric: string; value: string | null }> = await AppDataSource.query(
      `SELECT DISTINCT ON (ticker, metric) ticker, metric, value::text FROM intelligence_metrics WHERE ticker = ANY($1) AND metric IN ('roe','roce','profit_growth_yoy','debt_to_equity','promoter_holding_change_qoq','pe_ratio') ORDER BY ticker, metric, calculated_at DESC`,
      [tickers]
    );
    const m = new Map<string, Record<string, number>>();
    for (const x of metrics) {
      const k = x.ticker.replace(/\.NS$/, "");
      if (!m.has(k)) m.set(k, {});
      if (x.value != null && Number.isFinite(Number(x.value))) m.get(k)![x.metric] = Number(x.value);
    }
    const facts: Array<{ symbol: string; kind: string; sentiment: string | null; materiality: string | null; n: string }> = await AppDataSource.query(
      `SELECT symbol, kind, detail->>'sentiment' AS sentiment, detail->>'materiality' AS materiality, COUNT(*)::text AS n FROM stock_knowledge
        WHERE symbol = ANY($1) AND source_kind IN ('NEWS','EXCHANGE','FILING') AND observed_at >= CURRENT_DATE - 30 GROUP BY 1,2,3,4`,
      [rows.map((r) => r.symbol)]
    );
    const fb = new Map<string, typeof facts>();
    for (const f of facts) fb.set(f.symbol, [...(fb.get(f.symbol) ?? []), f]);
    for (const r of rows) {
      const k = m.get(r.symbol);
      if (k && Object.keys(k).length) {
        let s = 50;
        if (k.roe != null) s += k.roe >= 15 ? 15 : k.roe >= 8 ? 5 : -10;
        if (k.roce != null) s += k.roce >= 15 ? 10 : k.roce < 5 ? -10 : 0;
        if (k.profit_growth_yoy != null) s += k.profit_growth_yoy > 10 ? 10 : k.profit_growth_yoy < -10 ? -15 : 0;
        if (k.debt_to_equity != null) s += k.debt_to_equity <= 0.5 ? 10 : k.debt_to_equity > 2 ? -15 : 0;
        if (k.promoter_holding_change_qoq != null) s += k.promoter_holding_change_qoq < -1 ? -10 : k.promoter_holding_change_qoq > 0 ? 5 : 0;
        r.fundamental = Math.max(0, Math.min(100, s));
      } else r.fundamental = null;
      const fs = fb.get(r.symbol) ?? [];
      if (fs.length) {
        let e = 50;
        for (const f of fs) {
          const n = Number(f.n);
          if (f.kind === "REGULATORY" || f.kind === "LEGAL") e -= 20 * n;
          else if (f.sentiment === "NEGATIVE" && f.materiality === "HIGH") e -= 15 * n;
          else if (f.sentiment === "POSITIVE" && f.materiality === "HIGH") e += 10 * n;
          else if (f.kind === "RESULTS" || f.kind === "ORDER_WIN" || f.kind === "GUIDANCE") e += 5 * n;
        }
        r.event = Math.max(0, Math.min(100, e));
        r.researchEvidence = Math.min(100, fs.length * 15 + (k ? 25 : 0));
      } else {
        r.event = null;
        r.researchEvidence = k ? 25 : 0;
      }
    }
  }

  private async persistCandidates(scanId: string, asOf: string, rows: Row[], scanRunId: string | null): Promise<void> {
    const repo = AppDataSource.getRepository(OpportunityCandidate);
    const stIds = scanRunId
      ? new Map<string, string>((await AppDataSource.query(`SELECT ticker, id FROM short_term_candidates WHERE scan_run_id = $1`, [scanRunId]) as Array<{ ticker: string; id: string }>).map((x) => [x.ticker, x.id]))
      : new Map<string, string>();
    const ranked = [...rows].filter((r) => r.technical != null).sort((a, b) => (b.technical ?? 0) - (a.technical ?? 0));
    const rankBy = new Map(ranked.map((r, i) => [r.symbol, i + 1]));
    const cutoff = new Date(`${asOf}T15:30:00+05:30`);
    const batch: Partial<OpportunityCandidate>[] = [];
    for (const r of rows) {
      const v = r.view;
      batch.push({
        scanId,
        symbol: r.symbol,
        yahooTicker: r.yahoo,
        asOf,
        liquidityTier: r.tier,
        marketCapBucket: r.cap,
        sector: r.sector,
        stageReached: r.stageReached,
        rejectedAtStage: r.rejectedAt,
        rejectionReasons: r.reasons.slice(0, 12),
        signals: r.signals,
        features: (r.f ?? { unavailable: true }) as unknown as Record<string, unknown>,
        technicalScore: r.technical != null ? r.technical.toFixed(1) : null,
        fundamentalScore: r.fundamental != null ? r.fundamental.toFixed(1) : null,
        eventScore: r.event != null ? r.event.toFixed(1) : null,
        researchEvidenceScore: r.researchEvidence != null ? r.researchEvidence.toFixed(1) : null,
        liquidityScore: r.liquidity != null ? r.liquidity.toFixed(1) : null,
        riskScore: r.risk != null ? r.risk.toFixed(1) : null,
        modelHealthScore: v ? (v.modelHealth === "HEALTHY" ? "100.0" : v.modelHealth === "DEGRADED" ? "50.0" : v.modelHealth === "SHADOW" ? "25.0" : "0.0") : null,
        screenRank: rankBy.get(r.symbol) ?? null,
        setupType: v?.setupType ?? null,
        action: v?.action ?? null,
        tier: v?.tier ?? null,
        decisionStatus: v ? (v.qualified ? "QUALIFIED" : v.action) : null,
        plan: v ? { entryType: v.plan.entryType, entryZoneLow: v.plan.entryZoneLow, entryZoneHigh: v.plan.entryZoneHigh, entryTriggerPrice: v.plan.entryTriggerPrice, initialStop: v.plan.initialStop, target1: v.plan.target1, target2: v.plan.target2, rewardRiskToTarget1: v.plan.rewardRiskToTarget1, expectedHoldingDays: v.plan.expectedHoldingDays, atr14: v.plan.atr14, ev80LowerPct: (v.ev as Record<string, unknown> | null)?.ev80LowerPct ?? null } : null,
        shortTermCandidateId: stIds.get(r.yahoo) ?? null,
        featureCutoffAt: cutoff,
      });
      if (batch.length >= 300) {
        await repo.save(batch.map((b) => repo.create(b)), { chunk: 100 });
        batch.length = 0;
      }
    }
    if (batch.length) await repo.save(batch.map((b) => repo.create(b)), { chunk: 100 });
  }

  private explainZero(stages: StageCount[]): string[] {
    const last = stages[stages.length - 1];
    if (last && last.passed > 0) return [];
    const out: string[] = [];
    for (const s of [...stages].reverse()) {
      if (s.entered === 0) continue;
      const top = Object.entries(s.reasons).sort((a, b) => b[1] - a[1]).slice(0, 4);
      if (top.length) out.push(`${s.stage}: ${s.entered} entered, ${s.passed} passed — ${top.map(([k, n]) => `${n} ${k}`).join(", ")}`);
      else out.push(`${s.stage}: ${s.entered} entered, ${s.passed} passed`);
    }
    return out;
  }

  async latestFunnel(): Promise<ScanFunnel | null> {
    const rows: OpportunityScan[] = await AppDataSource.getRepository(OpportunityScan).find({ where: { universeLabel: BROAD_SCAN_LABEL, status: "success" }, order: { startedAt: "DESC" }, take: 1 });
    const s = rows[0];
    if (!s) return null;
    const stages = s.stages as unknown as StageCount[];
    const last = stages[stages.length - 1];
    return { scanId: s.id, asOf: s.asOf, regime: s.regime, stages, finalQualified: last?.passed ?? 0, zeroBecause: s.notes ? s.notes.split(" | ").filter(Boolean) : [], durationMs: s.finishedAt ? new Date(s.finishedAt).getTime() - new Date(s.startedAt).getTime() : 0, scanRunId: s.scanRunId };
  }
}

function reject(r: Row, at: Stage, reason: string, s: StageCount): void {
  r.rejectedAt = at;
  r.reasons.push(reason);
  r.stageReached = at;
  inc(s.reasons, reason.replace(/[₹\d.]+cr/g, "Xcr").replace(/\(\d+\)/g, ""));
}
function evidenceOrder(r: Row): number {
  return (r.technical ?? 0) + r.signals.length * 5 + (r.fundamental ?? 50) * 0.3 + (r.event ?? 50) * 0.2 + (r.liquidity ?? 0) * 0.2;
}

export const marketOpportunityScanner = new MarketOpportunityScanner();
