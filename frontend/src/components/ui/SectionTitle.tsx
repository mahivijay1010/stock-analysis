'use client';

import { ReactNode } from 'react';
import clsx from 'clsx';

/** Compact section label with a quiet product-blue marker. */
export function SectionTitle({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <h3
      className={clsx(
        'font-display flex items-center gap-2 text-sm font-semibold tracking-[0.075em] text-slate-300 uppercase',
        className,
      )}
    >
      <span
        aria-hidden
        className="h-3.5 w-0.5 shrink-0 rounded-full bg-[#78a6ff]"
      />
      <span className="min-w-0">{children}</span>
    </h3>
  );
}
