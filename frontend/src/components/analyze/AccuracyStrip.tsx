'use client';

import { Target } from 'lucide-react';
import type { AnalyzeAccuracy, Horizon } from '@/lib/types';
import { pct, plain } from '@/lib/format';
import { Card } from '@/components/ui';

function hit(accuracy: AnalyzeAccuracy, h: Horizon): number | null {
  const s = accuracy.horizons.find((x) => x.horizonDays === h);
  return s ? s.directionHitRatePct : null;
}

export function AccuracyStrip({
  accuracy,
  onGoToAccuracy,
}: {
  accuracy: AnalyzeAccuracy | null;
  onGoToAccuracy: () => void;
}) {
  if (!accuracy || accuracy.horizons.length === 0) {
    return (
      <Card className="flex items-center gap-3 p-4">
        <Target className="h-5 w-5 shrink-0 text-slate-500" aria-hidden />
        <p className="text-sm text-slate-400">
          Backtest pending for this stock — measured accuracy will appear once the next backtest runs.
        </p>
      </Card>
    );
  }

  const h1 = hit(accuracy, 1);
  const h7 = hit(accuracy, 7);
  const h30 = hit(accuracy, 30);
  const avgErr = accuracy.horizons.reduce((s, x) => s + x.avgAbsErrorPct, 0) / accuracy.horizons.length;

  return (
    <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-3">
        <Target className="mt-0.5 h-5 w-5 shrink-0 text-cyan-400" aria-hidden />
        <p className="text-sm leading-relaxed text-slate-300">
          Backtested over <span className="font-semibold text-slate-100">{accuracy.testDays} days</span>: 1-day
          direction accuracy <span className="font-semibold text-slate-100">{h1 != null ? pct(h1, 0) : '—'}</span>, 7-day{' '}
          <span className="font-semibold text-slate-100">{h7 != null ? pct(h7, 0) : '—'}</span>, 30-day{' '}
          <span className="font-semibold text-slate-100">{h30 != null ? pct(h30, 0) : '—'}</span>, avg error{' '}
          <span className="font-semibold text-slate-100">±{plain(avgErr, 1)}%</span>.
        </p>
      </div>
      <button
        type="button"
        onClick={onGoToAccuracy}
        className="btn-secondary shrink-0 self-start px-3 py-1.5 text-xs sm:self-auto"
      >
        View full accuracy
      </button>
    </Card>
  );
}
