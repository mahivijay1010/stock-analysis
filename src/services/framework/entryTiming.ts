/**
 * Module N3 — Entry timing ("buy today or wait"), PURE function.
 *
 * Deterministic scoring per SPEC_TIMING_NEWS.md: start at 50, add/subtract the
 * exact table amounts, clamp 0..100. Every reason quotes the real value that
 * moved the score; waitFor phrases the single biggest blocker concretely.
 *
 * HONESTY: this is a timing *lean* layered on measured signals — it never
 * claims certainty.
 */

import { EntryAction, EntryTiming } from "../../types";

export interface EntryTimingNewsInput {
  sentimentScore: number; // -100..100
  hypeTemperature: number; // 0..100
  fresh24hCount: number;
}

export interface EntryTimingInput {
  quantScore: number; // 0..100
  recommendation: "BUY" | "HOLD" | "AVOID";
  rsi14: number | null;
  bollingerPercentB: number | null;
  regime: "risk-on" | "neutral" | "risk-off" | null;
  pop7d: number | null; // 0..1 (Monte Carlo pop on Analyze, directionProb7d at scan level)
  expected1dPct: number | null;
  news: EntryTimingNewsInput | null; // null at scan level / when both sources failed
  /** Optional: real lower-band price so "wait for a pullback toward ₹X" can quote it. */
  bollingerLower?: number | null;
}

interface Contribution {
  delta: number;
  reason: string;
  waitFor: string | null; // concrete condition when this is the biggest blocker
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

const fmt = (x: number, dp = 1): string => x.toFixed(dp);
const sgn = (x: number, dp = 1): string => `${x >= 0 ? "+" : ""}${x.toFixed(dp)}%`;
const pts = (d: number): string => `${d >= 0 ? "+" : ""}${Math.round(d * 10) / 10} timing pts`;

export function computeEntryTiming(input: EntryTimingInput): EntryTiming {
  const contributions: Contribution[] = [];
  const neutralNotes: string[] = []; // real-value observations that moved nothing

  // 1) Quant score anchor: +(quantScore − 50) × 0.5
  {
    const delta = (input.quantScore - 50) * 0.5;
    contributions.push({
      delta,
      reason: `Quant score ${fmt(input.quantScore)}/100 → ${pts(delta)}`,
      waitFor:
        delta < 0
          ? `wait for the technical score to strengthen (now ${fmt(input.quantScore)}/100 — below the neutral 50)`
          : null,
    });
  }

  // 2) RSI zones
  if (input.rsi14 !== null) {
    const rsi = input.rsi14;
    if (rsi > 72) {
      contributions.push({
        delta: -15,
        reason: `RSI ${fmt(rsi)} — overbought; entries here historically give back the first move (−15)`,
        waitFor: `wait for RSI to cool below ~65 (now ${fmt(rsi)})`,
      });
    } else if (rsi >= 55) {
      contributions.push({
        delta: 5,
        reason: `RSI ${fmt(rsi)} — healthy momentum zone, not yet stretched (+5)`,
        waitFor: null,
      });
    } else if (rsi < 35) {
      contributions.push({
        delta: 8,
        reason: `RSI ${fmt(rsi)} — oversold dip in scope (+8)`,
        waitFor: null,
      });
    } else {
      neutralNotes.push(`RSI ${fmt(rsi)} — neutral zone, no timing adjustment`);
    }
  }

  // 3) Bollinger %B
  if (input.bollingerPercentB !== null) {
    const b = input.bollingerPercentB;
    if (b > 0.95) {
      contributions.push({
        delta: -10,
        reason: `Bollinger %B ${fmt(b, 2)} — pressed against the upper band (−10)`,
        waitFor:
          input.bollingerLower != null && Number.isFinite(input.bollingerLower)
            ? `wait for a pullback toward ₹${input.bollingerLower.toFixed(2)} (lower band); %B is ${fmt(b, 2)} now`
            : `wait for price to come off the upper Bollinger band (%B now ${fmt(b, 2)})`,
      });
    } else if (b < 0.15) {
      contributions.push({
        delta: 8,
        reason: `Bollinger %B ${fmt(b, 2)} — near the lower band, favorable entry zone (+8)`,
        waitFor: null,
      });
    } else {
      neutralNotes.push(`Bollinger %B ${fmt(b, 2)} — mid-band, no timing adjustment`);
    }
  }

  // 4) Market regime
  if (input.regime === "risk-off") {
    contributions.push({
      delta: -12,
      reason: `Market regime is RISK-OFF — broad headwind for new entries (−12)`,
      waitFor: `wait for the market regime to leave risk-off`,
    });
  } else if (input.regime === "risk-on") {
    contributions.push({
      delta: 5,
      reason: `Market regime is RISK-ON — tailwind for new entries (+5)`,
      waitFor: null,
    });
  } else if (input.regime === "neutral") {
    neutralNotes.push(`Market regime neutral — no timing adjustment`);
  }

  // 5) 7-day probability of profit
  if (input.pop7d !== null) {
    const popPct = input.pop7d * 100;
    if (input.pop7d >= 0.6) {
      contributions.push({
        delta: 10,
        reason: `7-day probability of profit ${fmt(popPct)}% — favorable odds (+10)`,
        waitFor: null,
      });
    } else if (input.pop7d <= 0.45) {
      contributions.push({
        delta: -10,
        reason: `7-day probability of profit only ${fmt(popPct)}% — worse than a coin flip (−10)`,
        waitFor: `wait for the 7-day odds to improve above ~50% (now ${fmt(popPct)}%)`,
      });
    } else {
      neutralNotes.push(`7-day probability of profit ${fmt(popPct)}% — near a coin flip`);
    }
  }

  // 6) Next-day expectation
  if (input.expected1dPct !== null && input.expected1dPct < -0.3) {
    contributions.push({
      delta: -5,
      reason: `Model expects ${sgn(input.expected1dPct, 2)} tomorrow — no rush to enter today (−5)`,
      waitFor: `wait a session — the model's 1-day expectation is ${sgn(input.expected1dPct, 2)}`,
    });
  }

  // 7) News (only when provided — scan-level verdicts pass null)
  const newsAware = input.news !== null;
  if (input.news) {
    const n = input.news;
    if (n.sentimentScore <= -30 && n.fresh24hCount >= 2) {
      contributions.push({
        delta: -20,
        reason: `Fresh negative news — sentiment ${fmt(n.sentimentScore, 0)} with ${n.fresh24hCount} headlines in 24h; let it settle before buying (−20)`,
        waitFor: `wait ~24–48h for the negative news to settle (sentiment ${fmt(n.sentimentScore, 0)}, ${n.fresh24hCount} fresh headlines)`,
      });
    }
    // Hype only blocks entries when the story is DIRECTIONAL — routine neutral
    // coverage of a liquid large cap is background noise, not a crowded trade.
    const directionalHype = n.hypeTemperature >= 70 && Math.abs(n.sentimentScore) >= 20;
    if (directionalHype) {
      contributions.push({
        delta: -12,
        reason: `Directional news hype ${fmt(n.hypeTemperature, 0)}/100 with sentiment ${fmt(n.sentimentScore, 0)} — the 48h half-life decay model says much is already priced in (−12)`,
        waitFor: `wait ~24–48h for the news hype to decay (hype ${fmt(n.hypeTemperature, 0)}/100, sentiment ${fmt(n.sentimentScore, 0)} now)`,
      });
    }
    if (n.sentimentScore >= 30 && n.hypeTemperature < 50) {
      contributions.push({
        delta: 8,
        reason: `Quietly positive news — sentiment ${fmt(n.sentimentScore, 0)} at low hype ${fmt(n.hypeTemperature, 0)}/100, not yet crowded (+8)`,
        waitFor: null,
      });
    }
    if (
      !(n.sentimentScore <= -30 && n.fresh24hCount >= 2) &&
      !directionalHype &&
      !(n.sentimentScore >= 30 && n.hypeTemperature < 50)
    ) {
      neutralNotes.push(
        `News tape unremarkable — sentiment ${fmt(n.sentimentScore, 0)}, hype ${fmt(n.hypeTemperature, 0)}/100, ${n.fresh24hCount} fresh headlines`
      );
    }
  }

  // ── Score, action ──
  const raw = 50 + contributions.reduce((s, c) => s + c.delta, 0);
  const score = Math.round(clamp(raw, 0, 100) * 10) / 10;

  let action: EntryAction;
  if (input.recommendation === "AVOID") action = "AVOID_ENTRY";
  else if (score >= 62) action = "BUY_TODAY";
  else if (score >= 40) action = "WAIT";
  else action = "AVOID_ENTRY";

  // ── waitFor: the single biggest negative contributor, phrased concretely ──
  let waitFor: string | null = null;
  if (action !== "BUY_TODAY") {
    const blockers = contributions
      .filter((c) => c.delta < 0 && c.waitFor)
      .sort((a, b) => a.delta - b.delta);
    if (blockers.length > 0) {
      waitFor = blockers[0].waitFor;
    } else if (input.recommendation === "AVOID") {
      waitFor = `the quant model rates this stock AVOID (score ${fmt(input.quantScore)}/100) — wait for the setup itself to improve, not just the entry day`;
    } else {
      waitFor = `wait for a stronger setup — timing score ${fmt(score)}/100 is below the ${action === "WAIT" ? "62 buy-today" : "40 minimum"} bar`;
    }
  }

  // ── Reasons: 3–5, biggest movers first, padded with real-value notes ──
  const reasons = contributions
    .slice()
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .map((c) => c.reason);
  for (const note of neutralNotes) {
    if (reasons.length >= 5) break;
    reasons.push(note);
  }

  return {
    action,
    score,
    reasons: reasons.slice(0, 5),
    waitFor,
    newsAware,
  };
}
