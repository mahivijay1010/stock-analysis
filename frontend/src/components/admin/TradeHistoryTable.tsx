'use client';

import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { ScrollText } from 'lucide-react';
import type { PaperTrade } from '@/lib/types';
import { fmtDateTime, inr, plain, signedInr } from '@/lib/format';
import type { Tone } from '@/components/ui';
import { Card, Chip, Collapsible, EmptyState, SearchInput, Skeleton } from '@/components/ui';
import { signTone } from './desk-ui';

type ResultFilter = 'ALL' | 'WINS' | 'LOSSES';
type TradeResult = 'WIN' | 'LOSS' | 'FLAT';

/** Realized outcome of a row — chips only exist where realized P&L exists (closed round trips). */
function resultOf(t: PaperTrade): TradeResult | null {
  if (t.realizedPnl == null) return null;
  if (t.realizedPnl > 0) return 'WIN';
  if (t.realizedPnl < 0) return 'LOSS';
  return 'FLAT';
}

const RESULT_TONE: Record<TradeResult, Tone> = {
  WIN: 'buy',
  LOSS: 'sell',
  FLAT: 'zinc',
};

/**
 * V9 — the Execution log: the SAME PaperTrade ledger, now a collapsible desk
 * section, still filterable (All/Wins/Losses + ticker text) with win/loss
 * chips per closed trade. These rows are exactly what the Performance
 * feedback card measures.
 */
export function TradeHistoryTable({
  trades,
  loading,
  unavailable,
}: {
  trades: PaperTrade[] | null;
  loading: boolean;
  unavailable: boolean;
}) {
  const [filter, setFilter] = useState<ResultFilter>('ALL');
  const [tickerQuery, setTickerQuery] = useState('');

  const sorted = useMemo(
    () =>
      trades
        ? [...trades].sort((a, b) => new Date(b.executedAt).getTime() - new Date(a.executedAt).getTime())
        : null,
    [trades],
  );

  const counts = useMemo(() => {
    let wins = 0;
    let losses = 0;
    for (const t of sorted ?? []) {
      const r = resultOf(t);
      if (r === 'WIN') wins += 1;
      else if (r === 'LOSS') losses += 1;
    }
    return { all: sorted?.length ?? 0, wins, losses };
  }, [sorted]);

  const filtered = useMemo(() => {
    if (!sorted) return null;
    const needle = tickerQuery.trim().toLowerCase();
    return sorted.filter((t) => {
      const r = resultOf(t);
      if (filter === 'WINS' && r !== 'WIN') return false;
      if (filter === 'LOSSES' && r !== 'LOSS') return false;
      if (needle && !t.ticker.toLowerCase().includes(needle) && !(t.name ?? '').toLowerCase().includes(needle)) {
        return false;
      }
      return true;
    });
  }, [sorted, filter, tickerQuery]);

  const filterTabs: Array<{ key: ResultFilter; label: string; count: number }> = [
    { key: 'ALL', label: 'All', count: counts.all },
    { key: 'WINS', label: 'Wins', count: counts.wins },
    { key: 'LOSSES', label: 'Losses', count: counts.losses },
  ];

  return (
    <Card className="p-5">
      <Collapsible
        id="desk.log"
        defaultOpen
        title={
          <span className="flex items-center gap-2">
            <ScrollText className="h-4 w-4 shrink-0 text-cyan-400" aria-hidden />
            Execution log
          </span>
        }
        subtitle="Every recorded paper trade with fees and realized P&L — the exact ledger the feedback loop measures."
        right={
          !loading && !unavailable && sorted ? (
            <Chip tone="zinc">
              {plain(counts.all, 0)} trade{counts.all === 1 ? '' : 's'}
            </Chip>
          ) : undefined
        }
      >
        {loading && (
          <div className="space-y-3">
            <Skeleton className="h-4" />
            <Skeleton className="h-4" />
            <Skeleton className="h-4" />
          </div>
        )}

        {!loading && unavailable && (
          <EmptyState
            glyph="slash"
            title="Execution log unavailable"
            message="The backend has not exposed trade history yet — recorded trades will appear here once it does."
          />
        )}

        {!loading && !unavailable && sorted && sorted.length === 0 && (
          <EmptyState
            glyph="radar"
            title="No trades recorded yet"
            message="Record a BUY from today's plan — every paper trade lands here with fees and realized P&L, and closed trades feed the performance feedback above."
          />
        )}

        {!loading && !unavailable && sorted && sorted.length > 0 && (
          <>
            {/* Filter tabs (kept) + ticker search */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex rounded-lg border border-white/8 bg-white/4 p-0.5" role="group" aria-label="Filter trades by result">
                {filterTabs.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    aria-pressed={filter === f.key}
                    onClick={() => setFilter(f.key)}
                    className={clsx(
                      'touch-target relative rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                      filter === f.key ? 'bg-cyan-400/15 text-cyan-300' : 'text-slate-400 hover:text-slate-200',
                    )}
                  >
                    {f.label} <span className="tabular-nums opacity-70">{plain(f.count, 0)}</span>
                  </button>
                ))}
              </div>
              <SearchInput
                value={tickerQuery}
                onChange={(e) => setTickerQuery(e.target.value)}
                onClear={() => setTickerQuery('')}
                placeholder="ticker"
                aria-label="Filter by ticker or name"
                wrapClassName="w-44"
              />
            </div>

            {filtered && filtered.length === 0 && (
              <EmptyState
                glyph="slash"
                className="mt-3"
                title="No trades match this filter"
                message={`Nothing under "${filterTabs.find((f) => f.key === filter)?.label}${
                  tickerQuery.trim() ? `" + "${tickerQuery.trim()}` : ''
                }" — clear the ticker filter or switch back to All.`}
              />
            )}

            {filtered && filtered.length > 0 && (
              <div className="thin-scroll mt-3 max-h-[480px] overflow-x-auto overflow-y-auto rounded-xl border border-white/6">
                <table className="table-premium min-w-[880px]">
                  <thead>
                    <tr>
                      <th>Executed</th>
                      <th>Stock</th>
                      <th>Side</th>
                      <th className="num">Qty</th>
                      <th className="num">Price</th>
                      <th className="num">Fees</th>
                      <th>Status</th>
                      <th>Result</th>
                      <th className="num">Realized P&amp;L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((t) => {
                      const result = resultOf(t);
                      return (
                        <tr key={String(t.id)}>
                          <td className="text-xs whitespace-nowrap text-slate-400">{fmtDateTime(t.executedAt)}</td>
                          <td>
                            <p className="font-medium text-slate-100">{t.name || t.ticker}</p>
                            <p className="text-xs text-slate-500">{t.ticker}</p>
                          </td>
                          <td>
                            <Chip tone={t.side === 'BUY' ? 'cyan' : 'zinc'}>{t.side}</Chip>
                          </td>
                          <td className="num text-slate-200">{plain(t.qty, 0)}</td>
                          <td className="num whitespace-nowrap text-slate-200">{inr(t.price)}</td>
                          <td className="num whitespace-nowrap text-slate-400">{inr(t.fees)}</td>
                          <td>
                            <Chip tone={t.status === 'OPEN' ? 'wait' : 'zinc'}>{t.status}</Chip>
                          </td>
                          <td>
                            {result ? (
                              <Chip tone={RESULT_TONE[result]} glow={result !== 'FLAT'} className="px-2 py-0.5 text-[10px]">
                                {result}
                              </Chip>
                            ) : (
                              <span className="text-slate-600">—</span>
                            )}
                          </td>
                          <td
                            className={clsx(
                              'num font-display font-semibold whitespace-nowrap',
                              t.realizedPnl != null ? signTone(t.realizedPnl) : 'text-slate-600',
                            )}
                          >
                            {t.realizedPnl != null ? signedInr(t.realizedPnl) : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Collapsible>
    </Card>
  );
}
