/**
 * Immutable DecisionSnapshot core (reviewer's next-branch #29) — PURE.
 *
 * A snapshot SEALS the exact inputs a deterministic gate saw, pins every
 * version that changes what the decision MEANS, and hashes both canonically.
 * The guarantee we buy:
 *
 *     same sealed snapshot  +  same gate code/version  =  same decision
 *
 * Replay re-runs the pure gate on the SEALED inputs only — it NEVER reads live
 * prices/fundamentals/events. That makes a replayed decision immune to later
 * live-data mutation, and lets any downstream (shadow ledger, AI grounding,
 * audit) refer to one immutable evidence object.
 *
 * The gate we pin today is `evaluateEntryPolicy` (the deterministic TradeGate).
 * The realtime layer, when it lands, seals the SAME way against its own inputs;
 * this module is the shared primitive.
 */

import { createHash } from "crypto";
import { evaluateEntryPolicy, PolicyInputs, PolicyDecision, DECISION_POLICY_VERSION } from "./policy";

/**
 * Deterministic, key-order-independent serialization. Object keys are sorted
 * recursively so `{a,b}` and `{b,a}` hash identically (reviewer test #6 — the
 * one that's easy to get wrong by hashing raw JSON.stringify). Arrays keep
 * their order (it is semantic). undefined/function/symbol collapse to null, as
 * do non-finite numbers, so the output is always valid and stable.
 */
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  const t = typeof value;
  if (t === "number") return Number.isFinite(value as number) ? JSON.stringify(value) : "null";
  if (t === "boolean" || t === "string") return JSON.stringify(value);
  if (t !== "object") return "null"; // function / symbol
  if (Array.isArray(value)) return "[" + value.map((v) => canonicalize(v)).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
}

/** SHA-256 of the canonical form. */
export function hashCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

/** Every version axis that changes what the sealed decision means. */
export interface SnapshotVersions {
  decisionPolicyVersion: string;
  modelVersion: string;
  featureVersion?: string;
  policyVersion?: string;
  costModelVersion?: string;
  regimePolicyVersion?: string;
}

export interface SealedDecision {
  versionManifest: SnapshotVersions;
  /** The EXACT inputs the gate saw — the snapshot is self-contained. */
  inputs: PolicyInputs;
  /** sha256 over {versions, inputs} — changes if ANY input or version changes. */
  inputManifestHash: string;
  decision: PolicyDecision;
  /** sha256 over the decision output — the replay-verification target. */
  decisionHash: string;
}

function manifestHash(versions: SnapshotVersions, inputs: PolicyInputs): string {
  // Namespaced so a version and an input with the same shape can't collide.
  return hashCanonical({ versions, inputs });
}

/**
 * Seal a decision: run the pure gate on `inputs` and hash the manifest + output.
 * `versions.decisionPolicyVersion` defaults to the code's current constant so a
 * caller can't accidentally pin the wrong policy version.
 */
export function sealDecision(inputs: PolicyInputs, versions: Omit<SnapshotVersions, "decisionPolicyVersion"> & { decisionPolicyVersion?: string }): SealedDecision {
  const versionManifest: SnapshotVersions = { decisionPolicyVersion: DECISION_POLICY_VERSION, ...versions };
  const decision = evaluateEntryPolicy(inputs);
  return {
    versionManifest,
    inputs,
    inputManifestHash: manifestHash(versionManifest, inputs),
    decision,
    decisionHash: hashCanonical(decision),
  };
}

export interface ReplayResult {
  decision: PolicyDecision;
  decisionHash: string;
  recomputedInputHash: string;
  /** The sealed decision reproduced byte-identically (hash match). */
  deterministic: boolean;
}

/**
 * Replay a sealed snapshot against the CURRENT gate code, reading ONLY the
 * sealed inputs. Fail-closed:
 *  - a malformed/incomplete manifest is REFUSED (we never fetch live data to
 *    fill a gap — reviewer test #5),
 *  - a manifest whose input hash no longer verifies is REFUSED (the snapshot
 *    was altered — immutability breach).
 */
export function replaySealed(sealed: SealedDecision): ReplayResult {
  if (!sealed || typeof sealed !== "object" || !sealed.inputs || !sealed.versionManifest || typeof sealed.inputManifestHash !== "string") {
    throw new Error("DecisionSnapshot replay REFUSED: manifest is incomplete — refusing to fetch current data to fill the gap (fail-closed).");
  }
  const recomputedInputHash = manifestHash(sealed.versionManifest, sealed.inputs);
  if (recomputedInputHash !== sealed.inputManifestHash) {
    throw new Error("DecisionSnapshot replay REFUSED: sealed input manifest hash does not verify — the snapshot was altered since it was sealed.");
  }
  const decision = evaluateEntryPolicy(sealed.inputs); // ONLY the sealed inputs — no live reads
  const decisionHash = hashCanonical(decision);
  return { decision, decisionHash, recomputedInputHash, deterministic: decisionHash === sealed.decisionHash };
}

/** Replay and throw unless the decision reproduces byte-identically. */
export function assertReplayDeterministic(sealed: SealedDecision): ReplayResult {
  const r = replaySealed(sealed);
  if (!r.deterministic) {
    throw new Error(`DecisionSnapshot NON-DETERMINISTIC replay: decision hash ${r.decisionHash} ≠ sealed ${sealed.decisionHash} — the gate code changed without a version bump.`);
  }
  return r;
}
