'use client';

import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlertTriangle, ArrowLeftRight, BrainCircuit, IndianRupee, Scale, ShieldOff } from 'lucide-react';
import { ApiError, getPositionSize } from '@/lib/api';
import type { KellyInput, PayoffSourceKind } from '@/lib/types';
import { AMOUNT_MAX, AMOUNT_MIN } from '@/lib/types';
import { inrSmart, pct, plain } from '@/lib/format';
import { Card, CardSkeleton, Chip, InfoTip, SectionTitle } from '@/components/ui';
import { KellyAppliedBadge } from '@/components/KellyAppliedBadge';

/** Same key ProjectionsTable persists its ₹ base under — the spec'd default source. */
const PROJ_BASE_KEY = 'stocksense.projBase';
const FALLBACK_CAPITAL = 100_000;

const KELLY_TIP =
  'Kelly criterion: f* = p − (1−p)/b, where p is the measured win rate and b the measured payoff (avg win ÷ avg loss). It maximizes long-run log growth ONLY if p and b are right — which is exactly why the headline here is HALF-Kelly.';

const HALF_TIP =
  'Half-Kelly (f*/2) is the headline on purpose: p and b are estimates with error, and full Kelly overshoots badly when they are optimistic. Halving the fraction keeps roughly 75% of the growth with about half the drawdowns.';

function loadDefaultCapital(): number {
  if (typeof window === 'undefined') return FALLBACK_CAPITAL;
  try {
    const stored = window.localStorage.getItem(PROJ_BASE_KEY);
    const n = stored == null ? NaN : Number(stored);
    return Number.isFinite(n) && n >= AMOUNT_MIN && n <= AMOUNT_MAX ? Math.round(n) : FALLBACK_CAPITAL;
  } catch {
    return FALLBACK_CAPITAL;
  }
}

function parseCapital(raw: string): number | null {
  const cleaned = raw.replace(/[₹,\s]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < AMOUNT_MIN || n > AMOUNT_MAX) return null;
  return Math.round(n);
}

/* ------------------------------------------------------------------ */
/* V10 B3 — payoff-source badge (measured / DCF-implied / structural)  */
/* ------------------------------------------------------------------ */

/**
 * Classify the payoff b provenance from its descriptive source string.
 * Order matters: the structural AND DCF labels both contain "not measured",
 * so 'dcf' → 'structural' → 'measured'. Unknown labels get no badge.
 */
function payoffSourceKind(source: string | null | undefined): PayoffSourceKind | null {
  if (!source) return null;
  const s = source.toLowerCase();
  if (s.includes('dcf')) return 'dcf-implied';
  if (s.includes('structural')) return 'structural';
  if (s.includes('measured') || s.includes('closed desk')) return 'measured';
  return null;
}

const PAYOFF_BADGE: Record<PayoffSourceKind, { label: string; tone: 'emerald' | 'violet' | 'zinc'; title: string }> = {
  measured: {
    label: 'b: measured',
    tone: 'emerald',
    title: 'Payoff b measured from YOUR closed desk trades (avg win ÷ avg loss) — a measured b always wins once usable.',
  },
  'dcf-implied': {
    label: 'b: DCF-implied prior',
    tone: 'violet',
    title:
      'Pre-measurement prior from the stored Intelligence DCF: b = (base-or-bull upside) ÷ |bear downside| vs the current price, clamped 0.5–3.0. Assumption-sensitive, NOT measured — replaced by YOUR measured b once 10 closed trades include both wins and losses.',
  },
  structural: {
    label: 'b: structural 1.5',
    tone: 'zinc',
    title: 'Payoff b is the structural 1.5 assumption from the 3:1 target/stop geometry — stated, not measured.',
  },
};

/** One-line explanation of the DCF prior (SPEC_V10 B3) — shown only when the prior is in play. */
const DCF_PRIOR_LINE =
  'DCF-implied prior: no usable measured payoff yet, so b comes from the stored Intelligence DCF scenarios — ' +
  '(base-or-bull upside) ÷ |bear downside| vs the current price, clamped 0.5–3.0. Assumption-sensitive, not a ' +
  'measurement; YOUR measured b takes over once 10 closed trades include both wins and losses.';

/** "62.0% · per-stock 7d hits · 41 samples" — provenance always visible. */
function InputTile({ label, input, asPct }: { label: string; input: KellyInput; asPct: boolean }) {
  const v = input.value;
  return (
    <div className="glass-inset px-3 py-2.5">
      <p className="text-[11px] text-slate-500">{label}</p>
      <p className="font-display mt-0.5 text-sm font-semibold text-slate-100 tabular-nums">
        {v == null || !Number.isFinite(v) ? '—' : asPct ? pct(v * 100, 1) : plain(v, 2)}
      </p>
      <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
        {input.source}
        {input.samples != null ? ` · ${plain(input.samples, 0)} samples` : ''}
      </p>
    </div>
  );
}

/**
 * V8 R4 — measured-inputs Kelly sizing in the trade-plan area. Capital input
 * (defaults from the projections ₹ base), HALF-Kelly headline with the full-
 * Kelly figure secondary, an explicit zero-edge state when f* ≤ 0, provenance
 * for p and b, and every backend warning. Hidden entirely on a 404 backend.
 */
export function KellySizingCard({ ticker }: { ticker: string }) {
  // This card only renders after the analyze query resolves (client-side),
  // so lazy localStorage initializers carry no hydration risk.
  const [capital, setCapital] = useState<number>(() => loadDefaultCapital());
  const [raw, setRaw] = useState<string>(() => plain(loadDefaultCapital(), 0));

  // Debounce typing → one request per settled value.
  useEffect(() => {
    const t = setTimeout(() => {
      const parsed = parseCapital(raw);
      if (parsed != null) setCapital(parsed);
    }, 600);
    return () => clearTimeout(t);
  }, [raw]);

  const { data, isPending, isFetching, isError, error, refetch } = useQuery({
    queryKey: ['position-size', ticker, capital],
    queryFn: () => getPositionSize(ticker, capital),
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
    retry: (failureCount, err) => !(err instanceof ApiError && err.status === 404) && failureCount < 2,
  });

  if (isError && error instanceof ApiError && error.status === 404) return null;
  if (isPending) return <CardSkeleton lines={3} />;

  const invalid = raw.trim().length > 0 && parseCapital(raw) == null;
  const noEdge = data != null && (data.kellyFraction <= 0 || data.halfKelly <= 0);
  // V9 — adaptive-Kelly fields (absent on older backends → V8 rendering unchanged).
  const v9 = data?.applied != null || data?.measured != null;
  // V10 B3 — payoff provenance badge (classified from the source string; no badge on unknown labels).
  const payoffKind = payoffSourceKind(data?.payoff?.source);
  const payoffBadge = payoffKind != null ? PAYOFF_BADGE[payoffKind] : null;

  return (
    <Card className="p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <SectionTitle>
            <span className="inline-flex flex-wrap items-center gap-1">
              <span>Kelly sizing — measured inputs</span>
              <InfoTip label="How does Kelly sizing work?" text={KELLY_TIP} />
            </span>
          </SectionTitle>
          {data?.applied != null && <KellyAppliedBadge applied={data.applied} className="px-2 py-0.5 text-[10px]" />}
          {payoffBadge && (
            <Chip tone={payoffBadge.tone} title={payoffBadge.title} className="px-2 py-0.5 text-[10px]">
              {payoffKind === 'dcf-implied' && <BrainCircuit className="h-3 w-3" aria-hidden />}
              {payoffBadge.label}
            </Chip>
          )}
        </div>
        <div className="input-wrap relative w-44">
          <IndianRupee
            className="input-icon pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-slate-500"
            aria-hidden
          />
          <input
            type="text"
            inputMode="numeric"
            aria-label="Trading capital in rupees"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            onBlur={() => setRaw(plain(parseCapital(raw) ?? capital, 0))}
            placeholder="capital"
            className="input-glass py-1.5 pr-3 pl-8 text-xs"
          />
        </div>
      </div>
      {invalid && (
        <p className="mt-2 text-xs text-amber-400">
          Enter capital between ₹{plain(AMOUNT_MIN, 0)} and ₹{plain(AMOUNT_MAX, 0)}.
        </p>
      )}

      {isError || !data ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="flex items-start gap-2 text-sm text-slate-400">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden />
            Position sizing unavailable right now{error instanceof Error && error.message ? ` — ${error.message}` : ''}.
          </p>
          <button type="button" onClick={() => refetch()} className="btn-secondary px-3 py-1.5 text-xs">
            Retry
          </button>
        </div>
      ) : (
        <div className={clsx('transition-opacity', isFetching && 'opacity-60')}>
          {noEdge ? (
            <div className="mt-4 flex items-start gap-3 rounded-lg border border-rose-500/25 bg-rose-500/8 px-4 py-3">
              <ShieldOff className="mt-0.5 h-5 w-5 shrink-0 text-rose-400" aria-hidden />
              <div>
                <p className="font-display text-sm font-semibold tracking-wide text-rose-300">
                  No edge measured — Kelly says size zero
                </p>
                <p className="mt-1 text-xs leading-relaxed text-slate-400">
                  {data.recommendation ||
                    'With the measured win rate and payoff, f* ≤ 0: do not size up. Minimum position or skip — sizing cannot rescue a bet with no measured edge.'}
                </p>
              </div>
            </div>
          ) : (
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-[1fr_auto]">
              <div>
                <p className="flex items-center gap-1 text-[11px] font-medium tracking-[0.08em] text-slate-500 uppercase">
                  <span>Half-Kelly — the headline</span>
                  <InfoTip label="Why is half-Kelly the headline?" text={HALF_TIP} />
                </p>
                <p className="font-display mt-1 text-4xl font-semibold tracking-tight text-slate-100 tabular-nums">
                  {pct(data.halfKelly * 100, 1)}{' '}
                  <span className="text-lg text-slate-400">of capital</span>
                </p>
                <p className="mt-1.5 text-sm text-slate-300 tabular-nums">
                  ≈ <span className="font-semibold text-slate-100">{inrSmart(data.recommendedAmount)}</span> on{' '}
                  {inrSmart(data.capital)}
                  {data.sharesAtLivePrice != null && (
                    <span className="text-slate-400">
                      {' '}
                      · {plain(data.sharesAtLivePrice, 0)} share{data.sharesAtLivePrice === 1 ? '' : 's'} at{' '}
                      {data.livePrice != null ? inrSmart(data.livePrice) : 'the live price'}
                    </span>
                  )}
                </p>
              </div>
              <div className="glass-inset h-fit px-4 py-3 sm:text-right">
                <p className="text-[11px] text-slate-500">Full Kelly f* (clamped 0–25%)</p>
                <p className="font-display mt-0.5 text-lg font-semibold text-slate-300 tabular-nums">
                  {pct(data.kellyFraction * 100, 1)}
                </p>
                <p className="mt-0.5 text-[11px] text-slate-500">not the recommendation — estimation error</p>
              </div>
            </div>
          )}

          <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
            {/* V9: these stay the MODEL block — the applied pair may swap in YOUR desk history. */}
            <InputTile label={v9 ? 'Win rate p — model' : 'Win rate p (measured)'} input={data.winRate} asPct />
            <InputTile
              label={
                payoffKind === 'dcf-implied'
                  ? 'Payoff b — DCF-implied prior'
                  : v9
                    ? 'Payoff b — model (avg win / avg loss)'
                    : 'Payoff b = avg win / avg loss'
              }
              input={data.payoff}
              asPct={false}
            />
            <div className="glass-inset px-3 py-2.5">
              <p className="text-[11px] text-slate-500">Formula</p>
              <p className="font-display mt-0.5 text-sm font-semibold text-slate-100">
                f* = p − (1−p)/b
              </p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">headline = f*/2 · clamp [0, 0.25]</p>
            </div>
          </div>

          {/* V10 B3 — one-line prior explanation, only while the DCF prior is actually in play */}
          {payoffKind === 'dcf-implied' && (
            <p className="mt-3 flex items-start gap-2 rounded-lg border border-violet-400/25 bg-violet-400/8 px-3.5 py-2.5 text-xs leading-relaxed text-slate-200">
              <BrainCircuit className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-300" aria-hidden />
              <span>{DCF_PRIOR_LINE}</span>
            </p>
          )}

          {/* V9 — model vs YOUR closed-trade history, verbatim from the backend */}
          {data.comparison && (
            <p className="mt-3 flex items-start gap-2 rounded-lg border border-cyan-400/25 bg-cyan-400/8 px-3.5 py-2.5 text-xs leading-relaxed text-slate-200">
              <ArrowLeftRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cyan-400" aria-hidden />
              <span>{data.comparison}</span>
            </p>
          )}

          {data.warnings.length > 0 && (
            <ul className="mt-3 space-y-1.5">
              {data.warnings.map((w, i) => (
                <li key={i} className="flex items-start gap-2 text-xs leading-relaxed text-amber-400">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  {w}
                </li>
              ))}
            </ul>
          )}

          <p className="mt-3 flex items-start gap-2 text-[11px] leading-relaxed text-slate-500">
            <Scale className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            {data.note ||
              'Kelly maximizes log growth only if p and b are estimated correctly; half-Kelly gives up ~25% of growth to roughly halve the drawdowns.'}
          </p>
        </div>
      )}
    </Card>
  );
}
