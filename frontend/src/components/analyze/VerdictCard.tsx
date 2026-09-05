'use client';

import clsx from 'clsx';
import type { FrameworkReport, FrameworkVerdict, QuantAnalysis } from '@/lib/types';
import { Card, Chip, RecBadge, RiskChip, ScoreDonut, SectionTitle } from '@/components/ui';
import { Tilt } from '@/components/motion';

const VERDICT_META: Record<
  FrameworkVerdict,
  { label: string; badge: string; donut: 'BUY' | 'HOLD' | 'AVOID' }
> = {
  STRONG_CANDIDATE: {
    label: 'STRONG CANDIDATE',
    badge: 'border-buy/30 bg-buy/10 text-buy shadow-[0_0_14px_rgba(0,212,170,0.25)]',
    donut: 'BUY',
  },
  WATCH: {
    label: 'WATCH',
    badge: 'border-amber-400/30 bg-amber-400/10 text-amber-400 shadow-[0_0_14px_rgba(251,191,36,0.25)]',
    donut: 'HOLD',
  },
  PASS: {
    label: 'PASS',
    badge: 'border-sell/30 bg-sell/10 text-sell shadow-[0_0_14px_rgba(255,77,109,0.25)]',
    donut: 'AVOID',
  },
};

/** Placeholder ring when a score cannot be computed. */
function NullDonut({ label, size = 104 }: { label: string; size?: number }) {
  return (
    <div
      role="img"
      aria-label={`${label}: not available`}
      className="flex shrink-0 flex-col items-center justify-center rounded-full border-[8px] border-white/6"
      style={{ width: size, height: size }}
    >
      <span className="font-display text-2xl font-semibold text-slate-500">—</span>
      <span className="mt-0.5 max-w-[80px] text-center text-[9px] leading-tight text-slate-600">{label}</span>
    </div>
  );
}

/** "Macro 10% · Industry 15% · …" from weightsUsed (accepts fractions or percents). */
function weightsLine(weights: Record<string, number>): string {
  const entries = Object.entries(weights).filter(([, v]) => Number.isFinite(v) && v > 0);
  if (!entries.length) return '';
  return entries
    .map(([k, v]) => `${k.charAt(0).toUpperCase()}${k.slice(1)} ${Math.round(v <= 1 ? v * 100 : v)}%`)
    .join(' · ');
}

/**
 * The verdict rail card: quant score donut + BUY/HOLD/AVOID badge + risk on
 * top, and (when the V2 framework is present) the master score with its
 * STRONG_CANDIDATE/WATCH/PASS verdict below. Scores animate on load via the
 * donut sweep; a missing master score renders an honest null ring, never 0.
 */
export function VerdictCard({
  analysis,
  framework,
}: {
  analysis: QuantAnalysis;
  framework?: FrameworkReport | null;
}) {
  const { recommendation, riskLevel, score, reasons } = analysis;

  const summaryParts =
    recommendation === 'BUY'
      ? reasons.positive.slice(0, 2)
      : recommendation === 'AVOID'
        ? reasons.negative.slice(0, 2)
        : [reasons.positive[0], reasons.negative[0]].filter(Boolean);
  const summary = summaryParts.join(' · ') || 'Signals are mixed at current levels.';

  const verdictMeta = framework ? VERDICT_META[framework.verdict] : null;
  const scoredPhases = framework ? framework.phases.filter((p) => p.score != null && p.weight > 0).length : 0;
  const weights = framework ? weightsLine(framework.weightsUsed) : '';

  return (
    <Tilt maxDeg={3}>
      <Card elevated className="p-5 sm:p-6">
        <SectionTitle>Verdict</SectionTitle>

        <div className="mt-4 flex flex-col items-start gap-5 sm:flex-row sm:items-center">
          <ScoreDonut score={score} tone={recommendation} size={116} label="quant score / 100" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-3">
              <RecBadge rec={recommendation} size="lg" />
              <RiskChip risk={riskLevel} />
            </div>
            <p className="mt-3 text-sm leading-relaxed text-slate-400">{summary}</p>
          </div>
        </div>

        {framework && verdictMeta && (
          <div className="mt-5 flex flex-col items-start gap-5 border-t border-white/8 pt-5 sm:flex-row sm:items-center">
            {framework.masterScore == null ? (
              <NullDonut label="master score" />
            ) : (
              <ScoreDonut
                score={framework.masterScore}
                tone={verdictMeta.donut}
                size={104}
                label="master score / 100"
              />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-3">
                <span
                  className={clsx(
                    'font-display inline-flex items-center rounded-xl border px-4 py-1.5 text-lg font-bold tracking-wide',
                    verdictMeta.badge,
                  )}
                >
                  {verdictMeta.label}
                </span>
                <Chip tone="zinc">8-phase framework</Chip>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-slate-400">
                {framework.masterScore == null
                  ? 'No master score — fewer than 3 phases could be scored with free data.'
                  : `Weighted over ${scoredPhases} scored phase${scoredPhases === 1 ? '' : 's'}${
                      weights ? `: ${weights}` : ''
                    } (weights renormalized across available phases).`}
              </p>
            </div>
          </div>
        )}
      </Card>
    </Tilt>
  );
}
