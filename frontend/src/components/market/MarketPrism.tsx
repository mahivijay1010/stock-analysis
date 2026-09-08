'use client';

import clsx from 'clsx';

export type MarketPrismState = {
  direction?: 'up' | 'down' | 'neutral';
  volatility?: 'low' | 'normal' | 'high';
  confidence?: 'low' | 'medium' | 'high';
  risk?: 'low' | 'medium' | 'high';
};

/**
 * Lightweight, information-bearing product identity. The prism's posture,
 * internal spread and warm risk edge are driven only by explicit state props.
 * CSS transforms keep it GPU-cheap and the adjacent copy makes the meaning
 * available without requiring anyone to interpret the object.
 */
export function MarketPrism({
  state = {},
  compact = false,
  label = 'Market depth',
}: {
  state?: MarketPrismState;
  compact?: boolean;
  label?: string;
}) {
  const direction = state.direction ?? 'neutral';
  const volatility = state.volatility ?? 'normal';
  const confidence = state.confidence ?? 'medium';
  const risk = state.risk ?? 'low';

  return (
    <figure
      className={clsx(
        'market-prism',
        `market-prism-${direction}`,
        `market-prism-vol-${volatility}`,
        `market-prism-confidence-${confidence}`,
        `market-prism-risk-${risk}`,
        compact && 'market-prism-compact',
      )}
      aria-label={`${label}: ${direction} direction, ${volatility} volatility, ${confidence} confidence, ${risk} risk`}
    >
      <div className="market-prism-scene" aria-hidden>
        <span className="market-prism-depth market-prism-depth-back" />
        <span className="market-prism-face market-prism-face-left" />
        <span className="market-prism-face market-prism-face-right" />
        <span className="market-prism-face market-prism-face-center" />
        <span className="market-prism-depth market-prism-depth-front" />
        <span className="market-prism-orbit market-prism-orbit-a"><i /></span>
        <span className="market-prism-orbit market-prism-orbit-b"><i /></span>
      </div>
      <figcaption>
        <strong>{label}</strong>
        <span>{confidence} confidence · {risk} risk</span>
      </figcaption>
    </figure>
  );
}
