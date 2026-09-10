'use client';

import { ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { useTilt } from '@/hooks/useTilt';
import { DURATION, EASE } from '@/lib/design-tokens';

/* ------------------------------------------------------------------ */
/* Tab content transition (fade + rise)                                */
/* ------------------------------------------------------------------ */

export function TabPanel({ children, className }: { children: ReactNode; className?: string }) {
  const reducedMotion = useReducedMotion();

  return (
    <motion.div
      data-slot="tab-panel"
      initial={reducedMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2, ease: EASE.standard }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/* Staggered card entrance                                             */
/* ------------------------------------------------------------------ */

const staggerContainer = {
  hidden: {},
  show: { transition: { staggerChildren: 0.085, delayChildren: 0.05 } },
};

const staggerChild = {
  hidden: { opacity: 0, y: 18, scale: 0.992, filter: 'blur(4px)' },
  show: { opacity: 1, y: 0, scale: 1, filter: 'blur(0px)', transition: { duration: 0.46, ease: EASE.spring } },
};

export function Stagger({ children, className }: { children: ReactNode; className?: string }) {
  const reducedMotion = useReducedMotion();
  return (
    <motion.div variants={staggerContainer} initial={reducedMotion ? false : 'hidden'} animate="show" className={className}>
      {children}
    </motion.div>
  );
}

export function StaggerItem({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div variants={staggerChild} className={className}>
      {children}
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/* Tilt wrapper (3D hover)                                             */
/* ------------------------------------------------------------------ */

export function Tilt({
  children,
  className,
  maxDeg = 5,
}: {
  children: ReactNode;
  className?: string;
  maxDeg?: number;
}) {
  const ref = useTilt<HTMLDivElement>({ maxDeg });
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* CountUp — legacy alias of the library's AnimatedNumber              */
/* ------------------------------------------------------------------ */

export { AnimatedNumber as CountUp } from '@/components/ui/AnimatedNumber';

/** Default duration re-exported for callers that tune CountUp. */
export const COUNTUP_DURATION_MS = DURATION.slow;
