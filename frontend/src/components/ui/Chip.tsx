'use client';

import { ReactNode } from 'react';
import clsx from 'clsx';
import type { EntryAction, Recommendation, RiskLevel } from '@/lib/types';

/**
 * Semantic chip tones. `buy` / `sell` / `wait` are the canonical semantic
 * names; `emerald` / `rose` / `amber` are legacy aliases that map onto them so
 * older call sites keep rendering with the upgraded accent tokens.
 */
export type Tone =
  | 'buy'
  | 'sell'
  | 'wait'
  | 'emerald'
  | 'rose'
  | 'amber'
  | 'sky'
  | 'cyan'
  | 'violet'
  | 'zinc';

const BUY_CLASSES = 'border-buy/30 bg-buy/10 text-buy';
const SELL_CLASSES = 'border-sell/30 bg-sell/10 text-sell';
const WAIT_CLASSES = 'border-amber-400/30 bg-amber-400/10 text-amber-400';
const CYAN_CLASSES = 'border-[#78a6ff]/25 bg-[#78a6ff]/10 text-[#a9c3ff]';

export const TONE_CLASSES: Record<Tone, string> = {
  buy: BUY_CLASSES,
  emerald: BUY_CLASSES,
  sell: SELL_CLASSES,
  rose: SELL_CLASSES,
  wait: WAIT_CLASSES,
  amber: WAIT_CLASSES,
  sky: CYAN_CLASSES,
  cyan: CYAN_CLASSES,
  violet: 'border-[#9c8cff]/25 bg-[#9c8cff]/10 text-[#bdb4ff]',
  zinc: 'border-white/10 bg-white/5 text-slate-300',
};

const BUY_GLOW = 'shadow-[0_0_12px_rgba(54,201,155,0.12)]';
const SELL_GLOW = 'shadow-[0_0_12px_rgba(239,106,130,0.12)]';
const WAIT_GLOW = 'shadow-[0_0_12px_rgba(232,180,90,0.11)]';
const CYAN_GLOW = 'shadow-[0_0_12px_rgba(120,166,255,0.11)]';

export const TONE_GLOW: Record<Tone, string> = {
  buy: BUY_GLOW,
  emerald: BUY_GLOW,
  sell: SELL_GLOW,
  rose: SELL_GLOW,
  wait: WAIT_GLOW,
  amber: WAIT_GLOW,
  sky: CYAN_GLOW,
  cyan: CYAN_GLOW,
  violet: 'shadow-[0_0_12px_rgba(156,140,255,0.11)]',
  zinc: '',
};

export function Chip({
  tone = 'zinc',
  children,
  className,
  title,
  glow = false,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  title?: string;
  /** Faint matching glow — for verdict/status chips that should read from across the room. */
  glow?: boolean;
}) {
  return (
    <span
      title={title}
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium whitespace-nowrap',
        TONE_CLASSES[tone],
        glow && TONE_GLOW[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export const REC_TONE: Record<Recommendation, Tone> = { BUY: 'buy', HOLD: 'wait', AVOID: 'sell' };
export const RISK_TONE: Record<RiskLevel, Tone> = { LOW: 'buy', MEDIUM: 'wait', HIGH: 'sell' };

export function RecBadge({ rec, size = 'sm' }: { rec: Recommendation; size?: 'sm' | 'lg' }) {
  const tone = REC_TONE[rec];
  if (size === 'lg') {
    return (
      <span
        className={clsx(
          'font-display inline-flex items-center rounded-xl border px-4 py-1.5 text-xl font-bold tracking-wide',
          TONE_CLASSES[tone],
          TONE_GLOW[tone],
        )}
      >
        {rec}
      </span>
    );
  }
  return (
    <Chip tone={tone} glow>
      {rec}
    </Chip>
  );
}

export function RiskChip({ risk }: { risk: RiskLevel }) {
  return <Chip tone={RISK_TONE[risk]}>{risk} RISK</Chip>;
}

/** V5 entry-timing metadata shared by the Stocks table, Top-5 cards and the Analyze timing card. */
export const ENTRY_META: Record<EntryAction, { label: string; short: string; tone: Tone }> = {
  BUY_TODAY: { label: 'BUY TODAY', short: 'BUY TODAY', tone: 'buy' },
  WAIT: { label: 'WAIT', short: 'WAIT', tone: 'wait' },
  AVOID_ENTRY: { label: 'AVOID ENTRY', short: 'AVOID', tone: 'sell' },
};

/** Small BUY TODAY / WAIT / AVOID chip for table rows and pick cards. */
export function EntryChip({ action, title }: { action: EntryAction; title?: string }) {
  const meta = ENTRY_META[action];
  return (
    <Chip tone={meta.tone} glow title={title ?? 'Entry timing (technical lean, not a guarantee)'}>
      {meta.short}
    </Chip>
  );
}

export function DataStatusChip({ status }: { status: 'live' | 'cached' }) {
  if (status === 'live') {
    return (
      <Chip tone="buy">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-buy opacity-60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-buy" />
        </span>
        Live
      </Chip>
    );
  }
  return (
    <Chip tone="wait">
      <span className="inline-flex h-1.5 w-1.5 rounded-full bg-amber-400" />
      Cached
    </Chip>
  );
}
