/**
 * LiveStockContext builder + live assessment (reviewer #9, #12, #17).
 *
 * posture — a single scalar in [-1,1] derived deterministically from the
 * numerical features (VWAP side, EMA alignment, RSI position). It is NOT a
 * probability and NOT a conviction score; it is an internal momentum reading
 * that feeds transition detection.
 *
 * assessLive — maps a posture CHANGE to a qualitative live assessment with a
 * dead-band (hysteresis): a move smaller than `minDelta` keeps the prior
 * assessment, so 10-minute readings don't flicker around a threshold. We never
 * emit a percentage here (reviewer #12) — only IMPROVING/STABLE/WEAKENING/…
 */

import { DecisionStatus } from "../decision/policy";
import { LiveFeatures, LiveStockContext, LiveAssessment, LiveEntryQuality, LiveRiskState, LiveDataQuality } from "./types";

/** Deterministic momentum posture in [-1,1] from features (null-safe). */
export function computePosture(f: LiveFeatures): number {
  let score = 0;
  let terms = 0;
  if (f.vwapDistancePct != null) { score += clamp(f.vwapDistancePct / 2, -1, 1); terms++; } // ±2% ⇒ ±1
  if (f.ema9 != null && f.ema21 != null && f.ema50 != null) {
    const aligned = f.ema9 > f.ema21 && f.ema21 > f.ema50 ? 1 : f.ema9 < f.ema21 && f.ema21 < f.ema50 ? -1 : 0;
    score += aligned; terms++;
  }
  if (f.rsi14 != null) { score += clamp((f.rsi14 - 50) / 30, -1, 1); terms++; } // 50±30 ⇒ ±1
  return terms === 0 ? 0 : clamp(score / terms, -1, 1);
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export interface AssessLiveInput {
  prevPosture: number | null;
  currPosture: number;
  prevAssessment: LiveAssessment | null;
  gate: DecisionStatus;
  dataQuality: LiveDataQuality;
  /** Dead-band: |Δposture| below this keeps the prior assessment (hysteresis). */
  minDelta?: number;
}

export function assessLive(input: AssessLiveInput): LiveAssessment {
  const minDelta = input.minDelta ?? 0.1;
  if (input.dataQuality === "UNAVAILABLE") return "INVALIDATED";
  if (input.prevPosture == null) return "STABLE"; // first reading — no change to assess
  const delta = input.currPosture - input.prevPosture;
  if (Math.abs(delta) < minDelta) return input.prevAssessment ?? "STABLE"; // dead-band
  const strong = Math.abs(delta) >= 2 * minDelta;
  if (delta > 0) return strong ? "STRONGLY_IMPROVING" : "IMPROVING";
  return strong ? "STRONGLY_WEAKENING" : "WEAKENING";
}

export interface BuildContextInput {
  securityId: string;
  ticker: string;
  asOf: number;
  price: { last: number; open: number; high: number; low: number };
  session: { volume: number };
  features: LiveFeatures;
  setupState: string;
  expectedR: number | null;
  expectedRLowerBound: number | null;
  entryQuality: LiveEntryQuality;
  riskState: LiveRiskState;
  relativeStrength: { vsMarketPct: number | null; marketPercentile: number | null };
  dataQuality: LiveDataQuality;
  gate: DecisionStatus;
  previous?: LiveStockContext | null;
}

/** Assemble the prepared single-truth object for a security at a checkpoint. */
export function buildLiveStockContext(input: BuildContextInput): LiveStockContext {
  const posture = computePosture(input.features);
  const changePct = input.price.open > 0 ? ((input.price.last - input.price.open) / input.price.open) * 100 : null;
  const liveAssessment = assessLive({
    prevPosture: input.previous?.posture ?? null,
    currPosture: posture,
    prevAssessment: input.previous?.liveAssessment ?? null,
    gate: input.gate,
    dataQuality: input.dataQuality,
  });
  return {
    securityId: input.securityId,
    ticker: input.ticker,
    asOf: input.asOf,
    price: { last: input.price.last, open: input.price.open, high: input.price.high, low: input.price.low, changePct },
    volume: { session: input.session.volume, relativeVolume: input.features.relativeVolume },
    features: input.features,
    posture,
    liveAssessment,
    setupState: input.setupState,
    expectedR: input.expectedR,
    expectedRLowerBound: input.expectedRLowerBound,
    entryQuality: input.entryQuality,
    riskState: input.riskState,
    relativeStrength: input.relativeStrength,
    dataQuality: input.dataQuality,
    gate: input.gate,
  };
}
