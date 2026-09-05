'use client';

import { useMemo } from 'react';
import clsx from 'clsx';
import { Boxes } from 'lucide-react';
import type { EnsembleBlock, EnsembleWeightRow } from '@/lib/types';
import { blendedProbUpAt, contributionLines, modelLabel } from '@/lib/models';
import { pct, plain } from '@/lib/format';
import { Card, Chip, InfoTip, SectionTitle } from '@/components/ui';
import { useMountSweep } from './anim';

const ENSEMBLE_TIP =
  'Six fixed-form models each state P(up); their votes are blended with inverse-Brier weights — the models that have measurably been closest to reality for THIS stock get the loudest vote. Weights come from walk-forward backtests (and online updates), never from opinion.';

const CONTRIBUTION_TIP =
  "The best model's own arithmetic: how much each z-scored feature moved its stated probability. Real explainability of the model — NOT a causal claim about the market.";

function fmtBrier(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? '—' : v.toFixed(4);
}

/** One inverse-Brier weight row — the bar sweeps in on load (meter-fill). */
function WeightRow({ w, isBest, maxWeight }: { w: EnsembleWeightRow; isBest: boolean; maxWeight: number }) {
  const sweep = useMountSweep(maxWeight > 0 ? w.weightPct / maxWeight : 0);
  return (
    <li className="flex items-center gap-3">
      <span
        className={clsx('w-28 shrink-0 truncate text-xs', isBest ? 'font-medium text-slate-200' : 'text-slate-400')}
        title={w.model}
      >
        {modelLabel(w.model)}
      </span>
      <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-white/8">
        <div
          className={clsx(
            'meter-fill h-full w-full rounded-full',
            isBest
              ? 'bg-gradient-to-r from-cyan-400 to-violet-400 shadow-[0_0_10px_rgba(34,211,238,0.35)]'
              : 'bg-gradient-to-r from-cyan-700 to-cyan-500',
          )}
          style={{ transform: `scaleX(${sweep})` }}
        />
      </div>
      <span className="w-11 shrink-0 text-right text-xs font-semibold text-slate-200 tabular-nums">
        {pct(Math.max(0, w.weightPct), 0)}
      </span>
      <span
        className="hidden w-20 shrink-0 text-right text-[11px] text-slate-500 tabular-nums sm:block"
        title={w.brier != null ? `Walk-forward Brier ${fmtBrier(w.brier)} (lower is better)` : 'No stored Brier for this model yet'}
      >
        {w.brier != null ? `B ${w.brier.toFixed(3)}` : '—'}
      </span>
    </li>
  );
}

/**
 * V7 — "Model ensemble" row under EntryTimingCard (SPEC_V7 A5.2): best-model
 * chip (name + Brier + samples), horizontal inverse-Brier weight bars per
 * model, the blended P(up, 7d), and the best model's exact feature
 * contributions when the backend provides them. Renders nothing when the
 * block carries no usable content (all fields optional-tolerant).
 */
export function EnsembleCard({ ensemble }: { ensemble: EnsembleBlock }) {
  const weights = useMemo(
    () =>
      (Array.isArray(ensemble.weights) ? ensemble.weights : [])
        .filter((w) => w && typeof w.model === 'string' && typeof w.weightPct === 'number' && Number.isFinite(w.weightPct))
        .slice()
        .sort((a, b) => b.weightPct - a.weightPct),
    [ensemble],
  );
  const best = ensemble.bestModel ?? null;
  const p7 = blendedProbUpAt(ensemble, 7);
  const contributions = useMemo(() => contributionLines(ensemble).slice(0, 8), [ensemble]);
  const maxWeight = Math.max(...weights.map((w) => w.weightPct), 1);

  if (!best && weights.length === 0 && p7 == null) return null;

  return (
    <Card className="p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionTitle>
          <span className="inline-flex flex-wrap items-center gap-1">
            <span>Model ensemble — who gets a vote?</span>
            <InfoTip label="How does the model ensemble work?" text={ENSEMBLE_TIP} />
          </span>
        </SectionTitle>
        {best ? (
          <Chip tone="violet" glow title="Lowest walk-forward Brier for this stock — the model the blend trusts most">
            <Boxes className="h-3.5 w-3.5" aria-hidden />
            best: {modelLabel(best.name)} · Brier {fmtBrier(best.brier)}
            {Number.isFinite(best.samples) ? ` · ${plain(best.samples, 0)} samples` : ''}
          </Chip>
        ) : (
          <Chip tone="zinc" title="No stored per-model stats yet — every model gets an equal vote">
            equal weights — no stored stats yet
          </Chip>
        )}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-5 lg:grid-cols-[1fr_260px]">
        {/* Inverse-Brier weight bars per model (sweep in on load) */}
        {weights.length > 0 && (
          <ul className="min-w-0 space-y-2.5">
            {weights.map((w) => (
              <WeightRow key={w.model} w={w} isBest={best != null && w.model === best.name} maxWeight={maxWeight} />
            ))}
          </ul>
        )}

        {/* Blended probability tile */}
        <div className="glass-inset h-fit p-4">
          <p className="text-[11px] font-medium tracking-[0.08em] text-slate-500 uppercase">Blended P(up, 7d)</p>
          <p className="font-display mt-1.5 text-3xl font-semibold tracking-tight text-slate-100 tabular-nums">
            {p7 != null ? pct(p7 * 100, 0) : '—'}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">
            {weights.length > 0
              ? `inverse-Brier-weighted vote of ${weights.length} model${weights.length === 1 ? '' : 's'}`
              : 'blended vote of the model pool'}
          </p>
        </div>
      </div>

      {/* Exact feature contributions of the best model (honest triage: explainability, not causality) */}
      {contributions.length > 0 && (
        <div className="mt-4 border-t border-white/8 pt-4">
          <p className="flex items-center gap-1 text-[11px] font-medium tracking-[0.08em] text-slate-500 uppercase">
            <span>Feature contributions — best model</span>
            <InfoTip label="What are feature contributions?" text={CONTRIBUTION_TIP} />
          </p>
          <ul className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
            {contributions.map((line, i) => (
              <li key={i} className="flex gap-2 text-sm leading-snug text-slate-300 tabular-nums">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-cyan-400" aria-hidden />
                {line}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
            The model&apos;s own arithmetic — how each measured feature moved its stated probability. An explanation
            of the model, not a causal claim about the market.
          </p>
        </div>
      )}

      {ensemble.note && <p className="mt-3 text-[11px] leading-relaxed text-slate-500">{ensemble.note}</p>}
    </Card>
  );
}
