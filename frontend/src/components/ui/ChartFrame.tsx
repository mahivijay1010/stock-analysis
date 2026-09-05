'use client';

import { ReactElement, ReactNode, useEffect, useState } from 'react';
import { ResponsiveContainer } from 'recharts';
import clsx from 'clsx';
import { CHART } from '@/lib/palette';

/**
 * Shared Recharts prop presets so every chart draws identical axes/grid ink.
 * Spread into the corresponding Recharts elements:
 *   <CartesianGrid {...chartGridProps} />
 *   <XAxis {...chartAxisProps} />  <YAxis {...chartAxisProps} axisLine={false} />
 */
export const chartGridProps = { stroke: CHART.grid, strokeWidth: 1, vertical: false } as const;

export const chartAxisProps = {
  tick: { fill: CHART.tick, fontSize: 11 },
  axisLine: { stroke: CHART.axisLine },
  tickLine: false,
  tickMargin: 8,
} as const;

/** Cursor line for <Tooltip cursor={chartCursor}> — matches axis ink. */
export const chartCursor = { stroke: CHART.axisLine, strokeWidth: 1 } as const;

/**
 * Series draw-in props — spread into Line/Area/Bar. Respects
 * prefers-reduced-motion via useChartMotion() when you need it reactive;
 * this static preset is for simple cases.
 */
export const chartAnimProps = { isAnimationActive: true, animationDuration: 350 } as const;

/** Reactive variant: disables the Recharts draw-in under prefers-reduced-motion. */
export function useChartMotion(): { isAnimationActive: boolean; animationDuration: number } {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return { isAnimationActive: !reduced, animationDuration: 350 };
}

/** Glass tooltip container for custom Recharts tooltips. */
export function ChartTip({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx('chart-tip px-3 py-2 text-xs', className)}>{children}</div>;
}

/** Legend swatch: line / dashed line / filled band / dot. */
export function ChartLegendKey({
  kind,
  color,
  label,
}: {
  kind: 'line' | 'dash' | 'fill' | 'dot';
  color: string;
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
      {kind === 'fill' ? (
        <span className="h-2.5 w-3.5 rounded-sm" style={{ backgroundColor: color, opacity: 0.25 }} />
      ) : kind === 'dot' ? (
        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
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

/**
 * Chart shell: header row (title/legend/right slot), fade-in on mount and a
 * ResponsiveContainer at a fixed height. Keep the actual Recharts markup in
 * the page — this frame only standardizes chrome and sizing.
 */
export function ChartFrame({
  children,
  height = 288,
  title,
  legend,
  right,
  ariaLabel,
  className,
}: {
  /** A single Recharts chart element (LineChart, ComposedChart, …). */
  children: ReactElement;
  height?: number;
  title?: ReactNode;
  /** Row of <ChartLegendKey /> nodes. */
  legend?: ReactNode;
  right?: ReactNode;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <figure aria-label={ariaLabel} className={clsx('animate-fade-in m-0', className)}>
      {(title != null || legend != null || right != null) && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          {title}
          <div className="flex flex-wrap items-center gap-4">
            {legend}
            {right}
          </div>
        </div>
      )}
      <div className="w-full" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
