'use client';

import { ReactNode } from 'react';
import clsx from 'clsx';

/** Compact workspace heading. Visual emphasis stays on the data below. */
export function ViewHero({
  title,
  subtitle,
  eyebrow,
  right,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Optional micro kicker above the title. */
  eyebrow?: ReactNode;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx('relative flex flex-wrap items-end justify-between gap-x-8 gap-y-4 border-b border-white/[0.055] pb-5', className)}>
      <div className="min-w-0">
        {eyebrow != null && (
          <p className="font-display mb-2 text-[9px] font-semibold tracking-[0.2em] text-cyan-300/65 uppercase">
            {eyebrow}
          </p>
        )}
        <h2 className="font-display text-3xl font-semibold tracking-[-0.035em] text-slate-100 sm:text-[2.35rem]">
          {title}
        </h2>
        {subtitle != null && <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-slate-500">{subtitle}</p>}
      </div>
      {/* min-w-0 (not shrink-0): the chip row must be allowed to shrink and
          wrap on phones — shrink-0 forced its max-content width and pushed
          the page into horizontal overflow at 375px (measured 479px). */}
      {right != null && <div className="flex min-w-0 flex-wrap items-center gap-2 pb-1.5">{right}</div>}
    </div>
  );
}
