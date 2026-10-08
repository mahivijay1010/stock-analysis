/**
 * ResearchQueueService — rebuilds the prioritised research work list from the
 * latest broad scan, watchlist and knowledge facts, and drains it: builds the
 * structured profile for the top-N, optionally runs the AI research layer
 * (budgeted), and records what happened. Deep research is never run for every
 * stock; the queue is the budget.
 */

import { AppDataSource } from "../../config/database";
import { ResearchQueueItem } from "../../entities";
import { companyResearchProfileService } from "./CompanyResearchProfileService";
import { aiResearchService } from "./AiResearchService";
import { PriorityInput, researchPriority } from "./researchPriority";

export class ResearchQueueService {
  async rebuild(): Promise<{ queued: number; fromScan: number; fromWatchlist: number }> {
    const [scan] = (await AppDataSource.query(`SELECT id, regime FROM opportunity_scans WHERE status='success' ORDER BY started_at DESC LIMIT 1`)) as Array<{ id: string; regime: string | null }>;
    const cands: Array<Record<string, unknown>> = scan
      ? await AppDataSource.query(`SELECT symbol, signals, technical_score, liquidity_tier, stage_reached, setup_type FROM opportunity_candidates WHERE scan_id = $1 AND stage_reached NOT IN ('UNIVERSE','DATA_VALIDATION','LIQUIDITY')`, [scan.id])
      : [];
    const watch: Array<{ symbol: string }> = await AppDataSource.query(`SELECT DISTINCT regexp_replace(i.yahoo_ticker, '\\.NS$', '') AS symbol FROM watchlist_items w JOIN instruments i ON i.id = w.instrument_id`);
    const watchSet = new Set(watch.map((w) => w.symbol));
    const symbols = [...new Set([...cands.map((c) => String(c.symbol)), ...watchSet])];
    if (!symbols.length) return { queued: 0, fromScan: 0, fromWatchlist: 0 };
    const facts: Array<{ symbol: string; n: string; major: boolean; results: boolean; ca: boolean }> = await AppDataSource.query(
      `SELECT symbol, COUNT(*)::text n, BOOL_OR(detail->>'materiality' = 'HIGH') major, BOOL_OR(kind IN ('RESULTS','GUIDANCE')) results, BOOL_OR(kind = 'CORPORATE_ACTION') ca
         FROM stock_knowledge WHERE symbol = ANY($1) AND kind <> 'SURVEILLANCE' AND observed_at >= CURRENT_DATE - 30 GROUP BY symbol`,
      [symbols]
    );
    const fb = new Map(facts.map((f) => [f.symbol, f]));
    const calendar: Array<{ symbol: string }> = await AppDataSource.query(
      `SELECT DISTINCT regexp_replace(ticker, '\\.NS$', '') AS symbol FROM structured_market_events
        WHERE event_type = 'results_calendar' AND event_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7`
    ).catch(() => []);
    const resultsSoon = new Set(calendar.map((c) => c.symbol));
    const lastResearch: Array<{ symbol: string; d: string }> = await AppDataSource.query(`SELECT symbol, MAX(built_at)::text d FROM company_research_profiles WHERE symbol = ANY($1) GROUP BY symbol`, [symbols]);
    const lr = new Map(lastResearch.map((x) => [x.symbol, x.d]));
    const evidenceSetups: Array<{ setup_type: string }> = await AppDataSource.query(
      `SELECT DISTINCT c->>'setupType' AS setup_type FROM short_term_model_performance p, jsonb_array_elements(p.metrics->'cells') c WHERE p.model_name='st-setup-expectancy' AND c->>'evidenceStrength' IN ('A','B')`
    ).catch(() => []);
    const evSet = new Set(evidenceSetups.map((e) => e.setup_type));
    const byCand = new Map(cands.map((c) => [String(c.symbol), c]));
    const repo = AppDataSource.getRepository(ResearchQueueItem);
    let queued = 0, fromScan = 0, fromWatchlist = 0;
    for (const symbol of symbols) {
      const c = byCand.get(symbol);
      const f = fb.get(symbol);
      const input: PriorityInput = {
        symbol,
        signals: (c?.signals as string[]) ?? [],
        technicalScore: c?.technical_score != null ? Number(c.technical_score) : null,
        liquidityTier: String(c?.liquidity_tier ?? "X"),
        stageReached: String(c?.stage_reached ?? "WATCHLIST"),
        newsFacts30d: f ? Number(f.n) : 0,
        majorNews: f?.major === true,
        resultsDue: f?.results === true || resultsSoon.has(symbol),
        corporateAction: f?.ca === true,
        onWatchlist: watchSet.has(symbol),
        regime: scan?.regime ?? null,
        setupType: c?.setup_type ? String(c.setup_type) : null,
        setupHasEvidence: c?.setup_type ? evSet.has(String(c.setup_type)) : false,
        lastResearchedDaysAgo: lr.has(symbol) ? Math.floor((Date.now() - new Date(lr.get(symbol) as string).getTime()) / 86_400_000) : null,
      };
      const pr = researchPriority(input);
      const source = watchSet.has(symbol) ? "WATCHLIST" : "SCAN";
      await AppDataSource.query(
        `INSERT INTO research_queue (symbol, priority, reasons, source, status) VALUES ($1,$2,$3,$4,'PENDING')
         ON CONFLICT (symbol) WHERE status = 'PENDING' DO UPDATE SET priority = EXCLUDED.priority, reasons = EXCLUDED.reasons, source = EXCLUDED.source, queued_at = now()`,
        [symbol, pr.priority, JSON.stringify(pr.reasons), source]
      );
      queued += 1;
      if (source === "SCAN") fromScan += 1;
      else fromWatchlist += 1;
    }
    void repo;
    return { queued, fromScan, fromWatchlist };
  }

  /** Research the top-N pending items: structured profile always; AI layer only within budget. */
  async drain(opts: { limit?: number; ai?: boolean; aiLimit?: number } = {}): Promise<{ researched: number; aiRuns: number; failed: number; items: Array<{ symbol: string; priority: number; profileId: string | null; ai: boolean; error?: string }> }> {
    const limit = opts.limit ?? Number(process.env.RESEARCH_QUEUE_DRAIN ?? 25);
    const aiLimit = opts.aiLimit ?? Number(process.env.RESEARCH_AI_PER_RUN ?? 8);
    const pending: ResearchQueueItem[] = await AppDataSource.getRepository(ResearchQueueItem).find({ where: { status: "PENDING" }, order: { priority: "DESC" }, take: limit });
    const out = { researched: 0, aiRuns: 0, failed: 0, items: [] as Array<{ symbol: string; priority: number; profileId: string | null; ai: boolean; error?: string }> };
    for (const item of pending) {
      try {
        const built = await companyResearchProfileService.build(item.symbol, { persist: true });
        let ai = false;
        if (opts.ai !== false && out.aiRuns < aiLimit && built.evidence.length >= 3) {
          const r = await aiResearchService.research(item.symbol, built).catch(() => null);
          if (r) {
            ai = true;
            out.aiRuns += 1;
          }
        }
        await AppDataSource.query(`UPDATE research_queue SET status='RESEARCHED', researched_at=now(), profile_id=$2 WHERE id=$1`, [item.id, built.profileId]);
        out.researched += 1;
        out.items.push({ symbol: item.symbol, priority: Number(item.priority), profileId: built.profileId, ai });
      } catch (err) {
        out.failed += 1;
        await AppDataSource.query(`UPDATE research_queue SET status='FAILED', error=$2 WHERE id=$1`, [item.id, (err instanceof Error ? err.message : String(err)).slice(0, 2000)]);
        out.items.push({ symbol: item.symbol, priority: Number(item.priority), profileId: null, ai: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return out;
  }

  async list(limit = 50): Promise<Array<{ symbol: string; priority: number; reasons: string[]; source: string; status: string; queuedAt: string; researchedAt: string | null; profileId: string | null }>> {
    const rows: ResearchQueueItem[] = await AppDataSource.getRepository(ResearchQueueItem).find({ order: { status: "ASC", priority: "DESC" }, take: limit });
    return rows.map((r) => ({ symbol: r.symbol, priority: Number(r.priority), reasons: r.reasons, source: r.source, status: r.status, queuedAt: new Date(r.queuedAt).toISOString(), researchedAt: r.researchedAt ? new Date(r.researchedAt).toISOString() : null, profileId: r.profileId }));
  }
}

export const researchQueueService = new ResearchQueueService();
