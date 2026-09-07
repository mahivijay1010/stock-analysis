'use client';

import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { CalendarDays, Fingerprint, ShieldQuestion } from 'lucide-react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { getDailyForecast, getStockChart, issueForecast } from '@/lib/api';
import type { ForecastDay, ForecastIssuance } from '@/lib/types';
import { CHART } from '@/lib/palette';
import { fmtDate, fmtDateShort, fmtDateTime, inr, pct, signedPct } from '@/lib/format';
import { Card, Chip, SectionTitle, CardSkeleton } from '@/components/ui';
import { useAuth } from '@/components/auth/useAuth';

/*
 * Phase C (upgrade-spec §5): the day-wise forecast table + one forecast chart
 * with an explicit issuance boundary. EVERY calendar day is rendered; weekends
 * and holidays say "Market closed" (a carried-forward number is context, not a
 * new prediction). Bands are labeled exactly: p10–p90 = 80%, p05–p95 = 90%.
 */

const STATE_LABEL: Record<ForecastDay['marketState'], string> = {
  expected_session: 'Session',
  weekend: 'Market closed — weekend',
  expected_closed: 'Market closed',
};

function OutcomeCell({ day }: { day: ForecastDay }) {
  const o = day.outcome;
  if (!o) return <span className="text-slate-600">—</span>;
  if (o.state === 'verified' && o.observedClose != null) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="font-medium text-slate-200">{inr(o.observedClose)}</span>
        {o.realizedReturnPct != null && (
          <span className={o.realizedReturnPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
            {signedPct(o.realizedReturnPct)}
          </span>
        )}
        <span
          className={clsx(
            'rounded px-1 text-[10px] font-semibold',
            o.insideBand80 ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300',
          )}
          title="Was the close inside the 80% (p10–p90) interval?"
        >
          {o.insideBand80 ? 'in 80%' : o.insideBand90 ? 'in 90%' : 'outside'}
        </span>
      </span>
    );
  }
  const label =
    o.state === 'pending' ? 'pending' : o.state === 'no_session' ? 'no session' : 'missing data';
  return <span className="text-xs text-slate-500">{label}</span>;
}

interface ChartPoint {
  x: number;
  date: string;
  close?: number | null;
  median?: number | null;
  band80?: [number, number] | null;
}

function ForecastBoundaryChart({ view }: { view: ForecastIssuance }) {
  const historyQ = useQuery({
    queryKey: ['forecast-history', view.ticker],
    queryFn: () => getStockChart(view.ticker, '3mo'),
    staleTime: 5 * 60_000,
  });

  const { data, boundaryX } = useMemo(() => {
    const hist = (historyQ.data?.bars ?? [])
      .filter((b) => b.date <= view.anchorSessionDate)
      .slice(-45);
    const points: ChartPoint[] = hist.map((b, i) => ({ x: i, date: b.date, close: b.close }));
    const boundary = points.length - 1;
    let x = boundary;
    if (points.length > 0) {
      // Join the forecast to the anchor close so the line is continuous.
      points[boundary] = { ...points[boundary], median: view.anchorPrice };
    }
    for (const d of view.days) {
      if (!d.prices) continue;
      x += 1;
      points.push({
        x,
        date: d.date,
        median: d.prices.p50,
        band80: [d.prices.p10, d.prices.p90],
      });
    }
    return { data: points, boundaryX: boundary };
  }, [historyQ.data, view]);

  if (historyQ.isLoading) return <CardSkeleton lines={4} />;
  if (data.length < 2) return null;

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
          <CartesianGrid stroke={CHART.grid} strokeDasharray="3 6" vertical={false} />
          <XAxis
            dataKey="x"
            type="number"
            domain={['dataMin', 'dataMax']}
            tickFormatter={(x: number) => {
              const p = data[Math.round(x)];
              return p ? fmtDateShort(p.date) : '';
            }}
            tick={{ fill: CHART.tick, fontSize: 11 }}
            axisLine={{ stroke: CHART.axisLine }}
            tickLine={false}
            minTickGap={40}
          />
          <YAxis
            domain={['auto', 'auto']}
            tick={{ fill: CHART.tick, fontSize: 11 }}
            tickFormatter={(v: number) => inr(v, 0)}
            axisLine={false}
            tickLine={false}
            width={70}
          />
          <Tooltip
            content={({ active, payload }) => {
              const p = active && payload?.length ? (payload[0].payload as ChartPoint) : null;
              if (!p) return null;
              return (
                <div className="chart-tip px-3 py-2 text-xs">
                  <p className="font-medium text-slate-300">{fmtDate(p.date)}</p>
                  {p.close != null && <p className="mt-1 text-sm font-semibold text-slate-100">{inr(p.close)}</p>}
                  {p.median != null && p.close == null && (
                    <>
                      <p className="mt-1 text-sm font-semibold text-slate-100">median {inr(p.median)}</p>
                      {p.band80 && (
                        <p className="mt-0.5 text-slate-400">
                          80% range: {inr(p.band80[0])} – {inr(p.band80[1])}
                        </p>
                      )}
                    </>
                  )}
                </div>
              );
            }}
          />
          <Area
            dataKey="band80"
            stroke="none"
            fill={CHART.sky}
            fillOpacity={0.14}
            isAnimationActive={false}
            connectNulls={false}
          />
          <Line
            dataKey="close"
            stroke={CHART.ink}
            strokeWidth={1.6}
            dot={false}
            isAnimationActive={false}
            connectNulls={false}
          />
          <Line
            dataKey="median"
            stroke={CHART.sky}
            strokeWidth={1.6}
            strokeDasharray="5 4"
            dot={false}
            isAnimationActive={false}
            connectNulls={false}
          />
          <ReferenceLine
            x={boundaryX}
            stroke={CHART.amber}
            strokeDasharray="4 4"
            label={{ value: 'issued', fill: CHART.amber, fontSize: 10, position: 'insideTopRight' }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export function DailyForecastCard({ ticker }: { ticker: string }) {
  const { auth } = useAuth();
  const signedIn = auth?.status === 'authenticated';
  const qc = useQueryClient();
  const dailyQ = useQuery({
    queryKey: ['forecast-daily', ticker],
    queryFn: () => getDailyForecast(ticker),
    staleTime: 60_000,
  });
  const issueM = useMutation({
    mutationFn: () => issueForecast(ticker),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['forecast-daily', ticker] }),
  });

  if (dailyQ.isLoading) {
    return (
      <Card>
        <SectionTitle>Next 30 calendar days</SectionTitle>
        <CardSkeleton lines={6} />
      </Card>
    );
  }
  if (dailyQ.isError) {
    return (
      <Card>
        <SectionTitle>Next 30 calendar days</SectionTitle>
        <p className="mt-2 text-sm text-slate-400">
          Forecast unavailable: {dailyQ.error instanceof Error ? dailyQ.error.message : 'unknown error'}
        </p>
      </Card>
    );
  }

  const res = dailyQ.data!;
  if (!res.available) {
    return (
      <Card>
        <SectionTitle>Next 30 calendar days</SectionTitle>
        <div className="mt-3 flex flex-col items-start gap-3">
          <p className="text-sm leading-relaxed text-slate-400">{res.reason}</p>
          {signedIn ? (
            <button
              type="button"
              onClick={() => issueM.mutate()}
              disabled={issueM.isPending}
              className="rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-1.5 text-xs font-semibold text-cyan-300 transition-colors hover:bg-cyan-400/20 disabled:opacity-50"
            >
              {issueM.isPending ? 'Issuing…' : 'Issue forecast now'}
            </button>
          ) : (
            <p className="text-xs text-slate-500">Sign in to issue one on demand.</p>
          )}
          {issueM.isError && (
            <p className="text-xs text-rose-400">
              {issueM.error instanceof Error ? issueM.error.message : 'Issuance failed'}
            </p>
          )}
        </div>
      </Card>
    );
  }

  const view = res.view;
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <SectionTitle>Next 30 calendar days</SectionTitle>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">
            Window {fmtDate(view.windowStart)} → {fmtDate(view.windowEnd)} · {view.targetSessionCount} expected
            sessions · anchored on the {fmtDate(view.anchorSessionDate)} close ({inr(view.anchorPrice)})
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip tone="zinc">
            <CalendarDays className="h-3.5 w-3.5" aria-hidden /> issued {fmtDateTime(view.issuedAt)}
          </Chip>
          <Chip tone="zinc" title={`sha256 input manifest: ${view.inputHash}`}>
            <Fingerprint className="h-3.5 w-3.5" aria-hidden /> {view.inputHash.slice(0, 10)}
          </Chip>
        </div>
      </div>

      <div className="mt-4">
        <ForecastBoundaryChart view={view} />
        <p className="mt-1 px-1 text-[11px] text-slate-500">
          Solid: observed closes. Dashed: forecast median with the 80% (p10–p90) interval, issued once at the
          boundary and never redrawn to fit reality.
        </p>
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-xs">
          <thead>
            <tr className="border-b border-white/8 text-[11px] uppercase tracking-wide text-slate-500">
              <th className="py-2 pr-3 font-medium">Date</th>
              <th className="py-2 pr-3 font-medium">State</th>
              <th className="py-2 pr-3 text-right font-medium">Median</th>
              <th className="py-2 pr-3 text-right font-medium">80% interval</th>
              <th className="py-2 pr-3 text-right font-medium">90% interval</th>
              <th className="py-2 pr-3 text-right font-medium" title="Bootstrap scenario frequency of a gain vs the anchor — historical resampling, not a calibrated probability">freq(up)</th>
              <th className="py-2 text-right font-medium">Actual</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {view.days.map((d) => {
              const closed = d.prices == null;
              return (
                <tr key={d.date} className={clsx('border-b border-white/4', closed && 'opacity-55')}>
                  <td className="py-1.5 pr-3 whitespace-nowrap text-slate-300">{fmtDate(d.date)}</td>
                  <td className="py-1.5 pr-3 text-slate-400">
                    {STATE_LABEL[d.marketState]}
                    {d.marketState === 'expected_session' && (
                      <span className="ml-1 text-slate-600" title="Future sessions are provisional until confirmed">
                        (expected)
                      </span>
                    )}
                  </td>
                  {closed ? (
                    <td colSpan={4} className="py-1.5 pr-3 text-right text-slate-600">
                      no prediction — market closed
                    </td>
                  ) : (
                    <>
                      <td className="py-1.5 pr-3 text-right font-medium text-slate-200">{inr(d.prices!.p50)}</td>
                      <td className="py-1.5 pr-3 text-right text-slate-400">
                        {inr(d.prices!.p10)} – {inr(d.prices!.p90)}
                      </td>
                      <td className="py-1.5 pr-3 text-right text-slate-500">
                        {inr(d.prices!.p05)} – {inr(d.prices!.p95)}
                      </td>
                      <td className="py-1.5 pr-3 text-right text-slate-400">
                        {d.pop != null ? pct(d.pop * 100, 0) : '—'}
                      </td>
                    </>
                  )}
                  <td className="py-1.5 text-right">
                    <OutcomeCell day={d} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex items-start gap-2 rounded-lg border border-white/6 bg-white/3 px-3 py-2">
        <ShieldQuestion className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden />
        <p className="text-[11px] leading-relaxed text-slate-500">{view.realityCheck}</p>
      </div>
    </Card>
  );
}
