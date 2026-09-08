'use client';

import clsx from 'clsx';

/** A semantic radar: outer=regime, middle=participation, core=quality. */
export function TradeRadarOrb({
  regime = 'unknown',
  participation = 'measuring',
  quality = 'idle',
  active = false,
  compact = false,
}: {
  regime?: string;
  participation?: string;
  quality?: string;
  active?: boolean;
  compact?: boolean;
}) {
  return (
    <figure className={clsx('trade-radar', active && 'trade-radar-active', compact && 'trade-radar-compact')}>
      <div className="trade-radar-scene" aria-hidden>
        <span className="trade-radar-ring trade-radar-ring-outer"><i /></span>
        <span className="trade-radar-ring trade-radar-ring-middle"><i /></span>
        <span className="trade-radar-ring trade-radar-ring-inner"><i /></span>
        <span className="trade-radar-core"><b>{active ? 'LIVE' : 'READY'}</b></span>
        <span className="trade-radar-scan" />
      </div>
      <figcaption className="sr-only">
        Trade radar. Market regime {regime}; sector participation {participation}; candidate quality {quality}.
      </figcaption>
      {!compact && (
        <div className="trade-radar-legend" aria-hidden>
          <span><i className="radar-key-outer" />Regime <b>{regime}</b></span>
          <span><i className="radar-key-middle" />Breadth <b>{participation}</b></span>
          <span><i className="radar-key-core" />Quality <b>{quality}</b></span>
        </div>
      )}
    </figure>
  );
}
