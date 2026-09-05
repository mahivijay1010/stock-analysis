'use client';

import { ReactNode } from 'react';
import clsx from 'clsx';
import { useTilt } from '@/hooks/useTilt';

export type GlassCardVariant = 'base' | 'elevated' | 'interactive';

/**
 * Glass surface, the workhorse container.
 * - `base`      — frosted glass panel (blur 20px, inset top highlight, elev-md).
 * - `elevated`  — 1px cyan→violet gradient border wrapper around a darker
 *                 glass surface (hero cards), elev-lg.
 * - `interactive` — base glass + 3D hover tilt + lift + border-glow. Use for
 *                 cards that navigate or expand on click.
 * `lift` adds hover lift + accent ring to base/elevated without the tilt.
 * Transforms only — no layout jitter; tilt and lift disable themselves under
 * prefers-reduced-motion (see useTilt + globals.css).
 */
export function GlassCard({
  children,
  className,
  variant = 'base',
  lift = false,
  maxTiltDeg = 4,
}: {
  children: ReactNode;
  className?: string;
  variant?: GlassCardVariant;
  /** Hover lift + accent ring (built into `interactive`). */
  lift?: boolean;
  /** Max tilt for the interactive variant, in degrees. */
  maxTiltDeg?: number;
}) {
  const tiltRef = useTilt<HTMLDivElement>({ maxDeg: maxTiltDeg });

  if (variant === 'elevated') {
    return (
      <div className={clsx('glass-elevated', lift && 'card-lift')}>
        <div className={clsx('glass-elevated-inner', className)}>{children}</div>
      </div>
    );
  }

  if (variant === 'interactive') {
    return (
      <div ref={tiltRef} className={clsx('glass card-lift card-glow', className)}>
        {children}
      </div>
    );
  }

  return <div className={clsx('glass', lift && 'card-lift', className)}>{children}</div>;
}

/**
 * Legacy alias — the original `Card` API every view already imports.
 * `elevated` renders the gradient-border hero variant; `lift` adds hover lift.
 */
export function Card({
  children,
  className,
  elevated = false,
  lift = false,
}: {
  children: ReactNode;
  className?: string;
  elevated?: boolean;
  lift?: boolean;
}) {
  return (
    <GlassCard variant={elevated ? 'elevated' : 'base'} lift={lift} className={className}>
      {children}
    </GlassCard>
  );
}
