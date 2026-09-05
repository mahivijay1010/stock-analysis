'use client';

import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  Area,
  Bar as RBar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import clsx from 'clsx';
import { getStockChart } from '@/lib/api';
import type { ChartRange } from '@/lib/types';
import { CHART_RANGES } from '@/lib/types';
import { CHART } from '@/lib/palette';
import { compactCount, fmtDate, fmtDateShort, inr } from '@/lib/format';
import { Card, ErrorState, Skeleton } from '@/components/ui';

const RANGE_COPY: Record<ChartRange, string> = {
  '7d': 'Seven-session structure',
  '15d': 'Three-week structure',
  '1mo': 'One-month structure',
  '3mo': 'Quarterly structure',
  '6mo': 'Six-month structure',
  '1y': 'One-year structure',
  '5y': 'Five-year structure',
};

interface Row {
  date: string;
  close: number;
  volume: number;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  up: boolean;
}

const SMA_KEYS = [
  { key: 'sma20', label: 'SMA 20', color: CHART.sky },
  { key: 'sma50', label: 'SMA 50', color: CHART.amber },
  { key: 'sma200', label: 'SMA 200', color: CHART.violet },
] as const;

type SmaKey = (typeof SMA_KEYS)[number]['key'];

function PriceTip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ dataKey?: string | number; value?: number | null; color?: string; name?: string | number }>;
  label?: string | number;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tip px-3 py-2 text-xs">
      <p className="font-medium text-slate-300">{typeof label === 'string' ? fmtDate(label) : label}</p>
      <div className="mt-1 space-y-0.5">
        {payload.map((e, i) =>
          e.value == null ? null : (
            <p key={i} className="flex items-center gap-1.5">
              <svg width="14" height="4" aria-hidden>
                <line x1="1" y1="2" x2="13" y2="2" stroke={e.color ?? CHART.ink} strokeWidth="2" strokeLinecap="round" />
              </svg>
              <span className="font-semibold text-slate-100">{inr(e.value)}</span>
              <span className="text-slate-500">{String(e.name ?? e.dataKey)}</span>
            </p>
          ),
        )}
      </div>
    </div>
  );
}

function VolumeTip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ value?: number | null }>;
  label?: string | number;
}) {
  if (!active || !payload?.length || payload[0]?.value == null) return null;
  return (
    <div className="chart-tip px-3 py-2 text-xs">
      <p className="font-medium text-slate-300">{typeof label === 'string' ? fmtDate(label) : label}</p>
      <p className="mt-0.5">
        <span className="font-semibold text-slate-100">{compactCount(payload[0].value)}</span>{' '}
        <span className="text-slate-500">shares</span>
      </p>
    </div>
  );
}

export function PriceChartCard({ ticker }: { ticker: string }) {
  const [range, setRange] = useState<ChartRange>('6mo');
  const [visible, setVisible] = useState<Record<SmaKey, boolean>>({ sma20: true, sma50: true, sma200: false });

  const { data, isPending, isFetching, isError, error, refetch } = useQuery({
    queryKey: ['chart', ticker, range],
    queryFn: () => getStockChart(ticker, range),
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  });

  const rows = useMemo<Row[]>(() => {
    if (!data) return [];
    return data.bars.map((b, i) => ({
      date: b.date,
      close: b.close,
      volume: b.volume,
      sma20: data.sma20[i] ?? null,
      sma50: data.sma50[i] ?? null,
      sma200: data.sma200[i] ?? null,
      up: i > 0 ? b.close >= data.bars[i - 1].close : true,
    }));
  }, [data]);

  const syncId = `price-${ticker}`;
  const summary = useMemo(() => {
    if (rows.length < 2) return null;
    const first = rows[0].close;
    const latest = rows[rows.length - 1].close;
    const closes = rows.map((row) => row.close);
    return {
      latest,
      changePct: first === 0 ? 0 : ((latest - first) / first) * 100,
      low: Math.min(...closes),
      high: Math.max(...closes),
      rangePosition: Math.max(...closes) === Math.min(...closes) ? 50 : ((latest - Math.min(...closes)) / (Math.max(...closes) - Math.min(...closes))) * 100,
    };
  }, [rows]);

  const gradientId = `price-fill-${ticker.replace(/[^a-z0-9]/gi, '-')}`;

  return (
    <Card className="price-chart-card p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="price-chart-heading">
          <div className="price-chart-kicker"><span aria-hidden /> Market structure</div>
          <h3>Price &amp; trend</h3>
          <p>{RANGE_COPY[range]} with adaptive moving averages and traded volume.</p>
        </div>
        <div className="chart-range-tabs flex max-w-full overflow-x-auto rounded-xl border border-white/8 bg-white/4 p-1">
          {CHART_RANGES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={clsx(
                'rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors',
                r === range ? 'bg-[#78a6ff]/15 text-[#b0c7ff]' : 'text-slate-400 hover:text-slate-200',
              )}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {summary && (
        <div className="chart-summary-row">
          <div><span>Latest</span><strong>{inr(summary.latest)}</strong></div>
          <div><span>Period move</span><strong className={summary.changePct >= 0 ? 'text-buy' : 'text-sell'}>{summary.changePct >= 0 ? '+' : ''}{summary.changePct.toFixed(2)}%</strong></div>
          <div><span>Range position</span><strong>{summary.rangePosition.toFixed(0)}%</strong></div>
          <div><span>Observed range</span><strong>{inr(summary.low, 0)} – {inr(summary.high, 0)}</strong></div>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-5">
        <span className="inline-flex items-center gap-2 text-[13px] font-medium text-slate-300">
          <svg width="18" height="6" aria-hidden>
            <line x1="1" y1="3" x2="17" y2="3" stroke={CHART.ink} strokeWidth="2.5" strokeLinecap="round" />
          </svg>
          Close
        </span>
        {SMA_KEYS.map((s) => (
          <button
            key={s.key}
            type="button"
            aria-pressed={visible[s.key]}
            onClick={() => setVisible((v) => ({ ...v, [s.key]: !v[s.key] }))}
            className={clsx(
              'inline-flex items-center gap-2 text-[13px] font-medium transition-opacity',
              visible[s.key] ? 'text-slate-300' : 'text-slate-500 opacity-50',
            )}
          >
            <svg width="18" height="6" aria-hidden>
              <line x1="1" y1="3" x2="17" y2="3" stroke={s.color} strokeWidth="2" strokeLinecap="round" />
            </svg>
            {s.label}
          </button>
        ))}
      </div>

      {isError ? (
        <div className="mt-4">
          <ErrorState compact message={error instanceof Error ? error.message : 'Failed to load chart'} onRetry={() => refetch()} />
        </div>
      ) : isPending && rows.length === 0 ? (
        <div className="mt-4 space-y-2">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : rows.length < 2 ? (
        <p className="mt-4 text-sm text-slate-400">Not enough data for this range.</p>
      ) : (
        <div className={clsx('price-chart-plot mt-4 transition-opacity', isFetching && 'opacity-60')}>
          <div className="price-series-chart h-[280px] w-full sm:h-[340px]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={rows} syncId={syncId} margin={{ top: 12, right: 12, bottom: 0, left: 4 }}>
                <defs>
                  <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={CHART.sky} stopOpacity="0.24" />
                    <stop offset="52%" stopColor={CHART.sky} stopOpacity="0.075" />
                    <stop offset="100%" stopColor={CHART.sky} stopOpacity="0" />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={CHART.grid} strokeWidth={1} vertical={false} />
                <XAxis dataKey="date" hide />
                <YAxis
                  domain={['auto', 'auto']}
                  tick={{ fill: CHART.tick, fontSize: 11 }}
                  tickFormatter={(v: number) => `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(v)}`}
                  axisLine={false}
                  tickLine={false}
                  width={72}
                />
                <Tooltip content={<PriceTip />} cursor={{ stroke: CHART.axisLine, strokeWidth: 1 }} />
                <Area
                  type="monotone"
                  dataKey="close"
                  stroke="none"
                  fill={`url(#${gradientId})`}
                  isAnimationActive
                  animationDuration={700}
                  tooltipType="none"
                />
                <Line
                  type="monotone"
                  dataKey="close"
                  stroke={CHART.sky}
                  strokeWidth={9}
                  strokeOpacity={0.11}
                  dot={false}
                  activeDot={false}
                  isAnimationActive={false}
                  tooltipType="none"
                />
                <Line
                  type="monotone"
                  dataKey="close"
                  name="Close"
                  stroke={CHART.ink}
                  strokeWidth={2.7}
                  dot={false}
                  isAnimationActive={false}
                  activeDot={{ r: 4, fill: CHART.ink, stroke: CHART.surface, strokeWidth: 2 }}
                />
                {SMA_KEYS.map((s) =>
                  visible[s.key] ? (
                    <Line
                      key={s.key}
                      type="monotone"
                      dataKey={s.key}
                      name={s.label}
                      stroke={s.color}
                      strokeWidth={2}
                      dot={false}
                      connectNulls={false}
                      isAnimationActive={false}
                      activeDot={{ r: 4, fill: s.color, stroke: CHART.surface, strokeWidth: 2 }}
                    />
                  ) : null,
                )}
                {summary && (
                  <ReferenceDot
                    x={rows[rows.length - 1].date}
                    y={summary.latest}
                    r={4.5}
                    fill={CHART.sky}
                    stroke={CHART.surface}
                    strokeWidth={2.5}
                  />
                )}
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <div className="price-volume-chart mt-1 h-24 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={rows} syncId={syncId} margin={{ top: 0, right: 8, bottom: 0, left: 4 }}>
                <XAxis
                  dataKey="date"
                  tick={{ fill: CHART.tick, fontSize: 11 }}
                  tickFormatter={(d: string) => fmtDateShort(d)}
                  axisLine={{ stroke: CHART.axisLine }}
                  tickLine={false}
                  minTickGap={48}
                  tickMargin={8}
                />
                <YAxis
                  tick={{ fill: CHART.tick, fontSize: 10 }}
                  tickFormatter={(v: number) => compactCount(v)}
                  axisLine={false}
                  tickLine={false}
                  width={72}
                  tickCount={3}
                />
                <Tooltip content={<VolumeTip />} cursor={{ fill: 'rgba(148,163,184,0.08)' }} />
                <RBar dataKey="volume" name="Volume" isAnimationActive={false} radius={[2, 2, 0, 0]} fillOpacity={0.8}>
                  {rows.map((r, i) => (
                    <Cell key={i} fill={r.up ? CHART.gain : CHART.loss} />
                  ))}
                </RBar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </Card>
  );
}
