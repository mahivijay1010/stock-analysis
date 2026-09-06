// Honest quote-freshness labeling (upgrade-audit §1.4 / R11): the backend's
// `dataStatus: "live"` can ride on a weekend-cached Friday close, so the UI
// derives its own label from the quote timestamp instead of trusting the flag.
// The real freshness contract (quoteTimestamp/quoteType/marketState/…) arrives
// with Phase C; until then this is a conservative client-side read.

import type { Quote } from './types';

export type FreshnessKind = 'live' | 'today' | 'stale-close';

export interface Freshness {
  kind: FreshnessKind;
  /** Short honest label, e.g. "live · 14:32" or "close of Fri, 4 Sep". */
  label: string;
  /** Longer explanation for tooltips/captions. */
  detail: string;
}

const IST_TZ = 'Asia/Kolkata';

function istDateKey(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: IST_TZ }); // YYYY-MM-DD
}

function istTime(d: Date): string {
  return d.toLocaleTimeString('en-IN', { timeZone: IST_TZ, hour: 'numeric', minute: '2-digit' });
}

function istDayLabel(d: Date): string {
  return d.toLocaleDateString('en-IN', { timeZone: IST_TZ, weekday: 'short', day: 'numeric', month: 'short' });
}

/**
 * Classify a quote's freshness from its own timestamp (IST product dates).
 * Never returns "live" for a previous session's cached close.
 */
export function quoteFreshness(quote: Pick<Quote, 'asOf' | 'marketState'>): Freshness {
  const asOf = new Date(quote.asOf);
  if (Number.isNaN(asOf.getTime())) {
    return { kind: 'stale-close', label: 'timestamp unknown', detail: 'The quote timestamp could not be parsed.' };
  }
  const now = new Date();
  const sameIstDay = istDateKey(asOf) === istDateKey(now);
  const ageMin = (now.getTime() - asOf.getTime()) / 60_000;
  const marketOpen = typeof quote.marketState === 'string' && /^(REGULAR|OPEN)$/i.test(quote.marketState);

  if (sameIstDay && marketOpen && ageMin <= 20) {
    return {
      kind: 'live',
      label: `live · ${istTime(asOf)} IST`,
      detail: 'Quote observed within the last 20 minutes during market hours.',
    };
  }
  if (sameIstDay) {
    return {
      kind: 'today',
      label: `today ${istTime(asOf)} IST`,
      detail: 'Observed earlier today — not a live tick.',
    };
  }
  return {
    kind: 'stale-close',
    label: `close of ${istDayLabel(asOf)}`,
    detail: `Cached close from ${istDayLabel(asOf)} (${istTime(asOf)} IST) — the market has not traded since, or fresher data was unavailable.`,
  };
}
