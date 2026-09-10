/**
 * AI snapshot grounding — the AI is advisory and CAP-ONLY. It cannot invent a
 * fact (every number must match derived evidence) and cannot raise the action
 * above the deterministic gate. Adversarial input degrades to the deterministic
 * decision, never throws.
 */

import { PolicyInputs } from "../src/services/decision/policy";
import { sealDecision, SealedDecision } from "../src/services/decision/decisionSnapshot";
import { buildEvidenceSet, validateGroundedResponse, GroundedAiResponse } from "../src/services/ai/snapshotGrounding";

const inputs = (over?: Partial<PolicyInputs>): PolicyInputs => ({
  ticker: "RELIANCE.NS",
  issuance: { anchorSessionDate: "2026-09-05", anchorAgeDays: 1, anchorIsLatestObservedSession: true, targetSessionCount: 21, annualizedVolPct: 25, medianReturnPct30: 2 },
  measured: { samples: 600, directionHitRatePct: 75, withinBandPct: 78, brierScore: 0.2 },
  afterMarketClose: true, riskScore: 40, dataQualityScore: 85, forecastConfidenceScore: 70,
  entryQualityScore: 60, evAfterCostsPct: 1.2, regime: { marketRegime: "bull_low_vol", entryRegime: "healthy_uptrend" },
  modelHealthState: "HEALTHY", ...over,
});
const versions = { modelVersion: "quant-v1", featureVersion: "st-features-v1" };

// A snapshot that clears the gate (BUY_CANDIDATE) and one capped at WAIT.
const buySealed = (): SealedDecision => sealDecision(inputs(), versions);
const waitSealed = (): SealedDecision => sealDecision(inputs({ entryQualityScore: 10 }), versions); // low entry ⇒ WAIT

const ev = (sealed: SealedDecision) => buildEvidenceSet(sealed, "RELIANCE.NS");

const resp = (sealed: SealedDecision, over: Partial<GroundedAiResponse>): GroundedAiResponse => ({
  ticker: "RELIANCE.NS",
  snapshotHash: sealed.inputManifestHash,
  claims: [],
  actionCap: "WAIT",
  ...over,
});

describe("evidence derivation", () => {
  test("evidence IDs are stable, snapshot-scoped, and cover the gate inputs", () => {
    const set = ev(buySealed());
    const ids = set.items.map((i) => i.id);
    expect(ids).toContain("EV:measured.directionHitRatePct");
    expect(ids).toContain("EV:riskScore");
    expect(ids).toContain("EV:regime.marketRegime");
    const rs = set.items.find((i) => i.id === "EV:riskScore");
    expect(rs?.value).toBe(40);
    expect(rs?.kind).toBe("numeric");
  });
});

describe("the AI cannot invent facts", () => {
  test("a claim citing a value that matches evidence is ACCEPTED", () => {
    const s = buySealed();
    const r = validateGroundedResponse(ev(s), resp(s, {
      claims: [{ statement: "risk is moderate", evidenceIds: ["EV:riskScore"], citedValues: [{ evidenceId: "EV:riskScore", value: 40 }] }],
    }));
    expect(r.acceptedClaims).toHaveLength(1);
    expect(r.rejectedClaims).toHaveLength(0);
  });
  test("a claim citing a FABRICATED number is REJECTED", () => {
    const s = buySealed();
    const r = validateGroundedResponse(ev(s), resp(s, {
      claims: [{ statement: "risk is tiny", evidenceIds: ["EV:riskScore"], citedValues: [{ evidenceId: "EV:riskScore", value: 3 }] }],
    }));
    expect(r.acceptedClaims).toHaveLength(0);
    expect(r.rejectedClaims[0].reasons.join(" ")).toMatch(/does not match evidence/);
  });
  test("a claim referencing an UNKNOWN evidence id is REJECTED", () => {
    const s = buySealed();
    const r = validateGroundedResponse(ev(s), resp(s, {
      claims: [{ statement: "insider buying", evidenceIds: ["EV:insiderBuying"] }],
    }));
    expect(r.acceptedClaims).toHaveLength(0);
    expect(r.rejectedClaims[0].reasons.join(" ")).toMatch(/unknown evidence id/);
  });
  test("a claim with NO evidence is REJECTED", () => {
    const s = buySealed();
    const r = validateGroundedResponse(ev(s), resp(s, { claims: [{ statement: "trust me", evidenceIds: [] }] }));
    expect(r.rejectedClaims[0].reasons.join(" ")).toMatch(/cites no evidence/);
  });
});

describe("the AI is cap-only (never raises the action)", () => {
  test("AI may LOWER a BUY_CANDIDATE to WAIT", () => {
    const s = buySealed();
    expect(ev(s).deterministicAction).toBe("BUY_CANDIDATE");
    const r = validateGroundedResponse(ev(s), resp(s, { actionCap: "WAIT" }));
    expect(r.effectiveAction).toBe("WAIT");
    expect(r.ok).toBe(true);
  });
  test("AI attempting to RAISE a WAIT to BUY_CANDIDATE is IGNORED and flagged", () => {
    const s = waitSealed();
    expect(ev(s).deterministicAction).toBe("WAIT");
    const r = validateGroundedResponse(ev(s), resp(s, { actionCap: "BUY_CANDIDATE" }));
    expect(r.effectiveAction).toBe("WAIT"); // clamped to deterministic — never above
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toMatch(/attempted to RAISE/);
  });
  test("AI agreeing with the deterministic action leaves it unchanged", () => {
    const s = buySealed();
    const r = validateGroundedResponse(ev(s), resp(s, { actionCap: "BUY_CANDIDATE" }));
    expect(r.effectiveAction).toBe("BUY_CANDIDATE");
  });
});

describe("adversarial input degrades to the deterministic decision (never throws)", () => {
  test("a response bound to the WRONG snapshot hash is discarded", () => {
    const s = buySealed();
    const r = validateGroundedResponse(ev(s), resp(s, { snapshotHash: "deadbeef", actionCap: "WAIT" }));
    expect(r.aiIgnored).toBe(true);
    expect(r.effectiveAction).toBe("BUY_CANDIDATE"); // AI ignored — deterministic stands
    expect(r.violations.join(" ")).toMatch(/snapshot hash mismatch/);
  });
  test("a response about the WRONG ticker is discarded", () => {
    const s = buySealed();
    const r = validateGroundedResponse(ev(s), resp(s, { ticker: "TCS.NS" }));
    expect(r.aiIgnored).toBe(true);
    expect(r.effectiveAction).toBe("BUY_CANDIDATE");
  });
  test("an unknown actionCap is a hard violation → deterministic stands", () => {
    const s = buySealed();
    const r = validateGroundedResponse(ev(s), resp(s, { actionCap: "MOON" as never }));
    expect(r.aiIgnored).toBe(true);
    expect(r.effectiveAction).toBe("BUY_CANDIDATE");
  });
});
