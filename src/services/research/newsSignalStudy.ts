/**
 * Prospective test of the web-news sentiment signal, exactly as pre-registered
 * in docs/news-signal-preregistration.md (2026-10-06). Runs nightly: it reports
 * progress until the sample threshold is first reached, then judges ONCE and
 * resolves the registered expectation (write-once).
 */
import { AppDataSource } from "../../config/database";
import { netSentiment } from "../knowledge/newsFacts";

export const NEWS_STUDY_VERSION = "news-signal-v1";
export const NEWS_RULE = {
  horizonSessions: 10,
  minDays: 20,
  minCalls: 150,
  minEachSide: 30,
  minHitPct: 55,
  minIcLbPct: 50,
  minSpreadT: 2.0,
  corporateActionMovePct: 25,
} as const;

export interface NewsCall {
  symbol: string;
  observedAt: string;
  score: number;
  relReturn: number; // fraction
}

export interface NewsStudyStats {
  calls: number;
  days: number;
  positive: number;
  negative: number;
  hitPct: number | null;
  hitLb95Pct: number | null;
  spreadPct: number | null;
  spreadT: number | null;
  thresholdReached: boolean;
  pass: boolean | null;
  why: string;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const sd = (xs: number[]) => {
  const m = mean(xs);
  return xs.length > 1 && m != null ? Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)) : null;
};

/** The pre-registered statistics, clustered by observation day. PURE. */
export function newsStats(calls: NewsCall[]): NewsStudyStats {
  const R = NEWS_RULE;
  const byDay = new Map<string, NewsCall[]>();
  for (const c of calls) byDay.set(c.observedAt, [...(byDay.get(c.observedAt) ?? []), c]);
  const pos = calls.filter((c) => c.score > 0);
  const neg = calls.filter((c) => c.score < 0);
  const hits = calls.filter((c) => Math.sign(c.score) === Math.sign(c.relReturn) && c.relReturn !== 0).length;
  const hitPct = calls.length ? (hits / calls.length) * 100 : null;

  const dayHit: number[] = [];
  const daySpread: number[] = [];
  for (const g of byDay.values()) {
    dayHit.push(g.filter((c) => Math.sign(c.score) === Math.sign(c.relReturn) && c.relReturn !== 0).length / g.length);
    const p = mean(g.filter((c) => c.score > 0).map((c) => c.relReturn));
    const n = mean(g.filter((c) => c.score < 0).map((c) => c.relReturn));
    // A day contributes to the spread only if it has both sides; otherwise its sign-adjusted mean.
    daySpread.push(p != null && n != null ? p - n : mean(g.map((c) => Math.sign(c.score) * c.relReturn))! * 2);
  }
  const mh = mean(dayHit);
  const sh = sd(dayHit);
  const hitLb = mh != null && sh != null ? (mh - (1.96 * sh) / Math.sqrt(dayHit.length)) * 100 : null;
  const ms = mean(daySpread);
  const ss = sd(daySpread);
  const spreadT = ms != null && ss && ss > 0 ? ms / (ss / Math.sqrt(daySpread.length)) : null;
  const spreadAll = mean(pos.map((c) => c.relReturn)) != null && mean(neg.map((c) => c.relReturn)) != null ? (mean(pos.map((c) => c.relReturn))! - mean(neg.map((c) => c.relReturn))!) * 100 : null;

  const thresholdReached = byDay.size >= R.minDays && calls.length >= R.minCalls && pos.length >= R.minEachSide && neg.length >= R.minEachSide;
  let pass: boolean | null = null;
  let why = `collecting: ${calls.length}/${R.minCalls} matured calls over ${byDay.size}/${R.minDays} days (${pos.length} positive, ${neg.length} negative; need ≥${R.minEachSide} each)`;
  if (thresholdReached) {
    const reasons: string[] = [];
    if (hitPct == null || hitPct <= R.minHitPct) reasons.push(`hit ${hitPct?.toFixed(1)}% ≤ ${R.minHitPct}%`);
    if (hitLb == null || hitLb <= R.minIcLbPct) reasons.push(`clustered hit LB ${hitLb?.toFixed(1)}% ≤ ${R.minIcLbPct}%`);
    if (spreadAll == null || spreadAll <= 0 || spreadT == null || spreadT < R.minSpreadT) reasons.push(`spread ${spreadAll?.toFixed(2)}% (t ${spreadT?.toFixed(2)}) fails t ≥ ${R.minSpreadT}`);
    pass = reasons.length === 0;
    why = pass ? "passes every pre-registered criterion" : reasons.join("; ");
  }
  return { calls: calls.length, days: byDay.size, positive: pos.length, negative: neg.length, hitPct, hitLb95Pct: hitLb, spreadPct: spreadAll, spreadT, thresholdReached, pass, why };
}

/** Build matured calls from stock_knowledge + nse_delivery. */
export async function loadNewsCalls(): Promise<NewsCall[]> {
  const R = NEWS_RULE;
  const facts: Array<{ symbol: string; d: string; sentiment: string; materiality: string }> = await AppDataSource.query(
    `SELECT symbol, to_char(observed_at,'YYYY-MM-DD') d, detail->>'sentiment' sentiment, detail->>'materiality' materiality
       FROM stock_knowledge WHERE source_kind = 'NEWS' AND detail->>'version' = 'news-facts-v1'`
  );
  const events = new Map<string, Array<{ sentiment: string; materiality: string }>>();
  for (const f of facts) events.set(`${f.symbol}|${f.d}`, [...(events.get(`${f.symbol}|${f.d}`) ?? []), f]);

  const sessions: Array<{ d: string }> = await AppDataSource.query(`SELECT DISTINCT to_char(trade_date,'YYYY-MM-DD') d FROM nse_delivery ORDER BY 1`);
  const dates = sessions.map((s) => s.d);
  const calls: NewsCall[] = [];
  const benchCache = new Map<string, number | null>();

  for (const [key, fs] of events) {
    if (!fs.some((f) => f.materiality === "HIGH" || f.materiality === "MEDIUM")) continue;
    const score = netSentiment(fs);
    if (score == null || score === 0) continue;
    const [symbol, d] = key.split("|");
    const i0 = dates.findIndex((x) => x > d);
    if (i0 < 0 || i0 + R.horizonSessions >= dates.length) continue; // not matured
    const t0 = dates[i0];
    const t1 = dates[i0 + R.horizonSessions];

    const path: Array<{ c: string }> = await AppDataSource.query(
      `SELECT close_price c FROM nse_delivery WHERE symbol = $1 AND series = 'EQ' AND trade_date BETWEEN $2 AND $3 ORDER BY trade_date`,
      [symbol, t0, t1]
    );
    const closes = path.map((p) => Number(p.c));
    if (closes.length < R.horizonSessions) continue;
    if (closes.some((c, k) => k > 0 && Math.abs(c / closes[k - 1] - 1) * 100 > R.corporateActionMovePct)) continue;
    const ret = closes[closes.length - 1] / closes[0] - 1;

    if (!benchCache.has(t0)) {
      const [b]: Array<{ m: string | null }> = await AppDataSource.query(
        `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY e.close_price / s.close_price - 1) m
           FROM nse_delivery s JOIN nse_delivery e ON e.symbol = s.symbol AND e.series = 'EQ' AND e.trade_date = $2
          WHERE s.trade_date = $1 AND s.series = 'EQ' AND s.close_price >= 5 AND s.turnover_lacs >= 200`,
        [t0, t1]
      );
      benchCache.set(t0, b?.m == null ? null : Number(b.m));
    }
    const bench = benchCache.get(t0);
    if (bench == null) continue;
    calls.push({ symbol, observedAt: d, score, relReturn: ret - bench });
  }
  return calls;
}

/** Nightly: record progress; on the first run that reaches the threshold, judge once and resolve the expectation. */
export async function runNewsSignalStudy(): Promise<NewsStudyStats> {
  const stats = newsStats(await loadNewsCalls());
  await AppDataSource.query(
    `INSERT INTO experiment_runs (name, kind, model_version, config, splits, dataset_manifest, dataset_hash, metrics, baselines, segments_used, used_final_test, status, notes, started_at, finished_at)
     VALUES ('news-signal-study','study',$1,$2::jsonb,'{}'::jsonb,$3::jsonb,$4,$5::jsonb,$6::jsonb,'["prospective"]'::jsonb,$7,'completed',$8,now(),now())`,
    [
      NEWS_STUDY_VERSION,
      JSON.stringify({ rule: NEWS_RULE, doc: "docs/news-signal-preregistration.md" }),
      JSON.stringify({ source: "stock_knowledge (news-facts-v1) + nse_delivery", calls: stats.calls, days: stats.days }),
      `${NEWS_STUDY_VERSION}|${stats.calls}|${stats.days}`,
      JSON.stringify(stats),
      JSON.stringify({ hit: "constant = 50%", benchmark: "median 10-session return of liquid EQ stocks" }),
      stats.thresholdReached,
      `News-sentiment signal: ${stats.why}`,
    ]
  );
  if (stats.thresholdReached && stats.pass != null) {
    await AppDataSource.query(
      `UPDATE learning_expectations SET status = $1, actual_value = $2, resolution_note = $3, resolved_at = now()
        WHERE scope = 'selection-signal' AND subject = 'news-sentiment' AND model_version = $4 AND status = 'OPEN'`,
      [stats.pass ? "WRONG" : "CORRECT", stats.pass ? 1 : 0, `${stats.pass ? "PASSED" : "FAILED"} — ${stats.why}`, NEWS_STUDY_VERSION]
    );
  }
  return stats;
}
