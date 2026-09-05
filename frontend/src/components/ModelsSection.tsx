'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Activity } from 'lucide-react';
import { ApiError, getCalibration } from '@/lib/api';
import { modelLabel, normalizeModelAggregate, sortModelNames } from '@/lib/models';
import { fmtDateTime, pct, plain } from '@/lib/format';
import { Card, Chip, InfoTip, SectionTitle } from '@/components/ui';

const MODELS_TIP =
  'Six fixed-form models each state P(up) from different evidence (momentum, mean reversion, trend, vol-adjusted returns, news sentiment, macro regime). The walk-forward Brier score per horizon shows which one has actually been closest to reality — lower is better, 0.25 = always saying 50%.';

function fmtBrier(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? '—' : v.toFixed(4);
}

/**
 * V7 — "Models" subsection on the Accuracy tab (SPEC_V7 A5.1): the aggregate
 * per-model Brier table per horizon from /api/calibration `models`, with the
 * best (lowest-Brier) model highlighted per horizon and the online-regret
 * drift line (spec A3). Shares the ['calibration'] query with
 * CalibrationSection (one fetch feeds both) and renders nothing at all when
 * the backend has not shipped the aggregate yet — loading/error UI for the
 * shared query is already surfaced by CalibrationSection above it.
 */
export function ModelsSection() {
  const { data } = useQuery({
    queryKey: ['calibration'],
    queryFn: getCalibration,
    staleTime: 5 * 60_000,
    retry: (failureCount, err) => !(err instanceof ApiError && err.status === 404) && failureCount < 2,
  });

  const aggregate = useMemo(() => normalizeModelAggregate(data?.models ?? null), [data]);

  const horizons = useMemo(() => {
    const set = new Set<number>();
    for (const byH of aggregate.values()) for (const h of byH.keys()) set.add(h);
    return Array.from(set).sort((a, b) => a - b);
  }, [aggregate]);

  const rows = useMemo(() => sortModelNames(Array.from(aggregate.keys())), [aggregate]);

  /** Lowest Brier per horizon → the model the ensemble trusts most there. */
  const bestByHorizon = useMemo(() => {
    const best = new Map<number, string>();
    for (const h of horizons) {
      let bestModel: string | null = null;
      let bestBrier = Infinity;
      for (const [m, byH] of aggregate) {
        const b = byH.get(h)?.brier;
        if (b != null && b < bestBrier) {
          bestBrier = b;
          bestModel = m;
        }
      }
      if (bestModel != null) best.set(h, bestModel);
    }
    return best;
  }, [aggregate, horizons]);

  const drift = data?.modelDrift ?? null;

  // Old backend / aggregate not shipped yet → hide the whole subsection gracefully.
  if (rows.length === 0 || horizons.length === 0) return null;

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionTitle>
          <span className="inline-flex flex-wrap items-center gap-1">
            <span>Models — which engine earns trust?</span>
            <InfoTip label="What is the model pool?" text={MODELS_TIP} />
          </span>
        </SectionTitle>
        <Chip tone="violet">{rows.length} models · walk-forward</Chip>
      </div>
      <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-400">
        Aggregate Brier score per model per horizon, measured across the whole universe by replaying history each
        model never saw. No single model wins everywhere — the ensemble weights each stock&apos;s blend by exactly
        these measured differences, not by opinion.
      </p>

      <div className="thin-scroll mt-4 overflow-x-auto rounded-xl border border-white/6">
        <table className="table-premium min-w-[560px]">
          <thead>
            <tr>
              <th>Model</th>
              {horizons.map((h) => (
                <th key={h} className="num">
                  {h}d Brier
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m}>
                <td>
                  <p className="font-medium text-slate-100">{modelLabel(m)}</p>
                  <p className="text-xs text-slate-500">{m}</p>
                </td>
                {horizons.map((h) => {
                  const stat = aggregate.get(m)?.get(h) ?? null;
                  const isBest = stat?.brier != null && bestByHorizon.get(h) === m;
                  const titleBits: string[] = [];
                  if (stat?.hitRatePct != null) titleBits.push(`hit rate ${pct(stat.hitRatePct, 1)}`);
                  if (stat?.samples != null) titleBits.push(`${plain(stat.samples, 0)} samples`);
                  return (
                    <td
                      key={h}
                      className={clsx(
                        'num tabular-nums',
                        isBest ? 'font-semibold text-emerald-400' : stat?.brier != null ? 'text-slate-300' : 'text-slate-600',
                      )}
                      title={titleBits.length > 0 ? `${modelLabel(m)} · ${h}d — ${titleBits.join(' · ')}` : undefined}
                    >
                      {fmtBrier(stat?.brier)}
                      {isBest && (
                        <span className="ml-1 align-middle text-[10px] font-semibold text-emerald-400" aria-label="best model at this horizon">
                          ★
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
        0 = perfect · 0.25 = coin-flip honesty line · ★ = lowest (best) Brier at that horizon · hover a cell for hit
        rate and sample count.
      </p>

      {drift && (drift.updatedAt || drift.switches != null || drift.note) && (
        <p className="mt-3 flex items-start gap-2 rounded-xl border border-white/8 bg-white/4 px-3.5 py-2.5 text-xs leading-relaxed text-slate-400">
          <Activity className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cyan-400" aria-hidden />
          <span>
            <span className="font-medium text-slate-300">Model drift:</span>{' '}
            {drift.switches != null && (
              <>
                <span className="font-semibold text-slate-200 tabular-nums">{plain(drift.switches, 0)}</span> best-model
                switch{drift.switches === 1 ? '' : 'es'} in the last online-weight update
              </>
            )}
            {drift.switches != null && drift.updatedAt && ' · '}
            {drift.updatedAt && <>updated {fmtDateTime(drift.updatedAt)}</>}
            {drift.note && <span className="text-slate-500"> — {drift.note}</span>}
          </span>
        </p>
      )}
    </Card>
  );
}
