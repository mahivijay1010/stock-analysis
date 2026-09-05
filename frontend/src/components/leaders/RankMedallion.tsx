'use client';

import clsx from 'clsx';

/* Metal ring treatments for the podium ranks; quiet glass ring otherwise. */
const MEDAL_RING: Record<number, { ring: string; glow: string; text: string }> = {
  1: {
    ring: 'from-amber-200 via-yellow-400 to-amber-600',
    glow: 'shadow-[0_0_20px_rgba(251,191,36,0.4)]',
    text: 'text-amber-300',
  },
  2: {
    ring: 'from-slate-100 via-slate-300 to-slate-500',
    glow: 'shadow-[0_0_16px_rgba(203,213,225,0.3)]',
    text: 'text-slate-200',
  },
  3: {
    ring: 'from-orange-200 via-orange-400 to-orange-700',
    glow: 'shadow-[0_0_16px_rgba(249,115,22,0.3)]',
    text: 'text-orange-300',
  },
};

const NEUTRAL_RING = { ring: 'from-white/30 via-white/10 to-white/5', glow: '', text: 'text-slate-300' };

/**
 * Rank medallion — gradient ring + display-font numeral. Gold / silver /
 * bronze for the podium, a neutral glass ring for every other rank.
 * `sm` fits dense table rows; `md` headlines the Top-5 pick cards.
 */
export function RankMedallion({
  rank,
  size = 'md',
  className,
}: {
  rank: number;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const meta = MEDAL_RING[rank] ?? NEUTRAL_RING;
  return (
    <span
      aria-label={`Rank ${rank}`}
      className={clsx(
        'inline-flex shrink-0 rounded-full bg-gradient-to-br p-[2px]',
        size === 'sm' ? 'h-7 w-7' : 'h-12 w-12',
        meta.ring,
        meta.glow,
        className,
      )}
    >
      <span
        className={clsx(
          'font-display flex h-full w-full items-center justify-center rounded-full bg-[var(--surface-solid)] font-bold tabular-nums',
          size === 'sm' ? 'text-xs' : 'text-xl',
          meta.text,
        )}
      >
        {rank}
      </span>
    </span>
  );
}
