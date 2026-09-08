/**
 * AI Investment Committee contracts (risk-spec Rule 13 + "AI API DESIGN").
 *
 * The committee receives ONLY structured JSON produced by the deterministic
 * quantitative systems (never raw prices to forecast from imagination) and
 * returns STRICT JSON validated against the schema below. Its authority is
 * CAP-ONLY: it may lower the TradeGate's action or add caveats; it can never
 * raise an action past the gate (enforced in code, not in the prompt).
 */

export const COMMITTEE_PROMPT_VERSION = "committee-prompt-v1";

/** The structured input contract (spec Rule 13). No personal user data. */
export interface CommitteeContext {
  ticker: string;
  timestamp: string;
  price: number | null;
  userContext: {
    /** Only what the user explicitly supplied — risk tolerance is never inferred. */
    holdsPosition: boolean;
    purchasePrice?: number | null;
    investmentHorizon?: string | null;
    riskTolerance?: string | null;
  } | null;
  fundamentals: Record<string, number | string | null> | null;
  valuation: { valuationScore: number | null; notes: string[] } | null;
  technicals: { setupScore: number | null; entryQualityScore: number | null; details: Record<string, number | null> } | null;
  regime: {
    market: string | null;
    stock?: string | null;
    entry?: string | null;
    confidence?: number | null;
    notes: string[];
  } | null;
  events: Array<{ type: string; date: string; source: string; detail: string }> | null;
  forecast: {
    horizonDays: number;
    medianReturnPct: number | null;
    p10Pct: number | null;
    p90Pct: number | null;
    scenarioFrequencyUp: number | null;
    method: string;
  } | null;
  /** Phase 8/12: the validated ensemble's stance — abstention is stated, never papered over. */
  ensembleForecast: {
    status: "abstained" | "available";
    directionProbability: number | null;
    members: string[];
    reason: string;
  } | null;
  /** Phase 12: cross-model disagreement measured offline; null = not measurable live. */
  modelDisagreement: { summary: string } | null;
  calibration: {
    brier: number | null;
    brierSkill: number | null;
    bandCoveragePct: number | null;
    calibrated: boolean;
  } | null;
  walkForwardPerformance: {
    directionHitRatePct: number | null;
    rawSamples: number | null;
  } | null;
  effectiveSampleSize: number | null;
  risk: { score: number | null; band: string; reasons: string[] } | null;
  expectedValue: {
    expectedReturnPct: number | null;
    evAfterCostsPct: number | null;
    rewardRiskRatio: number | null;
    expectedShortfallPct: number | null;
  } | null;
  dataQuality: { score: number | null; penalties: string[] } | null;
  /** The deterministic gate's own verdicts — the ceiling the committee cannot raise. */
  gate: {
    newEntryAction: string;
    existingHolderAction: string | null;
    unmetGates: Array<{ gate: string; current: string; required: string }>;
    decisionPolicyVersion: string;
  };
  /** Part 13: structured findings from the specialist AI roles (validated JSON, never prose). */
  roleFindings?: Record<string, unknown> | null;
  /** Part 13: deterministic 0-100 conflict measure between role findings, with reasons. */
  aiDisagreement?: { score: number; reasons: string[] } | null;
}

export const COMMITTEE_ACTIONS = [
  "BUY",
  "ACCUMULATE",
  "WATCH",
  "HOLD",
  "REDUCE",
  "AVOID",
  "INSUFFICIENT_DATA",
] as const;
export type CommitteeAction = (typeof COMMITTEE_ACTIONS)[number];

export interface CommitteeReview {
  action: CommitteeAction;
  newEntryAction: CommitteeAction;
  existingHolderAction: CommitteeAction;
  confidence: number; // 0-100
  confidenceBand: "LOW" | "MEDIUM" | "HIGH";
  setupScore: number; // 0-100
  entryScore: number; // 0-100
  topPositiveFactors: string[];
  topNegativeFactors: string[];
  missingCriticalEvidence: string[];
  invalidationConditions: string[];
  betterEntryConditions: string[];
  riskSummary: string;
  reasoningSummary: string;
  modelDisagreement: string;
  dataTimestamp: string;
}

export interface CommitteeResult {
  review: CommitteeReview;
  /** True when code lowered the model's output to respect the gate/evidence caps. */
  clamped: boolean;
  clampNotes: string[];
  provider: string;
  modelName: string;
  promptVersion: string;
  latencyMs: number;
  inputHash: string;
  tokensIn: number | null;
  tokensOut: number | null;
}

/** Rule 13 + "AI API DESIGN": the replaceable provider interface. */
export interface InvestmentReasoningProvider {
  readonly name: string;
  /** True when the provider can actually be called (e.g. API key configured). */
  isAvailable(): boolean;
  evaluateStock(context: CommitteeContext): Promise<CommitteeResult>;
  evaluateExistingPosition(context: CommitteeContext): Promise<CommitteeResult>;
  explainDecision(context: CommitteeContext): Promise<string>;
  identifyMissingEvidence(context: CommitteeContext): Promise<string[]>;
}

// ── strict output validation (pure, unit-tested) ────────────────────────────

const BANDS = ["LOW", "MEDIUM", "HIGH"] as const;

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * Validate the model's raw JSON against the strict schema. Throws with a
 * precise message on any violation — a malformed committee response is an
 * error, never silently coerced into advice.
 */
export function validateCommitteeReview(raw: unknown): CommitteeReview {
  if (raw == null || typeof raw !== "object") throw new Error("committee output is not a JSON object");
  const o = raw as Record<string, unknown>;
  const fail = (msg: string): never => {
    throw new Error(`committee output schema violation: ${msg}`);
  };

  const action = (field: string): CommitteeAction => {
    const v = o[field];
    if (typeof v !== "string" || !COMMITTEE_ACTIONS.includes(v as CommitteeAction)) {
      fail(`"${field}" must be one of ${COMMITTEE_ACTIONS.join("|")}, got ${JSON.stringify(v)}`);
    }
    return v as CommitteeAction;
  };
  const score = (field: string): number => {
    const v = o[field];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) {
      fail(`"${field}" must be a number 0-100, got ${JSON.stringify(v)}`);
    }
    return v as number;
  };
  const strArr = (field: string): string[] => {
    const v = o[field];
    if (!isStringArray(v)) fail(`"${field}" must be a string array`);
    return v as string[];
  };
  const str = (field: string): string => {
    const v = o[field];
    if (typeof v !== "string") fail(`"${field}" must be a string`);
    return v as string;
  };

  const band = o.confidenceBand;
  if (typeof band !== "string" || !BANDS.includes(band as (typeof BANDS)[number])) {
    fail(`"confidenceBand" must be LOW|MEDIUM|HIGH, got ${JSON.stringify(band)}`);
  }

  return {
    action: action("action"),
    newEntryAction: action("newEntryAction"),
    existingHolderAction: action("existingHolderAction"),
    confidence: score("confidence"),
    confidenceBand: band as CommitteeReview["confidenceBand"],
    setupScore: score("setupScore"),
    entryScore: score("entryScore"),
    topPositiveFactors: strArr("topPositiveFactors"),
    topNegativeFactors: strArr("topNegativeFactors"),
    missingCriticalEvidence: strArr("missingCriticalEvidence"),
    invalidationConditions: strArr("invalidationConditions"),
    betterEntryConditions: strArr("betterEntryConditions"),
    riskSummary: str("riskSummary"),
    reasoningSummary: str("reasoningSummary"),
    modelDisagreement: str("modelDisagreement"),
    dataTimestamp: str("dataTimestamp"),
  };
}

const ACTION_RANK: Record<CommitteeAction, number> = {
  BUY: 6,
  ACCUMULATE: 5,
  HOLD: 4,
  WATCH: 3,
  REDUCE: 2,
  AVOID: 1,
  INSUFFICIENT_DATA: 0,
};

/** Gate status → the MAXIMUM committee action allowed for new entries. */
function gateCeiling(newEntryGate: string): CommitteeAction {
  switch (newEntryGate) {
    case "BUY_CANDIDATE":
      return "BUY";
    case "WAIT":
      return "WATCH";
    case "AVOID_NEW_ENTRY":
      return "AVOID";
    default:
      return "INSUFFICIENT_DATA";
  }
}

/**
 * CAP-ONLY enforcement (code, not prompt): the committee can never raise an
 * action past the deterministic gate, HIGH confidence is impossible with
 * Brier skill ≤ 0, and confidence must be LOW when effective samples are
 * inadequate. Returns the (possibly lowered) review + what was clamped.
 */
export function clampReviewToGate(
  review: CommitteeReview,
  ctx: CommitteeContext
): { review: CommitteeReview; clamped: boolean; clampNotes: string[] } {
  const notes: string[] = [];
  const out: CommitteeReview = { ...review };

  const ceiling = gateCeiling(ctx.gate.newEntryAction);
  if (ACTION_RANK[out.newEntryAction] > ACTION_RANK[ceiling]) {
    notes.push(
      `newEntryAction ${out.newEntryAction} exceeded the TradeGate (${ctx.gate.newEntryAction}) — lowered to ${ceiling}.`
    );
    out.newEntryAction = ceiling;
  }
  if (ACTION_RANK[out.action] > ACTION_RANK[out.newEntryAction] && !ctx.userContext?.holdsPosition) {
    notes.push(`action ${out.action} lowered to match the capped new-entry action.`);
    out.action = out.newEntryAction;
  }

  const skill = ctx.calibration?.brierSkill ?? null;
  if ((skill == null || skill <= 0) && out.confidenceBand === "HIGH") {
    notes.push("confidence HIGH is impossible with Brier skill ≤ 0 (or unmeasured) — lowered to MEDIUM.");
    out.confidenceBand = "MEDIUM";
    out.confidence = Math.min(out.confidence, 60);
  }
  const effN = ctx.effectiveSampleSize ?? 0;
  if (effN < 10 && out.confidenceBand !== "LOW") {
    notes.push(`effective sample size ${effN} < 10 — confidence forced LOW.`);
    out.confidenceBand = "LOW";
    out.confidence = Math.min(out.confidence, 40);
  }
  // A committee cannot instruct existing holders harder than REVIEW-equivalents
  // when the deterministic holder policy says HOLD (never invent sell pressure).
  if (
    ctx.gate.existingHolderAction === "HOLD" &&
    (out.existingHolderAction === "REDUCE" || out.existingHolderAction === "AVOID")
  ) {
    notes.push(
      `existingHolderAction ${out.existingHolderAction} conflicts with the deterministic HOLD — lowered to HOLD.`
    );
    out.existingHolderAction = "HOLD";
  }

  return { review: out, clamped: notes.length > 0, clampNotes: notes };
}
