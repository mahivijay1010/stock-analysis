'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Umbrella } from 'lucide-react';
import { ApiError, getPortfolioStress } from '@/lib/api';
import { signedPct } from '@/lib/format';
import { Card, CardSkeleton, ErrorState, InfoTip, SectionTitle } from '@/components/ui';

const STRESS_TIP =
  'Real history replayed, twice: (a) the worst 21-trading-day market windows on record applied to this portfolio via each stock’s beta, and (b) thousands of 21-day blocks resampled from each stock’s own real returns. No synthetic data is generated — and no scenario here is a worst-case guarantee.';

const P5_TIP =
  'Block-bootstrap 21-day drawdown that was exceeded in only ~5% of resampled paths built from real returns — a plausible bad month, not a floor.';
const P1_TIP =
  'Block-bootstrap 21-day drawdown that was exceeded in only ~1% of resampled paths — a rare-but-real bad month, not the worst possible outcome.';

function stressTone(v: number): string {
  if (v < 0) return 'text-rose-400';
  if (v > 0) return 'text-emerald-400';
  return 'text-slate-300';
}

/**
 * V7 — "Stress test" card (SPEC_V7 A4 + A5.3): worst-5 historical scenario
 * bars (rose), block-bootstrap P5/P1 drawdown tiles, the backend's method
 * note and its plain-text hedge hint. Pass tickers+weights (Portfolio uses
 * the suggested allocation, the Desk uses open positions); the card hides
 * itself entirely when the endpoint 404s on an older backend.
 */
export function StressTestCard({
  tickers,
  weights,
  title = 'Stress test — how bad could 21 days get?',
}: {
  tickers?: string[];
  weights?: number[];
  title?: string;
}) {
  const tickerKey = tickers?.join(',') ?? '';
  const weightKey = weights?.map((w) => (Number.isFinite(w) ? w.toFixed(4) : 'x')).join(',') ?? '';

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ['portfolio-stress', tickerKey, weightKey],
    queryFn: () => getPortfolioStress(tickers, weights),
    staleTime: 5 * 60_000,
    retry: (failureCount, err) => !(err instanceof ApiError && err.status === 404) && failureCount < 2,
  });

  const scenarios = useMemo(
    () =>
      (Array.isArray(data?.scenarios) ? data.scenarios : [])
        .filter((s) => s && typeof s.portfolioReturnPct === 'number' && Number.isFinite(s.portfolioReturnPct))
        .slice(0, 5),
    [data],
  );
  const maxAbs = Math.max(...scenarios.map((s) => Math.abs(s.portfolioReturnPct)), 0.0001);

  // Old backend without /api/portfolio/stress → hide the whole card.
  if (isError && error instanceof ApiError && error.status === 404) return null;

  if (isPending) return <CardSkeleton lines={4} />;

  if (isError || !data) {
    return (
      <ErrorState
        compact
        message={error instanceof Error ? error.message : 'Failed to load the stress test'}
        onRetry={() => refetch()}
      />
    );
  }

  const p5 = Number.isFinite(data.p5DrawdownPct) ? data.p5DrawdownPct : null;
  const p1 = Number.isFinite(data.p1DrawdownPct) ? data.p1DrawdownPct : null;

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionTitle>
          <span className="inline-flex flex-wrap items-center gap-1">
            <span>{title}</span>
            <InfoTip label="How is this stress test built?" text={STRESS_TIP} />
          </span>
        </SectionTitle>
      </div>
      <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-400">
        Two honest views of the same question: what did the worst real market windows do to a portfolio like this,
        and how deep do resampled 21-day paths from these stocks&apos; own returns go?
        {tickers && tickers.length > 0 && (
          <span className="text-slate-500"> Portfolio: {tickers.join(', ')}.</span>
        )}
      </p>
      {/* Method provenance is a long sentence — a wrapping caption, never a
          nowrap chip (a chip here forced ~1,558px of horizontal overflow the
          moment the desk had an open position). */}
      {data.method && <p className="mt-1.5 max-w-3xl text-xs leading-relaxed text-slate-500">method — {data.method}</p>}

      {/* (a) Worst historical scenarios — rose bars */}
      {scenarios.length === 0 ? (
        <p className="mt-4 text-sm text-slate-400">No historical stress scenarios available yet.</p>
      ) : (
        <ul className="mt-4 space-y-2.5">
          {scenarios.map((s, i) => (
            <li key={`${s.label}-${i}`} className="flex items-center gap-3">
              <span className="w-36 shrink-0 truncate text-xs text-slate-400 sm:w-56" title={s.label}>
                {s.label}
              </span>
              <div className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/8">
                <div
                  className={clsx(
                    'h-full rounded-full transition-[width] duration-300',
                    s.portfolioReturnPct < 0
                      ? 'bg-gradient-to-r from-rose-600 to-rose-400'
                      : 'bg-gradient-to-r from-emerald-600 to-emerald-400',
                  )}
                  style={{ width: `${Math.max(2, Math.min(100, (Math.abs(s.portfolioReturnPct) / maxAbs) * 100))}%` }}
                />
              </div>
              <span className={clsx('w-16 shrink-0 text-right text-sm font-semibold tabular-nums', stressTone(s.portfolioReturnPct))}>
                {signedPct(s.portfolioReturnPct, 1)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* (b) Block-bootstrap drawdown tiles */}
      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="glass-inset p-4">
          <p className="flex items-center gap-1 text-[11px] font-medium tracking-[0.08em] text-slate-500 uppercase">
            <span className="min-w-0">P5 drawdown · 21d</span>
            <InfoTip label="What does P5 drawdown mean?" text={P5_TIP} />
          </p>
          <p className={clsx('font-display mt-1.5 text-2xl font-semibold tracking-tight tabular-nums', p5 != null ? stressTone(p5) : 'text-slate-500')}>
            {p5 != null ? signedPct(p5, 1) : '—'}
          </p>
          <p className="mt-1 text-xs text-slate-500">worse only ~5% of resampled paths</p>
        </div>
        <div className="glass-inset p-4">
          <p className="flex items-center gap-1 text-[11px] font-medium tracking-[0.08em] text-slate-500 uppercase">
            <span className="min-w-0">P1 drawdown · 21d</span>
            <InfoTip label="What does P1 drawdown mean?" text={P1_TIP} align="right" />
          </p>
          <p className={clsx('font-display mt-1.5 text-2xl font-semibold tracking-tight tabular-nums', p1 != null ? stressTone(p1) : 'text-slate-500')}>
            {p1 != null ? signedPct(p1, 1) : '—'}
          </p>
          <p className="mt-1 text-xs text-slate-500">worse only ~1% of resampled paths</p>
        </div>
      </div>

      {/* (c) Hedge hint — plain-text risk reduction, never options advice */}
      {data.hedgeHint && (
        <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-400/25 bg-amber-400/8 px-3.5 py-2.5">
          <Umbrella className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden />
          <p className="text-sm leading-relaxed text-amber-200">
            <span className="font-semibold text-amber-300">Hedge hint:</span> {data.hedgeHint}
          </p>
        </div>
      )}

      {/* (d) Method note — backend text verbatim */}
      {data.note && <p className="mt-3 text-[11px] leading-relaxed text-slate-500">{data.note}</p>}
    </Card>
  );
}
