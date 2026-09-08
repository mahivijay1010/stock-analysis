'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, HelpCircle, Scale } from 'lucide-react';
import { getDecision } from '@/lib/api';
import type { DecisionSnapshotView } from '@/lib/types';
import { fmtDateTime, signedPct } from '@/lib/format';
import { Card, Chip, Collapsible } from '@/components/ui';

/*
 * The canonical published decision + the risk-spec Rule 17 truth panel:
 * SETUP / ENTRY / MODEL CONFIDENCE / DATA QUALITY / RISK / EXPECTED VALUE /
 * CALIBRATION STATUS, plus "Why not Buy?", "What would change the decision?"
 * and the separate existing-holder decision (Rule 14). This is the SAME
 * snapshot the Watchlist shows (13.14) — evidence-gated and versioned; it
 * says WAIT/AVOID honestly when no validated edge exists.
 *
 * Unlike the pre-T2 version, failures are VISIBLE: a fetch error renders an
 * error card instead of silently leaving only the heuristic verdict
 * (audit §10.1).
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

const HOLDER_LABEL: Record<string, string> = {
  HOLD: 'Hold',
  REVIEW: 'Review',
  INSUFFICIENT_DATA: 'Insufficient data',
};

const HORIZON_LABEL: Record<string, string> = {
  long: 'Long-term candidate (>365d)',
  moderate: 'Moderate hold (31–365d)',
  short: 'Short-term only (≤30d)',
};

function ScoreRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-white/[0.04] py-1.5 last:border-0">
      <span className="text-xs text-slate-500" title={hint}>
        {label}
      </span>
      <span className="text-sm font-semibold text-slate-100 tabular-nums">{value}</span>
    </div>
  );
}

function TruthPanel({ s }: { s: DecisionSnapshotView }) {
  const sc = s.scoreCard;
  const ev = s.expectedValue;
  if (!sc) return null;
  const fc = sc.forecastConfidence;
  const calibrated = fc.brierSkill != null && fc.brierSkill > 0 && (fc.effectiveSamples ?? 0) >= 10;
  const dp = s.inputs?.directionProbability;
  return (
    <div className="mt-3 grid grid-cols-1 gap-x-8 rounded-xl border border-white/8 bg-white/3 px-4 py-2.5 sm:grid-cols-2">
      <ScoreRow label="Setup (technical description, not a probability)" value={sc.setupScore != null ? `${sc.setupScore}/100` : '—'} />
      <ScoreRow label="Entry quality" value={sc.entryTimingScore != null ? `${sc.entryTimingScore}/100` : '—'} />
      <ScoreRow
        label="Model confidence (measured out-of-sample)"
        value={`${fc.band} · ${fc.score}/100`}
        hint={fc.reasons[0]}
      />
      {fc.contributions && fc.contributions.length > 0 && (
        <div className="border-b border-white/[0.04] py-1.5 sm:col-span-2">
          <p className="text-[10px] tracking-wide text-slate-600 uppercase">Why confidence is {fc.band} (points lost per source)</p>
          <div className="mt-1 grid grid-cols-2 gap-x-6 gap-y-0.5 sm:grid-cols-4">
            {fc.contributions.map((c) => (
              <span key={c.factor} className="text-[11px] text-slate-500" title={c.detail}>
                {c.factor.replace(/\s*\(.*\)/, '')}{' '}
                <span className={c.shortfall < 0 ? 'font-semibold text-amber-300 tabular-nums' : 'text-slate-400 tabular-nums'}>
                  {c.shortfall < 0 ? c.shortfall : '✓'}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}
      <ScoreRow
        label="Data quality"
        value={`${sc.dataQuality.score}/100`}
        hint={sc.dataQuality.penalties.join(' · ') || 'no penalties'}
      />
      <ScoreRow
        label="Risk"
        value={sc.risk.score != null ? `${sc.risk.band.toUpperCase()} · ${sc.risk.score}/100` : 'UNKNOWN'}
        hint={sc.risk.reasons[0]}
      />
      <ScoreRow
        label="Expected value after costs (30d)"
        value={ev ? signedPct(ev.evAfterCostsPct) : '—'}
        hint={ev ? `mean ${signedPct(ev.expectedReturnPct)} − costs ${ev.transactionCostPct}%; reward/risk ${ev.rewardRiskRatio ?? '—'}` : undefined}
      />
      <ScoreRow
        label="Directional edge / calibration"
        value={calibrated ? 'validated' : 'NOT PROVEN'}
        hint={
          fc.effectiveSamples != null
            ? `~${fc.effectiveSamples} independent observation(s) after overlap adjustment; Brier skill ${fc.brierSkill}`
            : undefined
        }
      />
      {dp?.status === 'calibrated' && dp.calibratedProbability != null ? (
        <ScoreRow
          label="Directional probability (30d)"
          value={`${(dp.calibratedProbability * 100).toFixed(1)}% (calibrated · ${dp.calibratorType})`}
          hint={dp.statement}
        />
      ) : (
        <div className="flex items-baseline justify-between gap-3 border-b border-white/[0.04] py-1.5 last:border-0">
          <span className="text-xs text-slate-500">Directional probability (30d)</span>
          <span className="text-right text-[11px] leading-snug text-slate-400">
            Directional probability unavailable — insufficient calibrated evidence
          </span>
        </div>
      )}
      <ScoreRow
        label="Opportunity (descriptive blend, evidence-capped)"
        value={sc.overallOpportunityScore != null ? `${sc.overallOpportunityScore}/100` : '—'}
      />
      <p className="pt-2 text-[11px] leading-relaxed text-slate-600 sm:col-span-2">{sc.caption}</p>
    </div>
  );
}

export function CanonicalDecisionCard({ ticker }: { ticker: string }) {
  const q = useQuery({
    queryKey: ['decision', ticker],
    queryFn: () => getDecision(ticker),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  if (q.isPending) return null;
  if (q.isError) {
    // Rule 17 / audit §10.1: the conservative verdict must never silently vanish.
    return (
      <Card className="border-amber-400/20 p-4">
        <p className="flex items-center gap-2 text-xs font-medium text-amber-300">
          <AlertTriangle className="h-4 w-4" aria-hidden /> The evidence-gated decision could not be loaded
        </p>
        <p className="mt-1 text-xs leading-relaxed text-slate-400">
          {q.error instanceof Error ? q.error.message : 'Decision service unreachable.'} The verdict below is the
          HEURISTIC setup description only — do not treat it as a recommendation.
        </p>
      </Card>
    );
  }

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
  const whyNot = (s.unmetGates ?? []).length > 0;

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
            New entry: {LABEL[s.decisionStatus] ?? s.decisionStatus}
          </Chip>
          {s.existingHolderAction && (
            <Chip tone={s.existingHolderAction === 'REVIEW' ? 'amber' : 'zinc'}>
              Existing holder: {HOLDER_LABEL[s.existingHolderAction] ?? s.existingHolderAction}
            </Chip>
          )}
          {horizon && <Chip tone="cyan">{HORIZON_LABEL[horizon] ?? horizon}</Chip>}
          {s.inputs?.modelHealth && (
            <Chip
              tone={
                s.inputs.modelHealth.overallState === 'HEALTHY'
                  ? 'buy'
                  : s.inputs.modelHealth.overallState === 'SUSPENDED'
                    ? 'sell'
                    : s.inputs.modelHealth.overallState === 'DEGRADED'
                      ? 'amber'
                      : 'zinc'
              }
            >
              Model health: {s.inputs.modelHealth.overallState.replace('_', ' ').toLowerCase()}
            </Chip>
          )}
          {res.expired && <span className="text-[10px] text-slate-500">expired — refreshes tonight</span>}
        </div>
      </div>

      <TruthPanel s={s} />

      {whyNot && (
        <Collapsible
          id={`decision-why-not-${ticker}`}
          className="mt-3"
          title={
            <span className="flex items-center gap-1.5 text-xs font-medium text-slate-300">
              <HelpCircle className="h-3.5 w-3.5 text-slate-500" aria-hidden />
              Why not Buy? · What would change the decision?
            </span>
          }
        >
          <div className="space-y-2">
            <ul className="space-y-1.5">
              {s.reasons.map((r, i) => (
                <li key={i} className="text-xs leading-relaxed text-slate-400">
                  • {r}
                </li>
              ))}
            </ul>
            <div className="overflow-x-auto rounded-lg border border-white/6">
              <table className="w-full min-w-[420px] text-left text-xs">
                <thead>
                  <tr className="border-b border-white/8 text-[10px] uppercase tracking-wide text-slate-600">
                    <th className="px-3 py-1.5 font-medium">Gate</th>
                    <th className="px-3 py-1.5 font-medium">Currently</th>
                    <th className="px-3 py-1.5 font-medium">Would need</th>
                  </tr>
                </thead>
                <tbody>
                  {(s.unmetGates ?? []).map((g, i) => (
                    <tr key={i} className="border-b border-white/4 last:border-0">
                      <td className="px-3 py-1.5 text-slate-300">{g.gate}</td>
                      <td className="px-3 py-1.5 text-slate-400 tabular-nums">{g.current}</td>
                      <td className="px-3 py-1.5 text-slate-500 tabular-nums">{g.required}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </Collapsible>
      )}

      {s.holderReasons && s.holderReasons.length > 0 && (
        <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
          <span className="text-slate-600">Existing position:</span> {s.holderReasons[0]}
        </p>
      )}
      <p className="mt-2 text-[11px] leading-relaxed text-slate-600">{s.holdingsReviewNote}</p>
    </Card>
  );
}
