'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowRight, ArrowUp, BrainCircuit, Trophy } from 'lucide-react';
import { ApiError, getRankUniverse } from '@/lib/api';
import { DecisionGateChips, useDecisionBatch } from '@/components/DecisionGateChips';
import type { RankComponents, RankRow, RankUniverseResponse } from '@/lib/types';
import { fmtDate, fmtDateTime, plain } from '@/lib/format';
import {
  Button,
  Card,
  CardSkeleton,
  Chip,
  DataTable,
  type DataTableColumn,
  EmptyState,
  ErrorState,
  InfoTip,
  SearchInput,
  SectionTitle,
  TableSkeleton,
  ViewHero,
} from '@/components/ui';
import { RankMedallion } from '@/components/leaders/RankMedallion';

/* ------------------------------------------------------------------ */
/* Decile-gradient percentile encoding                                 */
/* Diverging ramp on the status accents: sell pole (weak) → slate      */
/* neutral mid → buy pole (strong); intensity encodes distance from    */
/* the median. The numeral is always printed, so color is never the    */
/* only encoding.                                                      */
/* ------------------------------------------------------------------ */

const DECILE_BADGE: string[] = [
  'border-sell/50 bg-sell/20 text-sell', // 0–9
  'border-sell/40 bg-sell/12 text-sell', // 10–19
  'border-sell/30 bg-sell/8 text-sell/90', // 20–29
  'border-sell/20 bg-sell/5 text-sell/75', // 30–39
  'border-white/10 bg-white/5 text-slate-400', // 40–49
  'border-white/12 bg-white/6 text-slate-300', // 50–59
  'border-buy/20 bg-buy/5 text-buy/75', // 60–69
  'border-buy/30 bg-buy/8 text-buy/90', // 70–79
  'border-buy/40 bg-buy/12 text-buy', // 80–89
  'border-buy/50 bg-buy/20 text-buy shadow-[0_0_14px_rgba(0,212,170,0.28)]', // 90–100
];

const DECILE_FILL: string[] = [
  'bg-sell/80',
  'bg-sell/60',
  'bg-sell/45',
  'bg-sell/30',
  'bg-slate-500/50',
  'bg-slate-400/60',
  'bg-buy/30',
  'bg-buy/45',
  'bg-buy/60',
  'bg-buy/80',
];

function decileOf(percentile: number): number {
  const p = Math.max(0, Math.min(100, percentile));
  return Math.min(9, Math.floor(p / 10));
}

function PercentileBadge({ percentile }: { percentile: number }) {
  const p = Math.max(0, Math.min(100, percentile));
  const decile = decileOf(p);
  return (
    <span
      title={`Rank percentile ${plain(p, 0)} of 100 — decile ${decile + 1} of the universe`}
      className={clsx(
        'font-display inline-flex min-w-11 items-center justify-center rounded-lg border px-2 py-1 text-sm font-bold tabular-nums',
        DECILE_BADGE[decile],
      )}
    >
      {Math.round(p)}
    </span>
  );
}

/** Decile-colored strength bar — decorative; the badge numeral carries the value. */
function DecileBar({ percentile }: { percentile: number }) {
  const p = Math.max(0, Math.min(100, percentile));
  return (
    <span aria-hidden className="relative hidden h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-white/6 sm:inline-block">
      <span
        className={clsx('absolute inset-y-0 left-0 rounded-full', DECILE_FILL[decileOf(p)])}
        style={{ width: `${p}%` }}
      />
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Component chips + data-status dots                                  */
/* ------------------------------------------------------------------ */

const COMPONENT_META: Array<{ key: keyof RankComponents; short: string; name: string; weight: string }> = [
  { key: 'momentum', short: 'M', name: 'Momentum 60d', weight: '×0.5' },
  { key: 'quality', short: 'Q', name: 'Quality (stored intelligence → quoteSummary fallback)', weight: '×0.3' },
  { key: 'sentiment', short: 'S', name: 'News sentiment (decay-weighted)', weight: '×0.2' },
];

/** 'ok' | 'fallback' | 'no-data' — tolerant to unknown labels and both backend shapes. */
function componentStatusOf(row: RankRow, key: keyof RankComponents): string {
  const cs = row.componentStatus;
  if (cs != null && typeof cs === 'object') {
    const v = cs[key];
    if (typeof v === 'string' && v) return v;
  } else if (typeof cs === 'string' && cs && key === 'sentiment') {
    // Spec R1: a bare string status refers to the sentiment cache ('no-data' when no NewsSummary).
    return cs;
  }
  return row.components?.[key] == null ? 'no-data' : 'ok';
}

function statusDotClass(status: string): string {
  const s = status.toLowerCase();
  if (s.includes('intelligence')) return 'bg-violet-400'; // V10 — stored Intelligence Engine metrics
  if (s === 'ok' || s === 'measured' || s === 'live') return 'bg-buy';
  if (s.includes('fallback') || s.includes('partial') || s.includes('proxy') || s.includes('quotesummary'))
    return 'bg-amber-400';
  if (s.includes('no-data') || s.includes('no_data') || s.includes('missing') || s.includes('none'))
    return 'bg-slate-600';
  return 'bg-slate-500';
}

function zLabel(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : '−'}${plain(Math.abs(v), 1)}σ`;
}

/* ------------------------------------------------------------------ */
/* V10 B1 — quality-source chip (intelligence / quoteSummary / none)   */
/* ------------------------------------------------------------------ */

type QualitySourceKind = 'intelligence' | 'fallback' | 'none';

/**
 * Classify where a row's quality z actually came from. V10 backends label the
 * quality componentStatus 'intelligence (n inputs)' | 'quoteSummary fallback'
 * | 'no-data'; V8 backends say 'ok' with qualitySource 'roe'/'operating-margin'
 * (which IS the quoteSummary fallback) — both shapes classify honestly.
 */
function qualitySourceInfo(row: RankRow): { kind: QualitySourceKind; label: string; title: string } {
  const status = componentStatusOf(row, 'quality');
  const combined = `${status} ${row.qualitySource ?? ''}`;
  const s = combined.toLowerCase();
  if (s.includes('intelligence')) {
    const inputs = /\((\d+)\s*inputs?\)/i.exec(combined)?.[1] ?? null;
    return {
      kind: 'intelligence',
      label: inputs ? `intelligence · ${inputs} inputs` : 'intelligence',
      title:
        'Quality pillar from STORED Intelligence Engine metrics (NSE XBRL filings — ROIC, FCF, current ratio, PEG), weights renormalized over the inputs available for this ticker. Kept fresh by a rotating nightly refresh — never a live bulk NSE fetch.',
    };
  }
  if (s.includes('no-data') || s.includes('no_data')) {
    return {
      kind: 'none',
      label: 'no quality data',
      title: 'No quality input available for this ticker — its quality z contributes 0 to the composite.',
    };
  }
  return {
    kind: 'fallback',
    label: row.qualitySource ? `quoteSummary · ${row.qualitySource}` : 'quoteSummary fallback',
    title:
      'Quality from the Yahoo quoteSummary fallback (ROE, else operating margin) — no stored Intelligence metrics for this ticker yet. The rotating nightly refresh builds intelligence coverage over ~3 weeks.',
  };
}

const QUALITY_SOURCE_CLASS: Record<QualitySourceKind, string> = {
  intelligence: 'border-violet-400/30 bg-violet-400/10 text-violet-300',
  fallback: 'border-amber-400/20 bg-amber-400/5 text-amber-300/80',
  none: 'border-white/8 bg-white/3 text-slate-600',
};

/** Small labeled provenance chip: which source fed the quality pillar for this row. */
function QualitySourceChip({ row }: { row: RankRow }) {
  const meta = qualitySourceInfo(row);
  return (
    <span
      title={meta.title}
      className={clsx(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] whitespace-nowrap',
        QUALITY_SOURCE_CLASS[meta.kind],
      )}
    >
      {meta.kind === 'intelligence' && <BrainCircuit className="h-3 w-3 shrink-0" aria-hidden />}
      {meta.label}
    </span>
  );
}

function ComponentChips({ row }: { row: RankRow }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {COMPONENT_META.map(({ key, short, name, weight }) => {
        const value = row.components?.[key] ?? null;
        const status = componentStatusOf(row, key);
        const source = key === 'quality' && row.qualitySource ? ` · source: ${row.qualitySource}` : '';
        return (
          <span
            key={key}
            title={`${name} ${weight} — z ${zLabel(value)} · status: ${status}${source}`}
            className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/4 px-2 py-0.5 text-[11px] text-slate-300 tabular-nums"
          >
            <span aria-hidden className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', statusDotClass(status))} />
            <span className="font-semibold text-slate-400">{short}</span>
            <span className={value == null ? 'text-slate-600' : undefined}>{zLabel(value)}</span>
          </span>
        );
      })}
      <QualitySourceChip row={row} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Expanded row — z-score breakdown bars (data already in the row;     */
/* no extra fetch) + quality provenance in full                        */
/* ------------------------------------------------------------------ */

/** Diverging z bar centered at 0, spanning the backend's ±3σ clamp. Decorative — the σ value is printed. */
function ZBar({ value }: { value: number | null | undefined }) {
  if (value == null || !Number.isFinite(value)) {
    return <p className="text-xs text-slate-600">no data — contributes 0 to the composite</p>;
  }
  const v = Math.max(-3, Math.min(3, value));
  const w = (Math.abs(v) / 3) * 50;
  return (
    <span aria-hidden className="relative block h-2 w-full max-w-44 overflow-hidden rounded-full bg-white/6">
      <span className="absolute inset-y-0 left-1/2 w-px bg-white/25" />
      <span
        className={clsx('absolute inset-y-0 rounded-full', v >= 0 ? 'left-1/2 bg-buy/70' : 'right-1/2 bg-sell/70')}
        style={{ width: `${w}%` }}
      />
    </span>
  );
}

function leaderGateKey(ticker: string): string {
  const t = ticker.trim().toUpperCase();
  return /\.(NS|BO)$/.test(t) ? t : `${t}.NS`;
}

function ExpandedBreakdown({ row, onAnalyze, gate }: { row: RankRow; onAnalyze: (ticker: string) => void; gate?: import('@/lib/api').DecisionBatchEntry }) {
  const quality = qualitySourceInfo(row);
  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:gap-8">
      <div className="min-w-0 flex-1">
        <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-3">
          {COMPONENT_META.map(({ key, name, weight }) => {
            const value = row.components?.[key] ?? null;
            const status = componentStatusOf(row, key);
            return (
              <div key={key} className="min-w-0">
                <p className="flex items-center gap-1.5 text-[11px] font-medium tracking-[0.08em] text-slate-500 uppercase">
                  <span aria-hidden className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', statusDotClass(status))} />
                  {name.split(' (')[0]} {weight}
                </p>
                <p className="font-display mt-1 text-lg font-semibold text-slate-100 tabular-nums">{zLabel(value)}</p>
                <ZBar value={value} />
                <p className="mt-1 text-[11px] text-slate-500">status: {status}</p>
              </div>
            );
          })}
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-slate-600">
          Cross-sectional z-scores (σ vs today&apos;s universe), clamped ±3 — each bar spans −3σ … +3σ around the
          universe median. Relative strength only, not a direction forecast.
        </p>
      </div>
      <div className="space-y-2 text-xs leading-relaxed text-slate-400 lg:w-80 lg:shrink-0">
        <QualitySourceChip row={row} />
        <p>{quality.title}</p>
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-slate-600">
          Published gate
          <DecisionGateChips entry={gate} />
        </div>
        <Button variant="secondary" size="sm" onClick={() => onAnalyze(row.ticker)}>
          Full analysis
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* V10 B1 — intelligence coverage (counted from the rows themselves,   */
/* preferring an explicit backend count/note when one ships)           */
/* ------------------------------------------------------------------ */

interface CoverageInfo {
  covered: number;
  /** Dedicated backend coverage note, rendered verbatim when present. */
  text: string | null;
  /** True when the backend shipped any explicit V10 coverage signal. */
  explicit: boolean;
}

function readCoverage(data: RankUniverseResponse, intelRowCount: number): CoverageInfo {
  const raw = data.intelligenceCoverage ?? data.coverage ?? null;
  let covered = intelRowCount;
  let text = data.intelligenceNote ?? null;
  let explicit = data.intelligenceNote != null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    covered = raw;
    explicit = true;
  } else if (typeof raw === 'string' && raw) {
    text = text ?? raw;
    explicit = true;
  } else if (raw != null && typeof raw === 'object') {
    const n = raw.covered ?? raw.count ?? raw.tickers;
    if (n != null && Number.isFinite(n)) covered = n;
    text = text ?? raw.note ?? null;
    explicit = true;
  }
  return { covered, text, explicit };
}

/* ------------------------------------------------------------------ */
/* IC panel — measured or the honest collecting note, never simulated  */
/* ------------------------------------------------------------------ */

const IC_TIP =
  'Spearman rank correlation between the composite rank and the realized forward 30-day return. It is only computed from snapshots logged BEFORE their outcomes matured — never backfilled from ranks computed today (that would be lookahead).';

function ICPanel({ ic, note }: { ic: { value: number; samples: number; since?: string | null } | null; note?: string | null }) {
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionTitle>
          <span className="inline-flex flex-wrap items-center gap-1">
            <span>Rank IC — measured, never simulated</span>
            <InfoTip label="What is the rank IC?" text={IC_TIP} />
          </span>
        </SectionTitle>
        <Chip tone={ic == null ? 'zinc' : ic.value >= 0.03 ? 'buy' : ic.value > 0 ? 'cyan' : 'sell'} glow={ic != null}>
          {ic == null ? 'collecting snapshots' : 'measured'}
        </Chip>
      </div>

      {ic != null ? (
        <div className="mt-3 flex flex-wrap items-end gap-x-8 gap-y-3">
          <div>
            <p className="text-[11px] font-medium tracking-[0.08em] text-slate-500 uppercase">Spearman IC (fwd 30d)</p>
            <p
              className={clsx(
                'font-display mt-1 text-4xl font-semibold tracking-tight tabular-nums',
                ic.value > 0 ? 'text-buy' : ic.value < 0 ? 'text-sell' : 'text-slate-200',
              )}
            >
              {ic.value >= 0 ? '+' : '−'}
              {plain(Math.abs(ic.value), 3)}
            </p>
          </div>
          <div className="pb-1 text-xs leading-relaxed text-slate-400">
            <p>
              <span className="font-semibold text-slate-200 tabular-nums">{plain(ic.samples, 0)}</span> matured
              rank-vs-outcome samples{ic.since ? <> · snapshots since {fmtDate(ic.since)}</> : null}
            </p>
            <p className="mt-0.5 text-slate-500">
              Cross-sectional ICs are small even when real (good desks live on 0.02–0.10); sign and stability matter
              more than size.
            </p>
          </div>
        </div>
      ) : (
        <p className="mt-3 text-sm leading-relaxed text-slate-400">
          {note ||
            'IC unlocks after ~20 daily snapshots with matured 30-day forwards (~7 weeks of collection). Until then this panel stays honestly empty — ranks must be logged before their outcomes, never reconstructed after.'}
        </p>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Ranking table columns                                               */
/* ------------------------------------------------------------------ */

/** RankRow + its stable universe rank (1 = strongest by percentile), assigned before search filtering. */
type RankedRow = RankRow & { rank: number };

const COLUMNS: Array<DataTableColumn<RankedRow>> = [
  {
    id: 'rank',
    header: '#',
    numeric: true,
    sortValue: (r) => r.rank,
    cell: (r) =>
      r.rank <= 3 ? (
        <RankMedallion rank={r.rank} size="sm" />
      ) : (
        <span className="text-slate-500 tabular-nums">{r.rank}</span>
      ),
    cellClassName: 'w-14',
  },
  {
    id: 'stock',
    header: 'Stock',
    sortValue: (r) => r.name,
    cell: (r) => (
      <div className="min-w-36">
        <p className="font-medium text-slate-100">{r.name}</p>
        <p className="text-xs text-slate-500">{r.ticker}</p>
      </div>
    ),
  },
  {
    id: 'sector',
    header: 'Sector',
    sortValue: (r) => r.sector || null,
    cell: (r) => <span className="whitespace-nowrap text-slate-300">{r.sector || '—'}</span>,
  },
  {
    id: 'percentile',
    header: 'Percentile',
    numeric: true,
    sortValue: (r) => r.percentile,
    cell: (r) => (
      <span className="inline-flex items-center justify-end gap-2.5">
        <DecileBar percentile={r.percentile} />
        <PercentileBadge percentile={r.percentile} />
      </span>
    ),
  },
  {
    id: 'composite',
    header: 'Composite',
    numeric: true,
    sortValue: (r) => r.composite,
    cell: (r) => (
      <span className={clsx('tabular-nums', r.composite > 0 ? 'text-buy' : r.composite < 0 ? 'text-sell' : 'text-slate-400')}>
        {r.composite >= 0 ? '+' : '−'}
        {plain(Math.abs(r.composite), 2)}
      </span>
    ),
  },
  {
    id: 'components',
    header: 'Components (z · status)',
    cell: (r) => <ComponentChips row={r} />,
  },
];

/* ------------------------------------------------------------------ */
/* View                                                                */
/* ------------------------------------------------------------------ */

const METHODOLOGY =
  'Composite = z(momentum 60d) × 0.5 + z(quality) × 0.3 + z(news sentiment, decayed) × 0.2 — z-scored across the whole universe daily, clamped ±3. This ranks stocks against each other; it is not a direction forecast (V7 measured no direction edge).';

const SCROLL_TOP_THRESHOLD = 320;

export function LeadersView({ onAnalyze }: { onAnalyze: (ticker: string) => void }) {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ['rank-universe'],
    queryFn: getRankUniverse,
    staleTime: 5 * 60_000,
    retry: (failureCount, err) => !(err instanceof ApiError && err.status === 404) && failureCount < 2,
  });

  // Phase 14: published-gate summaries for expanded rows (one batched read).
  const leaderTickers = useMemo(
    () => Array.from(new Set(((data?.rows ?? []) as RankRow[]).map((r) => leaderGateKey(r.ticker)))),
    [data],
  );
  const gateBatch = useDecisionBatch(leaderTickers);
  const decisions = gateBatch.data?.decisions ?? {};

  const [q, setQ] = useState('');

  // Stable universe ranks (by percentile desc) assigned BEFORE search filtering,
  // so a filtered or re-sorted view still shows each stock's true rank.
  const ranked = useMemo<RankedRow[]>(() => {
    return (data?.rows ?? [])
      .slice()
      .sort((a, b) => b.percentile - a.percentile || b.composite - a.composite || a.ticker.localeCompare(b.ticker))
      .map((r, i) => ({ ...r, rank: i + 1 }));
  }, [data]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return ranked;
    return ranked.filter(
      (r) =>
        r.name.toLowerCase().includes(needle) ||
        r.ticker.toLowerCase().includes(needle) ||
        (r.sector || '').toLowerCase().includes(needle),
    );
  }, [ranked, q]);

  const total = data?.rows.length ?? 0;
  const is404 = isError && error instanceof ApiError && error.status === 404;

  // V10 B1 — rows whose quality pillar came from stored Intelligence metrics.
  const intelRowCount = useMemo(
    () => (data?.rows ?? []).filter((r) => qualitySourceInfo(r).kind === 'intelligence').length,
    [data],
  );
  const coverage = data ? readCoverage(data, intelRowCount) : null;
  // Show the coverage note only when the backend actually signals V10 (rows or fields) — never on an older backend.
  const showCoverage = coverage != null && (coverage.explicit || intelRowCount > 0);

  /* Scroll-to-top — watches both the window and the table's own scroll container. */
  const tableWrapRef = useRef<HTMLDivElement>(null);
  const [showTop, setShowTop] = useState(false);
  const hasData = data != null;

  useEffect(() => {
    if (!hasData) return;
    const scroller = tableWrapRef.current?.querySelector<HTMLElement>('.thin-scroll') ?? null;
    const update = () =>
      setShowTop(window.scrollY > SCROLL_TOP_THRESHOLD || (scroller?.scrollTop ?? 0) > SCROLL_TOP_THRESHOLD);
    update();
    window.addEventListener('scroll', update, { passive: true });
    scroller?.addEventListener('scroll', update, { passive: true });
    return () => {
      window.removeEventListener('scroll', update);
      scroller?.removeEventListener('scroll', update);
    };
  }, [hasData]);

  const backToTop = () => {
    const behavior: ScrollBehavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 'auto'
      : 'smooth';
    tableWrapRef.current?.querySelector<HTMLElement>('.thin-scroll')?.scrollTo({ top: 0, behavior });
    window.scrollTo({ top: 0, behavior });
  };

  return (
    <div className="space-y-5">
      <ViewHero
        className="view-hero-subsection"
        eyebrow="Cross-sectional rank"
        title="Relative Leaders"
        subtitle="Who is strongest versus the rest of the universe right now — a cross-sectional rank, not a market-direction promise."
        visual={false}
        right={
          data ? (
            <>
              <Chip tone="cyan" glow>
                <Trophy className="h-3.5 w-3.5" aria-hidden />
                {plain(total, 0)} ranked
              </Chip>
              {showCoverage && coverage && (
                <Chip
                  tone="violet"
                  glow={coverage.covered > 0}
                  title="Rows whose quality pillar uses STORED Intelligence Engine metrics (NSE XBRL) instead of the quoteSummary fallback."
                >
                  <BrainCircuit className="h-3.5 w-3.5" aria-hidden />
                  intelligence {plain(coverage.covered, 0)}/{plain(total, 0)}
                </Chip>
              )}
              <Chip tone="zinc">as of {fmtDateTime(data.asOf)}</Chip>
            </>
          ) : undefined
        }
      />

      {isPending && (
        <div className="space-y-4">
          <CardSkeleton lines={2} />
          <Card className="p-5">
            <TableSkeleton rows={9} cols={5} />
          </Card>
        </div>
      )}

      {is404 && (
        <Card className="p-8">
          <EmptyState
            glyph="radar"
            title="The rank engine isn't live on this backend yet"
            message="This tab lights up when GET /api/rank/universe ships (V8 RankEngine). Nothing is simulated in the meantime."
          />
        </Card>
      )}

      {isError && !is404 && (
        <ErrorState
          message={error instanceof Error ? error.message : 'Failed to load the ranked universe'}
          onRetry={() => refetch()}
        />
      )}

      {data && (
        <>
          <ICPanel ic={data.ic} note={data.note} />

          <div className="flex flex-wrap items-center gap-3">
            <SearchInput
              aria-label="Filter leaders by name, ticker or sector"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onClear={() => setQ('')}
              placeholder="Filter by name, ticker or sector"
              wrapClassName="w-full max-w-xs"
            />
            <span className="text-xs text-slate-500 tabular-nums">
              {plain(rows.length, 0)} of {plain(total, 0)} stocks
            </span>
            <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-buy" /> measured
              </span>
              {showCoverage && (
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-violet-400" /> intelligence
                </span>
              )}
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-400" /> fallback
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-slate-600" /> no data
              </span>
            </span>
          </div>

          {/* V10 B1 — honest intelligence-coverage note (hidden on pre-V10 backends) */}
          {showCoverage && coverage && (
            <p className="flex items-start gap-2 rounded-lg border border-violet-400/20 bg-violet-400/5 px-3.5 py-2.5 text-xs leading-relaxed text-slate-300">
              <BrainCircuit className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-300" aria-hidden />
              <span>
                Quality pillar from stored Intelligence Engine metrics for{' '}
                <span className="font-semibold text-violet-300 tabular-nums">{plain(coverage.covered, 0)}</span> of{' '}
                <span className="tabular-nums">{plain(total, 0)}</span> ranked stocks — the rest use the quoteSummary
                fallback (ROE / op-margin).{' '}
                {coverage.text ??
                  'A rotating nightly job refreshes the 10 stalest tickers (stored metrics only, never a bulk NSE fetch), so full-universe coverage builds over roughly 3 weeks.'}
              </span>
            </p>
          )}

          <Card className="overflow-hidden">
            <div ref={tableWrapRef}>
              <DataTable
                ariaLabel="Ranked universe — cross-sectional composite"
                columns={COLUMNS}
                rows={rows}
                rowKey={(r) => r.ticker}
                initialSort={{ id: 'rank', dir: 'asc' }}
                onRowClick={(r) => onAnalyze(r.ticker)}
                renderExpanded={(r) => <ExpandedBreakdown row={r} onAnalyze={onAnalyze} gate={decisions[leaderGateKey(r.ticker)]} />}
                expandLabel="Component breakdown"
                maxHeight="40rem"
                empty={<EmptyState glyph="slash" title="No stocks match the current filter" />}
              />
            </div>
          </Card>

          <p className="px-1 text-xs leading-relaxed text-slate-500">{data.methodology || METHODOLOGY}</p>
        </>
      )}

      {showTop && (
        <button
          type="button"
          aria-label="Back to top"
          onClick={backToTop}
          className="glass animate-fade-in fixed right-5 bottom-24 z-40 flex h-11 w-11 items-center justify-center rounded-full text-slate-300 transition-colors hover:text-cyan-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
        >
          <ArrowUp className="h-4 w-4" aria-hidden />
        </button>
      )}
    </div>
  );
}
