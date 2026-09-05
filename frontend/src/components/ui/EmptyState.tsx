'use client';

import { ReactNode } from 'react';
import clsx from 'clsx';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { GlassCard } from './GlassCard';
import { Button } from './Button';

/** Inline glyphs for empty states: a slashed circle or a sweeping radar. */
export function EmptyGlyph({ kind = 'slash', className }: { kind?: 'slash' | 'radar'; className?: string }) {
  if (kind === 'radar') {
    return (
      <svg viewBox="0 0 48 48" className={clsx('h-10 w-10', className)} aria-hidden>
        <circle cx="24" cy="24" r="20" fill="none" stroke="rgba(148,163,184,0.25)" strokeWidth="1.5" />
        <circle cx="24" cy="24" r="12" fill="none" stroke="rgba(148,163,184,0.18)" strokeWidth="1" />
        <circle cx="24" cy="24" r="4" fill="none" stroke="rgba(148,163,184,0.18)" strokeWidth="1" />
        <g className="radar-beam">
          <path d="M 24 24 L 24 4 A 20 20 0 0 1 38 10 Z" fill="url(#radar-fade)" opacity="0.6" />
          <line x1="24" y1="24" x2="24" y2="4" stroke="#22d3ee" strokeWidth="1.5" strokeLinecap="round" />
        </g>
        <defs>
          <linearGradient id="radar-fade" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#22d3ee" stopOpacity="0" />
          </linearGradient>
        </defs>
        <circle cx="24" cy="24" r="1.6" fill="#22d3ee" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 48 48" className={clsx('h-10 w-10', className)} aria-hidden>
      <circle cx="24" cy="24" r="19" fill="none" stroke="rgba(148,163,184,0.35)" strokeWidth="2.5" />
      <line x1="11" y1="37" x2="37" y2="11" stroke="rgba(148,163,184,0.35)" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Friendly empty state: inline SVG glyph + one-line copy. Used for honest
 * NOT_AVAILABLE / no-qualifying-data moments — never hide these.
 */
export function EmptyState({
  title,
  message,
  glyph = 'slash',
  className,
  children,
}: {
  title: string;
  message?: ReactNode;
  glyph?: 'slash' | 'radar';
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={clsx('glass-inset flex items-start gap-4 p-4', className)}>
      <EmptyGlyph kind={glyph} className="mt-0.5 shrink-0" />
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-100">{title}</p>
        {message != null && <p className="mt-1 text-sm leading-relaxed text-slate-400">{message}</p>}
        {children}
      </div>
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
  compact = false,
}: {
  message: string;
  onRetry?: () => void;
  compact?: boolean;
}) {
  return (
    <GlassCard
      className={clsx('flex flex-col items-center justify-center text-center', compact ? 'gap-3 p-6' : 'gap-4 p-10')}
    >
      <AlertTriangle className="h-8 w-8 text-sell" aria-hidden />
      <div>
        <p className="font-medium text-slate-100">Something went wrong</p>
        <p className="mt-1 max-w-md text-sm text-slate-400">{message}</p>
      </div>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          <RefreshCw className="h-4 w-4" aria-hidden />
          Retry
        </Button>
      )}
    </GlassCard>
  );
}
