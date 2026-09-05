'use client';

import { ButtonHTMLAttributes, ReactNode } from 'react';
import clsx from 'clsx';
import { Loader2 } from 'lucide-react';

/**
 * Desk-local compositions on the design tokens. The buy/sell accents are
 * STATUS colors — every use here pairs them with an explicit text label
 * (BUY/SELL, stop/target), never color alone.
 */

/** Signed-value ink on the semantic accents (token migration of format.signClass). */
export function signTone(value: number): string {
  if (value > 0) return 'text-buy';
  if (value < 0) return 'text-sell';
  return 'text-slate-400';
}

/** Compact inset stat for plan cards and expanded rows. */
export function MiniStat({
  label,
  value,
  sub,
  valueClassName,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className="glass-inset px-3 py-2">
      <p className="text-[11px] text-slate-500">{label}</p>
      <p className={clsx('font-display mt-0.5 text-sm font-semibold text-slate-100 tabular-nums', valueClassName)}>
        {value}
      </p>
      {sub != null && <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{sub}</p>}
    </div>
  );
}

export interface TradeButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  side: 'BUY' | 'SELL';
  loading?: boolean;
  size?: 'sm' | 'md';
}

/**
 * Record BUY / Record SELL action button on the status accents. Text label is
 * always supplied by the caller (side never communicated by color alone).
 * `md` meets the 44px touch minimum natively; `sm` extends its hit area via
 * the .touch-target pseudo-element for dense table rows.
 */
export function TradeButton({ side, loading = false, size = 'md', disabled, className, children, ...rest }: TradeButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-xl border font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'md'
          ? 'min-h-11 px-4 py-2 text-sm'
          : 'touch-target relative min-h-8 px-3 py-1.5 text-xs',
        side === 'BUY'
          ? 'border-buy/40 bg-buy/15 text-buy hover:bg-buy/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-buy/70'
          : 'border-sell/40 bg-sell/10 text-sell hover:bg-sell/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sell/70',
        className,
      )}
      {...rest}
    >
      {loading && <Loader2 className={clsx('animate-spin', size === 'md' ? 'h-4 w-4' : 'h-3.5 w-3.5')} aria-hidden />}
      {children}
    </button>
  );
}
