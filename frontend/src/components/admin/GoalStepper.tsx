'use client';

import { useEffect, useState } from 'react';
import clsx from 'clsx';
import type { GoalTracker } from '@/lib/types';
import { inrShort, inrSmart, plain, signedPct } from '@/lib/format';
import { AnimatedNumber, Chip } from '@/components/ui';
import { signTone } from './desk-ui';

interface Step {
  day: number;
  target: number;
}

/** Position of the current equity along the evenly-spaced stepper (log interpolation per segment). */
function markerPos(steps: Step[], equity: number): number {
  const n = steps.length;
  if (n < 2 || equity <= 0) return 0;
  if (equity <= steps[0].target) return 0;
  if (equity >= steps[n - 1].target) return 100;
  for (let i = 0; i < n - 1; i++) {
    const a = steps[i].target;
    const b = steps[i + 1].target;
    if (equity >= a && equity < b && a > 0 && b > a) {
      const frac = Math.log(equity / a) / Math.log(b / a);
      return ((i + frac) / (n - 1)) * 100;
    }
  }
  return 0;
}

/** Animate 0 → ratio after mount; .meter-fill transitions the transform and snaps under prefers-reduced-motion. */
function useSweep(ratio: number): number {
  const [sweep, setSweep] = useState(0);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setSweep(ratio));
    return () => cancelAnimationFrame(raf);
  }, [ratio]);
  return sweep;
}

/**
 * The animated milestone path — content-only so the command deck can embed it.
 * The path is ASPIRATIONAL: it only ever renders below the reality check, and
 * the required-vs-achieved daily-rate line stays attached to it.
 */
export function MilestonePath({ goals, startCapital }: { goals: GoalTracker; startCapital: number }) {
  const steps: Step[] = [
    { day: 0, target: startCapital },
    ...[...goals.milestones].sort((a, b) => a.day - b.day),
  ];
  const n = steps.length;
  const pos = markerPos(steps, goals.currentEquity);
  const sweep = useSweep(pos / 100);
  const labelPos = Math.min(88, Math.max(12, pos)); // keep the "You" label inside the card
  const nextIdx = steps.findIndex((s) => goals.currentEquity < s.target);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[11px] font-medium tracking-[0.08em] text-slate-500 uppercase">
          Milestone path <span className="normal-case tracking-normal text-slate-600">(aspirational — see the reality check above)</span>
        </p>
        {goals.onTrack ? <Chip tone="buy">On track</Chip> : <Chip tone="sell">Behind the path</Chip>}
      </div>

      <div className="thin-scroll mt-2 overflow-x-auto">
        <div className="min-w-[480px] px-3 pt-10 pb-1">
          <div className="relative">
            {/* current-equity marker above the track */}
            <div
              className="absolute -top-9 flex -translate-x-1/2 flex-col items-center"
              style={{ left: `${labelPos}%` }}
            >
              <span className="rounded-md border border-cyan-400/40 bg-cyan-400/10 px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap text-cyan-200 shadow-[0_0_12px_rgba(34,211,238,0.25)] backdrop-blur">
                You: <AnimatedNumber value={goals.currentEquity} format={inrSmart} /> · day {goals.currentDay}
              </span>
              <span aria-hidden className="mt-0.5 h-2 w-0.5 rounded bg-cyan-300" />
            </div>

            {/* track — transform-only sweep, snaps under prefers-reduced-motion */}
            <div className="h-1.5 overflow-hidden rounded-full bg-white/8">
              <div
                className="meter-fill h-full w-full rounded-full bg-gradient-to-r from-cyan-400 via-buy to-buy shadow-[0_0_10px_rgba(0,212,170,0.4)]"
                style={{ transform: `scaleX(${sweep})` }}
              />
            </div>

            {/* milestone nodes */}
            {steps.map((s, i) => {
              const achieved = goals.currentEquity >= s.target;
              const isNext = i === nextIdx;
              return (
                <span
                  key={s.day}
                  aria-hidden
                  className={clsx(
                    'absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2',
                    achieved
                      ? 'border-buy bg-buy shadow-[0_0_10px_rgba(0,212,170,0.55)]'
                      : isNext
                        ? 'animate-pulse border-amber-400 bg-[#10141F] shadow-[0_0_10px_rgba(251,191,36,0.45)]'
                        : 'border-slate-600 bg-[#10141F]',
                  )}
                  style={{ left: `${(i / (n - 1)) * 100}%` }}
                />
              );
            })}
          </div>

          {/* node labels */}
          <div className="relative mt-2.5 h-9">
            {steps.map((s, i) => {
              const achieved = goals.currentEquity >= s.target;
              return (
                <div
                  key={s.day}
                  className={clsx(
                    'absolute -translate-x-1/2 text-center',
                    i === 0 && 'translate-x-0 text-left',
                    i === n - 1 && '-translate-x-full text-right',
                  )}
                  style={{ left: `${(i / (n - 1)) * 100}%` }}
                >
                  <p
                    className={clsx(
                      'font-display text-xs font-semibold whitespace-nowrap tabular-nums',
                      achieved ? 'text-buy' : 'text-slate-300',
                    )}
                  >
                    {inrShort(s.target)}
                  </p>
                  <p className="text-[10px] whitespace-nowrap text-slate-500">{s.day === 0 ? 'start' : `day ${s.day}`}</p>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 border-t border-white/8 pt-3 text-xs">
        <p className="text-slate-400">
          Required to next milestone:{' '}
          <span className="font-semibold text-amber-400">
            {plain(goals.requiredDailyReturnPctToNextMilestone, 1)}%/day
          </span>
        </p>
        <p className="text-slate-400">
          Achieved so far:{' '}
          <span className={clsx('font-semibold', signTone(goals.achievedAvgDailyReturnPct))}>
            {signedPct(goals.achievedAvgDailyReturnPct, 2)}/day avg
          </span>
        </p>
      </div>
    </div>
  );
}
