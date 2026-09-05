'use client';

import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Activity, AlertTriangle } from 'lucide-react';
import { ApiError, getVolForecast } from '@/lib/api';
import type { VolRegime } from '@/lib/types';
import { pct, plain, signedPct } from '@/lib/format';
import { Card, CardSkeleton, Chip, InfoTip, SectionTitle } from '@/components/ui';
import { useMountSweep } from './anim';

const HAR_TIP =
  'HAR-RV regresses tomorrow’s realized variance on its 1-day, 5-day and 22-day averages. Honest caveat: true HAR-RV uses intraday data; this one proxies realized vol from daily returns (r²), which is noisier.';

const R2_TIP =
  'Out-of-sample R² is walk-forward over the last ~60 days: each day is forecast by a model fit only on earlier data — no lookahead. In-sample R² always flatters; judge the out-of-sample number.';

const HARX_TIP =
  'V10 fits BOTH models per ticker: plain HAR, and HAR-X which adds the previous day’s India VIX level (z-scored over the fit window). Whichever wins the walk-forward out-of-sample R² makes the forecast — this chip names the winner.';

/** Tolerant numeric field reader — the V10 backend ships in parallel, key spellings may vary. */
function pickNum(data: object, keys: string[]): number | null | undefined {
  const rec = data as Record<string, unknown>;
  for (const k of keys) {
    if (k in rec) {
      const v = rec[k];
      if (v === null) return null;
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
  }
  return undefined;
}

const REGIME_META: Record<VolRegime, { label: string; tone: 'wait' | 'zinc' | 'buy' }> = {
  elevated: { label: 'ELEVATED VOL', tone: 'wait' },
  normal: { label: 'NORMAL VOL', tone: 'zinc' },
  calm: { label: 'CALM VOL', tone: 'buy' },
};

/** Daily-proxy R² values are honestly tiny — keep 3 decimals below 0.1 so they stay readable. */
function fmtR2(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return plain(v, Math.abs(v) < 0.1 ? 3 : 2);
}

/** One labeled horizontal bar — forecasts in cyan, the realized reference in
 *  slate. Sweeps in on load via the meter-fill transform (reduced-motion safe). */
function VolBar({
  label,
  value,
  max,
  reference = false,
}: {
  label: string;
  value: number | null;
  max: number;
  reference?: boolean;
}) {
  const ratio = value != null && max > 0 ? Math.max(0.02, Math.min(1, value / max)) : 0;
  const sweep = useMountSweep(ratio);
  return (
    <li className="flex items-center gap-3">
      <span className="w-36 shrink-0 text-xs text-slate-400">{label}</span>
      <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-white/8">
        {value != null && (
          <div
            className={clsx(
              'meter-fill h-full w-full rounded-full',
              reference ? 'bg-slate-500/80' : 'bg-gradient-to-r from-cyan-600 to-cyan-400',
            )}
            style={{ transform: `scaleX(${sweep})` }}
          />
        )}
      </div>
      <span className="w-16 shrink-0 text-right text-xs font-semibold text-slate-200 tabular-nums">
        {value != null ? pct(value, 1) : '—'}
      </span>
    </li>
  );
}

/**
 * V8 R2 — HAR-RV volatility forecast for the analyzed ticker: forecast (1d/5d
 * annualized) vs the 22d realized average, regime chip, sizing hint when
 * elevated, and BOTH R²s with the daily-proxy caveat. Hidden entirely when the
 * endpoint 404s (older backend).
 */
export function VolForecastCard({ ticker }: { ticker: string }) {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ['vol-forecast', ticker],
    queryFn: () => getVolForecast(ticker),
    staleTime: 5 * 60_000,
    retry: (failureCount, err) => !(err instanceof ApiError && err.status === 404) && failureCount < 2,
  });

  if (isError && error instanceof ApiError && error.status === 404) return null;
  if (isPending) return <CardSkeleton lines={3} />;
  if (isError || !data) {
    return (
      <Card className="flex flex-wrap items-center justify-between gap-3 p-5">
        <div className="flex items-start gap-2 text-sm text-slate-400">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden />
          Volatility forecast unavailable right now
          {error instanceof Error && error.message ? ` — ${error.message}` : ''}.
        </div>
        <button type="button" onClick={() => refetch()} className="btn-secondary px-3 py-1.5 text-xs">
          Retry
        </button>
      </Card>
    );
  }

  const { forecast1dVolPct: f1, forecast5dVolPct: f5, historicalAvgVolPct: hist } = data;
  if (f1 == null && f5 == null && hist == null) return null;

  const regime = REGIME_META[data.regime] ?? { label: String(data.regime).toUpperCase(), tone: 'zinc' as const };
  const max = Math.max(...[f1, f5, hist].filter((v): v is number => v != null && Number.isFinite(v)), 1);
  const deltaPct = f1 != null && hist != null && hist > 0 ? ((f1 - hist) / hist) * 100 : null;

  // ── V10 B2 — HAR vs HAR-X (prev-day India VIX), read tolerantly ──
  const vixDelta = pickNum(data, ['vixDeltaR2', 'vixDeltaR2OutOfSample', 'vixDeltaR2Oos']);
  const r2Har = pickNum(data, ['r2OutOfSampleHar', 'harR2OutOfSample', 'r2OosHar']);
  const r2HarX = pickNum(data, ['r2OutOfSampleHarX', 'harXR2OutOfSample', 'harxR2OutOfSample', 'r2OosHarX']);
  const repoRate = pickNum(data, ['repoRatePct', 'repoRate']);
  // Matches "HAR-X", "HARX" and "HAR-RV-X" (however B2 spells the winner) — but never plain "HAR-RV (Corsi)".
  const isHarX = /\bhar[\s-]*(?:rv)?[\s-]*x\b/i.test(data.method ?? '');
  // Only render V10 chrome when the backend actually signals it — never on a V8 backend.
  const v10Vol = vixDelta !== undefined || r2Har !== undefined || r2HarX !== undefined || isHarX;

  return (
    <Card className="p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionTitle>
          <span className="inline-flex flex-wrap items-center gap-1">
            <span>Volatility forecast — HAR-RV</span>
            <InfoTip label="How is volatility forecast?" text={HAR_TIP} />
          </span>
        </SectionTitle>
        <div className="flex flex-wrap items-center gap-2">
          {v10Vol && (
            <Chip tone={isHarX ? 'violet' : 'zinc'} glow={isHarX} title={HARX_TIP}>
              {isHarX ? 'HAR-X · India VIX' : 'plain HAR'}
            </Chip>
          )}
          {repoRate != null && (
            <Chip
              tone="zinc"
              title="RBI repo rate from stored macro — context only, NEVER a regressor: policy moves are rare events, unfitable on ~250 daily observations."
            >
              repo {pct(repoRate, 2)} · context
            </Chip>
          )}
          <Chip tone={regime.tone} glow>
            <Activity className="h-3.5 w-3.5" aria-hidden />
            {regime.label}
          </Chip>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-5 lg:grid-cols-[1fr_240px]">
        <div className="min-w-0">
          <ul className="space-y-2.5" aria-label="Forecast versus realized annualized volatility">
            <VolBar label="Forecast · next 1d" value={f1} max={max} />
            <VolBar label="Forecast · next 5d" value={f5} max={max} />
            <VolBar label="Realized · 22d avg" value={hist} max={max} reference />
          </ul>
          {deltaPct != null && (
            <p className="mt-3 text-xs leading-relaxed text-slate-400">
              Tomorrow&apos;s forecast <span className="font-medium text-slate-300">volatility</span> is{' '}
              <span
                className={clsx(
                  'font-semibold tabular-nums',
                  deltaPct > 0 ? 'text-amber-400' : deltaPct < 0 ? 'text-buy' : 'text-slate-300',
                )}
              >
                {signedPct(deltaPct, 0)}
              </span>{' '}
              vs the realized 22-day average — a risk gauge, not a price forecast.
            </p>
          )}
        </div>

        <div className="glass-inset h-fit p-4">
          <p className="flex items-center gap-1 text-[11px] font-medium tracking-[0.08em] text-slate-500 uppercase">
            <span>Model fit — R²</span>
            <InfoTip label="What do the two R² numbers mean?" text={R2_TIP} align="right" />
          </p>
          <div className="mt-2 flex items-end gap-5">
            <div>
              <p className="font-display text-2xl font-semibold tracking-tight text-slate-100 tabular-nums">
                {fmtR2(data.r2OutOfSample)}
              </p>
              <p className="mt-0.5 text-[11px] text-slate-500">
                out-of-sample (walk-fwd {data.oosSamples != null ? `${plain(data.oosSamples, 0)}d` : '60d'})
                {v10Vol ? ` · ${isHarX ? 'HAR-X' : 'HAR'}` : ''}
              </p>
            </div>
            <div>
              <p className="font-display text-lg font-semibold tracking-tight text-slate-400 tabular-nums">
                {fmtR2(data.r2InSample)}
              </p>
              <p className="mt-0.5 text-[11px] text-slate-500">in-sample</p>
            </div>
          </div>

          {/* V10 B2 — both OOS R²s + the honest VIX delta */}
          {r2Har != null && r2HarX != null && (
            <p className="mt-2 border-t border-white/6 pt-2 text-[11px] leading-relaxed text-slate-500 tabular-nums">
              OOS R² — HAR <span className="font-semibold text-slate-300">{fmtR2(r2Har)}</span> vs HAR-X{' '}
              <span className="font-semibold text-slate-300">{fmtR2(r2HarX)}</span>
            </p>
          )}
          {vixDelta != null && (
            <p
              className={clsx(
                'text-[11px] leading-relaxed text-slate-500',
                r2Har != null && r2HarX != null ? 'mt-1' : 'mt-2 border-t border-white/6 pt-2',
              )}
            >
              India VIX ΔR² (OOS):{' '}
              <span
                className={clsx(
                  'font-semibold tabular-nums',
                  vixDelta > 0 ? 'text-violet-300' : vixDelta < 0 ? 'text-slate-300' : 'text-slate-400',
                )}
              >
                {vixDelta >= 0 ? '+' : '−'}
                {fmtR2(Math.abs(vixDelta))}
              </span>{' '}
              — {isHarX ? 'the VIX regressor won out-of-sample, so HAR-X makes this forecast' : 'the VIX regressor did not win out-of-sample, so plain HAR makes this forecast'}
              .
            </p>
          )}
        </div>
      </div>

      {data.sizingHint && (
        <p className="mt-4 flex items-start gap-2 rounded-lg border border-amber-400/25 bg-amber-400/8 px-3 py-2.5 text-xs leading-relaxed text-amber-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {data.sizingHint}
        </p>
      )}

      <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
        {data.note || 'Daily-proxy caveat: realized vol here is estimated from daily returns (r²), noisier than the intraday data true HAR-RV uses.'}
        {data.method ? ` Method: ${data.method}.` : ''}
      </p>
    </Card>
  );
}
