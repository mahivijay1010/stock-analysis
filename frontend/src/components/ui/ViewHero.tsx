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
    <section className={clsx('view-hero', className)}>
      <div className="view-hero-sheen" aria-hidden />
      <div className="view-hero-copy min-w-0">
        {eyebrow != null && (
          <p className="view-hero-eyebrow font-display">
            {eyebrow}
          </p>
        )}
        <h2 className="view-hero-title font-display">
          {title}
        </h2>
        {subtitle != null && <p className="view-hero-subtitle">{subtitle}</p>}
      </div>
      <div className="view-hero-aside">
        <div className="view-hero-object" aria-hidden>
          <span className="view-hero-core" />
          <span className="view-hero-orbit view-hero-orbit-a" />
          <span className="view-hero-orbit view-hero-orbit-b" />
          <span className="view-hero-satellite" />
        </div>
        {/* min-w-0 (not shrink-0): the chip row must be allowed to shrink and
            wrap on phones — shrink-0 forced its max-content width and pushed
            the page into horizontal overflow at 375px. */}
        {right != null && <div className="view-hero-meta">{right}</div>}
      </div>
    </section>
  );
}
