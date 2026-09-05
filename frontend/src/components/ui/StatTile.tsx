'use client';

import { ReactNode } from 'react';
import clsx from 'clsx';
import { useTilt } from '@/hooks/useTilt';
import { Sparkline } from './Sparkline';

/**
 * Compact KPI tile: uppercase micro label, big display-face value, optional
 * sub line, ⓘ popover, 3D hover tilt and a tiny trend sparkline.
 */
export function StatTile({
  label,
  value,
  sub,
  subClassName,
  tilt = false,
  info,
  spark,
  sparkTone = 'auto',
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  subClassName?: string;
  /** 3D hover tilt (desk stat tiles, etc.) */
  tilt?: boolean;
  /** Optional ⓘ popover next to the label (pass an <InfoTip />). */
  info?: ReactNode;
  /** Optional tiny trend line, right-aligned next to the value. */
  spark?: number[];
  sparkTone?: 'info' | 'buy' | 'sell' | 'auto';
  className?: string;
}) {
  const ref = useTilt<HTMLDivElement>();
  return (
    <div ref={tilt ? ref : undefined} className={clsx('glass p-4', className)}>
      <p className="flex items-center gap-1 text-[11px] font-medium tracking-[0.08em] text-slate-500 uppercase">
        <span className="min-w-0">{label}</span>
        {info}
      </p>
      <div className="flex items-end justify-between gap-3">
        <p className="font-display mt-1.5 min-w-0 text-2xl font-semibold tracking-tight text-slate-100 tabular-nums">
          {value}
        </p>
        {spark != null && spark.length > 1 && <Sparkline data={spark} tone={sparkTone} width={72} height={28} />}
      </div>
      {sub != null && <p className={clsx('mt-1 text-xs text-slate-500', subClassName)}>{sub}</p>}
    </div>
  );
}
