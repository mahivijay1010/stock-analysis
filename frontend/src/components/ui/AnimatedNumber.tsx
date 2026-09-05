'use client';

import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import clsx from 'clsx';

/**
 * Animated numeric value (CountUp upgrade): rAF tween, ease-out cubic,
 * tabular numerals, NaN-safe, snaps instantly under prefers-reduced-motion.
 * The initial render shows the value as-is (no attention-grabbing 0→N sweep
 * on load); it animates on subsequent changes.
 */
export function AnimatedNumber({
  value,
  format,
  className,
  durationMs = 500,
}: {
  value: number;
  format: (v: number) => string;
  className?: string;
  durationMs?: number;
}) {
  const reduced = useReducedMotion();
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  const rafRef = useRef(0);

  useEffect(() => {
    const from = fromRef.current;
    if (from === value) return;
    const jump = reduced || !Number.isFinite(value) || !Number.isFinite(from);
    const start = performance.now();
    const tick = (now: number) => {
      if (jump) {
        fromRef.current = value;
        setDisplay(value);
        return;
      }
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      setDisplay(from + (value - from) * eased);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = value;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [value, durationMs, reduced]);

  return <span className={clsx('tabular-nums', className)}>{format(display)}</span>;
}
