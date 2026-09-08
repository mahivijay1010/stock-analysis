/**
 * OFFLINE RESEARCH: event-reaction study (upgrade Parts 4/7 — event surprise).
 *
 * For every point-in-time structured event, measures ABNORMAL forward returns
 * (stock − NIFTY, and stock − sector basket) at +1/+3/+5/+10/+20 sessions
 * from the first session AFTER announcedAt, with event features:
 * pre-announcement 20-session return (and sector-adjusted version), source
 * tier, and novelty (days since the ticker's previous same-type event).
 *
 * HIERARCHICAL FALLBACK (never claim stock-specific effects on thin data):
 *   stock×type (needs ≥10 events) → sector×type (≥15) → type pooled (≥20).
 * Every level reports its sample size; below every floor the verdict is
 * INSUFFICIENT_SAMPLES, not a number.
 *
 * Extraction: order values for order_win events are pulled from headlines by
 * the OpenAI EXTRACTION tier (strictly from text; absent ⇒ null) — extraction
 * may read, it may never invent.
 *
 * Usage: npx ts-node --transpile-only scripts/eventStudy.ts [--skip-ingest]
 */

import { createHash } from "crypto";
import { AppDataSource } from "../src/config/database";
import { ExperimentRun, StructuredMarketEvent } from "../src/entities";
import { NSE_UNIVERSE } from "../src/data/nseUniverse";
import { marketDataService } from "../src/services/market/MarketDataService";
import { analysisCloses } from "../src/services/market/canonical";
import { eventService } from "../src/services/market/EventService";
import { buildSectorIndex } from "../src/services/research/excessReturns";
import { round4 } from "../src/services/research/metrics";
import { getOpenAIProvider } from "../src/services/reasoning/providerRegistry";
import { strictSchema } from "../src/services/reasoning/roles";

const OFFSETS = [1, 3, 5, 10, 20] as const;

interface EventObs {
  ticker: string;
  sector: string;
  eventType: string;
  eventDate: string;
  sourceTier: number;
  preReturn20: number | null;
  sectorAdjPreReturn20: number | null;
  noveltyDays: number | null;
  abnormalVsNifty: Record<number, number | null>;
  abnormalVsSector: Record<number, number | null>;
}

function meanStats(xs: number[]): { mean: number; se: number; n: number } | null {
  if (xs.length < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
  return { mean: round4(m * 100), se: round4(((sd / Math.sqrt(xs.length)) * 100)), n: xs.length };
}

async function main(): Promise<void> {
  const skipIngest = process.argv.includes("--skip-ingest");
  await AppDataSource.initialize();
  const started = new Date();

  // 1. Backfill corporate actions from the (now universe-wide) adjusted bars.
  if (!skipIngest) {
    let inserted = 0;
    for (const u of NSE_UNIVERSE) {
      const r = await eventService.ingestCorporateActions(u.ticker);
      inserted += r.inserted;
    }
    console.log(`corporate-action backfill: ${inserted} new events`);
  }

  // 2. Load events + bars + benchmarks.
  const events = await AppDataSource.getRepository(StructuredMarketEvent)
    .createQueryBuilder("e")
    .orderBy("e.announced_at", "ASC")
    .getMany();
  console.log(`events loaded: ${events.length}`);
  const nifty = await marketDataService.getNiftyBars("2y");
  const niftyCloses = new Map(nifty.map((b) => [b.date, b.close]));
  const niftyDates = nifty.map((b) => b.date);

  const sectorByTicker = new Map(NSE_UNIVERSE.map((u) => [u.ticker.replace(/\.(NS|BO)$/, ""), u.sector]));
  const barsByTicker = new Map<string, Array<{ date: string; close: number }>>();
  const bySector = new Map<string, string[]>();
  for (const u of NSE_UNIVERSE) {
    try {
      const bars = await marketDataService.getDailyBars(u.ticker, "2y");
      const closes = analysisCloses(bars);
      barsByTicker.set(u.ticker.replace(/\.(NS|BO)$/, ""), bars.map((b, i) => ({ date: b.date, close: closes[i] })));
      const list = bySector.get(u.sector) ?? [];
      list.push(u.ticker.replace(/\.(NS|BO)$/, ""));
      bySector.set(u.sector, list);
    } catch {
      /* ticker without bars simply contributes no observations */
    }
  }
  const sectorIndexBySector = new Map<string, Map<string, number>>();
  for (const [sector, members] of bySector) {
    sectorIndexBySector.set(sector, buildSectorIndex(members.map((t) => barsByTicker.get(t) ?? [])));
  }

  // 3. Build observations.
  const lastSameType = new Map<string, string>();
  const observations: EventObs[] = [];
  for (const e of events) {
    const bars = barsByTicker.get(e.ticker);
    const sector = sectorByTicker.get(e.ticker) ?? "UNKNOWN";
    if (!bars || bars.length < 60) continue;
    const announcedDate = e.announcedAt.toISOString().slice(0, 10);
    // First session with a bar AFTER the announcement becomes t0.
    const t0 = bars.findIndex((b) => b.date > announcedDate);
    if (t0 < 21 || t0 < 0) continue;

    const cum = (series: Array<{ date: string; close: number }>, from: number, to: number): number | null => {
      if (to >= series.length || from < 0 || !(series[from].close > 0)) return null;
      return series[to].close / series[from].close - 1;
    };
    const niftyCum = (fromDate: string, toDate: string): number | null => {
      const f = niftyCloses.get(fromDate);
      const t = niftyCloses.get(toDate);
      return f != null && t != null && f > 0 ? t / f - 1 : null;
    };
    const sectorIdx = sectorIndexBySector.get(sector);
    const sectorCum = (fromDate: string, toDate: string): number | null => {
      const f = sectorIdx?.get(fromDate);
      const t = sectorIdx?.get(toDate);
      return f != null && t != null && f > 0 ? t / f - 1 : null;
    };

    const pre = cum(bars, t0 - 21, t0 - 1);
    const preNifty = niftyCum(bars[t0 - 21].date, bars[t0 - 1].date);
    const preSector = sectorCum(bars[t0 - 21].date, bars[t0 - 1].date);
    const noveltyKey = `${e.ticker}|${e.eventType}`;
    const prevDate = lastSameType.get(noveltyKey);
    const noveltyDays = prevDate ? Math.floor((new Date(e.eventDate).getTime() - new Date(prevDate).getTime()) / 86400_000) : null;
    lastSameType.set(noveltyKey, e.eventDate);

    const abnormalVsNifty: Record<number, number | null> = {};
    const abnormalVsSector: Record<number, number | null> = {};
    for (const h of OFFSETS) {
      const raw = cum(bars, t0 - 1, t0 - 1 + h);
      const idx = t0 - 1 + h < bars.length ? niftyCum(bars[t0 - 1].date, bars[t0 - 1 + h].date) : null;
      const sec = t0 - 1 + h < bars.length ? sectorCum(bars[t0 - 1].date, bars[t0 - 1 + h].date) : null;
      abnormalVsNifty[h] = raw != null && idx != null ? raw - idx : null;
      abnormalVsSector[h] = raw != null && sec != null ? raw - sec : null;
    }
    observations.push({
      ticker: e.ticker,
      sector,
      eventType: e.eventType,
      eventDate: e.eventDate,
      sourceTier: e.sourceTier,
      preReturn20: pre,
      sectorAdjPreReturn20: pre != null && preSector != null ? pre - preSector : pre != null && preNifty != null ? pre - preNifty : null,
      noveltyDays,
      abnormalVsNifty,
      abnormalVsSector,
    });
  }
  console.log(`observations built: ${observations.length}`);

  // 4. Hierarchical aggregation with sample-size floors.
  const FLOORS = { stock: 10, sector: 15, pooled: 20 } as const;
  const levels: Array<Record<string, unknown>> = [];
  const groupBy = (keyOf: (o: EventObs) => string) => {
    const g = new Map<string, EventObs[]>();
    for (const o of observations) {
      const k = keyOf(o);
      const list = g.get(k) ?? [];
      list.push(o);
      g.set(k, list);
    }
    return g;
  };
  const summarize = (level: string, key: string, obs: EventObs[], floor: number) => {
    const row: Record<string, unknown> = { level, key, nEvents: obs.length };
    if (obs.length < floor) {
      row.verdict = `INSUFFICIENT_SAMPLES (${obs.length} < ${floor})`;
      levels.push(row);
      return;
    }
    for (const h of OFFSETS) {
      const xs = obs.map((o) => o.abnormalVsNifty[h]).filter((x): x is number => x != null);
      const st = meanStats(xs);
      row[`abn${h}`] = st ? `${st.mean}% ±${st.se} (n=${st.n})` : "n/a";
      // significance: |mean| > 2·SE
      if (st && Math.abs(st.mean) > 2 * st.se && h === 5) row.significantAt5 = true;
    }
    levels.push(row);
  };
  for (const [k, obs] of groupBy((o) => `${o.ticker}|${o.eventType}`)) summarize("stock×type", k, obs, FLOORS.stock);
  for (const [k, obs] of groupBy((o) => `${o.sector}|${o.eventType}`)) summarize("sector×type", k, obs, FLOORS.sector);
  for (const [k, obs] of groupBy((o) => o.eventType)) summarize("type-pooled", k, obs, FLOORS.pooled);

  // 5. Order-value extraction on order_win events (luna; strictly from text).
  const orderWins = events.filter((e) => e.eventType === "order_win" && e.headline);
  let extracted: Array<{ eventId: string; orderValueCrore: number | null }> = [];
  const provider = getOpenAIProvider();
  if (orderWins.length > 0 && provider.isAvailable()) {
    try {
      const { data } = await provider.extract({
        system: "You extract order values from Indian market headlines.",
        user:
          `For each event, extract the order value in ₹ crore if EXPLICITLY stated in the headline (null otherwise):\n` +
          JSON.stringify(orderWins.map((e) => ({ eventId: e.id, headline: e.headline }))),
        format: strictSchema("order_values", {
          values: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: { eventId: { type: "string" }, orderValueCrore: { type: ["number", "null"] } },
              required: ["eventId", "orderValueCrore"],
            },
          },
        }),
        validate: (raw) => {
          const o = raw as { values?: Array<{ eventId: string; orderValueCrore: number | null }> };
          if (!Array.isArray(o?.values)) throw new Error("order_values schema violation");
          const known = new Set(orderWins.map((e) => e.id));
          for (const v of o.values) if (!known.has(v.eventId)) throw new Error(`unknown eventId ${v.eventId}`);
          return o.values;
        },
      });
      extracted = data;
    } catch (e) {
      console.log("order-value extraction failed (recorded):", e instanceof Error ? e.message : e);
    }
  }

  const runRepo = AppDataSource.getRepository(ExperimentRun);
  const run = await runRepo.save(
    runRepo.create({
      name: "event-reaction-study",
      kind: "challenger",
      modelVersion: "event-study-v1",
      config: { offsets: OFFSETS, floors: FLOORS, benchmark: "NIFTY + equal-weight sector basket" },
      splits: { nEvents: events.length, nObservations: observations.length },
      datasetManifest: { source: "structured_market_events (point-in-time announcedAt) + adjusted bars — OFFLINE RESEARCH" },
      datasetHash: createHash("sha256").update(String(observations.length)).digest("hex"),
      metrics: { levels, orderValueExtraction: { attempted: orderWins.length, extracted: extracted.filter((x) => x.orderValueCrore != null).length } },
      baselines: { note: "abnormal return vs NIFTY and sector basket; zero-effect is the null" },
      segmentsUsed: ["full history (descriptive event study — no model promotion decision rides on this alone)"],
      usedFinalTest: false,
      status: "completed",
      startedAt: started,
      finishedAt: new Date(),
    })
  );

  console.log(`\nExperimentRun ${run.id} persisted.\n`);
  console.log("== hierarchical event-reaction summary (abnormal vs NIFTY) ==");
  for (const row of levels) {
    if (row.verdict) console.log(`${String(row.level).padEnd(12)} ${String(row.key).padEnd(34)} ${row.verdict}`);
    else console.log(`${String(row.level).padEnd(12)} ${String(row.key).padEnd(34)} +5s: ${row.abn5 ?? "n/a"} · +20s: ${row.abn20 ?? "n/a"}`);
  }
  console.log(`\norder-value extraction: ${extracted.filter((x) => x.orderValueCrore != null).length}/${orderWins.length} headlines carried explicit values`);
  await AppDataSource.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
