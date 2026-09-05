'use client';

import { useId } from 'react';
import clsx from 'clsx';
import type { Bar } from '@/lib/types';
import { fmtDateShort, inr, signedPct } from '@/lib/format';
import { Card } from '@/components/ui';
import { signTone } from './tone';

const WINDOWS = [
  { label: '7 days', days: 7 },
  { label: '15 days', days: 15 },
  { label: '30 days', days: 30 },
  { label: '3 months', days: 92 },
] as const;

/** date (YYYY-MM-DD) − n calendar days → YYYY-MM-DD. */
function minusDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
}

/** Inline sparkline of closes — pure presentation of the same real bars the chart uses. */
function WindowSparkline({ closes, positive }: { closes: number[]; positive: boolean }) {
  const gradId = useId();
  const w = 220;
  const h = 32;
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const pts = closes.map((c, i) => {
    const x = (i / Math.max(1, closes.length - 1)) * w;
    const y = h - 3 - ((c - min) / span) * (h - 6);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const stroke = positive ? 'var(--accent-buy)' : 'var(--accent-sell)';
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-10 w-full" aria-hidden>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${h} ${pts.join(' ')} ${w},${h}`} fill={`url(#${gradId})`} />
      <polyline points={pts.join(' ')} fill="none" stroke={stroke} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * "See it yourself" — how the price actually moved over the recent windows,
 * as one compact strip. Sliced client-side from the same ~250 real daily
 * bars the analysis used; real closes, never predictions.
 */
export function RecentWindowsPanel({ bars, currentPrice }: { bars: Bar[]; currentPrice: number }) {
  if (bars.length < 2) return null;
  const lastDate = bars[bars.length - 1].date;

  const cards = WINDOWS.map(({ label, days }) => {
    const cutoff = minusDays(lastDate, days);
    const slice = bars.filter((b) => b.date >= cutoff);
    if (slice.length < 2) return null;
    const first = slice[0];
    const last = slice[slice.length - 1];
    const changePct = first.close > 0 ? (last.close / first.close - 1) * 100 : 0;
    return { label, slice, first, last, changePct };
  }).filter((c): c is NonNullable<typeof c> => c !== null);

  if (cards.length === 0) return null;

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs font-semibold tracking-[0.08em] text-slate-400 uppercase">
          Recent performance — see it yourself
        </p>
        <p className="text-xs text-slate-500">
          current <span className="font-semibold text-slate-300 tabular-nums">{inr(currentPrice)}</span> · real daily
          closes, not predictions
        </p>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        {cards.map((c) => (
          <div key={c.label} className="recent-window-card glass-inset min-w-0 px-4 py-3">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-xs font-semibold text-slate-300">{c.label}</p>
              <p className={clsx('font-display text-base font-semibold tabular-nums', signTone(c.changePct))}>
                {signedPct(c.changePct)}
              </p>
            </div>
            <WindowSparkline closes={c.slice.map((b) => b.close)} positive={c.changePct >= 0} />
            <p className="mt-1 truncate text-[10px] text-slate-500 tabular-nums">
              {fmtDateShort(c.first.date)} {inr(c.first.close)} → {fmtDateShort(c.last.date)} {inr(c.last.close)}
            </p>
          </div>
        ))}
      </div>
    </Card>
  );
}
