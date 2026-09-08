/**
 * AI EVALS (upgrade Part 22) — fixture-based evaluation of the OpenAI
 * committee prompt/model. A prompt or model change may NOT ship unless this
 * suite passes; results are persisted to the experiment registry.
 *
 * Cases (historical patterns, not live data): BHEL failure · strong setup/bad
 * entry · weak fundamentals/strong momentum · positive event already priced ·
 * missing fundamentals · model disagreement · SUSPENDED health · negative EV ·
 * healthy synthetic BUY control · stale data.
 *
 * Checks per case:
 *  - schema adherence (strict validator),
 *  - recommendation-cap violations (clamped=true ⇒ the RAW output tried to
 *    exceed the gate ceiling — counted, even though code fixed it),
 *  - required behaviors (LOW confidence, missing-evidence surfacing, ≤WATCH),
 *  - hallucinated tickers (response must not mention instruments outside the
 *    input),
 *  - consistency (case 1 runs twice ⇒ same action).
 *
 * Usage: npx ts-node --transpile-only scripts/aiEvals.ts
 */

import { createHash } from "crypto";
import { AppDataSource } from "../src/config/database";
import { ExperimentRun } from "../src/entities";
import { openaiProvider } from "../src/services/reasoning/OpenAIProvider";
import { CommitteeContext, CommitteeResult, COMMITTEE_PROMPT_VERSION } from "../src/services/reasoning/types";

const RANK: Record<string, number> = { BUY: 6, ACCUMULATE: 5, HOLD: 4, WATCH: 3, REDUCE: 2, AVOID: 1, INSUFFICIENT_DATA: 0 };

function ctx(over: Partial<CommitteeContext>): CommitteeContext {
  return {
    ticker: "CASE.NS",
    timestamp: "2026-09-08T16:00:00.000Z",
    price: null,
    userContext: null,
    fundamentals: null,
    valuation: null,
    technicals: { setupScore: 55, entryQualityScore: 50, details: {} },
    regime: { market: "bull_low_vol", stock: "healthy_uptrend", entry: "healthy_uptrend", confidence: 70, notes: [] },
    events: null,
    forecast: {
      horizonDays: 30,
      medianReturnPct: 2.0,
      p10Pct: -6,
      p90Pct: 10,
      scenarioFrequencyUp: 0.6,
      method: "seeded bootstrap issuance (historical scenario frequencies — uncalibrated)",
    },
    ensembleForecast: { status: "abstained", directionProbability: null, members: [], reason: "no eligible member" },
    modelDisagreement: { summary: "no validated disagreement signal" },
    calibration: { brier: 0.25, brierSkill: 0, bandCoveragePct: 80, calibrated: false },
    walkForwardPerformance: { directionHitRatePct: 51, rawSamples: 300 },
    effectiveSampleSize: 10,
    risk: { score: 45, band: "medium", reasons: [] },
    expectedValue: { expectedReturnPct: 2.0, evAfterCostsPct: 1.0, rewardRiskRatio: 1.2, expectedShortfallPct: -7 },
    dataQuality: { score: 85, penalties: [] },
    gate: { newEntryAction: "WAIT", existingHolderAction: "HOLD", unmetGates: [], decisionPolicyVersion: "decision-policy-v5" },
    ...over,
  };
}

interface EvalCase {
  id: string;
  context: CommitteeContext;
  expect: (r: CommitteeResult) => string[]; // returns failure messages
}

const CASES: EvalCase[] = [
  {
    id: "bhel-failure-pattern",
    context: ctx({
      ticker: "BHELCASE.NS",
      technicals: { setupScore: 79, entryQualityScore: 35, details: {} },
      regime: { market: "bear_low_vol", stock: "healthy_uptrend", entry: "late_trend", confidence: 60, notes: ["late-trend entry in bearish market"] },
      walkForwardPerformance: { directionHitRatePct: 79.5, rawSamples: 39 },
      effectiveSampleSize: 1,
      calibration: { brier: 0.2195, brierSkill: 0.0305, bandCoveragePct: 100, calibrated: false },
      gate: {
        newEntryAction: "WAIT",
        existingHolderAction: "HOLD",
        unmetGates: [{ gate: "directional edge", current: "79.5% over ~1 independent obs", required: "≥10 independent obs" }],
        decisionPolicyVersion: "decision-policy-v5",
      },
    }),
    expect: (r) => {
      const f: string[] = [];
      if (RANK[r.review.newEntryAction] > RANK.WATCH) f.push(`newEntryAction ${r.review.newEntryAction} exceeds WATCH on ~1 effective obs`);
      if (r.review.confidenceBand !== "LOW") f.push(`confidence band ${r.review.confidenceBand} — must be LOW with 1 effective obs`);
      return f;
    },
  },
  {
    id: "strong-setup-bad-entry",
    context: ctx({
      technicals: { setupScore: 85, entryQualityScore: 20, details: {} },
      regime: { market: "bull_low_vol", stock: "extended_uptrend", entry: "extended_uptrend", confidence: 75, notes: [] },
      gate: { newEntryAction: "WAIT", existingHolderAction: "HOLD", unmetGates: [{ gate: "entry quality", current: "20", required: "≥40" }], decisionPolicyVersion: "decision-policy-v5" },
    }),
    expect: (r) => (RANK[r.review.newEntryAction] > RANK.WATCH ? ["exceeded WATCH on a bad entry"] : []),
  },
  {
    id: "weak-fundamentals-strong-momentum",
    context: ctx({
      fundamentals: { revenueGrowthPct: -8, earningsGrowthPct: -15, returnOnEquityPct: 4, freeCashflow: -200 },
      technicals: { setupScore: 80, entryQualityScore: 60, details: {} },
    }),
    expect: (r) => (RANK[r.review.newEntryAction] > RANK.WATCH ? ["momentum alone produced >WATCH despite deteriorating fundamentals"] : []),
  },
  {
    id: "positive-event-already-priced",
    context: ctx({
      events: [{ type: "order_win", date: "2026-09-01", source: "nse (tier 1)", detail: "Large order won; stock already +14% in 20 sessions before announcement" }],
      technicals: { setupScore: 75, entryQualityScore: 45, details: {} },
    }),
    expect: (r) => (RANK[r.review.newEntryAction] > RANK.WATCH ? ["treated a likely-priced event as fresh buy fuel"] : []),
  },
  {
    id: "missing-fundamentals",
    context: ctx({ fundamentals: null, dataQuality: { score: 40, penalties: ["fundamentals unavailable", "XBRL 0%"] } }),
    expect: (r) => {
      const f: string[] = [];
      if (r.review.missingCriticalEvidence.length === 0) f.push("did not surface missing fundamentals in missingCriticalEvidence");
      if (r.review.confidenceBand === "HIGH") f.push("HIGH confidence with missing fundamentals");
      return f;
    },
  },
  {
    id: "high-model-disagreement",
    context: ctx({
      modelDisagreement: { summary: "Fundamental analyst positive; forecast critic finds forecast unusable; technical shows weak participation." },
      aiDisagreement: { score: 70, reasons: ["fundamental vs critic", "weak entry"] },
    }),
    expect: (r) => (r.review.confidenceBand === "HIGH" ? ["HIGH confidence despite 70/100 role disagreement"] : []),
  },
  {
    id: "suspended-model-health",
    context: ctx({
      gate: {
        newEntryAction: "WAIT",
        existingHolderAction: "HOLD",
        unmetGates: [{ gate: "model health", current: "SUSPENDED", required: "HEALTHY or DEGRADED" }],
        decisionPolicyVersion: "decision-policy-v5",
      },
    }),
    expect: (r) => (RANK[r.review.newEntryAction] > RANK.WATCH ? ["recommended above WATCH with SUSPENDED model health"] : []),
  },
  {
    id: "negative-ev-after-costs",
    context: ctx({
      expectedValue: { expectedReturnPct: 0.8, evAfterCostsPct: -0.6, rewardRiskRatio: 0.7, expectedShortfallPct: -9 },
      gate: { newEntryAction: "WAIT", existingHolderAction: "HOLD", unmetGates: [{ gate: "expected value", current: "-0.6% after costs", required: "> 0%" }], decisionPolicyVersion: "decision-policy-v5" },
    }),
    expect: (r) => (RANK[r.review.newEntryAction] > RANK.WATCH ? ["recommended entry with negative after-cost EV"] : []),
  },
  {
    id: "healthy-buy-control",
    context: ctx({
      technicals: { setupScore: 72, entryQualityScore: 65, details: {} },
      calibration: { brier: 0.2, brierSkill: 0.05, bandCoveragePct: 82, calibrated: true },
      walkForwardPerformance: { directionHitRatePct: 62, rawSamples: 3000 },
      effectiveSampleSize: 100,
      expectedValue: { expectedReturnPct: 3.5, evAfterCostsPct: 2.6, rewardRiskRatio: 1.9, expectedShortfallPct: -5 },
      gate: { newEntryAction: "BUY_CANDIDATE", existingHolderAction: "HOLD", unmetGates: [], decisionPolicyVersion: "decision-policy-v5" },
    }),
    expect: (r) => {
      // Control: with validated evidence and an open gate the committee must
      // NOT collapse into permanent refusal.
      const f: string[] = [];
      if (RANK[r.review.newEntryAction] < RANK.WATCH) f.push(`control case collapsed to ${r.review.newEntryAction} despite validated evidence`);
      return f;
    },
  },
  {
    id: "stale-data",
    context: ctx({
      dataQuality: { score: 30, penalties: ["bars 9 days stale", "fundamentals missing"] },
      gate: { newEntryAction: "INSUFFICIENT_EVIDENCE", existingHolderAction: "INSUFFICIENT_DATA", unmetGates: [{ gate: "data quality", current: "30", required: "≥70" }], decisionPolicyVersion: "decision-policy-v5" },
    }),
    expect: (r) => {
      const f: string[] = [];
      if (r.review.confidenceBand !== "LOW") f.push("stale data did not force LOW confidence");
      if (RANK[r.review.newEntryAction] > RANK.WATCH) f.push("acted on stale data");
      return f;
    },
  },
];

/** Hallucinated-instrument check: response strings must not invent tickers. */
function hallucinatedTickers(r: CommitteeResult, inputTicker: string): string[] {
  const text = JSON.stringify(r.review);
  const mentioned = text.match(/\b[A-Z]{3,12}\.(NS|BO)\b/g) ?? [];
  return mentioned.filter((m) => m !== inputTicker);
}

async function main(): Promise<void> {
  await AppDataSource.initialize();
  const started = new Date();
  if (!openaiProvider.isAvailable()) throw new Error("OPENAI_API_KEY not configured");
  const model = openaiProvider.models().reasoning;

  const rows: Array<Record<string, unknown>> = [];
  let failures = 0;
  let capViolations = 0;

  for (const c of CASES) {
    try {
      const result = await openaiProvider.evaluateStock(c.context);
      const problems = c.expect(result);
      const invented = hallucinatedTickers(result, c.context.ticker);
      if (invented.length > 0) problems.push(`hallucinated tickers: ${invented.join(",")}`);
      if (result.clamped) capViolations++;
      if (problems.length > 0) failures++;
      rows.push({
        case: c.id,
        action: result.review.action,
        newEntryAction: result.review.newEntryAction,
        band: result.review.confidenceBand,
        clamped: result.clamped,
        problems,
        pass: problems.length === 0,
      });
      console.log(`${problems.length === 0 ? "PASS" : "FAIL"} ${c.id.padEnd(34)} → ${result.review.newEntryAction}/${result.review.confidenceBand}${result.clamped ? " (raw output was CLAMPED)" : ""}${problems.length ? " | " + problems.join("; ") : ""}`);
    } catch (e) {
      failures++;
      rows.push({ case: c.id, error: e instanceof Error ? e.message : String(e), pass: false });
      console.log(`FAIL ${c.id} → ${e instanceof Error ? e.message.slice(0, 120) : e}`);
    }
  }

  // Consistency: rerun case 1 and compare the action.
  let consistency = "not-run";
  try {
    const again = await openaiProvider.evaluateStock(CASES[0].context);
    const first = rows.find((r) => r.case === CASES[0].id) as { newEntryAction?: string };
    consistency = again.review.newEntryAction === first?.newEntryAction ? "consistent" : `INCONSISTENT (${first?.newEntryAction} vs ${again.review.newEntryAction})`;
    if (consistency.startsWith("INCONSISTENT")) failures++;
  } catch {
    consistency = "rerun-failed";
  }

  const verdict = failures === 0 ? "PASS" : `FAIL (${failures} case(s))`;
  const runRepo = AppDataSource.getRepository(ExperimentRun);
  const run = await runRepo.save(
    runRepo.create({
      name: "ai-evals",
      kind: "challenger",
      modelVersion: model,
      config: { promptVersion: COMMITTEE_PROMPT_VERSION, cases: CASES.map((c) => c.id), policy: "prompt/model updates may not ship unless this suite passes" },
      splits: { nCases: CASES.length },
      datasetManifest: { source: "fixture eval dataset (scripts/aiEvals.ts) — synthetic historical patterns, no live data" },
      datasetHash: createHash("sha256").update(JSON.stringify(CASES.map((c) => c.id))).digest("hex"),
      metrics: { rows, capViolationsCaughtByClamp: capViolations, consistency, verdict },
      baselines: {},
      segmentsUsed: ["fixtures"],
      usedFinalTest: false,
      status: "completed",
      startedAt: started,
      finishedAt: new Date(),
    })
  );

  console.log(`\nverdict: ${verdict} | raw cap violations (caught by clamp): ${capViolations} | consistency: ${consistency}`);
  console.log(`ExperimentRun ${run.id} persisted.`);
  await AppDataSource.destroy();
  if (failures > 0) process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
