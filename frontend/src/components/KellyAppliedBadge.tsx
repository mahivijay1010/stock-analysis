'use client';

import { Chip } from '@/components/ui';

interface AppliedMeta {
  label: string;
  tone: 'emerald' | 'cyan' | 'zinc';
  title: string;
}

/**
 * V9 — provenance metadata for the adaptive-Kelly applied pair (SPEC_V9 E2).
 * Which (p, b) the half-Kelly headline was actually computed from. Includes
 * 'measured-p+structural-b' defensively (≥30 closed but payoff unmeasurable,
 * e.g. zero losing trades) and falls back to the raw string on unknown labels.
 */
const APPLIED_META: Record<string, AppliedMeta> = {
  'measured-p+measured-b': {
    label: 'YOUR p · YOUR b',
    tone: 'emerald',
    title: 'Sized from YOUR desk history: measured win rate (last 30 closed trades) and measured payoff (avg win ÷ avg loss).',
  },
  'model-p+measured-b': {
    label: 'model p · YOUR b',
    tone: 'cyan',
    title: 'Win rate still comes from the model (fewer than 30 closed trades); payoff is measured from YOUR closed trades.',
  },
  'measured-p+structural-b': {
    label: 'YOUR p · structural b',
    tone: 'cyan',
    title: 'Win rate measured from YOUR closed trades; payoff still the structural 1.5 assumption (unmeasurable until both wins and losses exist).',
  },
  'model-p+structural-b': {
    label: 'model p · structural b',
    tone: 'zinc',
    title: 'Model win rate + structural 1.5 payoff assumption — your measured history is not usable yet (needs closed trades).',
  },
};

export function appliedMeta(applied: string): AppliedMeta {
  return (
    APPLIED_META[applied] ?? {
      label: applied,
      tone: 'zinc',
      title: 'Kelly input pair applied by the backend for the half-Kelly headline.',
    }
  );
}

/** Small chip stating which (p, b) pair the half-Kelly headline actually used. */
export function KellyAppliedBadge({ applied, className }: { applied: string; className?: string }) {
  const meta = appliedMeta(applied);
  return (
    <Chip tone={meta.tone} glow title={meta.title} className={className}>
      applied: {meta.label}
    </Chip>
  );
}
