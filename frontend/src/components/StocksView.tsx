'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowUpRight } from 'lucide-react';
import { getStocks } from '@/lib/api';
import { DecisionGateChips, useDecisionBatch } from '@/components/DecisionGateChips';
import type { EntryAction, Recommendation, UniverseStockRow } from '@/lib/types';
import { fmtDateTime, inr, plain, signedPct } from '@/lib/format';
import {
  Button,
  Card,
  Chip,
  DataTable,
  type DataTableColumn,
  EmptyState,
  ENTRY_META,
  EntryChip,
  ErrorState,
  RecBadge,
  RiskChip,
  ScoreBar,
  SearchInput,
  Select,
  type SelectOption,
  TableSkeleton,
  ViewHero,
} from '@/components/ui';

/** Signed-value ink on the semantic status accents (token migration of signClass). */
const signTone = (v: number) => (v > 0 ? 'text-buy' : v < 0 ? 'text-sell' : 'text-slate-400');

/** Sort orders: best-first under ascending sort. */
const ENTRY_ORDER: Record<EntryAction, number> = { TIMING_OK: 0, WAIT: 1, AVOID_ENTRY: 2 };
const REC_ORDER: Record<Recommendation, number> = { BUY: 0, HOLD: 1, AVOID: 2 };

function Dash() {
  return <span className="text-slate-600">—</span>;
}

function Fact({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="glass-inset px-3 py-2.5">
      <p className="text-[11px] text-slate-500">{label}</p>
      <div className="mt-1 text-sm font-semibold text-slate-100 tabular-nums">{value}</div>
      {sub != null && <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{sub}</p>}
    </div>
  );
}

/**
 * Expanded quick-stats row — built ONLY from data already in the scan row
 * (no extra calls). The full, live analysis stays one row-click away.
 */
function RowDetails({ s, onAnalyze }: { s: UniverseStockRow; onAnalyze: (ticker: string) => void }) {
  const scanned = s.score != null || s.recommendation != null || s.entryAction != null || s.riskLevel != null;
  return (
    <div className="py-1">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="font-display text-sm font-semibold tracking-tight text-slate-100">{s.name}</span>
          <Chip tone="zinc">{s.ticker}</Chip>
          {s.sector ? <Chip tone="zinc">{s.sector}</Chip> : null}
        </div>
        <Button variant="secondary" size="sm" onClick={() => onAnalyze(s.ticker)}>
          Full analysis
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>

      {scanned ? (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
          <Fact
            label="Last price"
            value={s.price != null ? inr(s.price) : <Dash />}
            sub={
              s.changePercent != null ? (
                <span className={clsx('font-medium tabular-nums', signTone(s.changePercent))}>
                  {signedPct(s.changePercent)} today
                </span>
              ) : undefined
            }
          />
          <Fact
            label="Quant score"
            value={
              s.score != null ? (
                <ScoreBar score={s.score} rec={s.recommendation ?? 'HOLD'} className="mt-0.5 min-w-28" />
              ) : (
                <Dash />
              )
            }
          />
          <Fact label="Recommendation" value={s.recommendation ? <RecBadge rec={s.recommendation} /> : <Dash />} />
          <Fact
            label="Entry timing"
            value={s.entryAction ? <EntryChip action={s.entryAction} /> : <Dash />}
            sub={s.entryAction ? `${ENTRY_META[s.entryAction].label} — technical lean, not a guarantee` : undefined}
          />
          <Fact label="Risk" value={s.riskLevel ? <RiskChip risk={s.riskLevel} /> : <Dash />} />
          <Fact label="Last scanned" value={s.analyzedAt ? fmtDateTime(s.analyzedAt) : <Dash />} />
        </div>
      ) : (
        <p className="glass-inset mt-3 px-3 py-2.5 text-xs leading-relaxed text-slate-400">
          Not scanned yet — no score, recommendation or entry read exists for this stock. Open the full analysis to
          run one against live data.
        </p>
      )}

      <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
        Quick stats come from the engine&apos;s last scan{s.analyzedAt ? ` (${fmtDateTime(s.analyzedAt)})` : ''} — the
        full analysis re-checks live data and carries its 80% ranges and measured accuracy.
      </p>
    </div>
  );
}

/** Universe rows use bare symbols; snapshots key by the Yahoo ticker. */
function normalizeNs(ticker: string): string {
  const t = ticker.trim().toUpperCase();
  return /\.(NS|BO)$/.test(t) ? t : `${t}.NS`;
}

export function StocksView({ onAnalyze }: { onAnalyze: (ticker: string) => void }) {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ['stocks'],
    queryFn: getStocks,
    staleTime: 5 * 60_000,
  });

  const [q, setQ] = useState('');
  const [sector, setSector] = useState('all');

  const sectors = useMemo(() => {
    const set = new Set((data ?? []).map((s) => s.sector).filter(Boolean));
    return Array.from(set).sort();
  }, [data]);

  const sectorOptions = useMemo<SelectOption[]>(
    () => [{ value: 'all', label: 'All sectors' }, ...sectors.map((s) => ({ value: s, label: s }))],
    [sectors],
  );

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data ?? []).filter((s) => {
      if (sector !== 'all' && s.sector !== sector) return false;
      if (!needle) return true;
      return s.name.toLowerCase().includes(needle) || s.ticker.toLowerCase().includes(needle);
    });
  }, [data, q, sector]);

  const scannedCount = useMemo(() => (data ?? []).filter((s) => s.score != null).length, [data]);

  // Phase 14: published-gate chips per row (absent = honestly "not published").
  const allTickers = useMemo(() => (data ?? []).map((s) => s.ticker), [data]);
  const batch = useDecisionBatch(allTickers);
  const decisions = useMemo(() => batch.data?.decisions ?? {}, [batch.data?.decisions]);

  const columns = useMemo<Array<DataTableColumn<UniverseStockRow>>>(
    () => [
      {
        id: 'stock',
        header: 'Stock',
        sortValue: (s) => s.name,
        cell: (s) => (
          <div className="min-w-40">
            <p className="font-medium text-slate-100">{s.name}</p>
            <p className="text-xs text-slate-500">{s.ticker}</p>
          </div>
        ),
      },
      {
        id: 'sector',
        header: 'Sector',
        sortValue: (s) => s.sector || null,
        cell: (s) => <span className="whitespace-nowrap text-slate-300">{s.sector || '—'}</span>,
      },
      {
        id: 'price',
        header: 'Last price',
        numeric: true,
        sortValue: (s) => s.price,
        cell: (s) => (s.price != null ? <span className="whitespace-nowrap text-slate-100">{inr(s.price)}</span> : <Dash />),
      },
      {
        id: 'change',
        header: '1D %',
        numeric: true,
        sortValue: (s) => s.changePercent,
        cell: (s) =>
          s.changePercent != null ? (
            <span className={clsx('whitespace-nowrap font-medium', signTone(s.changePercent))}>
              {signedPct(s.changePercent)}
            </span>
          ) : (
            <Dash />
          ),
      },
      {
        id: 'score',
        header: 'Score',
        sortValue: (s) => s.score,
        cell: (s) =>
          s.score != null ? <ScoreBar score={s.score} rec={s.recommendation ?? 'HOLD'} className="w-36" /> : <Dash />,
      },
      {
        id: 'entry',
        header: 'Entry',
        sortValue: (s) => (s.entryAction ? ENTRY_ORDER[s.entryAction] : null),
        cell: (s) => (s.entryAction ? <EntryChip action={s.entryAction} /> : <Dash />),
      },
      {
        id: 'rec',
        header: 'Recommendation',
        sortValue: (s) => (s.recommendation ? REC_ORDER[s.recommendation] : null),
        cell: (s) => (s.recommendation ? <RecBadge rec={s.recommendation} /> : <Dash />),
      },
      {
        id: 'gate',
        header: 'Published gate',
        sortValue: (s) => {
          const d = decisions[normalizeNs(s.ticker)];
          return d ? d.decisionStatus : null;
        },
        cell: (s) => <DecisionGateChips entry={decisions[normalizeNs(s.ticker)]} />,
      },
    ],
    [decisions],
  );

  const hero = (chips?: React.ReactNode) => (
    <ViewHero
      className="view-hero-subsection"
      eyebrow="Universe"
      title="Stocks"
      subtitle="The full NSE universe this engine scans — filter and sort it, expand a row for its quick stats, or tap the row for the complete live analysis."
      visual={false}
      right={chips}
    />
  );

  if (isPending) {
    return (
      <div className="space-y-5">
        {hero()}
        <Card className="p-5">
          <TableSkeleton rows={10} cols={6} />
        </Card>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <ErrorState
        message={error instanceof Error ? error.message : 'Failed to load the stock universe'}
        onRetry={() => refetch()}
      />
    );
  }

  const filtersActive = q.trim().length > 0 || sector !== 'all';

  return (
    <div className="space-y-5">
      {hero(
        <>
          <Chip tone="cyan" glow>
            universe: {plain(data.length, 0)} stocks
          </Chip>
          <Chip tone="zinc" title="Rows with a stored score from the engine's last scan — the rest show NOT AVAILABLE dashes until scanned.">
            scanned: {plain(scannedCount, 0)} of {plain(data.length, 0)}
          </Chip>
        </>,
      )}

      <div className="flex flex-wrap items-center gap-3">
        <SearchInput
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onClear={() => setQ('')}
          placeholder="Filter by name or ticker"
          aria-label="Filter by name or ticker"
          wrapClassName="w-full max-w-xs"
        />
        <Select
          options={sectorOptions}
          value={sector}
          onChange={setSector}
          ariaLabel="Filter by sector"
          className="w-52"
        />
        <span className="text-xs text-slate-500 tabular-nums">
          {plain(filtered.length, 0)} of {plain(data.length, 0)} stocks
        </span>
      </div>

      <Card className="overflow-hidden">
        <DataTable
          ariaLabel="NSE universe scan"
          columns={columns}
          rows={filtered}
          rowKey={(s) => s.ticker}
          initialSort={{ id: 'score', dir: 'desc' }}
          onRowClick={(s) => onAnalyze(s.ticker)}
          renderExpanded={(s) => <RowDetails s={s} onAnalyze={onAnalyze} />}
          expandLabel="Quick stats"
          maxHeight="40rem"
          empty={
            <EmptyState
              glyph="slash"
              className="mx-4 my-2"
              title="No stocks match the current filters"
              message={
                filtersActive
                  ? 'Nothing in the universe matches this search and sector combination.'
                  : 'The universe list came back empty.'
              }
            >
              {filtersActive && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2"
                  onClick={() => {
                    setQ('');
                    setSector('all');
                  }}
                >
                  Clear filters
                </Button>
              )}
            </EmptyState>
          }
        />
      </Card>

      <p className="px-1 text-[11px] leading-relaxed text-slate-500">
        Score bars are colored by the scan&apos;s recommendation (BUY teal · HOLD amber · AVOID red) with the score
        printed beside them. Dashes mean the engine has no stored value — never a fabricated zero.
      </p>
    </div>
  );
}
