'use client';

import { useQuery } from '@tanstack/react-query';
import { Scale } from 'lucide-react';
import { getDecision } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { Card, Chip } from '@/components/ui';

/*
 * The canonical published decision (spec §9/§13.14) — the SAME snapshot the
 * unified Watchlist shows, read from decision_snapshots. Distinct from the
 * heuristic verdict above it: this one is evidence-gated and versioned, and it
 * says WAIT/AVOID honestly when no validated edge exists.
 */

const TONE: Record<string, 'buy' | 'amber' | 'sell' | 'zinc'> = {
  BUY_CANDIDATE: 'buy',
  WAIT: 'amber',
  AVOID_NEW_ENTRY: 'sell',
  INSUFFICIENT_EVIDENCE: 'zinc',
};

const LABEL: Record<string, string> = {
  BUY_CANDIDATE: 'Buy candidate',
  WAIT: 'Wait',
  AVOID_NEW_ENTRY: 'Avoid new entry',
  INSUFFICIENT_EVIDENCE: 'Insufficient evidence',
};

const HORIZON_LABEL: Record<string, string> = {
  long: 'Long-term candidate (>365d)',
  moderate: 'Moderate hold (31–365d)',
  short: 'Short-term only (≤30d)',
};

const HORIZON_TONE: Record<string, 'emerald' | 'cyan' | 'amber'> = {
  long: 'emerald',
  moderate: 'cyan',
  short: 'amber',
};

export function CanonicalDecisionCard({ ticker }: { ticker: string }) {
  const q = useQuery({
    queryKey: ['decision', ticker],
    queryFn: () => getDecision(ticker),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  if (q.isPending || q.isError) return null; // the heuristic verdict still renders; nothing fabricated
  const res = q.data!;
  if (!res.available) {
    return (
      <Card className="p-4">
        <p className="flex items-center gap-2 text-xs font-medium text-slate-400">
          <Scale className="h-4 w-4 text-slate-500" aria-hidden /> Published decision
        </p>
        <p className="mt-2 text-xs leading-relaxed text-slate-500">{res.reason}</p>
      </Card>
    );
  }

  const s = res.snapshot;
  const horizon = s.horizonSuitability?.label ?? null;
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-xs font-medium text-slate-400">
          <Scale className="h-4 w-4 text-cyan-300" aria-hidden /> Published decision
          <span className="text-[10px] text-slate-600">
            {s.decisionPolicyVersion} · {fmtDateTime(s.asOf)} · re-evaluated nightly
          </span>
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip tone={TONE[s.decisionStatus] ?? 'zinc'} glow={s.decisionStatus === 'BUY_CANDIDATE'}>
            {LABEL[s.decisionStatus] ?? s.decisionStatus}
          </Chip>
          {horizon && (
            <Chip tone={HORIZON_TONE[horizon] ?? 'cyan'} title={s.horizonSuitability?.reasons?.[0]}>
              {HORIZON_LABEL[horizon] ?? horizon}
            </Chip>
          )}
          {res.expired && (
            <span className="text-[10px] text-slate-500">expired — refreshes tonight</span>
          )}
        </div>
      </div>
      {s.reasons?.[0] && <p className="mt-2 text-xs leading-relaxed text-slate-400">{s.reasons[0]}</p>}
      {horizon && s.horizonSuitability?.reasons?.[0] && (
        <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
          <span className="text-slate-600">Horizon:</span> {s.horizonSuitability.reasons[0]}
        </p>
      )}
      <p className="mt-2 text-[11px] leading-relaxed text-slate-600">{s.holdingsReviewNote}</p>
    </Card>
  );
}
