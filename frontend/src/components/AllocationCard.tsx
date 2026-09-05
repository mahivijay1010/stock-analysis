'use client';

import clsx from 'clsx';
import { AlertTriangle, Layers, ListOrdered, Loader2, PiggyBank, Target } from 'lucide-react';
import type { AllocationEvidence, AllocationPlan, PortfolioStrategy, RecordTradeRequest } from '@/lib/types';
import { fmtDateTime, inr, inrSmart, pct, plain, signedInr, signedPct } from '@/lib/format';
import { Card, Chip, EmptyState, ScoreDonut, SectionTitle, type Tone } from '@/components/ui';
import { Stagger, StaggerItem, Tilt } from '@/components/motion';

export const STRATEGY_LABEL: Record<PortfolioStrategy, string> = {
  'short-term': 'Short-term momentum',
  balanced: 'Balanced',
  'long-term': 'Long-term quality',
};

const VERDICT_CHIP: Record<'STRONG_CANDIDATE' | 'WATCH' | 'PASS', { label: string; tone: Tone }> = {
  STRONG_CANDIDATE: { label: 'STRONG CANDIDATE', tone: 'buy' },
  WATCH: { label: 'WATCH', tone: 'wait' },
  PASS: { label: 'PASS', tone: 'sell' },
};

const EVIDENCE_DOT: Record<AllocationEvidence['result'], string> = {
  pass: 'bg-buy',
  fail: 'bg-sell',
  neutral: 'bg-slate-500',
  'no-data': 'bg-slate-700',
};

/** Status color by sign — token classes (buy/sell), not chart hues. */
function signToneClass(value: number): string {
  if (value > 0) return 'text-buy';
  if (value < 0) return 'text-sell';
  return 'text-slate-400';
}

function EvidenceList({ evidence }: { evidence: AllocationEvidence[] }) {
  if (!evidence.length) return null;
  return (
    <ul className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
      {evidence.map((e, i) => (
        <li key={`${e.name}-${i}`} className="flex items-start gap-2 text-xs leading-relaxed">
          <span aria-hidden className={clsx('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', EVIDENCE_DOT[e.result])} />
          <span className="text-slate-400">
            <span className="text-slate-300">{e.name}</span>
            {e.value ? <span className="text-slate-500"> — {e.value}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Mini label/value cell for a leg's trade levels. Missing values render an explicit em-dash, never 0. */
function LevelStat({ label, value, valueClassName }: { label: string; value: string | null; valueClassName?: string }) {
  return (
    <div className="rounded-lg bg-white/4 px-2.5 py-2">
      <dt className="text-[10px] font-medium tracking-[0.08em] text-slate-500 uppercase">{label}</dt>
      <dd className={clsx('mt-0.5 text-xs font-semibold tabular-nums', value == null ? 'text-slate-600' : valueClassName)}>
        {value ?? '—'}
      </dd>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Building blocks — composed by AllocationCard (admin desk) and       */
/* directly by the Portfolio dashboard's collapsible sections.         */
/* ------------------------------------------------------------------ */

/** Cash reserve — deliberate, explained. An honesty element: keep it always visible. */
export function CashReserveNote({ allocation, className }: { allocation: AllocationPlan; className?: string }) {
  return (
    <div className={clsx('flex items-start gap-2.5 rounded-xl border border-violet-400/25 bg-violet-400/8 p-3', className)}>
      <PiggyBank className="mt-0.5 h-4 w-4 shrink-0 text-violet-300" aria-hidden />
      <p className="text-xs leading-relaxed text-slate-300">
        <span className="font-semibold text-violet-300">Cash reserve {pct(allocation.cashReservePct, 0)}</span>
        {' — '}
        {allocation.cashReserveReason}
      </p>
    </div>
  );
}

/** The engine's warnings — honesty element, render outside anything collapsible. */
export function AllocationWarnings({ warnings, className }: { warnings: string[]; className?: string }) {
  if (!warnings.length) return null;
  return (
    <ul className={clsx('space-y-1.5', className)}>
      {warnings.map((w, i) => (
        <li key={i} className="flex items-start gap-2 text-xs leading-relaxed text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {w}
        </li>
      ))}
    </ul>
  );
}

/** Per-stock legs as cards: score, sizing, levels, reasoning, evidence and odds. */
export function AllocationLegs({
  allocation,
  onAnalyze,
  onRecordBuy,
  recordingTicker,
  recordingAll = false,
  className,
}: {
  allocation: AllocationPlan;
  onAnalyze: (ticker: string) => void;
  onRecordBuy?: (req: RecordTradeRequest) => void;
  recordingTicker?: string | null;
  recordingAll?: boolean;
  className?: string;
}) {
  return (
    <Stagger className={clsx('grid gap-3 xl:grid-cols-2', className)}>
      {allocation.stocks.map((s) => (
        <StaggerItem key={s.ticker} className="h-full">
          <Tilt maxDeg={3} className="glass-inset flex h-full flex-col p-4">
            {/* Identity + sizing */}
            <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
              <div className="flex min-w-0 items-center gap-3">
                <ScoreDonut score={s.score} tone="neutral" size={40} />
                <div className="min-w-0">
                  <button
                    type="button"
                    onClick={() => onAnalyze(s.ticker)}
                    className="font-display block text-left text-sm font-semibold text-slate-100 underline-offset-4 transition-colors hover:text-cyan-400 hover:underline"
                  >
                    {s.name}
                  </button>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {s.ticker} · {s.sector}
                  </p>
                </div>
              </div>
              <div className="text-right">
                <p className="font-display text-base font-semibold text-slate-100 tabular-nums">{inrSmart(s.invested)}</p>
                <p className="text-xs text-slate-500 tabular-nums">
                  {plain(s.qty, 0)} × {inr(s.price)} · {pct(s.weightPct, 0)}
                </p>
              </div>
            </div>

            {/* Verdict + probability chips */}
            {(s.frameworkVerdict || s.masterScore != null || s.directionProb7d != null) && (
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                {s.frameworkVerdict && (
                  <Chip tone={VERDICT_CHIP[s.frameworkVerdict].tone} glow>
                    {VERDICT_CHIP[s.frameworkVerdict].label}
                  </Chip>
                )}
                {s.masterScore != null && <Chip tone="violet">master {Math.round(s.masterScore)}</Chip>}
                {s.directionProb7d != null && <Chip tone="cyan">P(up, 7d) {pct(s.directionProb7d * 100, 0)}</Chip>}
              </div>
            )}

            {/* Trade levels — missing = explicit dash, never a fabricated number */}
            <dl className="mt-3 grid grid-cols-2 gap-2 min-[420px]:grid-cols-3">
              <LevelStat label="Stop loss" value={s.stopLoss != null ? inr(s.stopLoss) : null} valueClassName="text-sell" />
              <LevelStat label="Target" value={s.target != null ? inr(s.target) : null} valueClassName="text-buy" />
              <LevelStat
                label="Max loss"
                value={s.maxLoss != null ? signedInr(-Math.abs(s.maxLoss)) : null}
                valueClassName="text-sell"
              />
              <LevelStat
                label="7d expected"
                value={s.expected7dPct != null ? signedPct(s.expected7dPct) : null}
                valueClassName={s.expected7dPct != null ? signToneClass(s.expected7dPct) : undefined}
              />
              <LevelStat
                label="30d expected"
                value={s.expected30dPct != null ? signedPct(s.expected30dPct) : null}
                valueClassName={s.expected30dPct != null ? signToneClass(s.expected30dPct) : undefined}
              />
              <LevelStat label="Est. fees" value={inr(s.fees)} valueClassName="text-slate-200" />
            </dl>

            {s.strategyFit && (
              <p className="mt-3 text-xs leading-relaxed text-violet-200/90">
                <span className="font-semibold text-violet-300">Strategy fit:</span> {s.strategyFit}
              </p>
            )}

            <p className="mt-2 text-xs leading-relaxed text-slate-400">{s.whyChosen}</p>
            {s.reasons.length > 0 && (
              <ul className="mt-1.5 space-y-1">
                {s.reasons.map((r, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs leading-relaxed text-slate-300">
                    <span aria-hidden className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-buy" />
                    {r}
                  </li>
                ))}
              </ul>
            )}

            {/* Evidence — real checked values with pass/fail dots */}
            <EvidenceList evidence={s.evidence} />

            <div className="mt-auto">
              <p className="mt-3 flex items-start gap-1.5 border-t border-white/6 pt-2.5 text-[11px] leading-relaxed text-slate-500">
                <Target className="mt-0.5 h-3 w-3 shrink-0 text-cyan-400" aria-hidden />
                {s.historicalOdds}
              </p>

              {onRecordBuy && (
                <button
                  type="button"
                  disabled={recordingTicker === s.ticker || recordingAll}
                  onClick={() => onRecordBuy({ ticker: s.ticker, side: 'BUY', qty: s.qty })}
                  className="mt-2.5 inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-buy/40 bg-buy/10 px-3 py-1.5 text-xs font-semibold text-buy transition-colors hover:bg-buy/20 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {(recordingTicker === s.ticker || recordingAll) && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  )}
                  Record BUY — {plain(s.qty, 0)} × {s.ticker}
                </button>
              )}
            </div>
          </Tilt>
        </StaggerItem>
      ))}
    </Stagger>
  );
}

/** Staggered entry plan (long-term / balanced strategies). */
export function TranchePlan({ plan, className }: { plan: string[] | null; className?: string }) {
  if (!plan || plan.length === 0) return null;
  return (
    <div className={clsx('rounded-xl border border-cyan-400/20 bg-cyan-400/6 p-4', className)}>
      <div className="flex items-center gap-2">
        <ListOrdered className="h-4 w-4 text-cyan-400" aria-hidden />
        <p className="text-xs font-semibold tracking-wide text-cyan-300">Staggered entry plan</p>
      </div>
      <ol className="mt-2 space-y-1.5">
        {plan.map((t, i) => (
          <li key={i} className="flex items-start gap-2.5 text-xs leading-relaxed text-slate-300">
            <span className="mt-px flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full bg-cyan-400/15 text-[10px] font-bold text-cyan-300">
              {i + 1}
            </span>
            {t}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** "Why this split" — the engine's own rationale bullets. */
export function SplitRationale({ rationale, className }: { rationale: string[]; className?: string }) {
  if (!rationale.length) return null;
  return (
    <div className={clsx('border-t border-white/8 pt-3', className)}>
      <p className="text-xs font-semibold text-slate-300">Why this split</p>
      <ul className="mt-1.5 space-y-1">
        {rationale.map((r, i) => (
          <li key={i} className="flex items-start gap-2 text-xs leading-relaxed text-slate-400">
            <span aria-hidden className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-cyan-400" />
            {r}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Combined outcome table (stocks + uninvested cash) with the 80% ranges, correlation note and fee line. */
export function CombinedOutcomes({
  allocation,
  heading = true,
  className,
}: {
  allocation: AllocationPlan;
  heading?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      {heading && (
        <p className="text-xs font-semibold text-slate-300">
          Combined outcome for {inrSmart(allocation.amount)} (stocks + uninvested cash)
        </p>
      )}
      <div className={clsx('thin-scroll overflow-x-auto rounded-xl border border-white/6', heading && 'mt-2')}>
        <table className="table-premium min-w-[560px]">
          <thead>
            <tr>
              <th>Horizon</th>
              <th className="num">Expected value</th>
              <th className="num">Expected P&amp;L</th>
              <th className="num">80% range</th>
            </tr>
          </thead>
          <tbody>
            {allocation.outcomes.map((o) => (
              <tr key={o.horizonDays}>
                <td className="text-slate-300">{o.horizonDays}d</td>
                <td className="num font-medium text-slate-100">{inrSmart(o.expectedValue)}</td>
                <td className={clsx('num font-medium', signToneClass(o.expectedProfit))}>
                  {signedInr(o.expectedProfit)} ({signedPct(o.expectedProfitPct)})
                </td>
                <td className="num text-xs text-slate-400">
                  {inrSmart(o.lowValue)} – {inrSmart(o.highValue)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">{allocation.correlationNote}</p>
      <p className="mt-2 text-[11px] text-slate-500">
        Total estimated round-trip fees {inr(allocation.totalFeesRoundTrip)} ({pct(allocation.totalFeesPct, 2)} of
        invested).
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* CSV export — client-side download of the allocation table           */
/* ------------------------------------------------------------------ */

/** One CSV cell: numbers rounded to 2dp, missing values written as NOT_AVAILABLE (never 0), quotes escaped. */
function csvCell(v: string | number | null | undefined): string {
  if (v == null) return 'NOT_AVAILABLE';
  const s = typeof v === 'number' ? (Number.isFinite(v) ? String(Math.round(v * 100) / 100) : 'NOT_AVAILABLE') : v;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Builds and downloads the suggested-allocation table as a CSV — purely
 * client-side (no request, no order placed anywhere). Numbers are raw INR /
 * percent values so spreadsheets can compute; the backend disclaimer rides
 * along verbatim so the export stays as honest as the page.
 */
export function downloadAllocationCsv(allocation: AllocationPlan, disclaimer?: string): void {
  const head = [
    'Ticker',
    'Name',
    'Sector',
    'Verdict',
    'Score',
    'Master score',
    'P(up 7d) %',
    'Qty',
    'Price INR',
    'Invested INR',
    'Weight %',
    'Stop loss INR',
    'Target INR',
    'Max loss INR',
    'Expected 7d %',
    'Expected 30d %',
    'Est. fees INR',
    'Why chosen',
  ];
  const rows = allocation.stocks.map((s) => [
    s.ticker,
    s.name,
    s.sector,
    s.frameworkVerdict,
    s.score,
    s.masterScore,
    s.directionProb7d != null ? Math.round(s.directionProb7d * 1000) / 10 : null,
    s.qty,
    s.price,
    s.invested,
    s.weightPct,
    s.stopLoss,
    s.target,
    s.maxLoss,
    s.expected7dPct,
    s.expected30dPct,
    s.fees,
    s.whyChosen,
  ]);
  const summary: Array<Array<string | number | null>> = [
    [],
    ['Strategy', STRATEGY_LABEL[allocation.strategy]],
    ['As of', allocation.asOf],
    ['Amount INR', allocation.amount],
    ['Invested INR', allocation.cashUsed],
    ['Cash reserve INR', allocation.cashLeft],
    ['Cash reserve %', allocation.cashReservePct],
    ['Round-trip fees INR (est.)', allocation.totalFeesRoundTrip],
    ['Round-trip fees % of invested', allocation.totalFeesPct],
  ];
  if (disclaimer) summary.push(['Disclaimer', disclaimer]);

  const csv = [head, ...rows, ...summary].map((r) => r.map(csvCell).join(',')).join('\r\n');
  const asOf = new Date(allocation.asOf);
  const stamp = (Number.isNaN(asOf.getTime()) ? new Date() : asOf).toISOString().slice(0, 10);

  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `stocksense-allocation-${allocation.strategy}-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ------------------------------------------------------------------ */
/* AllocationCard — the all-in-one card (admin desk + legacy callers)  */
/* ------------------------------------------------------------------ */

/**
 * Renders a multi-stock allocation plan: which stocks, how much each, why,
 * and the combined outcome ranges. Record-BUY buttons appear only when
 * onRecordBuy is provided (admin desk); the public Portfolio tab composes
 * the exported pieces directly into its collapsible dashboard instead.
 */
export function AllocationCard({
  allocation,
  reason,
  title = 'Suggested allocation',
  onAnalyze,
  onRecordBuy,
  recordingTicker,
  onRecordAll,
  recordingAll = false,
  recordError,
}: {
  allocation: AllocationPlan | null;
  reason?: string;
  title?: string;
  onAnalyze: (ticker: string) => void;
  onRecordBuy?: (req: RecordTradeRequest) => void;
  recordingTicker?: string | null;
  onRecordAll?: () => void;
  recordingAll?: boolean;
  recordError?: string | null;
}) {
  if (!allocation) {
    return (
      <Card className="p-5">
        <SectionTitle>{title}</SectionTitle>
        <EmptyState
          glyph="radar"
          className="mt-3"
          title="No allocation today"
          message={reason || 'No qualified BUY setups pass the filters right now — holding cash is the right move.'}
        />
      </Card>
    );
  }

  const multi = allocation.stocks.length > 1;
  const sectorCount = new Set(allocation.stocks.map((s) => s.sector)).size;

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-cyan-400" aria-hidden />
          <SectionTitle>{title}</SectionTitle>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone="violet">{STRATEGY_LABEL[allocation.strategy]}</Chip>
          <Chip tone="zinc">
            {allocation.stocks.length} stock{multi ? 's' : ''} · {sectorCount} sector{sectorCount > 1 ? 's' : ''}
          </Chip>
          <Chip tone="zinc">
            invested {inrSmart(allocation.cashUsed)} · cash left {inrSmart(allocation.cashLeft)}
          </Chip>
        </div>
      </div>
      <p className="mt-1 text-xs text-slate-500">as of {fmtDateTime(allocation.asOf)}</p>

      <CashReserveNote allocation={allocation} className="mt-3" />

      <AllocationLegs
        allocation={allocation}
        onAnalyze={onAnalyze}
        onRecordBuy={onRecordBuy}
        recordingTicker={recordingTicker}
        recordingAll={recordingAll}
        className="mt-4"
      />

      {onRecordAll && allocation.stocks.length > 1 && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {/* BUY-token surface (matches the desk TradeButton): white-on-emerald-600
              measured 3.65:1 contrast — text-buy on bg-buy/15 clears WCAG AA. */}
          <button
            type="button"
            disabled={recordingAll || !!recordingTicker}
            onClick={onRecordAll}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-buy/40 bg-buy/15 px-4 py-2 text-sm font-semibold text-buy transition-colors hover:bg-buy/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-buy/70 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {recordingAll && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            Record all {allocation.stocks.length} BUYs
          </button>
          <span className="text-xs text-slate-500">Paper trades only — no real orders are placed.</span>
        </div>
      )}
      {recordError && <p className="mt-2 text-xs text-sell">{recordError}</p>}

      <TranchePlan plan={allocation.tranchePlan} className="mt-5" />

      <CombinedOutcomes allocation={allocation} className="mt-5" />

      <SplitRationale rationale={allocation.rationale} className="mt-4" />

      <AllocationWarnings warnings={allocation.warnings} className="mt-3" />
    </Card>
  );
}
