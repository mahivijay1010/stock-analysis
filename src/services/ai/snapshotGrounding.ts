/**
 * AI snapshot grounding (reviewer #17/#18, next-branch #1) — PURE.
 *
 * Closes the AI-containment loop on the immutable DecisionSnapshot. The AI is
 * advisory and CAP-ONLY: it may interpret, challenge, and LOWER the action, but
 * it can never invent a fact or raise the decision. We enforce that mechanically
 * rather than by prompt convention:
 *
 *   1. Evidence is DERIVED from the sealed snapshot with stable, snapshot-scoped
 *      IDs — the AI's entire factual vocabulary is fixed before it runs.
 *   2. Every claim must reference existing evidence IDs; an unknown ID rejects
 *      the claim.
 *   3. Every number the AI cites must MATCH the evidence value; a fabricated or
 *      mismatched number rejects the claim.
 *   4. The ticker and snapshot hash the AI echoes must match; otherwise the
 *      whole AI contribution is discarded and the deterministic decision stands.
 *   5. The AI's action is clamped to AT MOST the deterministic action. Lowering
 *      is honoured (fail-safe); an attempt to raise is flagged and ignored.
 *
 * The backend consumes only the STRUCTURED, validated output — never the AI's
 * free text — so a hallucinated number in prose can't reach a decision.
 */

import { DecisionStatus } from "../decision/policy";
import { SealedDecision } from "../decision/decisionSnapshot";

export type EvidenceKind = "numeric" | "categorical" | "flag" | "absent";

export interface EvidenceItem {
  id: string; // stable, snapshot-scoped, e.g. "EV:measured.directionHitRatePct"
  field: string;
  value: number | string | boolean | null;
  kind: EvidenceKind;
}

export interface EvidenceSet {
  ticker: string;
  /** Binds this evidence to the exact sealed snapshot (its inputManifestHash). */
  snapshotHash: string;
  deterministicAction: DecisionStatus;
  items: EvidenceItem[];
}

export interface GroundedClaim {
  statement: string; // advisory display text — NOT trusted for facts
  evidenceIds: string[];
  /** Any number/label the AI asserts MUST be pinned to an evidence id here. */
  citedValues?: Array<{ evidenceId: string; value: number | string | boolean | null }>;
}

export interface GroundedAiResponse {
  ticker: string;
  snapshotHash: string;
  assessment?: string; // e.g. "IMPROVING" — advisory label, never a probability
  claims: GroundedClaim[];
  actionCap: DecisionStatus; // the AI's PROPOSED ceiling
}

export interface GroundingResult {
  ok: boolean; // no hard violations
  effectiveAction: DecisionStatus; // min(aiCap, deterministic) — never above deterministic
  aiIgnored: boolean; // true when a hard violation discarded the AI contribution
  acceptedClaims: GroundedClaim[];
  rejectedClaims: Array<{ claim: GroundedClaim; reasons: string[] }>;
  violations: string[];
}

const ACTION_RANK: Record<DecisionStatus, number> = {
  INSUFFICIENT_EVIDENCE: 0,
  AVOID_NEW_ENTRY: 1,
  WAIT: 2,
  BUY_CANDIDATE: 3,
};

/** Recursively collect scalar leaves as [dottedPath, value]. */
function flattenScalars(obj: unknown, prefix: string, out: Array<[string, number | string | boolean | null]>): void {
  if (obj === null || obj === undefined) {
    if (prefix) out.push([prefix, null]);
    return;
  }
  const t = typeof obj;
  if (t === "number" || t === "string" || t === "boolean") {
    out.push([prefix, obj as number | string | boolean]);
    return;
  }
  if (t !== "object") return;
  if (Array.isArray(obj)) return; // arrays aren't atomic evidence in this model
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    flattenScalars(v, prefix ? `${prefix}.${k}` : k, out);
  }
}

function kindOf(value: number | string | boolean | null): EvidenceKind {
  if (value === null) return "absent";
  if (typeof value === "number") return "numeric";
  if (typeof value === "boolean") return "flag";
  return "categorical";
}

/**
 * Derive the fixed evidence vocabulary from a sealed snapshot. The AI sees
 * exactly these facts — no more. `ticker` is required because the snapshot's
 * gate inputs carry it under a policy-specific field; we surface it explicitly.
 */
export function buildEvidenceSet(sealed: SealedDecision, ticker: string): EvidenceSet {
  const leaves: Array<[string, number | string | boolean | null]> = [];
  flattenScalars(sealed.inputs, "", leaves);
  const items: EvidenceItem[] = leaves.map(([field, value]) => ({ id: `EV:${field}`, field, value, kind: kindOf(value) }));
  return {
    ticker,
    snapshotHash: sealed.inputManifestHash,
    deterministicAction: sealed.decision.decisionStatus,
    items,
  };
}

function valuesMatch(a: number | string | boolean | null, b: number | string | boolean | null): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 1e-9;
  return a === b;
}

/**
 * Validate an AI response against the snapshot's evidence set. Returns the
 * sanitized, safe-to-consume result. NEVER throws on adversarial input — a
 * malformed or dishonest response degrades to the deterministic decision.
 */
export function validateGroundedResponse(evidence: EvidenceSet, response: GroundedAiResponse): GroundingResult {
  const violations: string[] = [];
  const byId = new Map(evidence.items.map((i) => [i.id, i]));

  // Hard violations: the AI answered about the wrong thing → discard entirely.
  if (response.ticker !== evidence.ticker) violations.push(`ticker mismatch: AI said ${JSON.stringify(response.ticker)}, snapshot is ${JSON.stringify(evidence.ticker)}`);
  if (response.snapshotHash !== evidence.snapshotHash) violations.push("snapshot hash mismatch: the AI response is not bound to this sealed snapshot");
  if (!ACTION_RANK.hasOwnProperty(response.actionCap)) violations.push(`unknown actionCap ${JSON.stringify(response.actionCap)}`);

  if (violations.length > 0) {
    return {
      ok: false,
      effectiveAction: evidence.deterministicAction, // AI ignored — deterministic stands
      aiIgnored: true,
      acceptedClaims: [],
      rejectedClaims: (response.claims ?? []).map((claim) => ({ claim, reasons: ["AI contribution discarded due to a hard violation"] })),
      violations,
    };
  }

  const acceptedClaims: GroundedClaim[] = [];
  const rejectedClaims: Array<{ claim: GroundedClaim; reasons: string[] }> = [];
  for (const claim of response.claims ?? []) {
    const reasons: string[] = [];
    for (const id of claim.evidenceIds ?? []) {
      if (!byId.has(id)) reasons.push(`references unknown evidence id ${id}`);
    }
    for (const cv of claim.citedValues ?? []) {
      const item = byId.get(cv.evidenceId);
      if (!item) reasons.push(`cites unknown evidence id ${cv.evidenceId}`);
      else if (!valuesMatch(cv.value, item.value)) reasons.push(`cited value for ${cv.evidenceId} (${JSON.stringify(cv.value)}) does not match evidence (${JSON.stringify(item.value)})`);
    }
    if ((claim.evidenceIds ?? []).length === 0) reasons.push("claim cites no evidence");
    if (reasons.length === 0) acceptedClaims.push(claim);
    else rejectedClaims.push({ claim, reasons });
  }

  // Action clamp: the AI may only LOWER. Raising is flagged and ignored.
  const raised = ACTION_RANK[response.actionCap] > ACTION_RANK[evidence.deterministicAction];
  if (raised) violations.push(`AI attempted to RAISE action to ${response.actionCap} above deterministic ${evidence.deterministicAction} — ignored (AI is cap-only)`);
  const effectiveAction: DecisionStatus = raised
    ? evidence.deterministicAction
    : ACTION_RANK[response.actionCap] < ACTION_RANK[evidence.deterministicAction]
      ? response.actionCap
      : evidence.deterministicAction;

  return {
    ok: violations.length === 0,
    effectiveAction,
    aiIgnored: false,
    acceptedClaims,
    rejectedClaims,
    violations,
  };
}
