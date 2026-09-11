/**
 * Snapshot validation, freshness, and multi-source reconciliation — PURE
 * (reviewer: parser-change detection, mandatory freshness, source disagreement).
 *
 * A scraped page that silently changes its markup, or a wrong field, must NEVER
 * become a live BUY. These functions are the firewall: invariants → DATA_INVALID,
 * a missing price → PARSER_ERROR, an unverifiable timestamp → UNKNOWN_FRESHNESS,
 * disagreeing sources → SOURCE_DISAGREEMENT (quarantine). None of them read the
 * network — they judge already-fetched quotes deterministically.
 */

import { RawPriceQuote, MarketSnapshot, FreshnessStatus, SnapshotQuality, Security } from "./marketDataProvider";

export interface ValidationOptions {
  /** A single-session move larger than this (%) is implausible ⇒ DATA_INVALID. */
  maxChangePct: number;
}
export const DEFAULT_VALIDATION: ValidationOptions = { maxChangePct: 30 };

export interface FreshnessOptions {
  /** A source timestamp older than this (ms) ⇒ STALE. */
  maxFreshMs: number;
}
export const DEFAULT_FRESHNESS: FreshnessOptions = { maxFreshMs: 15 * 60_000 };

export interface ReconcileOptions {
  /** Max relative price spread across sources before SOURCE_DISAGREEMENT. */
  relTol: number;
}
export const DEFAULT_RECONCILE: ReconcileOptions = { relTol: 0.01 }; // 1%

export interface QuoteVerdict {
  quality: Extract<SnapshotQuality, "OK" | "DATA_INVALID" | "PARSER_ERROR" | "FAILED">;
  reasons: string[];
}

/** Validate ONE source quote against the invariants. */
export function validateQuote(q: RawPriceQuote, requestedTicker: string, opts: ValidationOptions = DEFAULT_VALIDATION): QuoteVerdict {
  const reasons: string[] = [];
  if (q.fetchError) return { quality: "FAILED", reasons: [`fetch failed: ${q.fetchError}`] };
  if (q.ticker !== requestedTicker) return { quality: "DATA_INVALID", reasons: [`ticker mismatch: got ${q.ticker}, requested ${requestedTicker}`] };
  if (q.price == null || !Number.isFinite(q.price)) return { quality: "PARSER_ERROR", reasons: ["price missing/non-finite — likely a markup/selector change"] };
  if (q.price <= 0) reasons.push("price <= 0");

  const { open, dayHigh: hi, dayLow: lo, volume, changePct } = q;
  if (lo != null && hi != null && lo > hi) reasons.push(`low ${lo} > high ${hi}`);
  if (lo != null && q.price < lo) reasons.push(`price ${q.price} < day low ${lo}`);
  if (hi != null && q.price > hi) reasons.push(`price ${q.price} > day high ${hi}`);
  if (open != null && open <= 0) reasons.push("open <= 0");
  if (volume != null && (!Number.isFinite(volume) || volume < 0)) reasons.push(`volume ${volume} invalid`);
  if (changePct != null && (!Number.isFinite(changePct) || Math.abs(changePct) > opts.maxChangePct)) reasons.push(`changePct ${changePct}% beyond ±${opts.maxChangePct}%`);

  return reasons.length ? { quality: "DATA_INVALID", reasons } : { quality: "OK", reasons: [] };
}

/** Classify a quote's freshness from its source timestamp. */
export function classifyFreshness(q: RawPriceQuote, now: number, opts: FreshnessOptions = DEFAULT_FRESHNESS): { freshness: FreshnessStatus; ageSeconds: number | null } {
  if (q.fetchError) return { freshness: "FAILED", ageSeconds: null };
  if (q.sourceTimestamp == null || !Number.isFinite(q.sourceTimestamp)) return { freshness: "UNKNOWN_FRESHNESS", ageSeconds: null };
  const age = now - q.sourceTimestamp;
  return { freshness: age <= opts.maxFreshMs ? "FRESH" : "STALE", ageSeconds: age / 1000 };
}

/** Reconcile OK prices across sources: agreement within relTol, else disagree. */
export function reconcilePrices(prices: number[], opts: ReconcileOptions = DEFAULT_RECONCILE): { agreed: boolean; price: number | null } {
  const finite = prices.filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
  if (finite.length === 0) return { agreed: false, price: null };
  if (finite.length === 1) return { agreed: true, price: finite[0] };
  const median = finite[Math.floor(finite.length / 2)];
  const spread = (finite[finite.length - 1] - finite[0]) / median;
  return { agreed: spread <= opts.relTol, price: median };
}

export interface BuildSnapshotOptions {
  now: number;
  validation?: ValidationOptions;
  freshness?: FreshnessOptions;
  reconcile?: ReconcileOptions;
}

/**
 * Assemble a normalized MarketSnapshot from N raw source quotes for one
 * security. Deterministic given (quotes, now, opts). Mode is always
 * SCRAPED_SNAPSHOT here — the honest label for a polled reading.
 */
export function buildScrapedSnapshot(security: Security, quotes: RawPriceQuote[], opts: BuildSnapshotOptions): MarketSnapshot {
  const now = opts.now;
  const notes: string[] = [];
  const base: MarketSnapshot = {
    securityId: security.securityId, ticker: security.ticker, mode: "SCRAPED_SNAPSHOT",
    price: null, previousClose: null, open: null, dayHigh: null, dayLow: null, volume: null, changePct: null,
    bid: null, ask: null, fetchedAt: now, sourceTimestamp: null, ageSeconds: null,
    freshness: "FAILED", quality: "FAILED", sources: [], notes,
  };
  if (quotes.length === 0) { notes.push("no sources returned"); return base; }

  const verdicts = quotes.map((q) => ({ q, v: validateQuote(q, security.ticker, opts.validation) }));
  const ok = verdicts.filter((x) => x.v.quality === "OK").map((x) => x.q);
  base.sources = quotes.map((q) => q.source);

  if (ok.length === 0) {
    // Surface the SEVEREST parse problem so the operator knows a selector broke.
    const parser = verdicts.find((x) => x.v.quality === "PARSER_ERROR");
    const invalid = verdicts.find((x) => x.v.quality === "DATA_INVALID");
    const chosen = parser ?? invalid ?? verdicts[0];
    base.quality = chosen.v.quality === "OK" ? "FAILED" : chosen.v.quality;
    base.freshness = base.quality === "FAILED" ? "FAILED" : "UNKNOWN_FRESHNESS";
    notes.push(...chosen.v.reasons);
    return base;
  }

  // Freshest OK quote supplies OHLC/volume; price is reconciled across OK sources.
  const withFreshness = ok.map((q) => ({ q, f: classifyFreshness(q, now, opts.freshness) }));
  withFreshness.sort((a, b) => (b.q.sourceTimestamp ?? -Infinity) - (a.q.sourceTimestamp ?? -Infinity));
  const primary = withFreshness[0];
  const recon = reconcilePrices(ok.map((q) => q.price as number), opts.reconcile);

  base.price = recon.price;
  base.previousClose = primary.q.previousClose ?? null;
  base.open = primary.q.open ?? null;
  base.dayHigh = primary.q.dayHigh ?? null;
  base.dayLow = primary.q.dayLow ?? null;
  base.volume = primary.q.volume ?? null;
  base.bid = primary.q.bid ?? null;
  base.ask = primary.q.ask ?? null;
  base.sourceTimestamp = primary.q.sourceTimestamp ?? null;
  base.freshness = primary.f.freshness;
  base.ageSeconds = primary.f.ageSeconds;
  base.changePct = primary.q.changePct ?? (base.price != null && base.previousClose ? ((base.price - base.previousClose) / base.previousClose) * 100 : null);

  if (!recon.agreed) {
    base.quality = "SOURCE_DISAGREEMENT";
    notes.push(`sources disagree on price beyond ${(opts.reconcile ?? DEFAULT_RECONCILE).relTol * 100}% — quarantined`);
  } else {
    base.quality = "OK";
  }
  return base;
}
