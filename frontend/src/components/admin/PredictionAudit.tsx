'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronDown, ClipboardCheck, Scale } from 'lucide-react';
import { getPredictionAudit } from '@/lib/api';
import type { TradeReviewRow } from '@/lib/types';
import { fmtDate, fmtDateTime, inr, inrSmart, pct, plain, signedInr, signedPct } from '@/lib/format';
import type { Tone } from '@/components/ui';
import { Card, CardSkeleton, Chip, Collapsible, EmptyState, ErrorState, SectionTitle } from '@/components/ui';
import { signTone } from './desk-ui';

const OUTCOME_META: Record<TradeReviewRow['outcome'], { label: string; tone: Tone }> = {
  TARGET_HIT: { label: 'TARGET HIT', tone: 'buy' },
  STOPPED_OUT: { label: 'STOPPED OUT', tone: 'wait' },
  MANUAL_EXIT: { label: 'MANUAL EXIT', tone: 'zinc' },
};

/** Compact stat tile on inset glass — shared with the V9 PerformanceFeedbackCard. */
export function AuditTile({
  label,
  value,
  sub,
  subClassName,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  subClassName?: string;
}) {
  return (
    <div className="glass-inset px-4 py-3">
      <p className="text-[11px] font-medium tracking-[0.08em] text-slate-500 uppercase">{label}</p>
      <p className="font-display mt-1 text-2xl font-semibold tracking-tight text-slate-100 tabular-nums">{value}</p>
      {sub != null && <p className={clsx('mt-0.5 text-[11px] leading-relaxed text-slate-500', subClassName)}>{sub}</p>}
    </div>
  );
}

/** Dot legend for "actual landed inside the promised 80% band". */
function BandDot({ withinBand }: { withinBand: boolean | null }) {
  if (withinBand == null) {
    return (
      <span
        role="img"
        title="band not recorded"
        className="inline-block h-2 w-2 rounded-full bg-slate-600"
        aria-label="band not recorded"
      />
    );
  }
  return (
    <span
      role="img"
      title={withinBand ? 'actual landed inside the 80% band' : 'actual fell outside the 80% band'}
      aria-label={withinBand ? 'within band' : 'outside band'}
      className={clsx(
        'inline-block h-2 w-2 rounded-full',
        withinBand ? 'bg-buy shadow-[0_0_6px_rgba(0,212,170,0.7)]' : 'bg-sell shadow-[0_0_6px_rgba(255,77,109,0.7)]',
      )}
    />
  );
}

/**
 * Prediction audit — the model vs reality. Every forecast is logged BEFORE the
 * outcome; the 18:30 IST job verifies matured ones against real closes. The
 * verdict is ALWAYS visible; the evidence tables live in a collapsible section
 * (open by default, state persists).
 */
export function PredictionAudit() {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ['admin', 'prediction-audit'],
    queryFn: getPredictionAudit,
    staleTime: 5 * 60_000,
  });

  const derived = useMemo(() => {
    if (!data) return null;
    const verified = data.liveStats.reduce((s, l) => s + l.samples, 0);
    const live1d = data.liveStats.find((l) => l.horizonDays === 1) ?? null;
    const base1d = data.baseline.find((b) => b.horizonDays === 1) ?? null;
    const liveSamples = data.liveStats.reduce((s, l) => s + l.samples, 0);
    const liveAvgErr =
      liveSamples > 0 ? data.liveStats.reduce((s, l) => s + l.avgAbsErrorPct * l.samples, 0) / liveSamples : null;
    const baseSamples = data.baseline.reduce((s, b) => s + b.samples, 0);
    const baseAvgErr =
      baseSamples > 0 ? data.baseline.reduce((s, b) => s + b.avgAbsErrorPct * b.samples, 0) / baseSamples : null;
    return { verified, live1d, base1d, liveAvgErr, baseAvgErr };
  }, [data]);

  if (isPending) return <CardSkeleton lines={6} />;

  if (isError || !data) {
    return (
      <Card className="p-5">
        <SectionTitle>Prediction audit — the model vs reality</SectionTitle>
        <div className="mt-3">
          <ErrorState
            compact
            message={error instanceof Error ? error.message : 'Could not load the prediction audit.'}
            onRetry={() => refetch()}
          />
        </div>
      </Card>
    );
  }

  const stats = data.tradeStats;
  const winBarMax = Math.max(stats.avgWin ?? 0, Math.abs(stats.avgLoss ?? 0), 1);

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ClipboardCheck className="h-4 w-4 text-cyan-400" aria-hidden />
          <SectionTitle>Prediction audit — the model vs reality</SectionTitle>
        </div>
        <Chip tone="zinc">updated {fmtDateTime(data.updatedAt)}</Chip>
      </div>

      {/* Verdict — verbatim, amber glass. ALWAYS visible, never inside the collapse. */}
      <div className="mt-3 rounded-2xl border border-amber-400/35 bg-amber-400/10 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]" role="note">
        <div className="flex items-start gap-3">
          <Scale className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" aria-hidden />
          <div className="min-w-0">
            <p className="font-display text-xs font-semibold tracking-[0.12em] text-amber-400 uppercase">Verdict</p>
            <p className="mt-1 text-sm leading-relaxed text-slate-200">{data.verdict}</p>
          </div>
        </div>
      </div>

      <Collapsible
        id="desk.audit"
        className="mt-4"
        defaultOpen
        title="The evidence — live hit rates, verified rows & expectancy"
        subtitle={`${plain(derived?.verified ?? 0, 0)} verified · ${plain(data.pendingCount, 0)} pending · verification runs 18:30 IST on trading days`}
      >
        {/* Methodology — expandable summary line */}
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-slate-500 transition-colors hover:text-slate-300 [&::-webkit-details-marker]:hidden">
            <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" aria-hidden />
            How this audit works — predictions are logged before the outcome, then checked against real closes
          </summary>
          <p className="glass-inset mt-2 p-3 text-xs leading-relaxed text-slate-400">{data.methodology}</p>
        </details>

        {/* Stat tiles */}
        <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <AuditTile label="Verified" value={plain(derived?.verified ?? 0, 0)} sub="live predictions checked against real closes" />
          <AuditTile label="Pending" value={plain(data.pendingCount, 0)} sub="logged, waiting to mature" />
          <AuditTile
            label="1d hit rate — live"
            value={
              derived?.live1d ? (
                <>
                  {pct(derived.live1d.hitRatePct, 1)}
                  <span className="ml-1 text-sm font-normal text-slate-500">(n={plain(derived.live1d.samples, 0)})</span>
                </>
              ) : (
                '—'
              )
            }
            sub={derived?.base1d ? `${pct(derived.base1d.directionHitRatePct, 1)} backtest baseline` : 'no baseline'}
            subClassName="text-cyan-400/80"
          />
          <AuditTile
            label="Avg |error| — live"
            value={derived?.liveAvgErr != null ? `±${plain(derived.liveAvgErr, 2)}%` : '—'}
            sub={derived?.baseAvgErr != null ? `±${plain(derived.baseAvgErr, 2)}% backtest baseline` : undefined}
            subClassName="text-cyan-400/80"
          />
        </div>

        {/* Live vs baseline per horizon */}
        {data.liveStats.length > 0 && (
          <div className="mt-5">
            <p className="font-display text-[11px] font-semibold tracking-[0.14em] text-slate-500 uppercase">
              Live vs backtest baseline, per horizon
            </p>
            <div className="thin-scroll mt-2 overflow-x-auto">
              <table className="table-premium min-w-[520px]">
                <thead>
                  <tr>
                    <th>Horizon</th>
                    <th className="num">Live hit rate</th>
                    <th className="num">Baseline hit rate</th>
                    <th className="num">Within 80% band</th>
                  </tr>
                </thead>
                <tbody>
                  {[...data.liveStats]
                    .sort((a, b) => a.horizonDays - b.horizonDays)
                    .map((l) => {
                      const base = data.baseline.find((b) => b.horizonDays === l.horizonDays);
                      return (
                        <tr key={l.horizonDays}>
                          <td className="text-slate-300">{l.horizonDays}d</td>
                          <td className="num font-semibold text-slate-100">
                            {pct(l.hitRatePct, 1)} <span className="text-xs font-normal text-slate-500">(n={plain(l.samples, 0)})</span>
                          </td>
                          <td className="num text-slate-400">{base ? pct(base.directionHitRatePct, 1) : '—'}</td>
                          <td className="num text-slate-400">{l.withinBandPct != null ? pct(l.withinBandPct, 1) : '—'}</td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Recent verified predictions */}
        <div className="mt-5">
          <p className="font-display text-[11px] font-semibold tracking-[0.14em] text-slate-500 uppercase">
            Recent verified predictions
          </p>
          {data.recent.length === 0 ? (
            <EmptyState
              glyph="radar"
              className="mt-2"
              title={`${plain(data.pendingCount, 0)} predictions logged and waiting to mature`}
              message="Verification runs 18:30 IST on trading days — each matured forecast gets checked against the real close. This page fills itself as reality arrives."
            />
          ) : (
            <div className="thin-scroll mt-2 max-h-80 overflow-x-auto overflow-y-auto rounded-xl border border-white/6">
              <table className="table-premium min-w-[720px]">
                <thead>
                  <tr>
                    <th>Predicted → target</th>
                    <th>Ticker</th>
                    <th>Horizon</th>
                    <th className="num">Predicted</th>
                    <th className="num">Actual</th>
                    <th>Result</th>
                    <th title="actual inside the 80% band">Band</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent.map((r, i) => (
                    <tr key={`${r.ticker}-${r.predictionDate}-${r.horizonDays}-${i}`}>
                      <td className="text-xs whitespace-nowrap text-slate-400">
                        {fmtDate(r.predictionDate)} <span className="text-slate-600">→</span>{' '}
                        {r.targetDate ? fmtDate(r.targetDate) : '—'}
                      </td>
                      <td>
                        <span className="font-medium text-slate-100">{r.ticker}</span>
                        {r.recommendationGiven && (
                          <span className="ml-1.5 text-[10px] tracking-wide text-slate-500 uppercase">{r.recommendationGiven}</span>
                        )}
                      </td>
                      <td className="text-slate-300">{r.horizonDays}d</td>
                      <td className={clsx('num font-medium', signTone(r.predictedPct))}>{signedPct(r.predictedPct)}</td>
                      <td className={clsx('num font-semibold', signTone(r.actualPct))}>{signedPct(r.actualPct)}</td>
                      <td>
                        {r.hit ? (
                          <Chip tone="buy" glow className="px-2 py-0.5 text-[10px]">
                            HIT
                          </Chip>
                        ) : (
                          <Chip tone="sell" glow className="px-2 py-0.5 text-[10px]">
                            MISS
                          </Chip>
                        )}
                      </td>
                      <td>
                        <BandDot withinBand={r.withinBand} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Trade review */}
        <div className="mt-5">
          <p className="font-display text-[11px] font-semibold tracking-[0.14em] text-slate-500 uppercase">
            Closed-trade review — did price reach the plan?
          </p>
          {data.tradeReview.length === 0 ? (
            <EmptyState
              glyph="slash"
              className="mt-2"
              title="No closed paper trades yet"
              message="Record BUYs from the daily plan and close them per the exit advice — each close lands here with its outcome versus the plan's stop and target."
            />
          ) : (
            <ul className="mt-2 space-y-2">
              {data.tradeReview.map((t, i) => {
                const meta = OUTCOME_META[t.outcome] ?? OUTCOME_META.MANUAL_EXIT;
                return (
                  <li key={`${t.ticker}-${t.exitAt ?? i}`} className="glass-inset p-3.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-slate-100">{t.name || t.ticker}</span>
                        <Chip tone="zinc">{t.ticker}</Chip>
                        <Chip tone={meta.tone} glow>
                          {meta.label}
                        </Chip>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                        <span className="text-slate-400 tabular-nums">
                          {plain(t.qty, 0)} × {inr(t.entry)} <span className="text-slate-600">→</span>{' '}
                          {t.exit != null ? inr(t.exit) : '—'}
                        </span>
                        {t.realizedPnl != null && (
                          <span className={clsx('font-display font-semibold tabular-nums', signTone(t.realizedPnl))}>
                            {signedInr(t.realizedPnl)}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-[11px] text-slate-500">
                      {t.stopLoss != null && (
                        <span>
                          stop <span className="text-sell">{inr(t.stopLoss)}</span>
                        </span>
                      )}
                      {t.target != null && (
                        <span>
                          target <span className="text-buy">{inr(t.target)}</span>
                        </span>
                      )}
                      {t.exitAt && <span>closed {fmtDateTime(t.exitAt)}</span>}
                    </div>
                    {t.planNote && <p className="mt-1.5 text-xs leading-relaxed text-slate-500">{t.planNote}</p>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Expectancy */}
        <div className="glass-inset mt-5 p-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[auto_1fr] sm:items-center">
            <div className="pr-2 sm:pr-6">
              <p className="text-[11px] font-medium tracking-[0.08em] text-slate-500 uppercase">Expectancy / trade</p>
              <p
                className={clsx(
                  'font-display mt-1 text-4xl font-semibold tracking-tight tabular-nums',
                  stats.expectancy != null ? signTone(stats.expectancy) : 'text-slate-500',
                )}
              >
                {stats.expectancy != null ? signedInr(stats.expectancy) : '—'}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {plain(stats.closedTrades, 0)} closed trade{stats.closedTrades === 1 ? '' : 's'}
                {stats.winRatePct != null ? ` · win rate ${pct(stats.winRatePct, 1)}` : ''}
              </p>
            </div>
            <div className="space-y-2.5">
              <div>
                <div className="flex items-baseline justify-between text-xs">
                  <span className="text-slate-400">Avg win</span>
                  <span className="font-semibold text-buy tabular-nums">
                    {stats.avgWin != null ? inrSmart(stats.avgWin) : '—'}
                  </span>
                </div>
                <div className="mt-1 h-2 overflow-hidden rounded-full bg-white/6">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-[#00b894] to-buy"
                    style={{ width: `${stats.avgWin != null ? Math.max(2, (stats.avgWin / winBarMax) * 100) : 0}%` }}
                  />
                </div>
              </div>
              <div>
                <div className="flex items-baseline justify-between text-xs">
                  <span className="text-slate-400">Avg loss</span>
                  <span className="font-semibold text-sell tabular-nums">
                    {stats.avgLoss != null ? inrSmart(-Math.abs(stats.avgLoss)) : '—'}
                  </span>
                </div>
                <div className="mt-1 h-2 overflow-hidden rounded-full bg-white/6">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-[#e11d48] to-sell"
                    style={{
                      width: `${stats.avgLoss != null ? Math.max(2, (Math.abs(stats.avgLoss) / winBarMax) * 100) : 0}%`,
                    }}
                  />
                </div>
              </div>
            </div>
          </div>
          <p className="mt-3 border-t border-white/6 pt-3 text-xs leading-relaxed text-slate-500">{stats.note}</p>
        </div>
      </Collapsible>
    </Card>
  );
}
