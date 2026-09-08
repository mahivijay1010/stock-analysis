'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Loader2, ShieldAlert } from 'lucide-react';
import { getCommitteeReview, runCommitteeReview } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { Button, Card, Chip } from '@/components/ui';
import { useAuth } from '@/components/auth/useAuth';

/*
 * AI Investment Committee (risk-spec Rule 13) — ADVISORY and CAP-ONLY.
 * The card renders the latest stored review with full attribution (model,
 * prompt version, clamp record). Without an API key it says so honestly; the
 * deterministic evidence-gated decision above is unaffected either way.
 */

const ACTION_TONE: Record<string, 'buy' | 'amber' | 'sell' | 'zinc'> = {
  BUY: 'buy',
  ACCUMULATE: 'buy',
  HOLD: 'zinc',
  WATCH: 'amber',
  REDUCE: 'amber',
  AVOID: 'sell',
  INSUFFICIENT_DATA: 'zinc',
};

export function CommitteeCard({ ticker }: { ticker: string }) {
  const { auth } = useAuth();
  const signedIn = auth?.status === 'authenticated';
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['committee', ticker],
    queryFn: () => getCommitteeReview(ticker),
    staleTime: 5 * 60_000,
    retry: 1,
  });
  const runM = useMutation({
    mutationFn: () => runCommitteeReview(ticker),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['committee', ticker] }),
  });

  if (q.isPending || q.isError) return null; // committee absence never blocks the page
  const data = q.data!;

  if (!data.available && !data.review) {
    return (
      <Card className="p-4">
        <p className="flex items-center gap-2 text-xs font-medium text-slate-400">
          <Bot className="h-4 w-4 text-slate-500" aria-hidden /> AI Investment Committee
        </p>
        <p className="mt-1.5 text-xs leading-relaxed text-slate-500">{data.note}</p>
      </Card>
    );
  }

  const r = data.review;
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-xs font-medium text-slate-400">
          <Bot className="h-4 w-4 text-cyan-300" aria-hidden /> AI Investment Committee
          <span className="text-[10px] text-slate-600">
            advisory · cap-only — can never raise an action past the evidence gate
          </span>
        </p>
        {data.available && signedIn && (
          <Button variant="ghost" size="sm" onClick={() => runM.mutate()} disabled={runM.isPending}>
            {runM.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : 'Request review'}
          </Button>
        )}
      </div>

      {runM.isError && (
        <p className="mt-2 text-xs text-amber-300">
          {runM.error instanceof Error ? runM.error.message : 'Committee call failed.'}
        </p>
      )}

      {!r ? (
        <p className="mt-2 text-xs leading-relaxed text-slate-500">
          No committee review yet for this stock.{signedIn ? ' Request one above.' : ' Sign in to request one.'}
        </p>
      ) : (
        <div className="mt-3 space-y-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip tone={ACTION_TONE[r.response.newEntryAction] ?? 'zinc'}>
              New entry: {r.response.newEntryAction}
            </Chip>
            <Chip tone={ACTION_TONE[r.response.existingHolderAction] ?? 'zinc'}>
              Existing holder: {r.response.existingHolderAction}
            </Chip>
            <Chip tone="zinc">confidence {r.response.confidenceBand} · {Math.round(r.response.confidence)}/100</Chip>
            {r.clamped && (
              <Chip tone="amber" title={(r.clampNotes ?? []).join(' | ')}>
                <ShieldAlert className="h-3 w-3" aria-hidden /> clamped by the gate
              </Chip>
            )}
          </div>
          <p className="text-xs leading-relaxed text-slate-400">{r.response.reasoningSummary}</p>
          {r.response.modelDisagreement && (
            <p className="text-xs leading-relaxed text-slate-500">
              <span className="text-slate-600">Model disagreement:</span> {r.response.modelDisagreement}
            </p>
          )}
          {r.response.missingCriticalEvidence.length > 0 && (
            <p className="text-xs leading-relaxed text-slate-500">
              <span className="text-slate-600">Missing evidence:</span> {r.response.missingCriticalEvidence.join('; ')}
            </p>
          )}
          <p className="text-[10px] text-slate-600">
            {r.modelName} · {r.promptVersion} · {fmtDateTime(r.createdAt)} · {r.latencyMs}ms · the committee reasons
            over the deterministic systems&apos; output only — it never invents figures.
          </p>
        </div>
      )}
    </Card>
  );
}
