'use client';

import clsx from 'clsx';
import { useRef } from 'react';
import { useAmbientActivity } from '@/hooks/useAmbientActivity';

type LensVariant = 'watch' | 'discover' | 'record';

const COPY: Record<LensVariant, { mode: string; label: string; description: string }> = {
  watch: { mode: 'MONITOR', label: 'Portfolio lens', description: 'Price, decision and risk together' },
  discover: { mode: 'MAP', label: 'Opportunity field', description: 'Relative signals across the universe' },
  record: { mode: 'VERIFY', label: 'Evidence lens', description: 'Calibration before confidence' },
};

/** A bounded spatial signature for each workspace. No market values are inferred here. */
export function MarketLens({ variant }: { variant: LensVariant }) {
  const rootRef = useRef<HTMLElement>(null);
  const active = useAmbientActivity(rootRef);
  const copy = COPY[variant];

  return (
    <figure ref={rootRef} className={clsx('market-lens', `market-lens-${variant}`, !active && 'ambient-paused')} aria-label={`${copy.label}: ${copy.description}`}>
      <div className="market-lens-scene" aria-hidden>
        <span className="market-lens-plane market-lens-plane-a" />
        <span className="market-lens-plane market-lens-plane-b" />
        <span className="market-lens-axis market-lens-axis-x" />
        <span className="market-lens-axis market-lens-axis-y" />
        <span className="market-lens-orbit market-lens-orbit-a"><i /></span>
        <span className="market-lens-orbit market-lens-orbit-b"><i /></span>
        <span className="market-lens-core"><b>{copy.mode}</b></span>
        <span className="market-lens-node market-lens-node-a" />
        <span className="market-lens-node market-lens-node-b" />
        <span className="market-lens-node market-lens-node-c" />
      </div>
      <figcaption><strong>{copy.label}</strong><span>{copy.description}</span></figcaption>
    </figure>
  );
}
