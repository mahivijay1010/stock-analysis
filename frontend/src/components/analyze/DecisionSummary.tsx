'use client';

import type { ReactNode } from 'react';
import clsx from 'clsx';
import { motion, useReducedMotion } from 'framer-motion';
import {
  ArrowDownRight,
  ArrowUpRight,
  BrainCircuit,
  Clock3,
  Crosshair,
  Gauge,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import type { AnalyzeResponse, EntryAction, Recommendation } from '@/lib/types';
import { inr, plain } from '@/lib/format';
import { Card } from '@/components/ui';

// Risk-spec Rule 17 / audit §10.1: this card DESCRIBES the technical setup —
// action words (buy/wait/avoid) belong exclusively to the evidence-gated
// Published decision card above it.
const RECOMMENDATION_COPY: Record<Recommendation, { eyebrow: string; headline: string; summary: string; tone: string }> = {
  BUY: {
    eyebrow: 'Setup description',
    headline: 'Strong setup',
    summary: 'The technical setup scores well — that describes the chart, not the future. The action verdict is the evidence-gated Published decision above.',
    tone: 'decision-call-buy',
  },
  HOLD: {
    eyebrow: 'Setup description',
    headline: 'Neutral setup',
    summary: 'The technical setup is indecisive. The action verdict is the evidence-gated Published decision above.',
    tone: 'decision-call-wait',
  },
  AVOID: {
    eyebrow: 'Setup description',
    headline: 'Weak setup',
    summary: 'The technical setup scores poorly. The action verdict is the evidence-gated Published decision above.',
    tone: 'decision-call-avoid',
  },
};

const ENTRY_LABEL: Record<EntryAction, string> = {
  TIMING_OK: 'Timing OK',
  WAIT: 'Timing: wait',
  AVOID_ENTRY: 'Timing poor',
};

function ScoreOrb({ score }: { score: number }) {
  const reducedMotion = useReducedMotion();
  const value = Math.max(0, Math.min(100, score));

  return (
    <div className="decision-score-orb" role="meter" aria-label="Technical setup score" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value)}>
      <span className="decision-orbit decision-orbit-one" aria-hidden><i /></span>
      <span className="decision-orbit decision-orbit-two" aria-hidden><i /></span>
      <span className="decision-orb-halo" aria-hidden />
      <svg viewBox="0 0 120 120" aria-hidden>
        <circle className="decision-orb-track" cx="60" cy="60" r="49" pathLength="100" />
        <motion.circle
          className="decision-orb-progress"
          cx="60"
          cy="60"
          r="49"
          pathLength="100"
          strokeDasharray="100"
          initial={{ strokeDashoffset: reducedMotion ? 100 - value : 100 }}
          animate={{ strokeDashoffset: 100 - value }}
          transition={{ duration: 1.25, delay: 0.2, ease: [0.22, 1, 0.36, 1] }}
        />
      </svg>
      <span className="decision-orb-value">{Math.round(value)}</span>
      <span className="decision-orb-label">setup</span>
    </div>
  );
}

function KeyMetric({ icon, label, value, detail }: { icon: ReactNode; label: string; value: string; detail: string }) {
  return (
    <div className="decision-key-metric">
      <span className="decision-key-icon">{icon}</span>
      <div className="min-w-0">
        <p>{label}</p>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
    </div>
  );
}

function EvidenceList({ title, items, positive }: { title: string; items: string[]; positive: boolean }) {
  const Icon = positive ? ArrowUpRight : ArrowDownRight;
  return (
    <div className={clsx('decision-evidence-panel', positive ? 'decision-evidence-positive' : 'decision-evidence-caution')}>
      <p className="decision-evidence-label">{title}</p>
      {items.length > 0 ? (
        <ul>
          {items.slice(0, 3).map((item, index) => (
            <li key={`${item}-${index}`}>
              <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="decision-no-flags">
          <ShieldCheck className="h-5 w-5" aria-hidden />
          <div><strong>No active red flags</strong><span>No material opposing signal is present in the measured inputs.</span></div>
        </div>
      )}
    </div>
  );
}

export function DecisionSummary({ data }: { data: AnalyzeResponse }) {
  const { analysis, entryTiming, framework, tradePlan } = data;
  const rec = RECOMMENDATION_COPY[analysis.recommendation];
  const primaryReason = entryTiming?.reasons[0] ?? analysis.reasons.positive[0] ?? analysis.reasons.negative[0] ?? rec.summary;
  const timingLabel = entryTiming ? ENTRY_LABEL[entryTiming.action] : 'Not available';
  const timingClass = entryTiming?.action === 'TIMING_OK' ? 'decision-action-buy' : entryTiming?.action === 'WAIT' ? 'decision-action-wait' : 'decision-action-avoid';

  return (
    <div className="decision-3d-shell">
      <Card elevated className="decision-summary overflow-hidden">
        <div className="decision-stage-mesh" aria-hidden />

        <div className="decision-stage-main">
          <div className="decision-stage-copy">
            <div className="decision-kicker"><Sparkles className="h-4 w-4" aria-hidden />StockSense decision</div>
            <p className="decision-eyebrow">{rec.eyebrow}</p>
            <h2 className={clsx('decision-call', rec.tone)}>{rec.headline}</h2>
            <p className="decision-primary-reason">{primaryReason}</p>
            <div className="decision-badges">
              <span className={clsx('decision-action-badge', timingClass)}><Clock3 className="h-4 w-4" aria-hidden />{timingLabel}</span>
              <span className="decision-risk-badge"><ShieldCheck className="h-4 w-4" aria-hidden />{analysis.riskLevel.toLowerCase()} risk</span>
            </div>
          </div>

          <div className="decision-stage-visual">
            <span className="decision-visual-caption">Measured signal</span>
            <ScoreOrb score={analysis.score} />
            <span className="decision-visual-foot">Quant score / 100</span>
          </div>
        </div>

        <div className="decision-key-grid">
          <KeyMetric icon={<Gauge aria-hidden />} label="Setup score" value={`${Math.round(analysis.score)}/100`} detail="Model consensus" />
          <KeyMetric icon={<Clock3 aria-hidden />} label="Entry timing" value={entryTiming ? `${Math.round(entryTiming.score)}/100` : '—'} detail={entryTiming?.newsAware ? 'News-aware' : 'Market inputs'} />
          <KeyMetric icon={<BrainCircuit aria-hidden />} label="8-phase framework" value={framework?.masterScore != null ? `${Math.round(framework.masterScore)}/100` : '—'} detail={framework?.verdict ? framework.verdict.replaceAll('_', ' ').toLowerCase() : 'Partial coverage'} />
        </div>

        {tradePlan && (
          <div className="decision-plan-band">
            <div className="decision-plan-title"><Crosshair className="h-4 w-4" aria-hidden /><span>Measured trade geometry</span></div>
            <div className="decision-plan-level"><span>Entry</span><strong>{inr(tradePlan.entry)}</strong></div>
            <div className="decision-plan-level decision-plan-stop"><span>Protect</span><strong>{inr(tradePlan.stopLoss)}</strong><small>−{plain(Math.abs(tradePlan.stopLossPct), 1)}%</small></div>
            <div className="decision-plan-level decision-plan-target"><span>Target</span><strong>{inr(tradePlan.target)}</strong><small>+{plain(Math.abs(tradePlan.targetPct), 1)}%</small></div>
            <div className="decision-plan-level"><span>Reward : risk</span><strong>{plain(tradePlan.rewardRiskRatio, 1)} : 1</strong></div>
          </div>
        )}

        <div className="decision-evidence-grid">
          <EvidenceList title="Why the setup works" items={analysis.reasons.positive} positive />
          <EvidenceList title="What could change the call" items={analysis.reasons.negative} positive={false} />
        </div>
      </Card>
    </div>
  );
}
