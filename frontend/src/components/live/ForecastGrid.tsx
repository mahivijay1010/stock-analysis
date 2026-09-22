'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw, TrendingDown, TrendingUp, XCircle } from 'lucide-react';
import { getIntradayForecasts } from '@/lib/api';
import type { GradedForecastRow, HorizonScore, IntradayForecastRow, IntradaySnapshot } from '@/lib/types';

const POLL_MS = 5000;

/**
 * Live 1-minute and 5-minute forecasts for the whole universe, with the
 * measured scorecard shown BESIDE them rather than on another tab.
 *
 * The layout is deliberate. Every forecast sits next to the hit rate that
 * model horizon is actually achieving today, because this system's first live
 * grading scored 47.4% on 154 one-day predictions — below a coin flip — with
 * probabilities inverted where confidence was highest. A minute-scale forecast
 * is a harder problem than that one, so a clean grid of confident directions
 * with no scorecard would be the most misleading screen in the product.
 *
 * Nothing here is a trade suggestion. These forecasts carry no authority and
 * feed no decision; they exist to be measured in public.
 */
export function ForecastGrid({ onOpenStock }: { onOpenStock?: (ticker: string) => void }) {
  const [snap, setSnap] = useState<IntradaySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [horizon, setHorizon] = useState<number>(1);
  const [query, setQuery] = useState('');

  const refresh = useCallback(async () => {
    try {
      setSnap(await getIntradayForecasts());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach the analysis server');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const score = useMemo(
    () => snap?.scores.find((s) => s.horizonMin === horizon) ?? null,
    [snap, horizon]
  );

  const rows = useMemo(() => {
    if (!snap) return [];
    const q = query.trim().toUpperCase();
    return snap.forecasts
      .filter((f) => f.horizonMin === horizon)
      .filter((f) => (q ? f.ticker.toUpperCase().includes(q) : true))
      .sort((a, b) => Math.abs(b.expectedReturnPct) - Math.abs(a.expectedReturnPct));
  }, [snap, horizon, query]);

  const graded = useMemo(
    () => (snap?.recentGraded ?? []).filter((g) => g.horizonMin === horizon).slice(0, 12),
    [snap, horizon]
  );

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-semibold text-slate-100">Next 1 min / 5 min</h2>
          <p className="mt-0.5 max-w-3xl text-xs text-slate-400">
            A forecast for every stock, graded automatically the moment its horizon elapses. The scorecard beside each
            call is this model&apos;s <strong className="text-slate-300">measured</strong> performance today.
          </p>
        </div>
        <button
          onClick={() => void refresh()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
      </header>

      {error && <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-200">{error}</div>}

      {snap && !snap.feedRunning && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-200">
          The live feed is not running — no forecasts can be produced. Start the feed above.
        </div>
      )}

      {/* The headline is written by the backend to be the least flattering
          true statement available; render it verbatim, never summarised. */}
      {snap && (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-3">
          <div className="flex gap-2.5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <p className="text-sm text-slate-300">{snap.headline}</p>
          </div>
        </div>
      )}

      {/* Horizon switch + that horizon's live scorecard, side by side. */}
      <div className="flex flex-wrap items-center gap-2">
        {(snap?.scores ?? []).map((s) => (
          <button
            key={s.horizonMin}
            onClick={() => setHorizon(s.horizonMin)}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
              horizon === s.horizonMin ? 'bg-white/10 text-slate-100' : 'text-slate-400 hover:bg-white/5'
            }`}
          >
            {s.horizonMin} min
          </button>
        ))}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter ticker…"
          className="input-glass ml-auto max-w-[220px] px-3 py-1.5 text-xs"
        />
      </div>

      {score && <Scorecard score={score} expiredUngraded={snap?.expiredUngraded ?? 0} />}

      <div className="overflow-x-auto rounded-xl border border-white/10">
        <table className="w-full text-sm">
          <thead className="bg-white/[0.03] text-[11px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left">Stock</th>
              <th className="px-3 py-2 text-left">Call · this model&apos;s accuracy</th>
              <th className="px-3 py-2 text-right">Entry zone</th>
              <th className="px-3 py-2 text-right">Target (exit)</th>
              <th className="px-3 py-2 text-right">Stop-loss</th>
              <th className="px-3 py-2 text-left">Last result</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-sm text-slate-500">
                  {snap?.feedRunning
                    ? 'Building bars — a forecast needs at least 10 completed 1-minute bars, so the first calls appear ~10 minutes after the feed starts.'
                    : 'No forecasts.'}
                </td>
              </tr>
            ) : (
              rows.map((f) => (
                <ForecastRow
                  key={`${f.securityId}-${f.horizonMin}`}
                  f={f}
                  unproven={score?.unproven ?? true}
                  onOpen={onOpenStock ? () => onOpenStock(f.ticker) : undefined}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      {graded.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-medium text-slate-200">Just graded — what actually happened</h3>
          <div className="overflow-x-auto rounded-xl border border-white/10">
            <table className="w-full text-sm">
              <thead className="bg-white/[0.03] text-[11px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left">Result</th>
                  <th className="px-3 py-2 text-left">Stock</th>
                  <th className="px-3 py-2 text-left">Called</th>
                  <th className="px-3 py-2 text-right">Expected</th>
                  <th className="px-3 py-2 text-right">Actual</th>
                  <th className="px-3 py-2 text-right">Miss</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {graded.map((g) => (
                  <GradedRow key={`${g.securityId}-${g.horizonMin}-${g.gradedAt}`} g={g} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * The scorecard. Rendered above the grid so it cannot be scrolled past, and
 * states plainly when the sample is too small to mean anything.
 */
function Scorecard({ score, expiredUngraded }: { score: HorizonScore; expiredUngraded: number }) {
  const tone = score.unproven ? 'border-amber-500/25 bg-amber-500/5' : 'border-emerald-500/25 bg-emerald-500/5';
  return (
    <div className={`rounded-xl border p-3.5 ${tone}`}>
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-slate-500">{score.horizonMin}-min hit rate today</p>
          <p className="font-display text-xl font-semibold tabular-nums text-slate-100">
            {score.hitRatePct != null ? `${score.hitRatePct.toFixed(1)}%` : '—'}
            <span className="ml-2 text-xs font-normal text-slate-400">
              {score.correct}/{score.graded} graded
            </span>
          </p>
        </div>
        <Metric label="Brier" value={score.brier != null ? score.brier.toFixed(4) : '—'} hint="0.25 = always saying 50%" />
        <Metric
          label="Predicted vs actual move"
          value={
            score.meanAbsPredictedPct != null && score.meanAbsActualPct != null
              ? `${score.meanAbsPredictedPct.toFixed(3)}% vs ${score.meanAbsActualPct.toFixed(3)}%`
              : '—'
          }
          hint="how far off the size of the move is"
        />
        {expiredUngraded > 0 && (
          <Metric label="Expired ungraded" value={String(expiredUngraded)} hint="no price at resolve time" />
        )}
      </div>
      <p className={`mt-2 text-xs ${score.unproven ? 'text-amber-200' : 'text-emerald-200'}`}>
        {score.unproven ? 'UNPROVEN — ' : ''}
        {score.note}
      </p>
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className="font-display text-sm font-semibold tabular-nums text-slate-200">{value}</p>
      <p className="text-[10px] text-slate-500">{hint}</p>
    </div>
  );
}

function ForecastRow({ f, unproven, onOpen }: { f: IntradayForecastRow; unproven: boolean; onOpen?: () => void }) {
  const up = f.direction === 'UP';
  const secondsLeft = Math.max(0, Math.round((f.resolveAt - Date.now()) / 1000));
  return (
    <tr
      onClick={onOpen}
      className={onOpen ? 'cursor-pointer transition hover:bg-white/[0.04]' : undefined}
      title={onOpen ? 'Open live detail' : undefined}
    >
      <td className="px-3 py-2 font-medium text-slate-200">{f.ticker.replace(/\.NS$/, '')}</td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-1.5">
          <span
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ${
              up ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300'
            }`}
          >
            {up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
            {up ? 'BUY' : 'SELL'} {(f.probabilityUp * 100).toFixed(0)}%
          </span>
          {secondsLeft > 0 && <span className="text-[10px] text-slate-600">{secondsLeft}s</span>}
        </div>
        <p className={`mt-0.5 text-[10px] ${unproven ? 'text-amber-400' : 'text-emerald-400'}`}>
          {f.plan.accuracy.hitRatePct != null ? `${f.plan.accuracy.hitRatePct.toFixed(1)}% (n=${f.plan.accuracy.graded})` : `n=${f.plan.accuracy.graded}`}
          {unproven && ' UNPROVEN'}
        </p>
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-xs text-slate-300">
        {f.plan.entryLow.toFixed(2)}–{f.plan.entryHigh.toFixed(2)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-xs text-emerald-300">
        ₹{f.plan.targetPrice.toFixed(2)}
        <span className="ml-1 text-[10px] text-slate-500">
          {f.plan.targetPct > 0 ? '+' : ''}
          {f.plan.targetPct.toFixed(2)}%
        </span>
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-xs text-rose-300">
        ₹{f.plan.stopLossPrice.toFixed(2)}
        <span className="ml-1 text-[10px] text-slate-500">
          {f.plan.stopLossPct > 0 ? '+' : ''}
          {f.plan.stopLossPct.toFixed(2)}%
        </span>
      </td>
      <td className="px-3 py-2">
        {f.lastOutcome == null ? (
          <span className="text-[11px] text-slate-600">—</span>
        ) : f.lastOutcome === 'CORRECT' ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-emerald-300">
            <CheckCircle2 className="h-3 w-3" /> correct
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-[11px] text-rose-300">
            <XCircle className="h-3 w-3" /> wrong
          </span>
        )}
      </td>
    </tr>
  );
}

function GradedRow({ g }: { g: GradedForecastRow }) {
  const wrong = g.outcome === 'WRONG';
  return (
    <tr className={wrong ? 'bg-rose-500/[0.04]' : undefined}>
      <td className="px-3 py-2">
        {wrong ? (
          <span className="inline-flex items-center gap-1 rounded bg-rose-500/15 px-1.5 py-0.5 text-[11px] font-medium text-rose-300">
            <XCircle className="h-3 w-3" /> WRONG
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] font-medium text-emerald-300">
            <CheckCircle2 className="h-3 w-3" /> correct
          </span>
        )}
      </td>
      <td className="px-3 py-2 font-medium text-slate-200">{g.ticker.replace(/\.NS$/, '')}</td>
      <td className="px-3 py-2 text-xs text-slate-300">
        {g.direction}
        {g.actualDirection !== g.direction && <span className="text-rose-300"> → was {g.actualDirection}</span>}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-xs text-slate-400">
        {g.expectedReturnPct > 0 ? '+' : ''}
        {g.expectedReturnPct.toFixed(3)}%
      </td>
      <td
        className={`px-3 py-2 text-right tabular-nums text-xs ${
          g.actualReturnPct < 0 ? 'text-rose-300' : 'text-emerald-300'
        }`}
      >
        {g.actualReturnPct > 0 ? '+' : ''}
        {g.actualReturnPct.toFixed(3)}%
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-xs text-slate-400">
        {g.errorPct > 0 ? '+' : ''}
        {g.errorPct.toFixed(3)}pp
      </td>
    </tr>
  );
}
