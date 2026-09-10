/**
 * TickValidator (reviewer #2) — a corrupt market tick must NEVER silently enter
 * the indicators. Runs BEFORE bar building. Stateful per security (tracks the
 * last accepted timestamp/sequence) but the decision for a single tick is a
 * pure function of that state, so it is deterministic and replayable.
 */

import { MarketTick, TickValidation } from "./types";

export interface TickValidatorOptions {
  /** Reject ticks older than the last accepted by more than this (ms). */
  maxRegressionMs: number;
  /** Reject ticks whose exchange time is in the future by more than this (ms). */
  maxFutureSkewMs: number;
  /** Reject ticks older than this vs receivedAt (ms) — a stale feed. */
  maxStalenessMs: number;
  /** A sequence jump larger than this is a gap worth surfacing (not silently absorbed). */
  maxSequenceGap: number;
}

export const DEFAULT_TICK_VALIDATOR_OPTIONS: TickValidatorOptions = {
  maxRegressionMs: 2000,
  maxFutureSkewMs: 5000,
  maxStalenessMs: 60000,
  maxSequenceGap: 1,
};

interface PerSecurityState {
  lastTs: number;
  lastSeq: number | null;
  lastKey: string | null; // ts|seq|price to detect exact duplicates
}

export class TickValidator {
  private readonly opts: TickValidatorOptions;
  private readonly state = new Map<string, PerSecurityState>();

  constructor(opts: Partial<TickValidatorOptions> = {}) {
    this.opts = { ...DEFAULT_TICK_VALIDATOR_OPTIONS, ...opts };
  }

  validate(tick: MarketTick): TickValidation {
    // ── shape / value sanity ────────────────────────────────────────────────
    if (!tick || typeof tick.securityId !== "string" || tick.securityId.length === 0) return { status: "INVALID", reason: "missing securityId" };
    if (!Number.isFinite(tick.price)) return { status: "INVALID", reason: "price is not finite" };
    if (tick.price <= 0) return { status: "INVALID", reason: "price <= 0" };
    if (!Number.isFinite(tick.quantity) || tick.quantity < 0) return { status: "INVALID", reason: "quantity < 0 or not finite" };
    if (!Number.isFinite(tick.exchangeTimestamp) || !Number.isFinite(tick.receivedAt)) return { status: "INVALID", reason: "non-finite timestamp" };
    if (tick.bid != null && tick.ask != null && Number.isFinite(tick.bid) && Number.isFinite(tick.ask) && tick.bid > tick.ask) return { status: "INVALID", reason: "crossed book: bid > ask" };
    if (tick.exchangeTimestamp - tick.receivedAt > this.opts.maxFutureSkewMs) return { status: "INVALID", reason: "exchange timestamp in the future" };
    if (tick.receivedAt - tick.exchangeTimestamp > this.opts.maxStalenessMs) return { status: "STALE" };

    const prior = this.state.get(tick.securityId);
    const key = `${tick.exchangeTimestamp}|${tick.sequence ?? "-"}|${tick.price}|${tick.quantity}`;

    if (prior) {
      // Exact duplicate.
      if (prior.lastKey === key) return { status: "DUPLICATE" };
      // Sequence regression / gap (only when both sides carry a sequence).
      if (tick.sequence != null && prior.lastSeq != null) {
        if (tick.sequence <= prior.lastSeq) return { status: "DUPLICATE" };
        const gap = tick.sequence - prior.lastSeq;
        if (gap > this.opts.maxSequenceGap) {
          // Surface the gap but ADVANCE state so we don't wedge forever.
          this.state.set(tick.securityId, { lastTs: Math.max(prior.lastTs, tick.exchangeTimestamp), lastSeq: tick.sequence, lastKey: key });
          return { status: "SEQUENCE_GAP", expected: prior.lastSeq + 1, got: tick.sequence };
        }
      }
      // Timestamp regression beyond tolerance (out-of-order delivery).
      if (tick.exchangeTimestamp < prior.lastTs - this.opts.maxRegressionMs) return { status: "STALE" };
    }

    this.state.set(tick.securityId, {
      lastTs: Math.max(prior?.lastTs ?? tick.exchangeTimestamp, tick.exchangeTimestamp),
      lastSeq: tick.sequence ?? prior?.lastSeq ?? null,
      lastKey: key,
    });
    return { status: "VALID", tick };
  }

  reset(securityId?: string): void {
    if (securityId) this.state.delete(securityId);
    else this.state.clear();
  }
}
