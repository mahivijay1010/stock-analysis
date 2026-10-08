/**
 * GlobalIntelligenceService — orchestrates the global layer:
 *   snapshot(cutoff)      immutable set of observations usable at an India cutoff + regime + transmission + sectors
 *   runStudies()          shock studies and sector sensitivities → global_relationship_studies (+ experiment_runs)
 *   backfillRegimeDays()  daily regime history from the same rules (point-in-time by the leakage rule)
 *   regimeTrackRecord()   regime × NIFTY/sector forward returns × setup performance (withheld < 10)
 *   companyContext()      measurable global drivers for one company's sector
 * The regime and transmission are CONTEXT and risk inputs for the Money Desk; they never veto a stock.
 */

import { AppDataSource } from "../../config/database";
import { GlobalMarketSnapshot } from "../../entities";
import { wilsonLb95 } from "../evidence/selectivity";
import { GlobalMarketDataService, GlobalObservation, globalMarketDataService } from "./GlobalMarketDataService";
import { classifyGlobalRegime, ObsLite, RegimeResult } from "./globalRegime";
import { compositeSeries, DailySeries, driverChange, HORIZONS, MIN_SHOCK_N, sectorSensitivity, SensitivityResult, ShockDefinition, SHOCKS, shockStudy, ShockStudyResult, STUDY_VERSION, Transmission, transmissionFromActiveShocks, usableIndex } from "./globalRelationships";
import { closedBeforeCutoff, GLOBAL_UNIVERSE, INDIA_SECTOR_PROXIES, INDIA_TZ, instrumentByKey, localToUtc, partsIn } from "./globalUniverse";

export interface SectorImpact {
  sector: string;
  name: string;
  label: Transmission;
  drivers: Array<{ driver: string; correlation: number | null; beta: number | null; n: number; activeShock: string | null; direction: "UP" | "DOWN" | null }>;
  reasons: string[];
}
export interface GlobalSnapshotView {
  id: string | null;
  cutoffUtc: string;
  indiaSessionDate: string;
  globalDataAsOf: string | null;
  indiaDataAsOf: string | null;
  observations: GlobalObservation[];
  excludedForCutoff: Array<{ instrument: string; sessionDate: string; reason: string }>;
  missing: Array<{ instrument: string; reason: string }>;
  coverage: { scanned: number; valid: number; byRegion: Record<string, { valid: number; total: number }>; byAssetClass: Record<string, { valid: number; total: number }>; stale: number };
  regime: RegimeResult;
  india: { regime: string | null; reasons: string[]; diagnosis: { state: string; score: number; date: string } | null };
  transmission: { label: Transmission; reasons: string[]; evidence: Array<{ shock: string; n: number; medianPct: number | null; winRatePct: number | null; benchmarkMeanPct: number | null }>; activeShocks: string[] };
  sectors: SectorImpact[];
  events: Array<{ event: string; region: string; scheduledAt: string; importance: string; expected: string | null; actual: string | null }>;
}

const SECTOR_DRIVERS: Record<string, string[]> = {
  SEC_IT: ["NDX", "USDINR", "US10Y"],
  SEC_FIN: ["US10Y", "DXY", "SPX"],
  SEC_METAL: ["COPPER", "SHCOMP", "DXY"],
  SEC_ENERGY: ["BRENT", "WTI"],
  SEC_AUTO: ["BRENT", "COPPER", "SPX"],
  SEC_PHARMA: ["USDINR", "SPX"],
  SEC_FMCG: ["BRENT", "USDINR"],
  SEC_CAPGOODS: ["COPPER", "SHCOMP", "US10Y"],
  SEC_CHEM: ["BRENT", "SHCOMP"],
  SEC_CONSUMER: ["SPX", "USDINR"],
  SEC_REALTY: ["US10Y", "SPX"],
  SEC_TELECOM: ["US10Y"],
  NIFTYIT: ["NDX", "USDINR", "US10Y"],
  BANKNIFTY: ["US10Y", "DXY", "SPX"],
  NIFTYPHARMA: ["USDINR", "SPX"],
};

export class GlobalIntelligenceService {
  constructor(private readonly data: GlobalMarketDataService = globalMarketDataService) {}

  /** Build (and persist, immutable) the snapshot usable at a cutoff. Default cutoff: India's close on the latest India session ≤ now. */
  async snapshot(opts: { cutoffUtc?: Date; persist?: boolean; kind?: "REQUEST" | "SNAPSHOT" } = {}): Promise<GlobalSnapshotView> {
    const now = new Date();
    // Live decisions use everything that has CLOSED before now; historical studies use the India-close rule.
    const cutoff = opts.cutoffUtc ?? now;
    const indiaSession = this.indiaSessionFor(cutoff);
    const { observations, missing } = await this.data.observeAll(now);
    const usable: GlobalObservation[] = [];
    const excluded: GlobalSnapshotView["excludedForCutoff"] = [];
    for (const o of observations) {
      const inst = instrumentByKey(o.instrument);
      if (!inst) continue;
      if (closedBeforeCutoff(inst, o.sessionDate, cutoff)) usable.push(o);
      else excluded.push({ instrument: o.instrument, sessionDate: o.sessionDate, reason: `session closes after the cutoff ${cutoff.toISOString()} (leakage rule)` });
    }
    // Re-derive the usable observation for excluded instruments from the prior session when the bars allow it.
    for (const e of excluded) {
      const inst = instrumentByKey(e.instrument);
      if (!inst) continue;
      const bars = await this.data.bars(inst).catch(() => []);
      const prior = bars.filter((b) => closedBeforeCutoff(inst, b.date, cutoff));
      const o = prior.length >= 2 ? this.data.observationFromBars(inst, prior, cutoff) : null;
      if (o) usable.push(o);
    }
    const lite: ObsLite[] = usable.map((o) => ({ key: o.instrument, assetClass: o.assetClass, region: o.region, sessionDate: o.sessionDate, price: o.price, ret1d: o.return1d, ret5d: o.return5d, ret20d: o.return20d, vol20: o.volatility20, isYield: o.isYield, chg5bps: o.chg5bps, chg20bps: o.chg20bps, freshness: o.freshness }));
    const regime = classifyGlobalRegime(lite);
    const studies = await this.latestStudies();
    const active = await this.activeShocks(indiaSession);
    const trans = transmissionFromActiveShocks(active.map((a) => ({ shock: a.shock, study: studies.find((s) => s.shock === a.shock.label && s.target === "NIFTY" && s.horizon === 5) })));
    const sectors = await this.sectorImpacts(active);
    const india = await this.indiaRegime();
    const events = await this.upcomingEvents(cutoff);
    const byRegion: Record<string, { valid: number; total: number }> = {};
    const byClass: Record<string, { valid: number; total: number }> = {};
    for (const inst of GLOBAL_UNIVERSE) {
      if (inst.region === "INDIA") continue;
      const ok = usable.some((u) => u.instrument === inst.key && u.freshness !== "STALE");
      byRegion[inst.region] = { valid: (byRegion[inst.region]?.valid ?? 0) + (ok ? 1 : 0), total: (byRegion[inst.region]?.total ?? 0) + 1 };
      byClass[inst.assetClass] = { valid: (byClass[inst.assetClass]?.valid ?? 0) + (ok ? 1 : 0), total: (byClass[inst.assetClass]?.total ?? 0) + 1 };
    }
    const globalObs = usable.filter((u) => u.region !== "INDIA");
    const view: GlobalSnapshotView = {
      id: null,
      cutoffUtc: cutoff.toISOString(),
      indiaSessionDate: indiaSession,
      globalDataAsOf: globalObs.length ? globalObs.map((u) => u.utcCloseAt).sort().reverse()[0] : null,
      indiaDataAsOf: usable.find((u) => u.instrument === "NIFTY")?.utcCloseAt ?? null,
      observations: usable.sort((a, b) => a.region.localeCompare(b.region) || a.instrument.localeCompare(b.instrument)),
      excludedForCutoff: excluded,
      missing,
      coverage: { scanned: GLOBAL_UNIVERSE.filter((i) => i.region !== "INDIA").length, valid: globalObs.filter((u) => u.freshness !== "STALE").length, byRegion, byAssetClass: byClass, stale: usable.filter((u) => u.freshness === "STALE").length },
      regime,
      india,
      transmission: { ...trans, activeShocks: active.map((a) => a.shock.label) },
      sectors,
      events,
    };
    if (opts.persist !== false) {
      const repo = AppDataSource.getRepository(GlobalMarketSnapshot);
      const row = await repo.save(repo.create({ cutoffUtc: cutoff, indiaSessionDate: indiaSession, kind: opts.kind ?? "REQUEST", observations: view.observations as unknown as Array<Record<string, unknown>>, coverage: view.coverage as unknown as Record<string, unknown>, regime: regime as unknown as Record<string, unknown>, transmission: view.transmission as unknown as Record<string, unknown>, sectors: sectors as unknown as Array<Record<string, unknown>> }));
      view.id = row.id;
      await AppDataSource.query(
        `INSERT INTO global_regime_days (india_session_date, regime, score, components, coverage, feature_cutoff_utc) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6)
         ON CONFLICT (india_session_date) DO UPDATE SET regime = EXCLUDED.regime, score = EXCLUDED.score, components = EXCLUDED.components, coverage = EXCLUDED.coverage, feature_cutoff_utc = EXCLUDED.feature_cutoff_utc, computed_at = now()`,
        [indiaSession, regime.regime, regime.score, JSON.stringify(regime.components), JSON.stringify(regime.dataCoverage), cutoff]
      );
    }
    return view;
  }

  /** The India session a decision at `at` is for: today if before the 15:30 close on a weekday, else the next weekday. */
  indiaSessionFor(at: Date): string {
    const p = partsIn(INDIA_TZ, at);
    let d = new Date(`${p.date}T00:00:00Z`);
    if (p.hhmm >= "15:30") d = new Date(d.getTime() + 86_400_000);
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d = new Date(d.getTime() + 86_400_000);
    return d.toISOString().slice(0, 10);
  }

  /** Evidence for a regime: NIFTY 5-session forward median/win rate on the regime's days vs unconditional (withheld below 20). */
  async regimeEvidence(regime: string): Promise<{ n: number; niftyMedian5dPct: number | null; niftyWinRate5dPct: number | null; unconditionalMedian5dPct: number | null } | null> {
    try {
      const rec = await this.regimeTrackRecordCached();
      const r = rec.regimes.find((x) => x.regime === regime);
      if (!r) return null;
      const all = rec.regimes.flatMap((x) => Array(x.n).fill(x.nifty["5d"]?.median ?? 0)) as number[];
      const unconditional = rec.unconditional5dMedian;
      const n = r.nifty["5d"]?.n ?? 0;
      return { n, niftyMedian5dPct: n >= 20 ? r.nifty["5d"].median : null, niftyWinRate5dPct: n >= 20 ? r.nifty["5d"].winRatePct : null, unconditionalMedian5dPct: unconditional };
      void all;
    } catch {
      return null;
    }
  }
  private trCache: { at: number; value: Awaited<ReturnType<GlobalIntelligenceService["regimeTrackRecord"]>> } | null = null;
  async regimeTrackRecordCached() {
    if (this.trCache && Date.now() - this.trCache.at < 60 * 60_000) return this.trCache.value;
    const v = await this.regimeTrackRecord();
    this.trCache = { at: Date.now(), value: v };
    return v;
  }

  /** Seed the known official calendar (sources recorded); idempotent. */
  async seedEvents(): Promise<number> {
    const rows: Array<[string, string, string, string, string]> = [
      ["FOMC decision", "US", "2026-10-28T18:00:00Z", "HIGH", "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"],
      ["FOMC decision", "US", "2026-12-09T19:00:00Z", "HIGH", "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"],
      ["US CPI (September 2026)", "US", "2026-10-14T12:30:00Z", "HIGH", "https://www.bls.gov/schedule/news_release/current_year.asp"],
      ["US PPI (September 2026)", "US", "2026-10-15T12:30:00Z", "MEDIUM", "https://www.bls.gov/schedule/news_release/current_year.asp"],
      ["US Employment Cost Index (Q3 2026)", "US", "2026-10-30T12:30:00Z", "MEDIUM", "https://www.bls.gov/schedule/news_release/current_year.asp"],
    ];
    let n = 0;
    for (const [event, region, at, importance, source] of rows) {
      await AppDataSource.query(`INSERT INTO global_events (event, region, scheduled_at, importance, source) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (event, scheduled_at) DO NOTHING`, [event, region, new Date(at), importance, source]);
      n += 1;
    }
    return n;
  }

  /** @deprecated kept for tests: India's close on the latest weekday ≤ now. */
  defaultCutoff(now: Date): Date {
    let p = partsIn(INDIA_TZ, now);
    let date = p.date;
    if (p.hhmm < "15:30" || p.weekday === 0 || p.weekday === 6) {
      let d = new Date(`${date}T00:00:00Z`);
      do {
        d = new Date(d.getTime() - 86_400_000);
        p = partsIn("UTC", d);
      } while (new Date(d).getUTCDay() === 0 || new Date(d).getUTCDay() === 6);
      date = p.date;
    }
    return localToUtc(INDIA_TZ, date, "15:30");
  }

  async latest(): Promise<GlobalSnapshotView | null> {
    const rows = await AppDataSource.getRepository(GlobalMarketSnapshot).find({ order: { cutoffUtc: "DESC" }, take: 1 });
    const s = rows[0];
    if (!s) return null;
    const obs = s.observations as unknown as GlobalObservation[];
    const globalObs = obs.filter((u) => u.region !== "INDIA");
    return {
      id: s.id,
      cutoffUtc: new Date(s.cutoffUtc).toISOString(),
      indiaSessionDate: s.indiaSessionDate,
      globalDataAsOf: globalObs.length ? globalObs.map((u) => u.utcCloseAt).sort().reverse()[0] : null,
      indiaDataAsOf: obs.find((u) => u.instrument === "NIFTY")?.utcCloseAt ?? null,
      observations: obs,
      excludedForCutoff: [],
      missing: [],
      coverage: s.coverage as unknown as GlobalSnapshotView["coverage"],
      regime: s.regime as unknown as RegimeResult,
      india: await this.indiaRegime(),
      transmission: (s.transmission ?? { label: "NEUTRAL", reasons: [], evidence: [], activeShocks: [] }) as unknown as GlobalSnapshotView["transmission"],
      sectors: (s.sectors ?? []) as unknown as SectorImpact[],
      events: await this.upcomingEvents(new Date(s.cutoffUtc)),
    };
  }

  private async indiaRegime(): Promise<{ regime: string | null; reasons: string[]; diagnosis: { state: string; score: number; date: string } | null }> {
    let diagnosis: { state: string; score: number; date: string } | null = null;
    try {
      const { indiaMarketService } = await import("./IndiaMarketService");
      const d = await indiaMarketService.latestStored();
      if (d) diagnosis = { state: d.state, score: d.score, date: d.date };
    } catch {
      /* diagnosis optional */
    }
    try {
      const { regimeService } = await import("../shortterm/RegimeService");
      const r = await regimeService.detect();
      return { regime: r.regime, reasons: r.reasons, diagnosis };
    } catch {
      return { regime: null, reasons: ["India regime unavailable"], diagnosis };
    }
  }

  /** Which shocks are active for an India session, using the same series the studies used. */
  async activeShocks(indiaSession: string): Promise<Array<{ shock: ShockDefinition; change: number }>> {
    const drivers = await this.driverSeries();
    const out: Array<{ shock: ShockDefinition; change: number }> = [];
    for (const s of SHOCKS) {
      const d = drivers.get(s.driver);
      if (!d) continue;
      const idx = usableIndex(d, indiaSession);
      const chg = idx >= 0 ? driverChange(d, idx, s.window) : null;
      if (chg == null) continue;
      if (s.direction === "UP" ? chg >= s.threshold : chg <= -s.threshold) out.push({ shock: s, change: Math.round(chg * 100) / 100 });
    }
    return out;
  }

  private async driverSeries(): Promise<Map<string, DailySeries>> {
    const keys = ["US10Y", "DXY", "BRENT", "VIX", "NDX", "SPX", "GOLD", "USDINR", "COPPER", "WTI", "SHCOMP", "NKY", "HSI"];
    const map = new Map<string, DailySeries>();
    await Promise.all(keys.map(async (k) => {
      const inst = instrumentByKey(k);
      if (!inst) return;
      const s = await this.data.series(inst, "5y");
      if (s) map.set(k, s);
    }));
    const nky = map.get("NKY"), hsi = map.get("HSI");
    if (nky && hsi) map.set("ASIA", compositeSeries("ASIA", [nky, hsi], true));
    return map;
  }

  private async targetSeries(): Promise<DailySeries[]> {
    const out: DailySeries[] = [];
    for (const k of ["NIFTY", "BANKNIFTY", "NIFTYIT", "NIFTYPHARMA"]) {
      const inst = instrumentByKey(k);
      const s = inst ? await this.data.series(inst, "5y") : null;
      if (s) out.push(s);
    }
    out.push(...(await this.data.sectorProxySeries()));
    return out;
  }

  /** Run every shock study × target × horizon and every sector sensitivity; append results (immutable) and register an experiment run. */
  async runStudies(): Promise<{ studies: number; displayable: number; sensitivities: number; experimentRunId: string | null }> {
    const drivers = await this.driverSeries();
    const targets = await this.targetSeries();
    const results: ShockStudyResult[] = [];
    for (const s of SHOCKS) {
      const d = drivers.get(s.driver);
      if (!d) continue;
      for (const t of targets) results.push(...shockStudy(s, d, t, HORIZONS));
    }
    const sens: SensitivityResult[] = [];
    for (const t of targets) {
      for (const dk of SECTOR_DRIVERS[t.key] ?? ["SPX", "US10Y", "DXY", "BRENT"]) {
        const d = drivers.get(dk);
        if (d) sens.push(sectorSensitivity(d, t, 5));
      }
    }
    let runId: string | null = null;
    try {
      const [row] = (await AppDataSource.query(
        `INSERT INTO experiment_runs (name, kind, model_version, config, splits, dataset_manifest, dataset_hash, metrics, baselines, segments_used, used_final_test, status, notes, started_at, finished_at)
         VALUES ('global-relationships', 'ablation', $1, $2::jsonb, '{}'::jsonb, $3::jsonb, $4, $5::jsonb, $6::jsonb, '[]'::jsonb, false, 'completed', $7, now(), now()) RETURNING id`,
        [STUDY_VERSION, JSON.stringify({ shocks: SHOCKS, horizons: HORIZONS, minN: MIN_SHOCK_N }), JSON.stringify({ drivers: [...drivers.keys()], targets: targets.map((t) => `${t.key}:${t.points.length}`) }), `global-${Date.now()}`, JSON.stringify({ studies: results.length, displayable: results.filter((r) => r.displayable).length }), JSON.stringify({ sensitivities: sens.length }), "Empirical global→India relationships; evidence only, never a production rule."]
      )) as Array<{ id: string }>;
      runId = row?.id ?? null;
    } catch { /* registry optional */ }
    for (const r of results) {
      await AppDataSource.query(
        `INSERT INTO global_relationship_studies (study_version, driver, shock, target, horizon_sessions, n, mean_pct, median_pct, win_rate_pct, wilson_lb95_pct, vol_pct, max_drawdown_pct, benchmark_mean_pct, benchmark_n, data_from, data_to, displayable, detail, experiment_run_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19)`,
        [STUDY_VERSION, r.driver, r.shock, r.target, r.horizon, r.n, r.meanPct, r.medianPct, r.winRatePct, r.wilsonLb95Pct, r.volPct, r.maxDrawdownPct, r.benchmarkMeanPct, r.benchmarkN, r.dataFrom, r.dataTo, r.displayable, JSON.stringify({ triggerDates: r.dates.slice(-40) }), runId]
      );
    }
    for (const s of sens) {
      await AppDataSource.query(
        `INSERT INTO global_relationship_studies (study_version, driver, shock, target, horizon_sessions, n, mean_pct, median_pct, win_rate_pct, wilson_lb95_pct, vol_pct, max_drawdown_pct, benchmark_mean_pct, benchmark_n, displayable, detail, experiment_run_id)
         VALUES ($1,$2,$3,$4,$5,$6,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,$7,$8::jsonb,$9)`,
        [STUDY_VERSION, s.driver, `SENSITIVITY:${s.window}d`, s.target, s.window, s.n, s.displayable, JSON.stringify({ correlation: s.correlation, beta: s.beta, note: s.note }), runId]
      );
    }
    return { studies: results.length, displayable: results.filter((r) => r.displayable).length, sensitivities: sens.length, experimentRunId: runId };
  }

  async latestStudies(): Promise<ShockStudyResult[]> {
    const rows: Array<Record<string, unknown>> = await AppDataSource.query(
      `SELECT DISTINCT ON (driver, shock, target, horizon_sessions) driver, shock, target, horizon_sessions, n, mean_pct, median_pct, win_rate_pct, wilson_lb95_pct, vol_pct, max_drawdown_pct, benchmark_mean_pct, benchmark_n, data_from::text, data_to::text, displayable
         FROM global_relationship_studies WHERE shock NOT LIKE 'SENSITIVITY:%' ORDER BY driver, shock, target, horizon_sessions, computed_at DESC`
    ).catch(() => []);
    const n = (v: unknown): number | null => (v == null ? null : Number(v));
    return rows.map((r) => ({ driver: String(r.driver), shock: String(r.shock), target: String(r.target), horizon: Number(r.horizon_sessions), n: Number(r.n), meanPct: n(r.mean_pct), medianPct: n(r.median_pct), winRatePct: n(r.win_rate_pct), wilsonLb95Pct: n(r.wilson_lb95_pct), volPct: n(r.vol_pct), maxDrawdownPct: n(r.max_drawdown_pct), benchmarkMeanPct: n(r.benchmark_mean_pct), benchmarkN: Number(r.benchmark_n ?? 0), displayable: r.displayable === true, dates: [], dataFrom: r.data_from ? String(r.data_from) : null, dataTo: r.data_to ? String(r.data_to) : null }));
  }

  async latestSensitivities(): Promise<SensitivityResult[]> {
    const rows: Array<Record<string, unknown>> = await AppDataSource.query(
      `SELECT DISTINCT ON (driver, target) driver, target, horizon_sessions, n, displayable, detail FROM global_relationship_studies WHERE shock LIKE 'SENSITIVITY:%' ORDER BY driver, target, computed_at DESC`
    ).catch(() => []);
    return rows.map((r) => {
      const d = (r.detail ?? {}) as Record<string, unknown>;
      return { driver: String(r.driver), target: String(r.target), n: Number(r.n), correlation: d.correlation != null ? Number(d.correlation) : null, beta: d.beta != null ? Number(d.beta) : null, displayable: r.displayable === true, window: Number(r.horizon_sessions), note: String(d.note ?? "") };
    });
  }

  /** Sector impact = active shocks × measured sector sensitivity (displayable only). */
  async sectorImpacts(active: Array<{ shock: ShockDefinition; change: number }>): Promise<SectorImpact[]> {
    const sens = await this.latestSensitivities();
    const out: SectorImpact[] = [];
    const sectors = [...INDIA_SECTOR_PROXIES.map((p) => ({ key: p.key, name: p.name })), { key: "NIFTYIT", name: "NIFTY IT" }, { key: "BANKNIFTY", name: "NIFTY Bank" }, { key: "NIFTYPHARMA", name: "NIFTY Pharma" }];
    for (const s of sectors) {
      const drivers = (SECTOR_DRIVERS[s.key] ?? []).map((dk) => {
        const m = sens.find((x) => x.driver === dk && x.target === s.key);
        const act = active.find((a) => a.shock.driver === dk);
        return { driver: dk, correlation: m?.displayable ? m.correlation : null, beta: m?.displayable ? m.beta : null, n: m?.n ?? 0, activeShock: act ? act.shock.label : null, direction: act ? act.shock.direction : null };
      });
      const reasons: string[] = [];
      let score = 0;
      for (const d of drivers) {
        if (!d.activeShock || d.beta == null || d.correlation == null || Math.abs(d.correlation) < 0.15) continue;
        const expected = d.beta * (d.direction === "UP" ? 1 : -1);
        score += expected;
        reasons.push(`${d.activeShock}: measured beta ${d.beta} (corr ${d.correlation}, n=${d.n}) → ${expected >= 0 ? "supportive" : "adverse"} for ${s.name}`);
      }
      if (!reasons.length) reasons.push(active.length ? "no active shock has a displayable measured sensitivity for this sector" : "no active global shock");
      out.push({ sector: s.key, name: s.name, label: score <= -1 ? "HEADWIND" : score >= 1 ? "TAILWIND" : "NEUTRAL", drivers, reasons });
    }
    return out;
  }

  /** Backfill daily regimes from history using only observations usable at each India close. */
  async backfillRegimeDays(days = 500): Promise<{ written: number }> {
    const nifty = await this.data.series(instrumentByKey("NIFTY")!, "5y");
    if (!nifty) return { written: 0 };
    const insts = GLOBAL_UNIVERSE.filter((i) => i.region !== "INDIA" && i.yahoo);
    // Precompute each bar's UTC close once; the per-day loop then only slices a sorted array.
    const barsBy = new Map<string, { bars: Awaited<ReturnType<GlobalMarketDataService["bars"]>>; closes: number[] }>();
    for (const i of insts) {
      const bars = await this.data.bars(i, "5y").catch(() => []);
      barsBy.set(i.key, { bars, closes: bars.map((b) => localToUtc(i.tz, b.date, i.localClose).getTime()) });
    }
    const sessions = nifty.points.slice(-days).map((p) => p.date);
    let written = 0;
    const values: unknown[] = [];
    const tuples: string[] = [];
    for (const d of sessions) {
      const cutoff = localToUtc(INDIA_TZ, d, "15:30");
      const cutoffMs = cutoff.getTime();
      const lite: ObsLite[] = [];
      for (const i of insts) {
        const entry = barsBy.get(i.key);
        if (!entry) continue;
        let hi = entry.closes.length;
        while (hi > 0 && entry.closes[hi - 1] > cutoffMs) hi -= 1;
        const bars = entry.bars.slice(0, hi);
        if (bars.length < 25) continue;
        const o = this.data.observationFromBars(i, bars.slice(-260), cutoff);
        if (o) lite.push({ key: o.instrument, assetClass: o.assetClass, region: o.region, sessionDate: o.sessionDate, price: o.price, ret1d: o.return1d, ret5d: o.return5d, ret20d: o.return20d, vol20: o.volatility20, isYield: o.isYield, chg5bps: o.chg5bps, chg20bps: o.chg20bps, freshness: "FRESH" });
      }
      if (lite.length < 8) continue;
      const r = classifyGlobalRegime(lite);
      const b = values.length;
      tuples.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4}::jsonb,$${b + 5}::jsonb,$${b + 6})`);
      values.push(d, r.regime, r.score, JSON.stringify(r.components.map((c) => ({ name: c.name, score: c.score, value: c.value }))), JSON.stringify(r.dataCoverage), cutoff);
      written += 1;
      if (tuples.length >= 100) await flush();
    }
    await flush();
    return { written };
    async function flush(): Promise<void> {
      if (!tuples.length) return;
      await AppDataSource.query(
        `INSERT INTO global_regime_days (india_session_date, regime, score, components, coverage, feature_cutoff_utc) VALUES ${tuples.join(",")}
         ON CONFLICT (india_session_date) DO UPDATE SET regime = EXCLUDED.regime, score = EXCLUDED.score, components = EXCLUDED.components, coverage = EXCLUDED.coverage, feature_cutoff_utc = EXCLUDED.feature_cutoff_utc, computed_at = now()`,
        values
      );
      tuples.length = 0;
      values.length = 0;
    }
  }

  /** Regime × forward NIFTY/sector returns × setup performance from the shadow ledger. */
  async regimeTrackRecord(): Promise<{ regimes: Array<{ regime: string; n: number; nifty: Record<string, { median: number | null; mean: number | null; winRatePct: number | null; n: number }>; sectors: Array<{ target: string; median5d: number | null; n: number }>; setups: Array<{ setupType: string; n: number; winRatePct: number | null; wilsonLb95Pct: number | null; expectancyR: number | null; withheld: boolean }> }>; unconditional5dMedian: number | null; caveat: string }> {
    const days: Array<{ d: string; regime: string }> = await AppDataSource.query(`SELECT india_session_date::text d, regime FROM global_regime_days ORDER BY 1`);
    const targets = await this.targetSeries();
    const byTarget = new Map(targets.map((t) => [t.key, t]));
    const nifty = byTarget.get("NIFTY");
    const idxOf = (t: DailySeries) => new Map(t.points.map((p, i) => [p.date, i]));
    const nIdx = nifty ? idxOf(nifty) : new Map<string, number>();
    const fwd = (t: DailySeries, idx: Map<string, number>, d: string, h: number) => {
      const i = idx.get(d);
      if (i == null || i + h >= t.points.length) return null;
      return ((t.points[i + h].value - t.points[i].value) / t.points[i].value) * 100;
    };
    const shadows: Array<{ anchor: string; setup: string; r: string | null }> = await AppDataSource.query(
      `SELECT anchor_date::text anchor, setup_type setup, (outcome->>'realizedNetR') r FROM short_term_shadow_predictions WHERE outcome IS NOT NULL AND (outcome->>'filled')::boolean IS TRUE AND outcome->>'realizedNetR' IS NOT NULL`
    ).catch(() => []);
    const regimeOf = new Map(days.map((x) => [x.d, x.regime]));
    const out: Array<{ regime: string; n: number; nifty: Record<string, { median: number | null; mean: number | null; winRatePct: number | null; n: number }>; sectors: Array<{ target: string; median5d: number | null; n: number }>; setups: Array<{ setupType: string; n: number; winRatePct: number | null; wilsonLb95Pct: number | null; expectancyR: number | null; withheld: boolean }> }> = [];
    for (const regime of ["RISK_ON", "NEUTRAL", "CAUTIOUS", "RISK_OFF", "STRESSED"]) {
      const ds = days.filter((x) => x.regime === regime).map((x) => x.d);
      const niftyStats: Record<string, { median: number | null; mean: number | null; winRatePct: number | null; n: number }> = {};
      for (const h of [1, 5, 10, 20]) {
        const rs = nifty ? ds.map((d) => fwd(nifty, nIdx, d, h)).filter((v): v is number => v != null) : [];
        const s = [...rs].sort((a, b) => a - b);
        niftyStats[`${h}d`] = { n: rs.length, median: rs.length >= 10 ? Math.round(s[s.length >> 1] * 100) / 100 : null, mean: rs.length >= 10 ? Math.round((rs.reduce((a, b) => a + b, 0) / rs.length) * 100) / 100 : null, winRatePct: rs.length >= 10 ? Math.round((rs.filter((v) => v > 0).length / rs.length) * 1000) / 10 : null };
      }
      const sectors = targets.filter((t) => t.key !== "NIFTY").map((t) => {
        const idx = idxOf(t);
        const rs = ds.map((d) => fwd(t, idx, d, 5)).filter((v): v is number => v != null);
        const s = [...rs].sort((a, b) => a - b);
        return { target: t.key, n: rs.length, median5d: rs.length >= 10 ? Math.round(s[s.length >> 1] * 100) / 100 : null };
      });
      const bySetup = new Map<string, number[]>();
      for (const sh of shadows) if (regimeOf.get(sh.anchor) === regime && sh.r != null) bySetup.set(sh.setup, [...(bySetup.get(sh.setup) ?? []), Number(sh.r)]);
      const setups = [...bySetup.entries()].map(([setupType, rs]) => {
        const wins = rs.filter((v) => v > 0).length;
        const enough = rs.length >= 10;
        return { setupType, n: rs.length, winRatePct: enough ? Math.round((wins / rs.length) * 1000) / 10 : null, wilsonLb95Pct: enough ? Math.round((wilsonLb95(wins, rs.length) ?? 0) * 1000) / 10 : null, expectancyR: enough ? Math.round((rs.reduce((a, b) => a + b, 0) / rs.length) * 100) / 100 : null, withheld: !enough };
      });
      out.push({ regime, n: ds.length, nifty: niftyStats, sectors, setups });
    }
    const allFwd = nifty ? days.map((x) => fwd(nifty, nIdx, x.d, 5)).filter((v): v is number => v != null).sort((a, b) => a - b) : [];
    const unconditional5dMedian = allFwd.length >= 20 ? Math.round(allFwd[allFwd.length >> 1] * 100) / 100 : null;
    return { regimes: out, unconditional5dMedian, caveat: "Regimes are classified point-in-time (only observations closed before each India close). Forward returns are NIFTY/sector proxies; setup rows come from the radar's shadow ledger (realized net R), withheld below 10. Evidence for model development, not a rule." };
  }

  async upcomingEvents(from: Date): Promise<GlobalSnapshotView["events"]> {
    const rows: Array<Record<string, unknown>> = await AppDataSource.query(`SELECT event, region, scheduled_at, importance, expected, actual FROM global_events WHERE scheduled_at >= ($1::timestamptz - interval '2 days') ORDER BY scheduled_at ASC LIMIT 20`, [from]).catch(() => []);
    return rows.map((r) => ({ event: String(r.event), region: String(r.region), scheduledAt: new Date(String(r.scheduled_at)).toISOString(), importance: String(r.importance), expected: r.expected ? String(r.expected) : null, actual: r.actual ? String(r.actual) : null }));
  }

  /** Measurable global drivers for one company's NSE industry. */
  async companyContext(industry: string | null): Promise<{ globalRegime: string | null; indiaRegime: string | null; transmission: Transmission | null; sector: SectorImpact | null; statements: Array<{ text: string; evidence: string }> }> {
    const snap = await this.latest();
    if (!snap) return { globalRegime: null, indiaRegime: null, transmission: null, sector: null, statements: [{ text: "No global snapshot yet.", evidence: "none" }] };
    const proxy = INDIA_SECTOR_PROXIES.find((p) => industry && p.industries.includes(industry));
    const sector = snap.sectors.find((s) => s.sector === proxy?.key) ?? null;
    const statements: Array<{ text: string; evidence: string }> = [];
    statements.push({ text: `Global regime ${snap.regime.regime.replace(/_/g, " ").toLowerCase()} (component score ${snap.regime.score}); India regime ${snap.india.regime ?? "unknown"}; transmission ${snap.transmission.label.toLowerCase()}.`, evidence: snap.regime.reasons[0] });
    if (sector) {
      for (const d of sector.drivers) {
        if (d.activeShock && d.beta != null && d.correlation != null) statements.push({ text: `${d.activeShock} is currently a ${d.beta * (d.direction === "UP" ? 1 : -1) < 0 ? "headwind" : "tailwind"} for ${sector.name}.`, evidence: `measured 5-session beta ${d.beta}, correlation ${d.correlation}, n=${d.n}` });
        else if (d.beta != null && d.correlation != null) statements.push({ text: `${sector.name} has a measured sensitivity to ${d.driver} (beta ${d.beta}, corr ${d.correlation}); no shock is active now.`, evidence: `n=${d.n} non-overlapping 5-session blocks` });
        else statements.push({ text: `${sector.name} vs ${d.driver}: not enough overlapping history to state a sensitivity.`, evidence: `n=${d.n}` });
      }
    } else statements.push({ text: "No sector proxy for this industry; only the global and India regimes apply.", evidence: industry ?? "industry unknown" });
    return { globalRegime: snap.regime.regime, indiaRegime: snap.india.regime, transmission: snap.transmission.label, sector, statements };
  }
}

export const globalIntelligenceService = new GlobalIntelligenceService();
