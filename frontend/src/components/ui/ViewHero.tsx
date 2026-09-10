'use client';

import { ReactNode } from 'react';
import clsx from 'clsx';
import { MarketPrism, type MarketPrismState } from '@/components/market/MarketPrism';

/** Compact workspace heading. Visual emphasis stays on the data below. */
export function ViewHero({
  title,
  subtitle,
  eyebrow,
  right,
  visual,
  prismState,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Optional micro kicker above the title. */
  eyebrow?: ReactNode;
  right?: ReactNode;
  /** Optional data-bearing visual; defaults to the lightweight Market Prism. */
  visual?: ReactNode | false;
  prismState?: MarketPrismState;
  className?: string;
}) {
  const visualNode = visual === false ? null : (visual ?? <MarketPrism state={prismState} compact />);
  const hasAside = visualNode != null || right != null;

  return (
    <section className={clsx('view-hero', !hasAside && 'view-hero-no-aside', className)}>
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
      {hasAside && <div className="view-hero-aside">
        {visualNode}
        {/* min-w-0 (not shrink-0): the chip row must be allowed to shrink and
            wrap on phones — shrink-0 forced its max-content width and pushed
            the page into horizontal overflow at 375px. */}
        {right != null && <div className="view-hero-meta">{right}</div>}
      </div>}
    </section>
  );
}
