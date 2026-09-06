'use client';

import { useMemo } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { EquityPoint } from '@/lib/types';
import { CHART } from '@/lib/palette';
import { fmtDate, inrShort, inrSmart } from '@/lib/format';
import { Card, SectionTitle } from '@/components/ui';

// v2 upgrade: the aspirational milestone/goal path was removed from the
// product (upgrade-spec §2, last row). This is now a plain record of actual
// sandbox equity — no target overlay, no growth-path implication.

interface Row {
  day: number;
  date?: string;
  equity: number;
}

const DAY_MS = 86_400_000;

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
      <p className="mt-1 text-sm font-semibold text-slate-100">Equity {inrSmart(p.equity)}</p>
    </div>
  );
}

export function EquityCurveChart({ curve, startCapital }: { curve: EquityPoint[]; startCapital: number }) {
  const rows = useMemo<Row[]>(() => {
    if (!curve.length) return [{ day: 0, equity: startCapital }];
    const startMs = new Date(curve[0].date).getTime();
    return curve.map((p) => ({
      day: Number.isFinite(startMs) ? Math.max(0, Math.round((new Date(p.date).getTime() - startMs) / DAY_MS)) : 0,
      date: p.date,
      equity: p.equity,
    }));
  }, [curve, startCapital]);

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionTitle>Sandbox equity history</SectionTitle>
        <span className="text-xs text-slate-500">actual recorded values only</span>
      </div>

      <div className="mt-4 h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 10, right: 14, bottom: 0, left: 4 }}>
            <CartesianGrid stroke={CHART.grid} strokeWidth={1} vertical={false} />
            <XAxis
              type="number"
              dataKey="day"
              domain={[0, 'dataMax']}
              tickFormatter={(v: number) => (v === 0 ? 'Start' : `D${v}`)}
              tick={{ fill: CHART.tick, fontSize: 11 }}
              axisLine={{ stroke: CHART.axisLine }}
              tickLine={false}
              tickMargin={8}
            />
            <YAxis
              domain={['auto', 'auto']}
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
    </Card>
  );
}
