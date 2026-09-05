'use client';

import { ReactNode, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import { ChevronDown } from 'lucide-react';

const STORE_PREFIX = 'stocksense.collapse.';

/**
 * Disclosure section: chevron rotation + framer-motion height animation.
 * Open state persists per `id` in localStorage (`stocksense.collapse.<id>`),
 * read after mount so SSR markup stays deterministic.
 */
export function Collapsible({
  id,
  title,
  subtitle,
  right,
  defaultOpen = false,
  children,
  className,
  bodyClassName,
}: {
  /** Stable id — the localStorage persistence key. */
  id: string;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Extra chips/actions on the header row (clicks won't toggle). */
  right?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);

  // Restore persisted state post-hydration (server can't read localStorage).
  useEffect(() => {
    const restore = window.requestAnimationFrame(() => {
      try {
        const stored = window.localStorage.getItem(STORE_PREFIX + id);
        if (stored === '1') setOpen(true);
        else if (stored === '0') setOpen(false);
      } catch {
        /* storage unavailable — keep defaultOpen */
      }
    });
    return () => window.cancelAnimationFrame(restore);
  }, [id]);

  const toggle = () => {
    setOpen((v) => {
      const next = !v;
      try {
        window.localStorage.setItem(STORE_PREFIX + id, next ? '1' : '0');
      } catch {
        /* non-fatal */
      }
      return next;
    });
  };

  return (
    <div className={className}>
      <div className="flex items-center gap-3">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`collapsible-${id}`}
          onClick={toggle}
          className="group flex min-h-11 min-w-0 flex-1 items-center justify-between gap-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400/70"
        >
          <span className="min-w-0">
            <span className="font-display block text-sm font-semibold tracking-wide text-slate-200 group-hover:text-slate-100">
              {title}
            </span>
            {subtitle != null && <span className="mt-0.5 block text-xs text-slate-500">{subtitle}</span>}
          </span>
          <motion.span
            animate={{ rotate: open ? 180 : 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="shrink-0 text-slate-500 group-hover:text-cyan-300"
            aria-hidden
          >
            <ChevronDown className="h-4 w-4" />
          </motion.span>
        </button>
        {right != null && <div className="shrink-0">{right}</div>}
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={`collapsible-${id}`}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
            <div className={clsx('pt-3', bodyClassName)}>{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
