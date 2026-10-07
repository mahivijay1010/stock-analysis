'use client';

import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Activity, ArrowRight } from 'lucide-react';
import { getOutcomeReview, OutcomeReview, CalibrationReport } from '@/lib/api';

/**
 * Predicted vs happened — the feedback loop. The only surface that answers
 * "is any of this actually working?" It reads the matured ledgers and shows
 * the calibration curve (do the probabilities mean what they say), realized
 * hit rates with Wilson bounds, 80%-band coverage, which lanes have nothing
 * graded yet, and the biggest surprises — where the learning is.
 */

const RELIABILITY_META: Record<string, { label: string; tone: string }> = {
  WELL_CALIBRATED: { label: 'Well calibrated', tone: 'text-emerald-300' },
  OVERCONFIDENT: { label: 'Overconfident', tone: 'text-rose-300' },
  UNDERCONFIDENT: { label: 'Underconfident', tone: 'text-amber-300' },
  INSUFFICIENT: { label: 'Insufficient data', tone: 'text-slate-400' },
};

/** Reliability diagram: predicted probability (x) vs actual win rate (y), with
 *  the perfect-calibration diagonal. Dots above the line = pessimistic, below
 *  = overconfident. Dot area ∝ bin count. Pure SVG, no deps. */
function ReliabilityDiagram({ cal }: { cal: CalibrationReport }) {
  const S = 220;
  const pad = 28;
  const plot = S - pad * 2;
  const x = (p: number) => pad + p * plot;
  const y = (p: number) => S - pad - p * plot;
  const pts = cal.bins.filter((b) => b.actualRate != null && b.predictedMean != null);
  const maxCount = Math.max(1, ...pts.map((b) => b.count));
  return (
    <svg viewBox={`0 0 ${S} ${S}`} className="w-full max-w-[280px]" role="img" aria-label="Calibration reliability diagram">
      {/* grid */}
      {[0, 0.25, 0.5, 0.75, 1].map((g) => (
        <g key={g}>
          <line x1={x(g)} y1={y(0)} x2={x(g)} y2={y(1)} stroke="rgba(255,255,255,0.06)" />
          <line x1={x(0)} y1={y(g)} x2={x(1)} y2={y(g)} stroke="rgba(255,255,255,0.06)" />
        </g>
      ))}
      {/* perfect-calibration diagonal */}
      <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} stroke="rgba(148,163,184,0.5)" strokeDasharray="4 3" />
      {/* bin dots */}
      {pts.map((b, i) => (
        <circle
          key={i}
          cx={x(b.predictedMean!)}
          cy={y(b.actualRate!)}
          r={3 + 5 * Math.sqrt(b.count / maxCount)}
          fill={b.actualRate! < b.predictedMean! ? 'rgba(244,63,94,0.7)' : 'rgba(58,214,200,0.7)'}
          stroke="rgba(255,255,255,0.25)"
        />
      ))}
      {/* axis labels */}
      <text x={S / 2} y={S - 6} textAnchor="middle" className="fill-slate-500 text-[9px]">predicted probability →</text>
      <text x={10} y={S / 2} textAnchor="middle" transform={`rotate(-90 10 ${S / 2})`} className="fill-slate-500 text-[9px]">actual win rate →</text>
    </svg>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5">
      <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className={clsx('mt-0.5 font-semibold tabular-nums', tone ?? 'text-slate-200')}>{value}</p>
      {sub && <p className="text-[10px] text-slate-600">{sub}</p>}
    </div>
  );
}

export function OutcomeReviewPanel() {
  const { data, isLoading, isError } = useQuery<OutcomeReview>({ queryKey: ['outcome-review'], queryFn: getOutcomeReview, staleTime: 300_000 });
  if (isLoading) return <section className="rounded-xl border border-white/10 bg-white/[0.02] p-4 text-xs text-slate-500">Loading the feedback loop…</section>;
  if (isError || !data) return null;

  const a = data.laneA;
  const rel = RELIABILITY_META[a.calibration.reliability] ?? RELIABILITY_META.INSUFFICIENT;

  return (
    <section className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <div className="flex items-center gap-2">
        <Activity className="h-4 w-4 text-sky-400" aria-hidden />
        <h2 className="font-display text-sm font-semibold tracking-wide text-slate-200">Predicted vs happened — the feedback loop</h2>
      </div>
      <p className="mt-1 text-xs text-slate-400">{data.headline}</p>

      <div className="mt-3 grid gap-4 lg:grid-cols-[280px_1fr]">
        <div>
          <ReliabilityDiagram cal={a.calibration} />
          <p className="mt-1 text-center text-[11px]">
            <span className={rel.tone}>{rel.label}</span>
            <span className="text-slate-600"> · ECE {a.calibration.ece ?? '—'} · Brier {a.calibration.brier ?? '—'}</span>
          </p>
          <p className="mt-1 text-center text-[10px] text-slate-600">
            dots below the diagonal = overconfident; size ∝ sample
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
          <Stat label="Matured" value={String(a.graded)} sub="Lane A predictions" />
          <Stat label="Hit rate" value={a.overallHitRatePct != null ? `${a.overallHitRatePct}%` : '—'} sub={a.overallHitWilsonLb95Pct != null ? `Wilson LB ${a.overallHitWilsonLb95Pct}%` : undefined} tone={(a.overallHitRatePct ?? 0) < 55 ? 'text-amber-300' : 'text-emerald-300'} />
          <Stat label="Pred vs actual" value={`${a.meanPredictedReturnPct ?? '—'}% / ${a.meanActualReturnPct ?? '—'}%`} sub="mean expected / realized" />
          <Stat label="80% band" value={a.band80CoveragePct != null ? `${a.band80CoveragePct}%` : '—'} sub="actual landed inside" />
        </div>
      </div>

      {/* Hit rate by recommendation */}
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div>
          <p className="mb-1.5 text-[11px] uppercase tracking-wide text-slate-500">By recommendation</p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <tbody className="divide-y divide-white/5">
                {a.byRecommendation.map((c) => (
                  <tr key={c.key}>
                    <td className="py-1.5 text-slate-300">{c.key}</td>
                    <td className="py-1.5 text-right tabular-nums text-slate-400">n={c.n}</td>
                    <td className="py-1.5 text-right tabular-nums">
                      <span className={c.hitRatePct < 50 ? 'text-rose-300' : 'text-emerald-300'}>{c.hitRatePct}%</span>
                      <span className="text-slate-600"> (LB {c.wilsonLb95Pct}%)</span>
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-slate-500">{c.meanActualReturnPct}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Lane maturity */}
        <div>
          <p className="mb-1.5 text-[11px] uppercase tracking-wide text-slate-500">What&apos;s graded where</p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <tbody className="divide-y divide-white/5">
                {data.lanes.map((l) => (
                  <tr key={l.lane}>
                    <td className="py-1.5 text-slate-300">{l.lane}</td>
                    <td className="py-1.5 text-right tabular-nums text-slate-400">{l.graded}/{l.logged}</td>
                    <td className="py-1.5 pl-2 text-[10px] text-slate-600">{l.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Decisions worth reviewing */}
      {a.surprises.length > 0 && (
        <div className="mt-4">
          <p className="mb-1.5 text-[11px] uppercase tracking-wide text-slate-500">Decisions worth reviewing — biggest surprises</p>
          <div className="flex flex-col gap-1">
            {a.surprises.slice(0, 6).map((s, i) => (
              <div key={i} className="flex items-center justify-between gap-2 rounded-lg border border-white/8 bg-white/[0.02] px-3 py-1.5 text-[11px]">
                <span className="font-medium text-slate-200">{s.ticker.replace('.NS', '')}</span>
                <span className="flex items-center gap-1.5 text-slate-400">
                  <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px]">{s.recommendation}</span>
                  <span className="tabular-nums text-slate-500">{s.predictedReturnPct}%</span>
                  <ArrowRight className="h-3 w-3 text-slate-600" aria-hidden />
                  <span className={clsx('tabular-nums font-medium', (s.actualReturnPct ?? 0) < 0 ? 'text-rose-300' : 'text-emerald-300')}>{s.actualReturnPct}%</span>
                </span>
                <span className="text-[10px] text-slate-600">{s.kind}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="mt-3 border-t border-white/10 pt-2.5 text-[11px] leading-relaxed text-slate-600">{data.caveat}</p>
    </section>
  );
}
