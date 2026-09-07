'use client';

import { useMemo } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  LabelList,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import clsx from 'clsx';
import type { Bar, HorizonPrediction } from '@/lib/types';
import { HORIZON_TRADING_DAYS } from '@/lib/types';
import { CHART } from '@/lib/palette';
import { fmtDate, fmtDateShort, inr, pct, signedPct } from '@/lib/format';
import { Card, SectionTitle } from '@/components/ui';
import { signTone } from './tone';

interface FPoint {
  x: number;
  date?: string;
  hz?: string;
  close?: number | null;
  expected?: number | null;
  band?: [number, number] | null;
}

function ForecastTip({ active, payload }: { active?: boolean; payload?: Array<{ payload?: FPoint }> }) {
  if (!active || !payload?.length) return null;
  const p = payload[0]?.payload;
  if (!p) return null;
  return (
    <div className="chart-tip px-3 py-2 text-xs">
      {p.hz ? (
        <>
          <p className="font-medium text-slate-300">{p.hz} ahead</p>
          <p className="mt-1 text-sm font-semibold text-slate-100">{p.expected != null ? inr(p.expected) : '—'}</p>
          {p.band && (
            <p className="mt-0.5 text-slate-400">
              80% range: {inr(p.band[0])} – {inr(p.band[1])}
            </p>
          )}
        </>
      ) : (
        <>
          <p className="font-medium text-slate-300">{p.date ? fmtDate(p.date) : ''}</p>
          <p className="mt-1 text-sm font-semibold text-slate-100">{p.close != null ? inr(p.close) : '—'}</p>
        </>
      )}
    </div>
  );
}

function LegendKey({ kind, color, label }: { kind: 'line' | 'dash' | 'fill'; color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
      {kind === 'fill' ? (
        <span className="h-2.5 w-3.5 rounded-sm" style={{ backgroundColor: color, opacity: 0.25 }} />
      ) : (
        <svg width="18" height="6" aria-hidden>
          <line
            x1="1"
            y1="3"
            x2="17"
            y2="3"
            stroke={color}
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={kind === 'dash' ? '4 3' : undefined}
          />
        </svg>
      )}
      {label}
    </span>
  );
}

export function ForecastChart({ bars, predictions }: { bars: Bar[]; predictions: HorizonPrediction[] }) {
  const hist = useMemo(() => bars.slice(-60), [bars]);
  const last = hist.length - 1;

  const { data, ticks, hzAt } = useMemo(() => {
    const rows: FPoint[] = hist.map((b, i) => ({ x: i, date: b.date, close: b.close }));
    const map = new Map<number, string>();
    if (last >= 0) {
      const anchor = hist[last];
      rows[last] = { ...rows[last], expected: anchor.close, band: [anchor.close, anchor.close] };
      for (const p of [...predictions].sort((a, b) => a.horizonDays - b.horizonDays)) {
        const x = last + HORIZON_TRADING_DAYS[p.horizonDays];
        map.set(x, `${p.horizonDays}d`);
        rows.push({ x, hz: `${p.horizonDays}d`, expected: p.expectedPrice, band: [p.lowPrice, p.highPrice] });
      }
    }
    const t: number[] = last >= 1 ? [0, Math.round(last / 2), last] : [0];
    for (const p of predictions) {
      const h = p.horizonDays;
      if (h === 7 || h === 15 || h === 30) t.push(last + HORIZON_TRADING_DAYS[h]);
    }
    return { data: rows, ticks: t, hzAt: map };
  }, [hist, last, predictions]);

  const sorted = useMemo(() => [...predictions].sort((a, b) => a.horizonDays - b.horizonDays), [predictions]);

  if (hist.length < 2) {
    return (
      <Card className="p-5">
        <SectionTitle>Prediction chart</SectionTitle>
        <p className="mt-3 text-sm text-slate-400">Not enough price history to draw this chart.</p>
      </Card>
    );
  }

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionTitle>Price history &amp; forecast</SectionTitle>
        <div className="flex flex-wrap items-center gap-4">
          <LegendKey kind="line" color={CHART.ink} label="History (last 60 sessions)" />
          <LegendKey kind="dash" color={CHART.sky} label="Expected price" />
          <LegendKey kind="fill" color={CHART.sky} label="80% range" />
        </div>
      </div>

      <div className="mt-4 h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 18, right: 18, bottom: 0, left: 4 }}>
            <CartesianGrid stroke={CHART.grid} strokeWidth={1} vertical={false} />
            <XAxis
              type="number"
              dataKey="x"
              domain={[0, 'dataMax']}
              ticks={ticks}
              tickFormatter={(x: number) => hzAt.get(x) ?? (hist[x] ? fmtDateShort(hist[x].date) : '')}
              tick={{ fill: CHART.tick, fontSize: 11 }}
              axisLine={{ stroke: CHART.axisLine }}
              tickLine={false}
              tickMargin={8}
            />
            <YAxis
              domain={['auto', 'auto']}
              tick={{ fill: CHART.tick, fontSize: 11 }}
              tickFormatter={(v: number) => `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(v)}`}
              axisLine={false}
              tickLine={false}
              width={72}
            />
            <Tooltip content={<ForecastTip />} cursor={{ stroke: CHART.axisLine, strokeWidth: 1 }} />
            <ReferenceLine
              x={last}
              stroke={CHART.axisLine}
              label={{ value: 'Today', position: 'insideTopLeft', fill: '#64748b', fontSize: 10 }}
            />
            <defs>
              <linearGradient id="forecastBand" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#22d3ee" stopOpacity={0.3} />
                <stop offset="100%" stopColor="#22d3ee" stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <Area
              dataKey="band"
              stroke="none"
              fill="url(#forecastBand)"
              isAnimationActive
              animationDuration={350}
              activeDot={false}
            />
            <Line
              dataKey="close"
              stroke={CHART.ink}
              strokeWidth={2}
              dot={false}
              isAnimationActive
              animationDuration={350}
              activeDot={{ r: 4, fill: CHART.ink, stroke: CHART.surface, strokeWidth: 2 }}
            />
            <Line
              dataKey="expected"
              stroke={CHART.sky}
              strokeWidth={2}
              strokeDasharray="6 4"
              isAnimationActive
              animationDuration={350}
              dot={{ r: 4, fill: CHART.sky, stroke: CHART.surface, strokeWidth: 2 }}
              activeDot={{ r: 5, fill: CHART.sky, stroke: CHART.surface, strokeWidth: 2 }}
            >
              <LabelList dataKey="hz" position="top" offset={10} fill={CHART.tick} fontSize={11} />
            </Line>
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {sorted.length > 0 && (
        <div className="thin-scroll mt-4 flex gap-2 overflow-x-auto border-t border-white/8 pt-4">
          {sorted.map((p) => (
            <div key={p.horizonDays} className="glass-inset min-w-32 flex-1 px-3 py-2">
              <p className="text-[11px] text-slate-500">{p.horizonDays}-day</p>
              <p className={clsx('font-display text-sm font-semibold tabular-nums', signTone(p.expectedReturnPct))}>
                {signedPct(p.expectedReturnPct)}
              </p>
              <p className="text-[11px] text-slate-500">
                {signedPct(p.low80Pct, 1)} to {signedPct(p.high80Pct, 1)}
              </p>
              <p className="text-[11px] text-slate-500" title="Model-derived odds (uncalibrated heuristic — not a measured probability)">model odds {pct(p.directionProb * 100, 0)}</p>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
