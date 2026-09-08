'use client';

import { useQuery } from '@tanstack/react-query';
import { GitBranch } from 'lucide-react';
import { getForecastVintage } from '@/lib/api';
import { fmtDateTime, inr, signedPct } from '@/lib/format';
import { Card, Chip } from '@/components/ui';

/*
 * Forecast vintages + drift (upgrade Parts 10/11/20): the ORIGINAL issuance is
 * immutable and scored; the CURRENT issuance is a separate vintage; the drift
 * engine says NORMAL / DRIFTING / INVALIDATED with concrete reasons. A stale
 * forecast is never silently re-anchored.
 */

const DRIFT_TONE: Record<string, 'buy' | 'amber' | 'sell'> = {
  NORMAL: 'buy',
  DRIFTING: 'amber',
  INVALIDATED: 'sell',
};

function VintageBlock({ title, v, price }: { title: string; v: NonNullable<Awaited<ReturnType<typeof getForecastVintage>>['original']>; price: number | null }) {
  return (
    <div className="glass-inset flex-1 px-3.5 py-3">
      <p className="text-[10px] font-semibold tracking-[0.14em] text-slate-500 uppercase">{title}</p>
      <div className="mt-2 space-y-1.5 text-xs leading-relaxed">
        <p className="text-slate-400">
          Issued <span className="text-slate-200">{fmtDateTime(v.issuedAt)}</span> · anchor{' '}
          <span className="text-slate-200 tabular-nums">{v.anchorSessionDate}</span> @{' '}
          <span className="text-slate-200 tabular-nums">{inr(v.anchorPrice)}</span>
        </p>
        {v.medianAtToday != null && (
          <p className="text-slate-400">
            Median at today <span className="text-slate-200 tabular-nums">{inr(v.medianAtToday)}</span>
            {price != null && v.errorPct != null && (
              <>
                {' '}
                · error <span className="text-slate-200 tabular-nums">{signedPct(v.errorPct)}</span>
              </>
            )}
          </p>
        )}
        {v.insideBand80 != null && (
          <p className="text-slate-400">
            Inside original 80% interval:{' '}
            <span className={v.insideBand80 ? 'font-semibold text-buy' : 'font-semibold text-sell'}>
              {v.insideBand80 ? 'YES' : 'NO'}
            </span>
          </p>
        )}
        {v.medianReturnPct30 != null && (
          <p className="text-slate-500">30d median forecast return {signedPct(v.medianReturnPct30)} (distribution centre, not a signal)</p>
        )}
      </div>
    </div>
  );
}

export function ForecastVintageCard({ ticker }: { ticker: string }) {
  const q = useQuery({
    queryKey: ['forecast-vintage', ticker],
    queryFn: () => getForecastVintage(ticker),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  if (q.isPending || q.isError || !q.data) return null;
  const d = q.data;
  if (!d.original) return null;
  const sameRun = d.current && d.original.runId === d.current.runId;

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-xs font-medium text-slate-400">
          <GitBranch className="h-4 w-4 text-cyan-300" aria-hidden /> Forecast vintages
          <span className="text-[10px] text-slate-600">originals are immutable — accountability over cosmetics</span>
        </p>
        {d.drift && (
          <Chip tone={DRIFT_TONE[d.drift.state] ?? 'zinc'} glow={d.drift.state === 'INVALIDATED'}>
            Forecast state: {d.drift.state.toLowerCase()}
          </Chip>
        )}
      </div>

      <div className="mt-3 flex flex-col gap-3 sm:flex-row">
        <VintageBlock title="Original forecast" v={d.original} price={d.currentPrice} />
        {!sameRun && d.current && <VintageBlock title="Current forecast" v={d.current} price={d.currentPrice} />}
      </div>

      {d.drift && (
        <ul className="mt-3 space-y-1">
          {d.drift.reasons.map((r, i) => (
            <li key={i} className="text-[11px] leading-relaxed text-slate-500">
              • {r}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
