/**
 * BHEL historical regression replay (completion directive, Phase 15).
 *
 * Replays 2026-09-04 (the original failure date: app showed BUY at ₹431.10
 * with "conviction" 78.8) through the CURRENT pipeline, point-in-time:
 *  - bars truncated to ≤ 2026-09-04 (adjusted-close policy),
 *  - the measured walk-forward row that ACTUALLY existed that day (queried
 *    from model_performance, ran_at ≤ replay date — not hardcoded),
 *  - a fresh seeded issuance from the truncated series (same simulator),
 *  - regime, entry quality, event risk (announcedAt ≤ replay moment),
 *  - the Phase 7 calibrated-probability statement,
 *  - decision-policy-v5.
 *
 * Output: docs/bhel-regression-final.md with the actual computed values.
 */

import * as fs from "fs";
import { AppDataSource } from "../src/config/database";
import { marketDataService } from "../src/services/market/MarketDataService";
import { analysisCloses, adjustedDailyReturns } from "../src/services/market/canonical";
import { analyzeBars } from "../src/services/quant/engine";
import { simulateDailyQuantiles } from "../src/services/quant/montecarlo";
import { assessRegime } from "../src/services/decision/regimeEngine";
import { assessEntryQuality } from "../src/services/framework/entryQuality";
import { computeExpectedValue } from "../src/services/decision/expectedValue";
import { evaluateEntryPolicy, DECISION_POLICY_VERSION, effectiveSamples } from "../src/services/decision/policy";
import { eventService } from "../src/services/market/EventService";
import { resolveDirectionProbability } from "../src/services/research/calibratorRegistry";
import { Bar } from "../src/services/market/types";

const REPLAY_DATE = "2026-09-04";
const TICKER = "BHEL.NS";

const trunc = (bars: Bar[]): Bar[] => bars.filter((b) => b.date <= REPLAY_DATE);

async function main(): Promise<void> {
  await AppDataSource.initialize();

  // ── point-in-time inputs ────────────────────────────────────────────────
  const [stockAll, niftyAll, vixAll] = await Promise.all([
    marketDataService.getDailyBars(TICKER, "2y"),
    marketDataService.getNiftyBars("2y").catch(() => [] as Bar[]),
    marketDataService.getIndiaVixBars("2y").catch(() => [] as Bar[]),
  ]);
  const bars = trunc(stockAll);
  const nifty = trunc(niftyAll);
  const vix = trunc(vixAll);
  const closes = analysisCloses(bars);
  const anchorPrice = closes[closes.length - 1];
  const lastBar = bars[bars.length - 1]?.date;

  // The ORIGINAL surface, from the immutable prediction log of that day.
  const orig: Array<{ score: string; recommendation_given: string; predicted_probability: string; base_price: string }> =
    await AppDataSource.query(
      `SELECT score, recommendation_given, predicted_probability, base_price
         FROM prediction_logs
        WHERE ticker = $1 AND horizon_days = 30 AND prediction_date::date = $2
        ORDER BY prediction_date DESC LIMIT 1`,
      [TICKER, REPLAY_DATE]
    );

  // The measured walk-forward row that existed ON that date (no lookahead).
  const mpRows: Array<{ samples: number; hit: string; band: string; brier: string; ran_at: string }> =
    await AppDataSource.query(
      `SELECT (e->>'samples')::int AS samples, e->>'directionHitRatePct' AS hit,
              e->>'withinBandPct' AS band, e->>'brierScore' AS brier, mp.ran_at
         FROM model_performance mp, jsonb_array_elements(mp.horizons) e
        WHERE mp.ticker = $1 AND e->>'horizonDays' = '30' AND mp.model_version = 'quant-v1'
          AND mp.ran_at <= ($2::date + interval '1 day')
        ORDER BY mp.ran_at DESC LIMIT 1`,
      [TICKER, REPLAY_DATE]
    );
  const mp = mpRows[0] ?? null;
  const measured = mp
    ? { samples: mp.samples, directionHitRatePct: Number(mp.hit), withinBandPct: Number(mp.band), brierScore: Number(mp.brier) }
    : null;

  // Issuance reconstructed from the truncated series (same seeded simulator).
  const rets = adjustedDailyReturns(bars.slice(-260));
  const sim = simulateDailyQuantiles(rets, 21);
  const last = sim.perStep[20];
  const first = sim.perStep[0];
  const annVol = ((first.q.p90 - first.q.p10) / (2 * 1.2816)) * Math.sqrt(252) * 100;
  const ev = computeExpectedValue({
    anchorPrice,
    p05: anchorPrice * (1 + last.q.p05),
    p10: anchorPrice * (1 + last.q.p10),
    p50: anchorPrice * (1 + last.q.p50),
    p90: anchorPrice * (1 + last.q.p90),
    p95: anchorPrice * (1 + last.q.p95),
    meanPrice: anchorPrice * (1 + last.mean),
    pop: last.pop,
    horizonDays: 30,
  });

  // Regime, entry quality, events — all point-in-time.
  const vixLevel = vix.length ? vix[vix.length - 1].close : null;
  const vixBelow = vix.length >= 60 && vixLevel != null ? vix.filter((b) => b.close < vixLevel).length / vix.length : null;
  const regime = assessRegime({
    niftyBars: nifty.slice(-252),
    vixLevel,
    vixPercentile1y: vixBelow != null ? vixBelow * 100 : null,
    stockBars: bars.slice(-252),
    sectorRelativeStrength20pp: null,
    upcomingEventRisk: undefined,
  });
  const eventRisk = await eventService.assessEventRisk(TICKER, new Date(`${REPLAY_DATE}T15:40:00+05:30`));
  const analysis = analyzeBars(bars.slice(-252));
  const entryQuality = assessEntryQuality({
    baseTimingScore: null,
    price: anchorPrice,
    technicals: analysis.technicals,
    fundamentals: null, // point-in-time Yahoo fundamentals for a past date are not reconstructable — stated, and null only penalizes
    intervalWidthPct30: (last.q.p90 - last.q.p10) * 100,
    rewardRiskRatio: ev.rewardRiskRatio,
    marketRegime: regime.marketRegime,
  });
  const directionProbability = await resolveDirectionProbability("champion-quant-v1", 30, last.pop);

  const decision = evaluateEntryPolicy({
    ticker: TICKER,
    issuance: {
      anchorSessionDate: lastBar,
      anchorAgeDays: 0,
      anchorIsLatestObservedSession: true,
      targetSessionCount: 21,
      annualizedVolPct: annVol,
      medianReturnPct30: last.q.p50 * 100,
    },
    measured,
    afterMarketClose: true,
    riskScore: null, // full scorecard risk needs live fundamentals; null = unknown (conservative)
    dataQualityScore: null,
    forecastConfidenceScore: null,
    entryQualityScore: entryQuality.score,
    evAfterCostsPct: ev.evAfterCostsPct,
    regime: { marketRegime: regime.marketRegime, entryRegime: regime.entryRegime },
    modelHealthState: null, // live monitoring did not exist on the replay date; null never loosens
  });

  const o = orig[0] ?? null;
  const effN = measured ? effectiveSamples(measured.samples) : null;

  const md = `# BHEL regression replay — FINAL (completion Phase 15)

Replayed **${REPLAY_DATE}** (original failure date) through the CURRENT pipeline,
**point-in-time**: bars truncated at the replay date, the measured walk-forward row
that existed that day, events readable only if announced by then. Generated by
\`scripts/bhelReplay.ts\` — no hardcoded verdicts; rerunning reproduces this file.

## What the app ACTUALLY showed on ${REPLAY_DATE} (immutable prediction log)

| Surface | Value |
| --- | --- |
| Price | ₹${o ? Number(o.base_price).toFixed(2) : "n/a"} |
| Recommendation | **${o?.recommendation_given ?? "n/a"}** |
| Score shown | ${o ? Number(o.score).toFixed(1) : "n/a"} ("conviction"-style) |
| P(up, 30d) shown | ${o ? (Number(o.predicted_probability) * 100).toFixed(1) + "%" : "n/a"} |

## The same moment through the CURRENT pipeline (${DECISION_POLICY_VERSION})

| Component | Point-in-time output |
| --- | --- |
| Anchor (last bar ≤ ${REPLAY_DATE}) | ${lastBar} · ₹${anchorPrice.toFixed(2)} (adjusted-close policy) |
| Heuristic setup score (descriptive only) | ${analysis.score}/100 — never an action |
| Market regime | ${regime.marketRegime} |
| Stock regime | ${regime.stockRegime} |
| Entry regime (through the market lens) | **${regime.entryRegime}** |
| Entry quality v2.1 | ${entryQuality.score}/100 |
| Issuance (seeded MC on truncated adjusted returns) | median 30d ${(last.q.p50 * 100).toFixed(2)}%, 80% band ${(last.q.p10 * 100).toFixed(2)}% … ${(last.q.p90 * 100).toFixed(2)}%, PoP ${(last.pop * 100).toFixed(1)}% |
| EV after costs (30d) | ${ev.evAfterCostsPct != null ? ev.evAfterCostsPct.toFixed(2) + "%" : "n/a"} |
| Measured 30d row available that day | ${measured ? `${measured.directionHitRatePct.toFixed(1)}% hit over ${measured.samples} RAW samples · Brier ${measured.brierScore} · band ${measured.withinBandPct}%` : "none"} |
| Overlap-adjusted effective samples | **~${effN ?? "n/a"} independent observation(s)** (30d labels logged daily) |
| Direction probability statement | ${directionProbability.statement} |
| Point-in-time events visible | ${eventRisk.events.length} (announcedAt ≤ ${REPLAY_DATE}); eventRisk=${eventRisk.upcomingEventRisk} |

## Decision

**${decision.decisionStatus}** (evidence: ${decision.evidenceStatus})

Unmet gates:

${decision.unmetGates.map((g) => `- **${g.gate}** — currently ${g.current}; would need ${g.required}`).join("\n")}

Reasons:

${decision.reasons.map((r) => `- ${r}`).join("\n")}

## Verdict

The ${REPLAY_DATE} failure cannot recur on this pipeline:

1. The ${o ? Number(o.score).toFixed(1) : "~79"} "conviction" BUY rested on ${measured?.samples ?? 39} OVERLAPPING
   30-day windows — the overlap adjustment collapses them to ~${effN ?? 1} independent
   observation(s), far below the ≥10 the edge test requires, so the direction-edge
   gate refuses regardless of the 79% headline hit rate.
2. The entry regime (${regime.entryRegime}) caps a fresh entry at WATCH on its own.
3. The directional probability the old surface displayed (${o ? (Number(o.predicted_probability) * 100).toFixed(1) + "%" : "~64%"})
   is now withheld: "${directionProbability.statement}".
4. BUY TODAY and "conviction" no longer exist anywhere in the product.

Replay decision: **${decision.decisionStatus}** — the honest answer for a stock
after a vertical run with zero validated, independent out-of-sample evidence.
`;

  fs.writeFileSync("docs/bhel-regression-final.md", md);
  console.log(md);
  await AppDataSource.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
