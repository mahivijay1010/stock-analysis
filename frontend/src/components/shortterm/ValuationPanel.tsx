'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronDown, Coins, Search, ShieldAlert, ShieldCheck } from 'lucide-react';
import { getValuation, ValuationRow } from '@/lib/api';
import { Button, Card, Chip, ErrorState, SearchInput, Skeleton } from '@/components/ui';

// Descriptive fundamentals: valuation never grants entry authority.
const VERDICT_META: Record<string, { label: string; tone: 'emerald' | 'amber' | 'rose' | 'zinc' }> =
  {
    UNDERVALUED_QUALITY: { label: 'Undervalued + quality', tone: 'emerald' },
    CHEAP_BUT_RISKY: { label: 'Cheap but risky', tone: 'amber' },
    FAIR: { label: 'Fairly valued', tone: 'zinc' },
    EXPENSIVE: { label: 'Expensive', tone: 'zinc' },
    VALUE_TRAP: { label: 'Value trap', tone: 'rose' },
  };
const GROUPS = [
  { id: 'quality', label: 'Undervalued + quality', verdicts: ['UNDERVALUED_QUALITY'] },
  { id: 'risky', label: 'Cheap but risky', verdicts: ['CHEAP_BUT_RISKY'] },
  { id: 'fair', label: 'Fair / expensive', verdicts: ['FAIR', 'EXPENSIVE'] },
  { id: 'trap', label: 'Value traps', verdicts: ['VALUE_TRAP'] },
] as const;
const pct = (n: number | null) => (n == null ? '—' : `${n > 0 ? '+' : ''}${Math.round(n)}%`);
const multiple = (n: number | null) => (n == null ? '—' : `${n.toFixed(1)}×`);

function ValRow({ v }: { v: ValuationRow }) {
  const [open, setOpen] = useState(false);
  const meta = VERDICT_META[v.verdict] ?? { label: v.verdict, tone: 'zinc' as const };
  return (
    <>
      <tr className={clsx('valuation-table-row', v.isValueTrap && 'valuation-row-trap')}>
        <th scope="row">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls={`valuation-detail-${v.symbol}`}
            className="valuation-stock-toggle"
          >
            <span className="valuation-stock-mark" aria-hidden>
              {v.symbol.slice(0, 2)}
            </span>
            <span>
              {v.symbol}
              <small>
                {v.price != null
                  ? `₹${v.price.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
                  : 'Price unavailable'}
              </small>
            </span>
          </button>
        </th>
        <td>
          <Chip tone={meta.tone}>{meta.label}</Chip>
        </td>
        <td
          className={clsx(
            'valuation-number',
            (v.dcfMarginOfSafetyPct ?? 0) > 0 && 'radar-value-positive',
          )}
        >
          {pct(v.dcfMarginOfSafetyPct)}
        </td>
        <td className="valuation-number">{v.roce != null ? `${Math.round(v.roce)}%` : '—'}</td>
        <td className="valuation-number">{multiple(v.pe)}</td>
        <td>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-label={`${open ? 'Hide' : 'Show'} ${v.symbol} fundamentals`}
            aria-expanded={open}
            aria-controls={`valuation-detail-${v.symbol}`}
            className="radar-row-expand"
          >
            <ChevronDown className={clsx(open && 'rotate-180')} aria-hidden />
          </button>
        </td>
      </tr>
      {open && (
        <tr id={`valuation-detail-${v.symbol}`}>
          <td colSpan={6} className="valuation-detail-cell">
            <dl className="valuation-detail-metrics">
              <div>
                <dt>Price / book</dt>
                <dd>{multiple(v.pb)}</dd>
              </div>
              <div>
                <dt>Return on equity</dt>
                <dd>{v.roe != null ? `${Math.round(v.roe)}%` : '—'}</dd>
              </div>
              <div>
                <dt>Debt / equity</dt>
                <dd>{multiple(v.deRatio)}</dd>
              </div>
              <div>
                <dt>Promoter holding</dt>
                <dd>{v.promoterHolding != null ? `${Math.round(v.promoterHolding)}%` : '—'}</dd>
              </div>
              <div>
                <dt>Holding change, QoQ</dt>
                <dd className={clsx((v.promoterChangeQoq ?? 0) < 0 && 'radar-value-negative')}>
                  {v.promoterChangeQoq != null ? `${v.promoterChangeQoq} pp` : '—'}
                </dd>
              </div>
            </dl>
            {v.trapFlags.length > 0 && (
              <ul className="valuation-trap-flags">
                {v.trapFlags.map((flag, i) => (
                  <li key={i}>
                    <ShieldAlert aria-hidden />
                    {flag}
                  </li>
                ))}
              </ul>
            )}
            {v.notes.map((note, i) => (
              <p key={i} className="radar-control-hint">
                {note}
              </p>
            ))}
          </td>
        </tr>
      )}
    </>
  );
}

export function ValuationPanel() {
  const q = useQuery({
    queryKey: ['valuation'],
    queryFn: () => getValuation(),
    staleTime: 300_000,
  });
  const [group, setGroup] = useState('ALL');
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(12);
  const loaded = useMemo(
    () => (q.data?.rows ?? []).filter((r) => r.verdict !== 'INSUFFICIENT_DATA'),
    [q.data],
  );
  const rows = loaded.filter(
    (r) =>
      (group === 'ALL' ||
        GROUPS.find((g) => g.id === group)?.verdicts.some((v) => v === r.verdict)) &&
      (!search || r.symbol.toLowerCase().includes(search.toLowerCase().trim())),
  );
  return (
    <Card className="radar-research-panel valuation-panel">
      <div className="radar-panel-heading">
        <div>
          <h2>
            Valuation & quality <span className="radar-heading-tag">Fundamentals</span>
          </h2>
          <p>
            Look beyond the price tag. Separate quality from risk, and spot potential value traps.
          </p>
        </div>
        <div className="radar-panel-meta">
          <span>
            <strong>{loaded.length}</strong> stocks with fundamentals
          </span>
          <small>
            <ShieldCheck aria-hidden />
            Descriptive, never an entry signal
          </small>
        </div>
      </div>
      <div
        className="valuation-summary-grid"
        role="group"
        aria-label="Filter valuation by assessment"
      >
        {GROUPS.map((g) => (
          <button
            type="button"
            key={g.id}
            aria-pressed={group === g.id}
            className={clsx('valuation-summary-tile', `valuation-summary-${g.id}`)}
            onClick={() => {
              setGroup((current) => (current === g.id ? 'ALL' : g.id));
              setLimit(12);
            }}
          >
            <span>{g.label}</span>
            <strong>{loaded.filter((r) => g.verdicts.some((v) => v === r.verdict)).length}</strong>
            <small>
              {g.id === 'trap'
                ? 'Quality or ownership flags'
                : g.id === 'quality'
                  ? 'Value backed by quality'
                  : g.id === 'risky'
                    ? 'Requires closer inspection'
                    : 'Limited valuation support'}
            </small>
          </button>
        ))}
      </div>
      <div className="valuation-toolbar">
        <div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setGroup('ALL');
              setSearch('');
              setLimit(12);
            }}
            disabled={group === 'ALL' && !search}
          >
            All assessments
          </Button>
          <span>{rows.length} stocks · ranked by value score</span>
        </div>
        <SearchInput
          aria-label="Search valuation stocks"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setLimit(12);
          }}
          onClear={() => {
            setSearch('');
            setLimit(12);
          }}
          placeholder="Search a stock symbol…"
          wrapClassName="valuation-search"
        />
      </div>
      {q.isPending && (
        <div className="radar-table-loading" role="status">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-14 rounded-lg" />
          ))}
          <span className="sr-only">Loading cached fundamentals…</span>
        </div>
      )}
      {q.isError && (
        <ErrorState
          message="Fundamentals are unavailable right now. Retry to load the latest valuation research."
          onRetry={() => q.refetch()}
        />
      )}
      {q.isSuccess && rows.length > 0 && (
        <>
          <div
            className="radar-table-scroll"
            role="region"
            aria-label="Stock valuations, scroll horizontally for all metrics"
            tabIndex={0}
          >
            <table className="radar-data-table valuation-data-table">
              <thead>
                <tr>
                  <th scope="col">Stock / price</th>
                  <th scope="col">Assessment</th>
                  <th scope="col" className="valuation-number">
                    DCF margin of safety
                  </th>
                  <th scope="col" className="valuation-number">
                    ROCE
                  </th>
                  <th scope="col" className="valuation-number">
                    P/E
                  </th>
                  <th scope="col">
                    <span className="sr-only">Details</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, limit).map((v) => (
                  <ValRow key={v.ticker} v={v} />
                ))}
              </tbody>
            </table>
          </div>
          <div className="radar-panel-footer">
            <span>
              Showing {Math.min(limit, rows.length)} of {rows.length} stocks · expand a stock for
              fundamentals
            </span>
            {rows.length > limit && (
              <Button variant="secondary" size="sm" onClick={() => setLimit((n) => n + 12)}>
                Show more
                <ChevronDown className="h-3.5 w-3.5" aria-hidden />
              </Button>
            )}
          </div>
        </>
      )}
      {q.isSuccess && rows.length === 0 && (
        <div className="radar-filter-empty">
          {loaded.length ? <Search aria-hidden /> : <Coins aria-hidden />}
          <h3>
            {loaded.length ? 'No stocks match these filters.' : 'Fundamentals are being prepared.'}
          </h3>
          <p>
            {loaded.length
              ? 'Try a different symbol or select all assessments.'
              : 'Valuation research will appear here as company fundamentals become available.'}
          </p>
        </div>
      )}
      <p className="radar-evidence-caveat">
        <ShieldAlert aria-hidden />
        <span>
          DCF margin of safety depends on model assumptions. A cheap stock can still be a value
          trap. Valuation describes fundamentals; it does not predict returns or authorize a trade.
        </span>
      </p>
    </Card>
  );
}
