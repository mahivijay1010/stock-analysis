'use client';

import { useMemo } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { EquityPoint, GoalTracker } from '@/lib/types';
import { CHART } from '@/lib/palette';
import { fmtDate, inrShort, inrSmart } from '@/lib/format';
import { Card, SectionTitle } from '@/components/ui';

interface Row {
  day: number;
  date?: string;
  equity?: number | null;
  target?: number | null;
}

const DAY_MS = 86_400_000;

/** Constant-daily-compounding (geometric) interpolation between milestone points. */
function targetAt(day: number, pts: Array<{ day: number; target: number }>): number | null {
  if (!pts.length) return null;
  if (day <= pts[0].day) return pts[0].target;
  const lastPt = pts[pts.length - 1];
  if (day >= lastPt.day) return lastPt.target;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (day >= a.day && day <= b.day) {
      if (b.day === a.day || a.target <= 0 || b.target <= 0) return a.target;
      const frac = (day - a.day) / (b.day - a.day);
      return a.target * Math.pow(b.target / a.target, frac);
    }
  }
  return null;
}

function LegendKey({ dash, color, label }: { dash?: boolean; color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
      <svg width="18" height="6" aria-hidden>
        <line
          x1="1"
          y1="3"
          x2="17"
          y2="3"
          stroke={color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={dash ? '4 3' : undefined}
        />
      </svg>
      {label}
    </span>
  );
}

function CurveTip({ active, payload }: { active?: boolean; payload?: Array<{ payload?: Row }> }) {
  if (!active || !payload?.length) return null;
  const p = payload[0]?.payload;
  if (!p) return null;
  return (
    <div className="chart-tip px-3 py-2 text-xs">
      <p className="font-medium text-slate-300">
        Day {p.day}
        {p.date ? ` · ${fmtDate(p.date)}` : ''}
      </p>
      {p.equity != null && (
        <p className="mt-1 text-sm font-semibold text-slate-100">Equity {inrSmart(p.equity)}</p>
      )}
      {p.target != null && <p className="mt-0.5 text-slate-400">Milestone path {inrSmart(p.target)}</p>}
    </div>
  );
}

export function EquityCurveChart({
  curve,
  goals,
  startCapital,
}: {
  curve: EquityPoint[];
  goals: GoalTracker;
  startCapital: number;
}) {
  const { rows, ticks, yDomain, yTicks } = useMemo(() => {
    const startMs = new Date(goals.startedAt).getTime();
    const dayOf = (iso: string) =>
      Number.isFinite(startMs) ? Math.max(0, Math.round((new Date(iso).getTime() - startMs) / DAY_MS)) : 0;

    const milestonePts = [
      { day: 0, target: Math.max(1, startCapital) },
      ...[...goals.milestones].sort((a, b) => a.day - b.day),
    ];
    const lastMilestoneDay = milestonePts[milestonePts.length - 1]?.day ?? 30;

    const equityByDay = new Map<number, { equity: number; date?: string }>();
    for (const p of curve) {
      equityByDay.set(dayOf(p.date), { equity: Math.max(1, p.equity), date: p.date }); // clamp for log scale
    }
    // Ensure start and today are on the curve even if the backend curve is sparse.
    if (!equityByDay.has(0)) equityByDay.set(0, { equity: Math.max(1, startCapital) });
    const today = Math.max(0, goals.currentDay);
    if (!equityByDay.has(today)) equityByDay.set(today, { equity: Math.max(1, goals.currentEquity) });

    const maxDay = Math.max(lastMilestoneDay, today, ...Array.from(equityByDay.keys()));
    const out: Row[] = [];
    for (let d = 0; d <= maxDay; d++) {
      const e = equityByDay.get(d);
      out.push({ day: d, date: e?.date, equity: e ? e.equity : null, target: targetAt(d, milestonePts) });
    }

    const equityVals = Array.from(equityByDay.values()).map((v) => v.equity);
    const minVal = Math.min(Math.max(1, startCapital), ...equityVals);
    const maxTarget = milestonePts[milestonePts.length - 1]?.target ?? 100_000;
    const domain: [number, number] = [Math.max(1, Math.floor(minVal * 0.8)), Math.ceil(maxTarget * 1.1)];
    const yT = [1_000, 5_000, 10_000, 50_000, 100_000].filter((t) => t >= domain[0] && t <= domain[1]);

    const xT = Array.from(new Set([0, ...milestonePts.map((m) => m.day)])).filter((t) => t <= maxDay);
    return { rows: out, ticks: xT, yDomain: domain, yTicks: yT };
  }, [curve, goals, startCapital]);

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionTitle>Equity curve vs milestone path</SectionTitle>
        <div className="flex flex-wrap items-center gap-4">
          <LegendKey color={CHART.ink} label="Actual equity" />
          <LegendKey dash color={CHART.amber} label="Milestone path (aspirational)" />
        </div>
      </div>

      <div className="mt-4 h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 10, right: 14, bottom: 0, left: 4 }}>
            <CartesianGrid stroke={CHART.grid} strokeWidth={1} vertical={false} />
            <XAxis
              type="number"
              dataKey="day"
              domain={[0, 'dataMax']}
              ticks={ticks}
              tickFormatter={(v: number) => (v === 0 ? 'Start' : `D${v}`)}
              tick={{ fill: CHART.tick, fontSize: 11 }}
              axisLine={{ stroke: CHART.axisLine }}
              tickLine={false}
              tickMargin={8}
            />
            <YAxis
              scale="log"
              domain={yDomain}
              ticks={yTicks}
              allowDataOverflow
              tickFormatter={(v: number) => inrShort(v)}
              tick={{ fill: CHART.tick, fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={56}
            />
            <Tooltip content={<CurveTip />} cursor={{ stroke: CHART.axisLine, strokeWidth: 1 }} />
            <defs>
              <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#22d3ee" stopOpacity={0.28} />
                <stop offset="100%" stopColor="#22d3ee" stopOpacity={0} />
              </linearGradient>
            </defs>
            <Line
              dataKey="target"
              stroke={CHART.amber}
              strokeWidth={2}
              strokeDasharray="6 4"
              dot={false}
              isAnimationActive
              animationDuration={350}
              activeDot={false}
            />
            <Area
              dataKey="equity"
              stroke={CHART.ink}
              strokeWidth={2}
              fill="url(#equityFill)"
              baseValue="dataMin"
              connectNulls
              dot={{ r: 2.5, fill: CHART.ink, strokeWidth: 0 }}
              isAnimationActive
              animationDuration={350}
              activeDot={{ r: 4, fill: CHART.ink, stroke: CHART.surface, strokeWidth: 2 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-slate-600">
        Log scale — the dashed path is the aspirational milestone track, not a forecast. See the reality check above.
      </p>
    </Card>
  );
}
