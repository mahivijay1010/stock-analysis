/**
 * V10 B1 — rotating nightly Intelligence refresh: PURE candidate selection
 * (no DB, no HTTP — CronService supplies the freshness data and does the
 * actual throttled refreshing).
 *
 * Policy (SPEC_V10): after the 08:45 IST scan, refresh the
 * ROTATION_BATCH_SIZE (=10) universe tickers with the OLDEST stored
 * intelligence — never-stored tickers count as infinitely old and go first.
 * Any candidate refreshed within the last ROTATION_MIN_AGE_MS (24h) is
 * skipped. Full-universe coverage (151) builds in ~3 weeks at 10/night.
 */

export const ROTATION_BATCH_SIZE = 10;
export const ROTATION_MIN_AGE_MS = 24 * 60 * 60 * 1000; // 24h
/** ≥5s between two NSE refreshes — each one is ~13s of polite scraping already. */
export const ROTATION_THROTTLE_MS = 5_000;

export interface RotationFreshness {
  /** Normalized ticker (no .NS/.BO suffix). */
  ticker: string;
  /** Newest stored metric timestamp; null = never stored (highest priority). */
  lastStoredAt: Date | null;
}

/**
 * Pick the tickers to refresh tonight: the `limit` stalest (never-stored
 * first, then oldest timestamp; ties keep input order), minus any already
 * refreshed within `minAgeMs`.
 */
export function pickRotationCandidates(
  rows: RotationFreshness[],
  now: Date,
  limit: number = ROTATION_BATCH_SIZE,
  minAgeMs: number = ROTATION_MIN_AGE_MS
): string[] {
  const age = (r: RotationFreshness): number =>
    r.lastStoredAt ? r.lastStoredAt.getTime() : Number.NEGATIVE_INFINITY;
  const sorted = rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const ta = age(a.r);
      const tb = age(b.r);
      if (ta === tb) return a.i - b.i; // stable: universe order breaks ties
      return ta < tb ? -1 : 1;
    })
    .map((x) => x.r);
  return sorted
    .slice(0, Math.max(0, limit))
    .filter(
      (r) => r.lastStoredAt === null || now.getTime() - r.lastStoredAt.getTime() >= minAgeMs
    )
    .map((r) => r.ticker);
}
