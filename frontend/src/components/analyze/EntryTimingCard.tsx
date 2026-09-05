'use client';

import clsx from 'clsx';
import { Clock3, Hourglass } from 'lucide-react';
import type { EntryTiming } from '@/lib/types';
import { AnimatedNumber, Card, Chip, ENTRY_META, SectionTitle } from '@/components/ui';
import { Tilt } from '@/components/motion';
import { useMountSweep } from './anim';

const BADGE_CLASSES: Record<EntryTiming['action'], string> = {
  BUY_TODAY: 'border-buy/30 bg-buy/10 text-buy shadow-[0_0_24px_rgba(0,212,170,0.32)]',
  WAIT: 'border-amber-400/30 bg-amber-400/10 text-amber-400 shadow-[0_0_24px_rgba(251,191,36,0.32)]',
  AVOID_ENTRY: 'border-sell/30 bg-sell/10 text-sell shadow-[0_0_24px_rgba(255,77,109,0.32)]',
};

const GAUGE_FILL: Record<EntryTiming['action'], string> = {
  BUY_TODAY: 'bg-gradient-to-r from-[#00b894] to-buy',
  WAIT: 'bg-gradient-to-r from-amber-600 to-amber-400',
  AVOID_ENTRY: 'bg-gradient-to-r from-[#e11d48] to-sell',
};

const DOT: Record<EntryTiming['action'], string> = {
  BUY_TODAY: 'bg-buy',
  WAIT: 'bg-amber-400',
  AVOID_ENTRY: 'bg-sell',
};

/** Backend zone cut-offs (entryTiming: BUY_TODAY ≥62 / WAIT 40–61 / AVOID <40). */
const WAIT_AT = 40;
const BUY_AT = 62;

/**
 * The timing gauge: a 0–100 track with the backend's real decision zones
 * tinted underneath (avoid <40 · wait 40–61 · buy ≥62), threshold ticks, and
 * an action-colored fill that sweeps to the score on load (transform-only —
 * snaps instantly under prefers-reduced-motion via the meter-fill CSS).
 */
function TimingGauge({ score, action }: { score: number; action: EntryTiming['action'] }) {
  const sweep = useMountSweep(score / 100);
  const zone = action === 'BUY_TODAY' ? 'buy today' : action === 'WAIT' ? 'wait' : 'avoid entry';

  return (
    <div role="img" aria-label={`Timing score ${Math.round(score)} of 100 — ${zone} zone`}>
      <div className="relative">
        {/* decision zones, tinted to the backend's real cut-offs */}
        <div className="flex h-3 overflow-hidden rounded-full">
          <div className="bg-sell/12" style={{ width: `${WAIT_AT}%` }} aria-hidden />
          <div className="bg-amber-400/12" style={{ width: `${BUY_AT - WAIT_AT}%` }} aria-hidden />
          <div className="flex-1 bg-buy/12" aria-hidden />
        </div>
        {/* animated score fill */}
        <div className="absolute inset-0 overflow-hidden rounded-full" aria-hidden>
          <div
            className={clsx('meter-fill h-full w-full rounded-full', GAUGE_FILL[action])}
            style={{ transform: `scaleX(${sweep})` }}
          />
        </div>
        {/* threshold ticks */}
        <span aria-hidden className="absolute -inset-y-1 w-px bg-white/35" style={{ left: `${WAIT_AT}%` }} />
        <span aria-hidden className="absolute -inset-y-1 w-px bg-white/35" style={{ left: `${BUY_AT}%` }} />
      </div>
      <div className="mt-1.5 flex justify-between text-[10px] text-slate-500 tabular-nums">
        <span>avoid &lt; {WAIT_AT}</span>
        <span>
          wait {WAIT_AT}–{BUY_AT - 1}
        </span>
        <span>buy ≥ {BUY_AT}</span>
      </div>
    </div>
  );
}

/**
 * V5 — "Buy today or wait?" verdict. A timing LEAN layered on measured
 * signals — every reason quotes the real value that moved the score.
 */
export function EntryTimingCard({ timing }: { timing: EntryTiming }) {
  const meta = ENTRY_META[timing.action];
  const score = Math.max(0, Math.min(100, timing.score));

  return (
    <Tilt maxDeg={3}>
      <Card className="p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SectionTitle>Entry timing — buy today or wait?</SectionTitle>
          <Chip tone={timing.newsAware ? 'violet' : 'zinc'}>
            {timing.newsAware ? 'news-aware' : 'technicals only'}
          </Chip>
        </div>

        <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-5">
          <span
            className={clsx(
              'font-display inline-flex shrink-0 items-center gap-2.5 self-start rounded-2xl border px-5 py-2.5 text-2xl font-bold tracking-wide sm:px-6 sm:py-3 sm:text-3xl',
              BADGE_CLASSES[timing.action],
            )}
          >
            <Clock3 className="h-6 w-6 sm:h-7 sm:w-7" aria-hidden />
            {meta.label}
          </span>

          <div className="min-w-0 flex-1">
            {/* Prominent 0–100 zone gauge */}
            <div className="flex items-baseline gap-1.5">
              <AnimatedNumber
                value={Math.round(score)}
                format={(v) => String(Math.round(v))}
                className="font-display text-3xl font-semibold tracking-tight text-slate-100"
              />
              <span className="text-xs text-slate-500">/ 100 timing score</span>
            </div>
            <div className="mt-2">
              <TimingGauge score={score} action={timing.action} />
            </div>
          </div>
        </div>

        {timing.reasons.length > 0 && (
          <ul className="mt-4 space-y-1.5">
            {timing.reasons.map((r, i) => (
              <li key={i} className="flex gap-2 text-sm leading-snug text-slate-400">
                <span className={clsx('mt-1.5 h-1 w-1 shrink-0 rounded-full', DOT[timing.action])} aria-hidden />
                {r}
              </li>
            ))}
          </ul>
        )}

        {timing.waitFor && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-400/25 bg-amber-400/8 px-3.5 py-2.5">
            <Hourglass className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden />
            <p className="text-sm leading-relaxed text-amber-200">
              <span className="font-semibold text-amber-300">What to wait for:</span> {timing.waitFor}
            </p>
          </div>
        )}

        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
          A timing lean built from measured signals — not certainty, not a guarantee.
        </p>
      </Card>
    </Tilt>
  );
}
