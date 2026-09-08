'use client';

import { useQuery } from '@tanstack/react-query';
import { getDecisionBatch, DecisionBatchEntry } from '@/lib/api';
import { Chip } from '@/components/ui';

/*
 * Phase 14 (completion directive): Discover rows carry the PUBLISHED gate —
 * SETUP / ENTRY / CONFIDENCE / GATE — read from decision snapshots via the
 * batch endpoint. A ticker without a published snapshot shows "not published"
 * rather than an invented verdict; heuristic scores elsewhere on the row are
 * descriptions, and the gate chip is the only action-bearing element.
 */

const GATE_TONE: Record<DecisionBatchEntry['decisionStatus'], 'buy' | 'amber' | 'sell' | 'zinc'> = {
  BUY_CANDIDATE: 'buy',
  WAIT: 'amber',
  AVOID_NEW_ENTRY: 'sell',
  INSUFFICIENT_EVIDENCE: 'zinc',
};

const GATE_LABEL: Record<DecisionBatchEntry['decisionStatus'], string> = {
  BUY_CANDIDATE: 'Buy candidate',
  WAIT: 'Wait',
  AVOID_NEW_ENTRY: 'Avoid',
  INSUFFICIENT_EVIDENCE: 'Insufficient',
};

/** Batched fetch of published-decision summaries, cached per ticker set. */
export function useDecisionBatch(tickers: string[]) {
  const key = [...tickers].sort().join(',');
  return useQuery({
    queryKey: ['decision-batch', key],
    queryFn: () => getDecisionBatch(tickers),
    enabled: tickers.length > 0,
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

export function DecisionGateChips({ entry }: { entry: DecisionBatchEntry | undefined }) {
  if (!entry) {
    return (
      <span
        className="text-[10px] text-slate-600"
        title="No evidence-gated decision has been published for this stock yet — decisions publish nightly for followed/held instruments."
      >
        gate not published
      </span>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Chip tone={GATE_TONE[entry.decisionStatus] ?? 'zinc'}>GATE {GATE_LABEL[entry.decisionStatus] ?? entry.decisionStatus}</Chip>
      <Chip tone="zinc">SETUP {entry.setupScore != null ? `${entry.setupScore}` : '—'}</Chip>
      <Chip tone="zinc">ENTRY {entry.entryQualityScore != null ? `${entry.entryQualityScore}` : '—'}</Chip>
      <Chip tone="zinc">CONF {entry.confidenceBand ?? '—'}</Chip>
      {entry.expired && <span className="text-[10px] text-slate-600">expired</span>}
    </div>
  );
}
