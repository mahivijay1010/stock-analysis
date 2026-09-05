'use client';

import clsx from 'clsx';
import { ArrowDownRight, ArrowUpRight, Minus, TrendingDown, TrendingUp } from 'lucide-react';
import type { QuantAnalysis, Signal } from '@/lib/types';
import { Card, SectionTitle } from '@/components/ui';
import { useMountSweep } from './anim';

function DirectionIcon({ direction }: { direction: Signal['direction'] }) {
  if (direction === 'bullish') return <TrendingUp className="h-3.5 w-3.5 text-buy" aria-hidden />;
  if (direction === 'bearish') return <TrendingDown className="h-3.5 w-3.5 text-sell" aria-hidden />;
  return <Minus className="h-3.5 w-3.5 text-slate-500" aria-hidden />;
}

const SIGNAL_FILL: Record<Signal['direction'], string> = {
  bullish: 'bg-gradient-to-r from-[#00b894] to-buy',
  bearish: 'bg-gradient-to-r from-[#e11d48] to-sell',
  neutral: 'bg-slate-500/70',
};

/** One signal row: direction icon + name + animated weight bar + weight %. */
function SignalRow({ signal, maxWeight }: { signal: Signal; maxWeight: number }) {
  const ratio = maxWeight > 0 ? Math.max(0, Math.min(1, signal.weight / maxWeight)) : 0;
  const sweep = useMountSweep(ratio);
  return (
    <li className="flex items-center gap-2.5" title={signal.detail}>
      <DirectionIcon direction={signal.direction} />
      <span className="w-40 shrink-0 truncate text-xs text-slate-300 sm:w-48">{signal.name}</span>
      <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/8">
        <div
          className={clsx('meter-fill h-full w-full rounded-full', SIGNAL_FILL[signal.direction])}
          style={{ transform: `scaleX(${sweep})` }}
        />
      </div>
      <span className="w-9 shrink-0 text-right text-[11px] text-slate-500 tabular-nums">
        {Math.round(signal.weight * 100)}%
      </span>
    </li>
  );
}

export function SignalsPanel({ analysis }: { analysis: QuantAnalysis }) {
  const { reasons, signals } = analysis;
  const maxWeight = Math.max(...signals.map((s) => s.weight), 0);

  return (
    <Card className="p-5">
      <SectionTitle>Signals &amp; reasons</SectionTitle>

      <div className="mt-4 grid gap-6 md:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
        <div>
          <p className="text-xs font-medium tracking-wide text-buy uppercase">Working for it</p>
          {reasons.positive.length ? (
            <ul className="mt-2 space-y-2">
              {reasons.positive.map((r, i) => (
                <li key={i} className="flex gap-2 text-sm leading-snug text-slate-300">
                  <ArrowUpRight className="mt-0.5 h-4 w-4 shrink-0 text-buy" aria-hidden />
                  {r}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-slate-500">No positive signals right now.</p>
          )}
        </div>
        <div>
          <p className="text-xs font-medium tracking-wide text-sell uppercase">Working against it</p>
          {reasons.negative.length ? (
            <ul className="mt-2 space-y-2">
              {reasons.negative.map((r, i) => (
                <li key={i} className="flex gap-2 text-sm leading-snug text-slate-300">
                  <ArrowDownRight className="mt-0.5 h-4 w-4 shrink-0 text-sell" aria-hidden />
                  {r}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-slate-500">No negative signals right now.</p>
          )}
        </div>
      </div>

      {signals.length > 0 && (
        <div className="mt-5 border-t border-white/8 pt-4">
          <p className="text-[11px] font-medium tracking-[0.08em] text-slate-500 uppercase">
            Signal weights in the score
          </p>
          <ul className="mt-2.5 space-y-2">
            {signals.map((s, i) => (
              <SignalRow key={`${s.name}-${i}`} signal={s} maxWeight={maxWeight} />
            ))}
          </ul>
          <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
            Hover a row for the exact measured values behind each signal.
          </p>
        </div>
      )}
    </Card>
  );
}
