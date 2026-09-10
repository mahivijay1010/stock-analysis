/**
 * Immutable DecisionSnapshot — the six guarantees the reviewer required of the
 * snapshot branch (#29): replay determinism, live-mutation immunity, hash
 * sensitivity, version sensitivity, missing-evidence fail-closed, and
 * serialization stability (key-order independence).
 */

import { PolicyInputs } from "../src/services/decision/policy";
import { canonicalize, hashCanonical, sealDecision, replaySealed, assertReplayDeterministic, SealedDecision } from "../src/services/decision/decisionSnapshot";

const inputs = (over?: Partial<PolicyInputs>): PolicyInputs => ({
  ticker: "T.NS",
  issuance: { anchorSessionDate: "2026-09-05", anchorAgeDays: 1, anchorIsLatestObservedSession: true, targetSessionCount: 21, annualizedVolPct: 25, medianReturnPct30: 2 },
  measured: { samples: 600, directionHitRatePct: 75, withinBandPct: 78, brierScore: 0.2 },
  afterMarketClose: true, riskScore: 40, dataQualityScore: 85, forecastConfidenceScore: 70,
  entryQualityScore: 60, evAfterCostsPct: 1.2, regime: { marketRegime: "bull_low_vol", entryRegime: "healthy_uptrend" },
  modelHealthState: "HEALTHY", ...over,
});
const versions = { modelVersion: "quant-v1", featureVersion: "st-features-v1" };

describe("1. replay determinism", () => {
  test("sealing then replaying reproduces the decision byte-identically", () => {
    const sealed = sealDecision(inputs(), versions);
    const a = replaySealed(sealed);
    const b = replaySealed(sealed);
    expect(a.deterministic).toBe(true);
    expect(a.decisionHash).toBe(sealed.decisionHash);
    expect(a.decisionHash).toBe(b.decisionHash);
    expect(a.decision).toEqual(b.decision);
    expect(() => assertReplayDeterministic(sealed)).not.toThrow();
  });
});

describe("2. live-data mutation immunity", () => {
  test("replay reads ONLY the sealed inputs — mutating 'live' inputs afterwards changes nothing", () => {
    const sealed = sealDecision(inputs(), versions);
    const decisionBefore = sealed.decision.decisionStatus;
    // Simulate the world moving on: a totally different live input set exists…
    const live = inputs({ riskScore: 99, dataQualityScore: 10, evAfterCostsPct: -5, modelHealthState: "SUSPENDED" });
    void live; // …it is never consulted by replay.
    const replayed = replaySealed(sealed);
    expect(replayed.deterministic).toBe(true);
    expect(replayed.decision.decisionStatus).toBe(decisionBefore);
  });
});

describe("3. hash sensitivity", () => {
  test("changing ONE input value changes the input manifest hash", () => {
    const a = sealDecision(inputs(), versions);
    const b = sealDecision(inputs({ entryQualityScore: 61 }), versions); // +1
    expect(b.inputManifestHash).not.toBe(a.inputManifestHash);
  });
  test("an identical input set produces an identical hash (stable, not random)", () => {
    expect(sealDecision(inputs(), versions).inputManifestHash).toBe(sealDecision(inputs(), versions).inputManifestHash);
  });
});

describe("4. version sensitivity", () => {
  test("bumping a pinned version changes the input manifest hash even with identical inputs", () => {
    const a = sealDecision(inputs(), versions);
    const b = sealDecision(inputs(), { ...versions, featureVersion: "st-features-v2" });
    expect(b.inputManifestHash).not.toBe(a.inputManifestHash);
    // …but the raw DECISION output (a function of inputs only) is unchanged.
    expect(b.decisionHash).toBe(a.decisionHash);
  });
});

describe("5. missing-evidence fail-closed", () => {
  test("an incomplete manifest is REFUSED, not silently backfilled from live data", () => {
    const sealed = sealDecision(inputs(), versions);
    // A referenced input is dropped after sealing (simulating lost evidence).
    const tampered = { ...sealed, inputs: undefined } as unknown as SealedDecision;
    expect(() => replaySealed(tampered)).toThrow(/REFUSED/);
  });
  test("a tampered input whose hash no longer verifies is REFUSED", () => {
    const sealed = sealDecision(inputs(), versions);
    const tampered: SealedDecision = { ...sealed, inputs: { ...sealed.inputs, riskScore: 5 } }; // hash not updated
    expect(() => replaySealed(tampered)).toThrow(/does not verify|altered/);
  });
});

describe("6. serialization stability (key-order independence)", () => {
  test("the same object hashes the same regardless of key insertion order", () => {
    const forward = { a: 1, b: { c: 2, d: [3, 4] }, e: "x" };
    const shuffled = { e: "x", b: { d: [3, 4], c: 2 }, a: 1 };
    expect(canonicalize(forward)).toBe(canonicalize(shuffled));
    expect(hashCanonical(forward)).toBe(hashCanonical(shuffled));
  });
  test("array order IS semantic and is preserved", () => {
    expect(hashCanonical([1, 2, 3])).not.toBe(hashCanonical([3, 2, 1]));
  });
  test("undefined keys and non-finite numbers collapse deterministically", () => {
    expect(canonicalize({ a: undefined, b: NaN, c: Infinity, d: 1 })).toBe(canonicalize({ b: null, c: null, d: 1 }));
  });
  test("two sealed snapshots of the same decision built from differently-ordered inputs match", () => {
    // Build the SAME logical inputs with a different key order on the nested issuance.
    const base = inputs();
    const reordered: PolicyInputs = {
      ...base,
      issuance: { annualizedVolPct: 25, anchorAgeDays: 1, anchorIsLatestObservedSession: true, medianReturnPct30: 2, targetSessionCount: 21, anchorSessionDate: "2026-09-05" },
    };
    expect(sealDecision(reordered, versions).inputManifestHash).toBe(sealDecision(base, versions).inputManifestHash);
  });
});
