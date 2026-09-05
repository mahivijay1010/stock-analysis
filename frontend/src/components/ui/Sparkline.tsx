'use client';

import { useId } from 'react';
import clsx from 'clsx';
import { COLOR } from '@/lib/design-tokens';

export type SparklineTone = 'info' | 'buy' | 'sell' | 'auto';

/**
 * Tiny inline SVG trend line with a soft gradient fill and a last-point dot.
 * `tone="auto"` colors by direction (last vs first). Decorative by default
 * (aria-hidden) — pass `ariaLabel` when it carries meaning on its own.
 */
export function Sparkline({
  data,
  width = 120,
  height = 36,
  tone = 'info',
  strokeWidth = 1.5,
  fill = true,
  className,
  ariaLabel,
}: {
  data: number[];
  width?: number;
  height?: number;
  tone?: SparklineTone;
  strokeWidth?: number;
  fill?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  const uid = useId();

  if (data.length === 0) return null;

  const color =
    tone === 'auto'
      ? data[data.length - 1] >= data[0]
        ? COLOR.accent.buy
        : COLOR.accent.sell
      : tone === 'buy'
        ? COLOR.accent.buy
        : tone === 'sell'
          ? COLOR.accent.sell
          : COLOR.accent.cyan;

  const pad = strokeWidth + 1.5;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min;

  const x = (i: number) => (data.length === 1 ? width / 2 : pad + (i / (data.length - 1)) * (width - pad * 2));
  const y = (v: number) => (span === 0 ? height / 2 : height - pad - ((v - min) / span) * (height - pad * 2));

  const points = data.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`);
  const line = `M ${points.join(' L ')}`;
  const area = `${line} L ${x(data.length - 1).toFixed(2)},${height - pad} L ${x(0).toFixed(2)},${height - pad} Z`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={clsx('shrink-0', className)}
      role={ariaLabel ? 'img' : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
    >
      <defs>
        <linearGradient id={`spark-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {fill && data.length > 1 && <path d={area} fill={`url(#spark-${uid})`} />}
      {data.length > 1 ? (
        <path d={line} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <line x1={pad} x2={width - pad} y1={height / 2} y2={height / 2} stroke={color} strokeWidth={strokeWidth} />
      )}
      <circle cx={x(data.length - 1)} cy={y(data[data.length - 1])} r={2} fill={color} />
    </svg>
  );
}
