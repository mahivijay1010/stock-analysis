'use client';

import { useEffect, useState } from 'react';

/**
 * Animate a meter fill 0 → ratio on mount (and toward any new ratio).
 * Pair with the global `.meter-fill` class + `transform: scaleX(sweep)`:
 * the CSS owns the transition and snaps instantly under
 * prefers-reduced-motion, so this hook stays decorative-safe.
 */
export function useMountSweep(ratio: number): number {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  const [sweep, setSweep] = useState(0);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setSweep(clamped));
    return () => cancelAnimationFrame(raf);
  }, [clamped]);
  return sweep;
}
