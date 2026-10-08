/**
 * UniverseIngestionService — discovers securities from the exchange provider,
 * upserts the security master idempotently (never duplicates: symbol is the
 * key), records every detected change in the append-only change log, and
 * classifies liquidity / activity / tradability from the delivery feed.
 *
 * Jobs: syncSecurityUniverse (full), syncNewListings, syncSymbolChanges,
 * syncCompanyChanges, classifyLiquidity. Each writes a universe_sync_runs row
 * with source, counts and freshness.
 */

import { AppDataSource } from "../../config/database";
import { SecurityMaster, SecurityMasterChange, UniverseSyncRun } from "../../entities";
import { SecurityMasterProvider, SecurityMasterSnapshot } from "./providers/interfaces";
import { nseSecurityMasterProvider } from "./providers/NseSecurityMasterProvider";
import {
  classifyInstrumentType,
  dedupeListings,
  diffMaster,
  industryIndexMap,
  isActiveByTrade,
  isTradable,
  InstrumentType,
  LiquidityTier,
  LIQUIDITY_TIERS,
  liquidityTierOf,
  marketCapBucketFromIndices,
  marketCapBucketFromValue,
  MasterRowInput,
} from "./universeClassification";

const todayIst = (): string => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

export class UniverseIngestionService {
  constructor(private readonly provider: SecurityMasterProvider = nseSecurityMasterProvider) {}

  private async startRun(job: string, source: string): Promise<UniverseSyncRun> {
    const repo = AppDataSource.getRepository(UniverseSyncRun);
    return repo.save(repo.create({ job, source, status: "running", counts: {} }));
  }
  private async finishRun(run: UniverseSyncRun, counts: Record<string, unknown>, error?: unknown): Promise<void> {
    run.finishedAt = new Date();
    run.status = error ? "failed" : "success";
    run.counts = counts;
    run.error = error ? (error instanceof Error ? error.message : String(error)).slice(0, 4000) : null;
    await AppDataSource.getRepository(UniverseSyncRun).save(run);
  }

  /** Full discovery + upsert + change detection + classification. Idempotent. */
  async syncSecurityUniverse(): Promise<Record<string, unknown>> {
    const run = await this.startRun("syncSecurityUniverse", this.provider.name);
    try {
      const snap = await this.provider.fetchSnapshot();
      const counts = await this.applySnapshot(snap, run.id);
      const liq = await this.classifyLiquidity(run.id);
      const all = { ...counts, ...liq, providerErrors: snap.errors, fetchedAt: snap.fetchedAt };
      await this.finishRun(run, all);
      return all;
    } catch (err) {
      await this.finishRun(run, {}, err);
      throw err;
    }
  }

  /** Seed from the local nse_securities table when the exchange is unreachable (no network needed). */
  async seedFromLocalTables(): Promise<Record<string, unknown>> {
    const run = await this.startRun("seedFromLocalTables", "nse_securities+nse_delivery");
    try {
      const rows: Array<{ symbol: string; company_name: string; isin: string | null; listing_date: string | null; industry: string | null; indices: string[] | null; instrument_type: string }> = await AppDataSource.query(
        `SELECT symbol, company_name, isin, listing_date::text, industry, indices, instrument_type FROM nse_securities`
      );
      const snap: SecurityMasterSnapshot = {
        source: "nse_securities(local)",
        fetchedAt: new Date().toISOString(),
        listings: rows.map((r) => ({ symbol: r.symbol, companyName: r.company_name, series: r.instrument_type === "ETF" ? null : "EQ", isin: r.isin, listedDate: r.listing_date, faceValue: null, listSource: r.instrument_type === "ETF" ? "ETF" : "EQUITY_L" })),
        symbolChanges: [],
        nameChanges: [],
        indexMemberships: rows.flatMap((r) => (r.indices ?? []).map((ix) => ({ symbol: r.symbol, index: ix, industry: r.industry }))),
        errors: [],
      };
      const counts = await this.applySnapshot(snap, run.id);
      const liq = await this.classifyLiquidity(run.id);
      await this.finishRun(run, { ...counts, ...liq });
      return { ...counts, ...liq };
    } catch (err) {
      await this.finishRun(run, {}, err);
      throw err;
    }
  }

  private async applySnapshot(snap: SecurityMasterSnapshot, runId: string): Promise<Record<string, unknown>> {
    const repo = AppDataSource.getRepository(SecurityMaster);
    const listings = dedupeListings(snap.listings);
    const { industry, indices } = industryIndexMap(snap.indexMemberships);
    const existing = await repo.find();
    const stored = new Map<string, MasterRowInput>(existing.map((e) => [e.symbol, { symbol: e.symbol, companyName: e.companyName, isin: e.isin, series: e.series, instrumentType: e.instrumentType as InstrumentType, listedDate: e.listedDate, isActive: e.isActive }]));
    const fresh: MasterRowInput[] = listings.map((l) => ({ symbol: l.symbol, companyName: l.companyName, isin: l.isin, series: l.series, instrumentType: classifyInstrumentType(l), listedDate: l.listedDate, isActive: true }));
    const changes = diffMaster(stored, fresh);
    const today = todayIst();
    const now = new Date();
    // Upsert in chunks (ON CONFLICT (symbol)) — idempotent, never duplicates.
    let upserted = 0;
    for (let i = 0; i < fresh.length; i += 200) {
      const chunk = fresh.slice(i, i + 200);
      const values: unknown[] = [];
      const tuples: string[] = [];
      chunk.forEach((f, k) => {
        const ix = indices.get(f.symbol) ?? [];
        const cap = marketCapBucketFromIndices(ix);
        const base = k * 13;
        tuples.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12},$${base + 13})`);
        values.push(f.symbol.slice(0, 40), `${f.symbol}.NS`.slice(0, 50), f.companyName.slice(0, 200), f.isin && /^[A-Z0-9]{12}$/.test(f.isin) ? f.isin : null, f.series ? f.series.slice(0, 4) : null, f.instrumentType, (industry.get(f.symbol) ?? null)?.slice(0, 120) ?? null, f.listedDate, cap.bucket, cap.source, ix, snap.source.slice(0, 40), now);
      });
      await AppDataSource.query(
        `INSERT INTO security_master (symbol, yahoo_ticker, company_name, isin, series, instrument_type, industry, listed_date, market_cap_bucket, market_cap_source, indices, source, source_freshness_at)
         VALUES ${tuples.join(",")}
         ON CONFLICT (symbol) DO UPDATE SET
           company_name = EXCLUDED.company_name, isin = COALESCE(EXCLUDED.isin, security_master.isin), series = COALESCE(EXCLUDED.series, security_master.series),
           instrument_type = EXCLUDED.instrument_type, industry = COALESCE(EXCLUDED.industry, security_master.industry), listed_date = COALESCE(EXCLUDED.listed_date, security_master.listed_date),
           market_cap_bucket = CASE WHEN security_master.market_cap_source LIKE 'value:%' THEN security_master.market_cap_bucket ELSE EXCLUDED.market_cap_bucket END,
           market_cap_source = CASE WHEN security_master.market_cap_source LIKE 'value:%' THEN security_master.market_cap_source ELSE EXCLUDED.market_cap_source END,
           indices = EXCLUDED.indices, source = EXCLUDED.source, source_freshness_at = EXCLUDED.source_freshness_at, updated_at = now()`,
        values
      );
      upserted += chunk.length;
    }
    // Symbol changes: record, and mark the old symbol inactive if it still exists.
    let symbolChanges = 0;
    for (const sc of snap.symbolChanges) {
      if (!stored.has(sc.oldSymbol) && !fresh.some((f) => f.symbol === sc.newSymbol)) continue;
      changes.push({ symbol: sc.newSymbol, changeType: "SYMBOL_CHANGE", oldValue: sc.oldSymbol, newValue: sc.newSymbol });
      symbolChanges += 1;
      if (stored.has(sc.oldSymbol) && !fresh.some((f) => f.symbol === sc.oldSymbol)) {
        await AppDataSource.query(`UPDATE security_master SET is_active = false, is_tradable = false, data_status = 'NONE', updated_at = now() WHERE symbol = $1`, [sc.oldSymbol]);
        changes.push({ symbol: sc.oldSymbol, changeType: "DEACTIVATED", oldValue: "true", newValue: `renamed to ${sc.newSymbol}` });
      }
    }
    for (const nc of snap.nameChanges) {
      const s = stored.get(nc.symbol);
      if (s && nc.effectiveDate && nc.effectiveDate >= today) changes.push({ symbol: nc.symbol, changeType: "NAME_CHANGE", oldValue: nc.oldName, newValue: nc.newName });
    }
    const chRepo = AppDataSource.getRepository(SecurityMasterChange);
    let recorded = 0;
    for (const c of changes) {
      try {
        await chRepo.insert({ symbol: c.symbol, changeType: c.changeType, oldValue: c.oldValue, newValue: c.newValue, source: snap.source, observedAt: today, syncRunId: runId });
        recorded += 1;
      } catch {
        /* unique (symbol, type, date, value) — already recorded today */
      }
    }
    return {
      discovered: listings.length,
      upserted,
      newListings: changes.filter((c) => c.changeType === "NEW_LISTING").length,
      nameChanges: changes.filter((c) => c.changeType === "NAME_CHANGE").length,
      symbolChanges,
      changesRecorded: recorded,
      byType: countBy(fresh.map((f) => f.instrumentType)),
    };
  }

  /** Liquidity tier, activity, surveillance, tradability — from nse_delivery and stock_knowledge. */
  async classifyLiquidity(runId?: string): Promise<Record<string, unknown>> {
    const sessions: Array<{ d: string }> = await AppDataSource.query(
      `SELECT DISTINCT trade_date::text AS d FROM nse_delivery WHERE trade_date >= (SELECT MAX(trade_date) FROM nse_delivery) - 60 ORDER BY d DESC`
    );
    const sessionDates = sessions.map((s) => s.d).reverse();
    const latest = sessionDates[sessionDates.length - 1] ?? null;
    const window = sessionDates.slice(-LIQUIDITY_TIERS.windowSessions);
    const liq: Array<{ symbol: string; med: string; last: string; series: string }> = await AppDataSource.query(
      `SELECT symbol,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY turnover_lacs * 1e5)::text AS med,
              MAX(trade_date)::text AS last,
              (array_agg(series ORDER BY trade_date DESC))[1] AS series
         FROM nse_delivery WHERE trade_date >= $1 GROUP BY symbol`,
      [window[0] ?? latest]
    );
    const surv: Array<{ symbol: string; list: string }> = await AppDataSource.query(
      `SELECT DISTINCT ON (symbol) symbol, detail->>'list' AS list FROM stock_knowledge
        WHERE kind = 'SURVEILLANCE' AND observed_at = (SELECT MAX(observed_at) FROM stock_knowledge WHERE kind = 'SURVEILLANCE')
        ORDER BY symbol, observed_at DESC`
    );
    const survBy = new Map(surv.map((s) => [s.symbol, s.list]));
    const master: Array<{ symbol: string; instrument_type: string; series: string | null; market_cap_inr: string | null }> = await AppDataSource.query(
      `SELECT symbol, instrument_type, series, market_cap_inr FROM security_master`
    );
    const liqBy = new Map(liq.map((l) => [l.symbol, l]));
    const tiers: Record<string, number> = { A: 0, B: 0, C: 0, X: 0 };
    let active = 0;
    let tradable = 0;
    let deactivated = 0;
    const prevActive: Array<{ symbol: string; is_active: boolean }> = await AppDataSource.query(`SELECT symbol, is_active FROM security_master`);
    const prevBy = new Map(prevActive.map((p) => [p.symbol, p.is_active]));
    const today = todayIst();
    const chRepo = AppDataSource.getRepository(SecurityMasterChange);
    for (let i = 0; i < master.length; i += 500) {
      const chunk = master.slice(i, i + 500);
      const stmts: Promise<unknown>[] = [];
      for (const m of chunk) {
        const l = liqBy.get(m.symbol);
        const med = l ? Number(l.med) : null;
        const tier: LiquidityTier = liquidityTierOf(med);
        // The delivery feed is EQ-series only: SME instruments trade in SM/ST and are judged by listing, not by this feed.
        const feedCovers = m.instrument_type !== "SME";
        const isActive = feedCovers ? isActiveByTrade(l?.last ?? null, latest, sessionDates) : true;
        const s = survBy.get(m.symbol) ?? null;
        const series = l?.series ?? m.series;
        const tradableNow = isTradable({ instrumentType: m.instrument_type as InstrumentType, series, liquidityTier: tier, isActive, surveillance: s });
        tiers[tier] += 1;
        if (isActive) active += 1;
        if (tradableNow) tradable += 1;
        const capValue = m.market_cap_inr != null ? Number(m.market_cap_inr) : null;
        const capSql = capValue != null ? `, market_cap_bucket = '${marketCapBucketFromValue(capValue)}', market_cap_source = 'value:stored'` : "";
        stmts.push(
          AppDataSource.query(
            `UPDATE security_master SET liquidity_tier = $2, liquidity_median_value_inr = $3, liquidity_as_of = $4, last_trade_date = $5, is_active = $6, is_tradable = $7, surveillance = $8, series = COALESCE($9, series), updated_at = now()${capSql} WHERE symbol = $1`,
            [m.symbol, tier, med, latest, l?.last ?? null, isActive, tradableNow, s, series]
          )
        );
        if (prevBy.get(m.symbol) === true && !isActive) {
          deactivated += 1;
          stmts.push(chRepo.insert({ symbol: m.symbol, changeType: "DEACTIVATED", oldValue: "true", newValue: `no EQ trade in ${LIQUIDITY_TIERS.inactiveAfterSessions} sessions (last ${l?.last ?? "never"})`, source: "nse_delivery", observedAt: today, syncRunId: runId ?? null }).catch(() => undefined));
        }
      }
      await Promise.all(stmts);
    }
    return { liquidityAsOf: latest, tiers, active, tradable, deactivated, surveillance: surv.length };
  }

  async syncNewListings(): Promise<Record<string, unknown>> {
    const r = await this.syncSecurityUniverse();
    return { newListings: r.newListings, discovered: r.discovered };
  }
  async syncSymbolChanges(): Promise<Record<string, unknown>> {
    const r = await this.syncSecurityUniverse();
    return { symbolChanges: r.symbolChanges };
  }
  async syncCompanyChanges(): Promise<Record<string, unknown>> {
    const r = await this.syncSecurityUniverse();
    return { nameChanges: r.nameChanges };
  }

  providerHealth() {
    return this.provider.health();
  }
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

export const universeIngestionService = new UniverseIngestionService();
