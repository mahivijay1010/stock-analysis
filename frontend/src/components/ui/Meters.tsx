'use client';

import { ReactNode, useEffect, useId, useState } from 'react';
import clsx from 'clsx';
import type { Recommendation } from '@/lib/types';

/* ------------------------------------------------------------------ */
/* Shared                                                              */
/* ------------------------------------------------------------------ */

export type MeterTone = 'buy' | 'sell' | 'amber' | 'info';

const METER_FILL: Record<MeterTone, string> = {
  buy: 'bg-gradient-to-r from-[#00b894] to-buy',
  sell: 'bg-gradient-to-r from-[#e11d48] to-sell',
  amber: 'bg-gradient-to-r from-amber-600 to-amber-400',
  info: 'bg-gradient-to-r from-cyan-400 to-violet-500',
};

/** Animate 0 → ratio after mount; CSS .meter-fill transitions the transform
 *  (and snaps instantly under prefers-reduced-motion). */
function useSweep(ratio: number): number {
  const [sweep, setSweep] = useState(0);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setSweep(ratio));
    return () => cancelAnimationFrame(raf);
  }, [ratio]);
  return sweep;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/* ------------------------------------------------------------------ */
/* ProgressBar                                                         */
/* ------------------------------------------------------------------ */

/**
 * Horizontal progress meter with an animated transform-only sweep and a
 * gradient fill. `label`/value row is optional for dense layouts.
 */
export function ProgressBar({
  value,
  max = 100,
  tone = 'info',
  label,
  showValue = true,
  format,
  size = 'md',
  className,
}: {
  value: number;
  max?: number;
  tone?: MeterTone;
  label?: ReactNode;
  showValue?: boolean;
  /** Formats the right-hand value (default: rounded percent of max). */
  format?: (value: number) => string;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const ratio = clamp01(max === 0 ? 0 : value / max);
  const sweep = useSweep(ratio);
  const text = format ? format(value) : `${Math.round(ratio * 100)}%`;

  return (
    <div className={className}>
      {(label != null || showValue) && (
        <div className="mb-1.5 flex items-baseline justify-between gap-3">
          {label != null ? (
            <span className="text-[11px] font-medium tracking-[0.08em] text-slate-500 uppercase">{label}</span>
          ) : (
            <span />
          )}
          {showValue && <span className="text-sm font-semibold text-slate-100 tabular-nums">{text}</span>}
        </div>
      )}
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={Math.round(value * 100) / 100}
        aria-valuetext={text}
        className={clsx('overflow-hidden rounded-full bg-white/8', size === 'sm' ? 'h-1.5' : 'h-2.5')}
      >
        <div
          className={clsx('meter-fill h-full w-full rounded-full', METER_FILL[tone])}
          style={{ transform: `scaleX(${sweep})` }}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* ScoreBar (legacy) — 0-100 score with recommendation coloring        */
/* ------------------------------------------------------------------ */

const REC_METER: Record<Recommendation, MeterTone> = { BUY: 'buy', HOLD: 'amber', AVOID: 'sell' };

export function ScoreBar({ score, rec, className }: { score: number; rec: Recommendation; className?: string }) {
  const clamped = Math.max(0, Math.min(100, score));
  const sweep = useSweep(clamped / 100);
  return (
    <div className={clsx('flex items-center gap-2', className)}>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/8">
        <div
          className={clsx('meter-fill h-full w-full rounded-full', METER_FILL[REC_METER[rec]])}
          style={{ transform: `scaleX(${sweep})` }}
        />
      </div>
      <span className="text-sm font-semibold text-slate-100 tabular-nums">{Math.round(clamped)}</span>
      <span className="text-xs text-slate-500">/ 100</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* ScoreDonut                                                          */
/* ------------------------------------------------------------------ */

export type DonutTone = 'neutral' | 'BUY' | 'HOLD' | 'AVOID';

const DONUT_STOPS: Record<DonutTone, [string, string]> = {
  neutral: ['#22d3ee', '#a78bfa'], // cyan → violet
  BUY: ['#00d4aa', '#009b7d'], // buy accent
  HOLD: ['#fbbf24', '#d97706'], // amber
  AVOID: ['#ff4d6d', '#e11d48'], // sell accent
};

/**
 * Score gauge: SVG donut with rounded caps, gradient stroke, subtle outer
 * glow, animated sweep on mount and the score in the display face at center.
 * tone: 'neutral' (cyan→violet), or a Recommendation for semantic color.
 */
export function ScoreDonut({
  score,
  tone = 'neutral',
  size = 96,
  label,
  className,
}: {
  score: number;
  tone?: DonutTone;
  size?: number;
  /** Optional micro caption under the number (only readable at size ≳ 72). */
  label?: string;
  className?: string;
}) {
  const uid = useId();
  const clamped = Math.max(0, Math.min(100, score));
  // Animate 0 → score after mount; CSS .donut-arc transitions the dasharray
  // (and snaps instantly under prefers-reduced-motion).
  const [sweep, setSweep] = useState(0);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setSweep(clamped));
    return () => cancelAnimationFrame(raf);
  }, [clamped]);

  const [c0, c1] = DONUT_STOPS[tone];
  const strokeW = size >= 72 ? 8.5 : 10; // viewBox units — chunkier when tiny
  const r = 50 - strokeW / 2 - 1;
  const showLabel = label != null && size >= 72;

  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={clsx('shrink-0', className)}
      role="img"
      aria-label={`Score ${Math.round(clamped)} out of 100`}
    >
      <defs>
        <linearGradient id={`donut-${uid}`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor={c0} />
          <stop offset="100%" stopColor={c1} />
        </linearGradient>
      </defs>
      <circle cx="50" cy="50" r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={strokeW} />
      {clamped > 0 && (
        <circle
          className="donut-arc"
          cx="50"
          cy="50"
          r={r}
          fill="none"
          stroke={`url(#donut-${uid})`}
          strokeWidth={strokeW}
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray={`${Math.max(sweep, 0.5)} ${100 - Math.max(sweep, 0.5)}`}
          transform="rotate(-90 50 50)"
          style={{ filter: `drop-shadow(0 0 5px ${c0}66)` }}
        />
      )}
      <text
        x="50"
        y={showLabel ? 51 : 50}
        textAnchor="middle"
        dominantBaseline="central"
        fill="#f8fafc"
        fontSize={size >= 72 ? 30 : 34}
        fontWeight={600}
        style={{ fontFamily: 'var(--font-display)', fontVariantNumeric: 'tabular-nums' }}
      >
        {Math.round(clamped)}
      </text>
      {showLabel && (
        <text x="50" y="68" textAnchor="middle" fill="#64748b" fontSize="8">
          {label}
        </text>
      )}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* GaugeH — horizontal gauge for Brier-style metrics                   */
/* ------------------------------------------------------------------ */

/**
 * Horizontal gauge for metrics that live on a bounded scale and are judged
 * against a benchmark (e.g. Brier score vs the 0.25 coin flip). Renders a
 * gradient fill swept to the value, a benchmark tick, and min/max labels.
 * With `lowerIsBetter` + `benchmark`, the fill auto-colors buy/sell by which
 * side of the benchmark the value lands on (pass `tone` to override).
 */
export function GaugeH({
  value,
  min = 0,
  max = 1,
  benchmark,
  benchmarkLabel,
  label,
  format = (v: number) => String(Math.round(v * 10000) / 10000),
  lowerIsBetter = false,
  tone,
  className,
}: {
  value: number;
  min?: number;
  max?: number;
  /** Reference line, e.g. 0.25 coin-flip Brier. */
  benchmark?: number;
  benchmarkLabel?: string;
  label?: ReactNode;
  format?: (v: number) => string;
  /** Auto-color vs benchmark: below = good when true. */
  lowerIsBetter?: boolean;
  /** Explicit fill tone (overrides the benchmark auto-color). */
  tone?: MeterTone;
  className?: string;
}) {
  const span = max - min;
  const ratio = clamp01(span === 0 ? 0 : (value - min) / span);
  const sweep = useSweep(ratio);
  const benchRatio = benchmark != null ? clamp01(span === 0 ? 0 : (benchmark - min) / span) : null;

  const autoTone: MeterTone =
    benchmark == null ? 'info' : (lowerIsBetter ? value <= benchmark : value >= benchmark) ? 'buy' : 'sell';
  const fillTone = tone ?? autoTone;

  const ariaText = `${format(value)}${benchmark != null ? `, benchmark ${benchmarkLabel ?? ''} ${format(benchmark)}` : ''}`;

  return (
    <div className={className}>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        {label != null ? (
          <span className="text-[11px] font-medium tracking-[0.08em] text-slate-500 uppercase">{label}</span>
        ) : (
          <span />
        )}
        <span className="font-display text-sm font-semibold text-slate-100 tabular-nums">{format(value)}</span>
      </div>
      <div role="img" aria-label={typeof label === 'string' ? `${label}: ${ariaText}` : ariaText}>
        <div className="relative">
          <div className="h-2.5 overflow-hidden rounded-full bg-white/8">
            <div
              className={clsx('meter-fill h-full w-full rounded-full', METER_FILL[fillTone])}
              style={{ transform: `scaleX(${sweep})` }}
            />
          </div>
          {benchRatio != null && (
            <span
              aria-hidden
              className="absolute -inset-y-1 w-px bg-slate-200/80 shadow-[0_0_6px_rgba(248,250,252,0.5)]"
              style={{ left: `${benchRatio * 100}%` }}
            />
          )}
        </div>
        <div className="relative mt-1 flex justify-between text-[10px] text-slate-500 tabular-nums">
          <span>{format(min)}</span>
          {benchRatio != null && benchmarkLabel != null && (
            <span
              aria-hidden
              className="absolute top-0 -translate-x-1/2 whitespace-nowrap text-slate-400"
              style={{ left: `${benchRatio * 100}%` }}
            >
              {benchmarkLabel}
            </span>
          )}
          <span>{format(max)}</span>
        </div>
      </div>
    </div>
  );
}
