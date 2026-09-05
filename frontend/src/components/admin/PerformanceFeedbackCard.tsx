'use client';

import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlertTriangle, Repeat, Scale, SplitSquareHorizontal } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ApiError, getExecutionSummary } from '@/lib/api';
import type {
  ExecutionDriftPoint,
  ExecutionMeasured,
  ExecutionSummaryResponse,
  FactorInsightSide,
  FactorInsightSplit,
} from '@/lib/types';
import { CHART } from '@/lib/palette';
import { fmtDate, fmtDateShort, pct, plain, signedInr } from '@/lib/format';
import { Card, CardSkeleton, Chip, Collapsible, EmptyState, ErrorState, SectionTitle } from '@/components/ui';
import { appliedMeta, KellyAppliedBadge } from '@/components/KellyAppliedBadge';
import { AuditTile } from './PredictionAudit';
import { signTone } from './desk-ui';

/**
 * Backends may emit win rates as 0..1 or as a percent — normalize tolerantly.
 * (With the ≥30-trade window a genuine percent below 1% implies zero wins,
 * which maps to 0 either way, so the ≤1 heuristic is safe.)
 */
function asPct(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return v <= 1 ? v * 100 : v;
}

/** SPEC_V9 E2 selection rule → the pair behind today's adapted half-Kelly. */
function currentApplied(m: ExecutionMeasured): string {
  if (m.usableP && m.usableB) return 'measured-p+measured-b';
  if (m.usableP) return 'measured-p+structural-b';
  if (m.usableB) return 'model-p+measured-b';
  return 'model-p+structural-b';
}

/* ------------------------------------------------------------------ */
/* V10 B4 — factorInsights normalization (backend ships in parallel:   */
/* tolerate wrapper / bare array / bare note string and key variants)  */
/* ------------------------------------------------------------------ */

interface NormalizedSide {
  label: string;
  n: number | null;
  winRatePct: number | null;
}

interface NormalizedSplit {
  factor: string;
  high: NormalizedSide;
  low: NormalizedSide;
  note: string | null;
}

interface NormalizedInsights {
  splits: NormalizedSplit[];
  note: string | null;
  closedWithContext: number | null;
}

function normalizeSide(side: FactorInsightSide | null | undefined, fallbackLabel: string): NormalizedSide | null {
  if (side == null || typeof side !== 'object') return null;
  const rawWin = side.winRatePct ?? side.winRate;
  return {
    label: side.label ?? fallbackLabel,
    n: side.n ?? side.samples ?? side.count ?? null,
    winRatePct: asPct(rawWin),
  };
}

/** Null when the field is absent (older backend) — the whole block hides. */
function normalizeFactorInsights(fi: ExecutionSummaryResponse['factorInsights']): NormalizedInsights | null {
  if (fi == null) return null;
  if (typeof fi === 'string') return { splits: [], note: fi, closedWithContext: null };
  const rawSplits: FactorInsightSplit[] = Array.isArray(fi) ? fi : (fi.splits ?? fi.insights ?? []);
  const note = Array.isArray(fi) ? null : (fi.note ?? null);
  const closedWithContext = Array.isArray(fi) ? null : (fi.closedWithContext ?? fi.withContext ?? null);
  const splits: NormalizedSplit[] = [];
  for (const s of rawSplits ?? []) {
    if (s == null || typeof s !== 'object') continue;
    const thr = s.threshold != null ? String(s.threshold) : null;
    const high = normalizeSide(s.high ?? s.above, thr ? `≥ ${thr}` : 'high half');
    const low = normalizeSide(s.low ?? s.below, thr ? `< ${thr}` : 'low half');
    if (!high || !low) continue; // an honest split needs both sides
    splits.push({
      factor: s.factor ?? s.name ?? s.label ?? 'factor',
      high,
      low,
      note: s.note ?? s.detail ?? null,
    });
  }
  return { splits, note, closedWithContext };
}

function SideStat({ side }: { side: NormalizedSide }) {
  return (
    <span className="whitespace-nowrap text-slate-300 tabular-nums">
      <span className="text-slate-400">{side.label}</span>{' '}
      <span className="font-semibold text-slate-100">
        {side.winRatePct != null ? pct(side.winRatePct, 1) : '—'}
      </span>{' '}
      win{side.n != null && <span className="text-slate-500"> (n={plain(side.n, 0)})</span>}
    </span>
  );
}

type DriftRow = ExecutionDriftPoint & { pPct: number | null };

/** Dot area scales with the number of closed trades behind the snapshot (r 2.5 → 8). */
function driftDotRadius(closedTrades: number): number {
  return Math.min(8, 2.5 + Math.sqrt(Math.max(0, closedTrades)) * 0.55);
}

function renderDriftDot(props: { cx?: number; cy?: number; payload?: DriftRow; index?: number }) {
  const { cx, cy, payload, index } = props;
  if (cx == null || cy == null || payload == null || payload.halfKellyPct == null) {
    return <circle key={`drift-dot-gap-${index ?? 'x'}`} cx={-10} cy={-10} r={0} fill="none" />;
  }
  return (
    <circle
      key={`drift-dot-${payload.date}`}
      cx={cx}
      cy={cy}
      r={driftDotRadius(payload.closedTrades)}
      fill={CHART.sky}
      fillOpacity={0.85}
      stroke={CHART.surface}
      strokeWidth={1}
    />
  );
}

function DriftTip({ active, payload }: { active?: boolean; payload?: Array<{ payload?: DriftRow }> }) {
  if (!active || !payload?.length) return null;
  const p = payload[0]?.payload;
  if (!p) return null;
  return (
    <div className="chart-tip px-3 py-2 text-xs">
      <p className="font-medium text-slate-300">{fmtDate(p.date)}</p>
      <p className="mt-1 text-sm font-semibold text-slate-100">
        half-Kelly {p.halfKellyPct != null ? pct(p.halfKellyPct, 2) : '—'}
      </p>
      <p className="mt-0.5 text-slate-400">
        {plain(p.closedTrades, 0)} closed trade{p.closedTrades === 1 ? '' : 's'} · p{' '}
        {p.pPct != null ? pct(p.pPct, 1) : '—'} · b {p.measuredB != null ? plain(p.measuredB, 2) : '—'}
      </p>
      <p className="mt-0.5 text-slate-500">applied: {appliedMeta(p.applied).label}</p>
    </div>
  );
}

/**
 * V9 — Performance feedback: the execution loop measured. Model win rate vs
 * YOUR win rate, structural payoff vs YOUR payoff (with sample counts), the
 * adapted half-Kelly with its applied-source badge, expectancy, the honest
 * paper-fills note (always visible), and the nightly Kelly-drift chart (dots
 * sized by closed trades). Hides itself entirely on an older backend (404).
 */
export function PerformanceFeedbackCard() {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ['admin', 'execution-summary'],
    queryFn: getExecutionSummary,
    staleTime: 5 * 60_000,
    retry: (failureCount, err) => !(err instanceof ApiError && err.status === 404) && failureCount < 2,
  });

  // Older backend without SPEC_V9 E1 — hide the card entirely.
  if (isError && error instanceof ApiError && error.status === 404) return null;
  if (isPending) return <CardSkeleton lines={5} />;

  if (isError || !data) {
    return (
      <Card className="p-5">
        <SectionTitle>Performance feedback — the loop adapts to YOUR results</SectionTitle>
        <div className="mt-3">
          <ErrorState
            compact
            message={error instanceof Error ? error.message : 'Could not load the execution summary.'}
            onRetry={() => refetch()}
          />
        </div>
      </Card>
    );
  }

  // Optional-tolerant reads — the backend ships in parallel.
  const m: ExecutionMeasured = data.measured ?? {
    winRatePct: null,
    payoff: null,
    halfKellyPct: null,
    usableP: false,
    usableB: false,
    reasons: [],
  };
  const windowUsed = data.window?.used ?? 0;
  const windowSize = data.window?.size ?? 30;
  const yourWinPct = asPct(m.winRatePct);
  const modelWinPct = asPct(data.model?.winRatePct);
  const expectancy = data.expectancy ?? { value: null, note: '' };
  const reasons = m.reasons ?? [];
  // Prefer the backend's own applied label (live shape ships one); derive as fallback.
  const applied = m.applied ?? currentApplied(m);

  const driftRows: DriftRow[] = (data.drift ?? []).map((d) => ({ ...d, pPct: asPct(d.measuredP) }));
  const plottable = driftRows.filter((d) => d.halfKellyPct != null);
  const maxDot = plottable.reduce((s, d) => Math.max(s, d.closedTrades), 0);
  // V10 B4 — factor insights (null on a pre-V10 backend → the block hides entirely).
  const insights = normalizeFactorInsights(data.factorInsights);

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Repeat className="h-4 w-4 text-cyan-400" aria-hidden />
          <SectionTitle>Performance feedback — the loop adapts to YOUR results</SectionTitle>
        </div>
        <Chip tone="zinc">
          {plain(data.closedTrades, 0)} closed trade{data.closedTrades === 1 ? '' : 's'}
        </Chip>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-slate-500">
        Log → measure → adapt: every closed paper trade below feeds the measured win rate and payoff, and the Kelly
        sizing switches from model inputs to YOUR numbers once they are usable (p at {windowSize} closed, b at 10 with
        both wins and losses).
      </p>

      <Collapsible
        id="desk.feedback"
        className="mt-4"
        defaultOpen
        title="The measured loop — win rate, payoff, factor insights & Kelly drift"
        subtitle={`window: last ${plain(windowSize, 0)} closed trades (${plain(windowUsed, 0)} used)`}
      >
        {/* Model vs YOUR measured inputs + the adapted output */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <AuditTile
            label={`Win rate — yours, last ${plain(windowSize, 0)}`}
            value={
              yourWinPct != null ? (
                <>
                  {pct(yourWinPct, 1)}
                  <span className="ml-1 text-sm font-normal text-slate-500">(n={plain(windowUsed, 0)})</span>
                </>
              ) : (
                '—'
              )
            }
            sub={
              modelWinPct != null
                ? `model ${pct(modelWinPct, 1)} — ${data.model?.source ?? 'model source'}`
                : 'model win rate unavailable'
            }
            subClassName="text-cyan-400/80"
          />
          <AuditTile
            label="Payoff — yours vs structural"
            value={
              m.payoff != null ? (
                <>
                  {plain(m.payoff, 2)}
                  <span className="ml-1 text-sm font-normal text-slate-500">(n={plain(windowUsed, 0)})</span>
                </>
              ) : (
                '—'
              )
            }
            sub="structural assumption 1.5 (stated, not measured)"
            subClassName="text-cyan-400/80"
          />
          <AuditTile
            label="Adapted half-Kelly"
            value={m.halfKellyPct != null ? pct(m.halfKellyPct, 2) : '—'}
            sub={<KellyAppliedBadge applied={applied} className="mt-0.5 px-2 py-0.5 text-[10px]" />}
          />
          <AuditTile
            label="Expectancy / trade"
            value={
              expectancy.value != null ? (
                <span className={signTone(expectancy.value)}>{signedInr(expectancy.value)}</span>
              ) : (
                '—'
              )
            }
            sub={expectancy.note || undefined}
          />
        </div>

        {/* Honest reasons while measured inputs are not usable yet */}
        {reasons.length > 0 && (
          <ul className="mt-3 space-y-1.5">
            {reasons.map((r, i) => (
              <li key={i} className="flex items-start gap-2 text-xs leading-relaxed text-amber-400">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                {r}
              </li>
            ))}
          </ul>
        )}

        {/* V10 B4 — execution insights by entry-context factor (or the honest unlock note) */}
        {insights && (
          <div className="mt-5">
            <p className="font-display flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.14em] text-slate-500 uppercase">
              <SplitSquareHorizontal className="h-3.5 w-3.5 shrink-0 text-cyan-400" aria-hidden />
              Execution insights by factor — win rate on YOUR closed trades
            </p>
            {insights.splits.length > 0 ? (
              <>
                <ul className="mt-2 space-y-2">
                  {insights.splits.map((s, i) => {
                    const delta =
                      s.high.winRatePct != null && s.low.winRatePct != null
                        ? s.high.winRatePct - s.low.winRatePct
                        : null;
                    return (
                      <li
                        key={`${s.factor}-${i}`}
                        className="glass-inset flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3.5 py-2.5 text-xs"
                      >
                        <span className="w-36 shrink-0 font-medium break-all text-slate-200">{s.factor}</span>
                        <SideStat side={s.high} />
                        <span aria-hidden className="text-slate-600">
                          vs
                        </span>
                        <SideStat side={s.low} />
                        {delta != null && (
                          <span
                            title="Win-rate gap: high half minus low half, in percentage points"
                            className={clsx(
                              'ml-auto font-semibold whitespace-nowrap tabular-nums',
                              delta > 0 ? 'text-buy' : delta < 0 ? 'text-sell' : 'text-slate-400',
                            )}
                          >
                            {delta >= 0 ? '+' : '−'}
                            {plain(Math.abs(delta), 1)}pp
                          </span>
                        )}
                        {s.note && <span className="w-full text-[11px] leading-relaxed text-slate-500">{s.note}</span>}
                      </li>
                    );
                  })}
                </ul>
                <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
                  {insights.note ||
                    'Splits appear only when both halves have n≥8 closed trades with entry snapshots — smaller cuts are noise and stay hidden. At these sample sizes read the direction of a gap, not its exact size.'}
                </p>
              </>
            ) : (
              <EmptyState
                glyph="radar"
                className="mt-2"
                title="Factor insights locked"
                message={
                  insights.note ||
                  `Insights unlock at 20 closed trades with entry snapshots${
                    insights.closedWithContext != null ? ` — currently ${plain(insights.closedWithContext, 0)}` : ''
                  }. Every paper BUY now stores its entry context (quant score, master score, timing, intelligence quality, regime), so the count grows as you trade.`
                }
              />
            )}
          </div>
        )}

        {/* Kelly drift — nightly snapshots */}
        <div className="mt-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-display text-[11px] font-semibold tracking-[0.14em] text-slate-500 uppercase">
              Kelly drift — adapted half-Kelly over time
            </p>
            {plottable.length > 0 && (
              <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-500">
                <svg width="30" height="12" aria-hidden>
                  <circle cx="5" cy="6" r="2.5" fill={CHART.sky} fillOpacity="0.85" />
                  <circle cx="19" cy="6" r={driftDotRadius(maxDot)} fill={CHART.sky} fillOpacity="0.85" />
                </svg>
                dot size = closed trades behind that snapshot
              </span>
            )}
          </div>
          {plottable.length === 0 ? (
            <EmptyState
              glyph="radar"
              className="mt-2"
              title="No drift points yet"
              message="Drift plots after your first closed trades + first nightly snapshot — the evening job records that day's measured p, b and half-Kelly, one dot per day."
            />
          ) : (
            <div className="mt-3 h-56 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={driftRows} margin={{ top: 12, right: 16, bottom: 0, left: 4 }}>
                  <CartesianGrid stroke={CHART.grid} strokeWidth={1} vertical={false} />
                  <XAxis
                    dataKey="date"
                    tickFormatter={(v: string) => fmtDateShort(v)}
                    tick={{ fill: CHART.tick, fontSize: 11 }}
                    axisLine={{ stroke: CHART.axisLine }}
                    tickLine={false}
                    tickMargin={8}
                    minTickGap={28}
                  />
                  <YAxis
                    tickFormatter={(v: number) => `${plain(v, 1)}%`}
                    tick={{ fill: CHART.tick, fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    width={48}
                    domain={[0, (dataMax: number) => Math.max(1, dataMax * 1.25)]}
                  />
                  <Tooltip content={<DriftTip />} cursor={{ stroke: CHART.axisLine, strokeWidth: 1 }} />
                  <Line
                    dataKey="halfKellyPct"
                    stroke={CHART.sky}
                    strokeWidth={2}
                    dot={renderDriftDot}
                    activeDot={{ r: 4, fill: CHART.sky, stroke: CHART.surface, strokeWidth: 2 }}
                    isAnimationActive
                    animationDuration={350}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </Collapsible>

      {/* REQUIRED honesty — paper fills vs live reality. Always visible, even collapsed. */}
      <p className={clsx('mt-4 flex items-start gap-2 border-t border-white/6 pt-3 text-xs leading-relaxed text-slate-500')}>
        <Scale className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        {data.note ||
          'Paper fills execute at the quoted price with zero slippage — live results will be worse by fees and slippage.'}
      </p>
    </Card>
  );
}
