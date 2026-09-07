'use client';

import { useEffect, useId, useMemo, useState } from 'react';
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
import clsx from 'clsx';
import type { MonteCarloForecast, MonteCarloHorizon } from '@/lib/types';
import { CHART } from '@/lib/palette';
import { pct, plain, signedPct } from '@/lib/format';
import { Card, SectionTitle } from '@/components/ui';

/* ------------------------------------------------------------------ */
/* Mini PoP donut — P(return > 0) per horizon                          */
/* ------------------------------------------------------------------ */

function PopDonut({ horizon }: { horizon: MonteCarloHorizon }) {
  const uid = useId();
  const popPct = Math.max(0, Math.min(100, horizon.pop * 100));
  // Animated sweep on mount, mirroring ScoreDonut.
  const [sweep, setSweep] = useState(0);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setSweep(popPct));
    return () => cancelAnimationFrame(raf);
  }, [popPct]);

  const strokeW = 10;
  const r = 50 - strokeW / 2 - 1;

  return (
    <div className="flex flex-col items-center gap-1">
      <svg
        viewBox="0 0 100 100"
        width={64}
        height={64}
        role="img"
        aria-label={`${horizon.horizonDays}-day historical bootstrap scenario frequency of profit ${Math.round(popPct)} percent`}
      >
        <defs>
          <linearGradient id={`pop-${uid}`} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#22d3ee" />
            <stop offset="100%" stopColor="#a78bfa" />
          </linearGradient>
        </defs>
        <circle cx="50" cy="50" r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={strokeW} />
        {popPct > 0 && (
          <circle
            className="donut-arc"
            cx="50"
            cy="50"
            r={r}
            fill="none"
            stroke={`url(#pop-${uid})`}
            strokeWidth={strokeW}
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray={`${Math.max(sweep, 0.5)} ${100 - Math.max(sweep, 0.5)}`}
            transform="rotate(-90 50 50)"
            style={{ filter: 'drop-shadow(0 0 4px #22d3ee55)' }}
          />
        )}
        <text
          x="50"
          y="50"
          textAnchor="middle"
          dominantBaseline="central"
          fill="#f1f5f9"
          fontSize={26}
          fontWeight={600}
          style={{ fontFamily: 'var(--font-display)', fontVariantNumeric: 'tabular-nums' }}
        >
          {Math.round(popPct)}%
        </text>
      </svg>
      <span className="text-[11px] font-medium text-slate-500">{horizon.horizonDays}d</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Percentile cone                                                     */
/* ------------------------------------------------------------------ */

interface ConePoint {
  x: number;
  band95?: [number, number];
  band50?: [number, number];
  p50?: number;
  h?: MonteCarloHorizon;
}

function ConeTip({ active, payload }: { active?: boolean; payload?: Array<{ payload?: ConePoint }> }) {
  if (!active || !payload?.length) return null;
  const p = payload[0]?.payload;
  if (!p || !p.h) return null;
  const q = p.h.percentiles;
  return (
    <div className="chart-tip px-3 py-2 text-xs">
      <p className="font-medium text-slate-300">{p.h.horizonDays}-day simulated return</p>
      <div className="mt-1 space-y-0.5 tabular-nums">
        <p className="text-slate-400">
          p95 <span className="font-semibold text-slate-100">{signedPct(q.p95)}</span>
        </p>
        <p className="text-slate-400">
          p75 <span className="font-semibold text-slate-100">{signedPct(q.p75)}</span>
        </p>
        <p className="text-slate-300">
          median <span className="font-semibold text-slate-100">{signedPct(q.p50)}</span>
        </p>
        <p className="text-slate-400">
          p25 <span className="font-semibold text-slate-100">{signedPct(q.p25)}</span>
        </p>
        <p className="text-slate-400">
          p5 <span className="font-semibold text-slate-100">{signedPct(q.p5)}</span>
        </p>
        <p className="mt-1 text-slate-500">freq(up) {pct(p.h.pop * 100, 0)}</p>
      </div>
    </div>
  );
}

function LegendSwatch({ opacity, label }: { opacity: number; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
      <span className="h-2.5 w-3.5 rounded-sm" style={{ backgroundColor: CHART.sky, opacity }} aria-hidden />
      {label}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Card                                                                */
/* ------------------------------------------------------------------ */

/**
 * V5 — bootstrap Monte Carlo: PoP per horizon, the percentile cone
 * (p5–p95 outer, p25–p75 inner, p50 line) and 30-day tail-risk stats.
 */
export function MonteCarloCard({ forecast }: { forecast: MonteCarloForecast }) {
  const horizons = useMemo(
    () => [...forecast.horizons].sort((a, b) => a.horizonDays - b.horizonDays),
    [forecast.horizons],
  );

  const coneData = useMemo<ConePoint[]>(() => {
    const rows: ConePoint[] = [{ x: 0, band95: [0, 0], band50: [0, 0], p50: 0 }];
    for (const h of horizons) {
      const q = h.percentiles;
      rows.push({ x: h.horizonDays, band95: [q.p5, q.p95], band50: [q.p25, q.p75], p50: q.p50, h });
    }
    return rows;
  }, [horizons]);

  const h30 = horizons.find((h) => h.horizonDays === 30) ?? horizons[horizons.length - 1] ?? null;

  if (!horizons.length) return null;

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <SectionTitle>Monte Carlo — {plain(forecast.paths, 0)} simulated paths</SectionTitle>
        <p className="min-w-0 text-[11px] leading-relaxed text-slate-500">{forecast.method}</p>
      </div>

      {/* PoP donut row */}
      <p className="mt-4 text-[11px] font-medium tracking-[0.08em] text-slate-500 uppercase">
        Historical bootstrap scenario frequency (NOT a calibrated probability)
      </p>
      <div className="thin-scroll mt-2 flex gap-4 overflow-x-auto sm:gap-6">
        {horizons.map((h) => (
          <PopDonut key={h.horizonDays} horizon={h} />
        ))}
      </div>

      {/* Percentile cone */}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[11px] font-medium tracking-[0.08em] text-slate-500 uppercase">Simulated return cone</p>
        <div className="flex flex-wrap items-center gap-4">
          <LegendSwatch opacity={0.16} label="p5–p95" />
          <LegendSwatch opacity={0.4} label="p25–p75" />
          <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
            <svg width="18" height="6" aria-hidden>
              <line x1="1" y1="3" x2="17" y2="3" stroke={CHART.sky} strokeWidth="2" strokeLinecap="round" />
            </svg>
            median (p50)
          </span>
        </div>
      </div>
      <div className="mt-2 h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={coneData} margin={{ top: 8, right: 16, bottom: 0, left: 4 }}>
            <CartesianGrid stroke={CHART.grid} strokeWidth={1} vertical={false} />
            <XAxis
              type="number"
              dataKey="x"
              domain={[0, 'dataMax']}
              ticks={[0, ...horizons.map((h) => h.horizonDays)]}
              tickFormatter={(v: number) => (v === 0 ? 'today' : `${v}d`)}
              tick={{ fill: CHART.tick, fontSize: 11 }}
              axisLine={{ stroke: CHART.axisLine }}
              tickLine={false}
              tickMargin={8}
            />
            <YAxis
              domain={['auto', 'auto']}
              tick={{ fill: CHART.tick, fontSize: 11 }}
              tickFormatter={(v: number) => `${v > 0 ? '+' : ''}${plain(v, 0)}%`}
              axisLine={false}
              tickLine={false}
              width={52}
            />
            <Tooltip content={<ConeTip />} cursor={{ stroke: CHART.axisLine, strokeWidth: 1 }} />
            <ReferenceLine y={0} stroke={CHART.reference} strokeWidth={1} strokeDasharray="5 4" />
            <Area
              dataKey="band95"
              name="p5–p95"
              stroke="none"
              fill={CHART.sky}
              fillOpacity={0.16}
              isAnimationActive
              animationDuration={350}
              activeDot={false}
            />
            <Area
              dataKey="band50"
              name="p25–p75"
              stroke="none"
              fill={CHART.sky}
              fillOpacity={0.4}
              isAnimationActive
              animationDuration={350}
              activeDot={false}
            />
            <Line
              dataKey="p50"
              name="median"
              stroke={CHART.sky}
              strokeWidth={2}
              dot={{ r: 3, fill: CHART.sky, stroke: CHART.surface, strokeWidth: 2 }}
              activeDot={{ r: 5, fill: CHART.sky, stroke: CHART.surface, strokeWidth: 2 }}
              isAnimationActive
              animationDuration={350}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* 30-day tail-risk stats */}
      {h30 && (
        <div className="mt-4 grid grid-cols-3 gap-2 border-t border-white/8 pt-4">
          <div className="glass-inset px-3 py-2">
            <p className="text-[11px] text-slate-500">P(−10% or worse) · {h30.horizonDays}d</p>
            <p className={clsx('font-display text-sm font-semibold tabular-nums', 'text-sell')}>
              {pct(h30.pDown10 * 100, 1)}
            </p>
          </div>
          <div className="glass-inset px-3 py-2">
            <p className="text-[11px] text-slate-500">P(−20% or worse) · {h30.horizonDays}d</p>
            <p className={clsx('font-display text-sm font-semibold tabular-nums', 'text-sell')}>
              {pct(h30.pDown20 * 100, 1)}
            </p>
          </div>
          <div className="glass-inset px-3 py-2">
            <p className="text-[11px] text-slate-500">freq(+10% or better) · {h30.horizonDays}d</p>
            <p className={clsx('font-display text-sm font-semibold tabular-nums', 'text-buy')}>
              {pct(h30.pUp10 * 100, 1)}
            </p>
          </div>
        </div>
      )}

      <p className="mt-3 text-[11px] leading-relaxed text-slate-500">{forecast.note}</p>
    </Card>
  );
}
