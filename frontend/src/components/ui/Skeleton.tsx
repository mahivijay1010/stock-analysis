'use client';

import { CSSProperties } from 'react';
import clsx from 'clsx';
import { GlassCard } from './GlassCard';

/** Shimmering placeholder block (pauses under prefers-reduced-motion). */
export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return <div className={clsx('shimmer', className)} style={style} aria-hidden />;
}

/** Card-shaped loading state: title bar + n text lines. */
export function CardSkeleton({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <GlassCard className={clsx('p-5', className)}>
      <Skeleton className="mb-4 h-4 w-40" />
      <div className="space-y-3">
        {Array.from({ length: lines }).map((_, i) => (
          <Skeleton key={i} className="h-4" />
        ))}
      </div>
    </GlassCard>
  );
}

/** Table-shaped loading state: header strip + row grid. */
export function TableSkeleton({ rows = 5, cols = 4, className }: { rows?: number; cols?: number; className?: string }) {
  return (
    <div className={clsx('space-y-2.5', className)} aria-hidden>
      <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={i} className="h-3 w-2/3" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="grid gap-3" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className="h-4" />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Stat-tile-shaped loading state (label + big value + sub). */
export function StatTileSkeleton({ className }: { className?: string }) {
  return (
    <GlassCard className={clsx('p-4', className)}>
      <Skeleton className="h-3 w-24" />
      <Skeleton className="mt-2.5 h-7 w-32" />
      <Skeleton className="mt-2 h-3 w-20" />
    </GlassCard>
  );
}

/** Chart-shaped loading state: legend dots + plot area. */
export function ChartSkeleton({ height = 288, className }: { height?: number; className?: string }) {
  return (
    <div className={className} aria-hidden>
      <div className="mb-3 flex gap-4">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-20" />
      </div>
      <Skeleton className="w-full" style={{ height }} />
    </div>
  );
}
