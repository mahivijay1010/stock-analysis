'use client';

import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import { ChevronDown } from 'lucide-react';
import type { FrameworkReport, PhaseCheckResult, PhaseResult, PhaseStatus } from '@/lib/types';
import { Card, Chip, Collapsible } from '@/components/ui';

const STATUS_META: Record<PhaseStatus, { glyph: string; chip: string; label: string }> = {
  done: { glyph: '✓', chip: 'border-buy/30 bg-buy/10 text-buy', label: 'done' },
  partial: { glyph: '◐', chip: 'border-amber-400/30 bg-amber-400/10 text-amber-400', label: 'partial' },
  unavailable: { glyph: '—', chip: 'border-white/10 bg-white/5 text-slate-500', label: 'unavailable' },
};

const CHECK_META: Record<PhaseCheckResult, { glyph: string; className: string }> = {
  pass: { glyph: '✓', className: 'text-buy' },
  fail: { glyph: '✗', className: 'text-sell' },
  neutral: { glyph: '•', className: 'text-slate-400' },
  'no-data': { glyph: '—', className: 'text-slate-600' },
};

function scoreTone(score: number): 'buy' | 'wait' | 'sell' {
  if (score >= 70) return 'buy';
  if (score >= 40) return 'wait';
  return 'sell';
}

function weightLabel(weight: number): string {
  if (!weight) return 'informational';
  const pctVal = weight <= 1 ? weight * 100 : weight;
  return `weight ${Math.round(pctVal)}%`;
}

function PhaseRow({ phase }: { phase: PhaseResult }) {
  const [open, setOpen] = useState(false);
  const meta = STATUS_META[phase.status];
  const hasDetail = phase.checks.length > 0 || phase.missing.length > 0;

  return (
    <li className="glass-inset overflow-hidden">
      <button
        type="button"
        onClick={() => hasDetail && setOpen((v) => !v)}
        aria-expanded={open}
        disabled={!hasDetail}
        className={clsx(
          'flex w-full items-center gap-3 px-3 py-3 text-left',
          hasDetail && 'transition-colors hover:bg-white/4',
        )}
      >
        <span
          aria-hidden
          className={clsx(
            'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-sm font-semibold',
            meta.chip,
          )}
        >
          {meta.glyph}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-slate-100">
            Phase {phase.phase} · {phase.name}
          </span>
          <span className="block text-xs text-slate-500">
            {meta.label} · {weightLabel(phase.weight)}
          </span>
        </span>
        {phase.score != null ? (
          <Chip tone={scoreTone(phase.score)}>{Math.round(phase.score)} / 100</Chip>
        ) : (
          <Chip tone="zinc">not scored</Chip>
        )}
        {hasDetail && (
          <ChevronDown
            className={clsx('h-4 w-4 shrink-0 text-slate-500 transition-transform duration-200', open && 'rotate-180')}
            aria-hidden
          />
        )}
      </button>

      <AnimatePresence initial={false}>
        {open && hasDetail && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div className="space-y-3 px-3 pb-4 pl-12">
              {phase.checks.length > 0 && (
                <ul className="space-y-1.5">
                  {phase.checks.map((c, i) => {
                    const cm = CHECK_META[c.result];
                    return (
                      <li key={`${c.name}-${i}`} className="flex items-start gap-2 text-sm">
                        <span aria-hidden className={clsx('mt-px w-4 shrink-0 text-center font-semibold', cm.className)}>
                          {cm.glyph}
                        </span>
                        <span className="min-w-0">
                          <span className="text-slate-300">{c.name}</span>
                          {c.value && <span className="text-slate-500"> — {c.value}</span>}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              {phase.missing.length > 0 && (
                <div className="rounded-lg border border-amber-400/20 bg-amber-400/5 px-3 py-2">
                  <p className="text-xs font-medium text-amber-400">Not checkable with free data</p>
                  <ul className="mt-1 space-y-0.5">
                    {phase.missing.map((m, i) => (
                      <li key={i} className="text-xs leading-relaxed text-slate-400">
                        — {m}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}

/**
 * V2 — the 8-phase framework as a collapsed-by-default accordion. The
 * coverage chips (done / partial / unavailable) stay visible on the closed
 * header so the honest coverage read never disappears; expanding reveals
 * every phase's real checks and exactly what free data cannot verify.
 */
export function FrameworkPanel({ framework }: { framework: FrameworkReport }) {
  const { phases, coverage } = framework;
  const allMissing = Array.from(new Set(phases.flatMap((p) => p.missing)));

  return (
    <Card className="p-5">
      <Collapsible
        id="analyze-framework"
        defaultOpen={false}
        title="Analysis coverage — 8-phase framework"
        subtitle="Each phase shows exactly what was checked with real values — and what free data cannot verify. Nothing is fabricated to fill a gap."
        right={
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <Chip tone="buy" className="px-2 py-0.5 text-[10px]" title={`${coverage.done} phases done`}>
              ✓ {coverage.done} done
            </Chip>
            <Chip tone="wait" className="px-2 py-0.5 text-[10px]" title={`${coverage.partial} phases partial`}>
              ◐ {coverage.partial} partial
            </Chip>
            <Chip tone="zinc" className="px-2 py-0.5 text-[10px]" title={`${coverage.unavailable} phases unavailable`}>
              — {coverage.unavailable} unavailable
            </Chip>
          </div>
        }
      >
        <ul className="space-y-2">
          {[...phases]
            .sort((a, b) => a.phase - b.phase)
            .map((p) => (
              <PhaseRow key={p.phase} phase={p} />
            ))}
        </ul>

        {allMissing.length > 0 && (
          <div className="glass-inset mt-4 p-3">
            <p className="text-xs font-semibold text-slate-300">Not checkable with free data (full list)</p>
            <ul className="mt-1.5 grid grid-cols-1 gap-x-6 gap-y-0.5 sm:grid-cols-2">
              {allMissing.map((m, i) => (
                <li key={i} className="text-xs leading-relaxed text-slate-500">
                  — {m}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Collapsible>
    </Card>
  );
}
