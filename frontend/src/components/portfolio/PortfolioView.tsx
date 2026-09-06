'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  AlertTriangle,
  ArrowUpRight,
  ChevronDown,
  Clock3,
  Loader2,
  Plus,
  ShoppingCart,
  Trash2,
} from 'lucide-react';
import {
  addWatchlistItem,
  getPortfolioOverview,
  isNotFound,
  isUnauthorized,
  listTransactions,
  removeWatchlistItem,
} from '@/lib/api';
import type { PortfolioOverviewRow, TransactionRecord } from '@/lib/types';
import { fmtDate, fmtDateShort, fmtDateTime, inr, inrSmart, plain, signedInr, signedPct } from '@/lib/format';
import {
  Button,
  Card,
  CardSkeleton,
  Chip,
  EmptyState,
  ErrorState,
  StatTile,
  ViewHero,
} from '@/components/ui';
import { Stagger, StaggerItem } from '@/components/motion';
import { SearchBox } from '@/components/analyze/SearchBox';
import { LoginPanel } from '@/components/auth/LoginPanel';
import { useAuth } from '@/components/auth/useAuth';
import { AddPurchaseForm } from '@/components/holdings/AddPurchaseForm';
import { TransactionsPanel } from '@/components/holdings/TransactionsPanel';
import { TransactionRowActions } from '@/components/holdings/TransactionRowActions';
import { DailyForecastCard } from '@/components/analyze/DailyForecastCard';
import { signTone } from '@/components/analyze/tone';

/*
 * Unified portfolio (owner request 2026-09-06): Watchlist and Holdings merged
 * into ONE screen. A row is "watching" and/or "holding" — following still
 * records no purchase, holding still comes only from the immutable ledger.
 * Each row shows THIS month's stored forecast (rolls automatically at month
 * change via the renewal job) and the latest nightly decision + risk-based
 * holding-horizon label. Rows expand on click; the heavy forecast chart/table
 * mounts ONLY when expanded.
 */

const DECISION_TONE: Record<string, 'buy' | 'amber' | 'sell' | 'zinc'> = {
  BUY_CANDIDATE: 'buy',
  WAIT: 'amber',
  AVOID_NEW_ENTRY: 'sell',
  INSUFFICIENT_EVIDENCE: 'zinc',
};

const DECISION_LABEL: Record<string, string> = {
  BUY_CANDIDATE: 'Buy candidate',
  WAIT: 'Wait',
  AVOID_NEW_ENTRY: 'Avoid new entry',
  INSUFFICIENT_EVIDENCE: 'Insufficient evidence',
};

const HORIZON_TONE: Record<string, 'emerald' | 'cyan' | 'amber' | 'zinc'> = {
  long: 'emerald',
  moderate: 'cyan',
  short: 'amber',
};

const HORIZON_LABEL: Record<string, string> = {
  long: 'Long-term candidate (>365d)',
  moderate: 'Moderate hold (31–365d)',
  short: 'Short-term only (≤30d)',
};

function MonthForecastBlock({ row }: { row: PortfolioOverviewRow }) {
  const mf = row.monthForecast;
  if (!mf) {
    return (
      <p className="text-xs leading-relaxed text-slate-500">
        No stored forecast for this month yet — issued nightly, or open the row and use Stock Detail.
      </p>
    );
  }
  const retPct = ((mf.medianPrice - mf.anchorPrice) / mf.anchorPrice) * 100;
  return (
    <div>
      <p className="text-[11px] text-slate-500">
        {fmtDateShort(mf.monthEnd)} outlook · issued {fmtDate(mf.issuedAt)}
        {mf.revision > 0 ? ` · rev ${mf.revision}` : ''}
      </p>
      <p className="text-sm font-semibold text-slate-100 tabular-nums">
        {inr(mf.medianPrice)}{' '}
        <span className={clsx('text-xs font-medium', retPct >= 0 ? 'text-buy' : 'text-sell')}>
          {signedPct(retPct)}
        </span>
      </p>
      <p className="text-[11px] text-slate-500 tabular-nums">
        80% range {inr(mf.p10)} – {inr(mf.p90)} · vs {fmtDateShort(mf.anchorDate)} close
      </p>
    </div>
  );
}

function DecisionChips({ row }: { row: PortfolioOverviewRow }) {
  const d = row.decision;
  if (!d) {
    return <p className="text-xs text-slate-500">No published decision yet — publishes nightly.</p>;
  }
  const horizon = d.horizon?.label ?? null;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip tone={DECISION_TONE[d.status] ?? 'zinc'} glow={d.status === 'BUY_CANDIDATE'}>
          {DECISION_LABEL[d.status] ?? d.status}
        </Chip>
        {d.expired && (
          <span className="text-[10px] text-slate-500" title="The entry opinion has passed its validUntil — it refreshes on the next nightly publication.">
            expired — refreshes tonight
          </span>
        )}
      </div>
      {horizon && (
        <Chip tone={HORIZON_TONE[horizon] ?? 'zinc'} className="px-2 py-0.5 text-[10px]" title={d.horizon?.reasons?.[0] ?? undefined}>
          {HORIZON_LABEL[horizon] ?? horizon}
        </Chip>
      )}
      {!horizon && d.horizon && (
        <span className="text-[10px] text-slate-500">horizon: insufficient history</span>
      )}
    </div>
  );
}

function HeldBlock({ row }: { row: PortfolioOverviewRow }) {
  const h = row.held;
  if (!h) return <Chip tone="zinc" className="px-2 py-0.5 text-[10px]">watching · no position</Chip>;
  return (
    <div>
      <Chip tone="cyan" className="px-2 py-0.5 text-[10px]">
        holding {h.qty} sh{h.avgCostPerShare != null ? ` @ ${inr(h.avgCostPerShare)}` : ''}
      </Chip>
      {h.unrealizedGrossPnl != null && (
        <p className={clsx('mt-1 text-xs font-medium tabular-nums', signTone(h.unrealizedGrossPnl))}>
          {signedInr(h.unrealizedGrossPnl)} unrealized
        </p>
      )}
    </div>
  );
}

/** This ticker's own transactions, with Edit/Remove one click away — no need to scroll to the bottom history. */
function RecentActivity({ ticker, onEdit }: { ticker: string; onEdit: (tx: TransactionRecord) => void }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['transactions'],
    queryFn: listTransactions,
    staleTime: 60_000,
    retry: false,
  });
  const rows = useMemo(
    () =>
      (q.data ?? [])
        .filter((t) => t.ticker === ticker && t.correctedBy == null && t.correctionOf == null)
        .sort((a, b) => String(b.executedAt).localeCompare(String(a.executedAt)))
        .slice(0, 5),
    [q.data, ticker],
  );
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['transactions'] });
    qc.invalidateQueries({ queryKey: ['holdings'] });
    qc.invalidateQueries({ queryKey: ['portfolio-overview'] });
  };

  if (q.isPending) return null;
  if (rows.length === 0) return null;

  return (
    <div className="rounded-xl border border-white/8 bg-white/3 px-3.5 py-2.5">
      <p className="text-[11px] font-medium text-slate-500">Recent activity — mistakenly added something? Edit or remove it here.</p>
      <div className="mt-2 space-y-1.5">
        {rows.map((t) => (
          <div key={String(t.id)} className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="text-slate-400">
              <span className="whitespace-nowrap text-slate-300">{fmtDate(t.executedAt)}</span>{' '}
              <span className={t.type === 'BUY' ? 'font-semibold text-buy' : t.type === 'SELL' ? 'font-semibold text-sell' : 'font-semibold text-slate-300'}>
                {t.type}
              </span>{' '}
              {t.qty != null ? `${plain(t.qty, 0)} sh` : ''}
              {t.price != null ? ` @ ${inr(t.price)}` : t.grossAmount != null ? ` (${inr(t.grossAmount)} gross)` : ''}
            </span>
            <TransactionRowActions tx={t} onEdit={onEdit} onDone={refresh} />
          </div>
        ))}
      </div>
    </div>
  );
}

function PortfolioRow({
  row,
  onOpenStock,
  onRecordPurchase,
  onEditTransaction,
}: {
  row: PortfolioOverviewRow;
  onOpenStock: (ticker: string) => void;
  onRecordPurchase: (ticker: string) => void;
  onEditTransaction: (tx: TransactionRecord) => void;
}) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const removeMut = useMutation({
    mutationFn: () => removeWatchlistItem(row.watch!.itemId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portfolio-overview'] }),
  });

  const projectedPnl = useMemo(() => {
    if (!row.held || !row.monthForecast) return null;
    const { qty, costBasis } = row.held;
    const mf = row.monthForecast;
    return {
      median: qty * mf.medianPrice - costBasis,
      p10: qty * mf.p10 - costBasis,
      p90: qty * mf.p90 - costBasis,
      monthEnd: mf.monthEnd,
    };
  }, [row.held, row.monthForecast]);

  return (
    <Card className="p-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.9fr)_minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-start">
        {/* Identity + price */}
        <div className="min-w-0">
          <button type="button" onClick={() => onOpenStock(row.ticker)} className="group block min-w-0 text-left">
            <p className="truncate font-display text-sm font-semibold tracking-tight text-slate-100 group-hover:text-cyan-300">
              {row.name}
            </p>
            <p className="text-xs text-slate-500">{row.ticker}</p>
          </button>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {row.price ? (
              <>
                <span className="text-sm font-semibold text-slate-100 tabular-nums">{inr(row.price.current)}</span>
                {row.price.asOf && (
                  <span className="inline-flex items-center gap-1 text-[10px] text-slate-500" title={row.price.source ?? undefined}>
                    <Clock3 className="h-3 w-3" aria-hidden />
                    as of {fmtDateTime(row.price.asOf)}
                  </span>
                )}
              </>
            ) : (
              <span className="text-[11px] text-slate-500">price unavailable right now</span>
            )}
          </div>
        </div>

        {/* Held state */}
        <HeldBlock row={row} />

        {/* This month's forecast */}
        <MonthForecastBlock row={row} />

        {/* Decision + horizon */}
        <DecisionChips row={row} />

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-1.5 lg:flex-col lg:items-end">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${row.ticker} forecast detail`}
          >
            <ChevronDown className={clsx('h-3.5 w-3.5 transition-transform', expanded && 'rotate-180')} aria-hidden />
            {expanded ? 'Close' : 'Forecast'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onRecordPurchase(row.ticker)}>
            <ShoppingCart className="h-3.5 w-3.5" aria-hidden /> Buy/Sell
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onOpenStock(row.ticker)}>
            Details <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
          </Button>
          {row.watch && !row.held && !confirmingRemove && (
            <Button variant="ghost" size="sm" onClick={() => setConfirmingRemove(true)} aria-label={`Unfollow ${row.ticker}`}>
              <Trash2 className="h-3.5 w-3.5 text-slate-500" aria-hidden />
            </Button>
          )}
          {confirmingRemove && (
            <span className="flex items-center gap-1.5 text-[11px] text-slate-400">
              Unfollow?
              <Button variant="secondary" size="sm" className="text-sell" onClick={() => removeMut.mutate()} disabled={removeMut.isPending}>
                {removeMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : 'Yes'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmingRemove(false)}>No</Button>
            </span>
          )}
        </div>
      </div>

      {row.watch?.note && (
        <p className="mt-3 border-t border-white/[0.06] pt-2 text-xs leading-relaxed text-slate-400">
          <span className="text-slate-600">Note:</span> {row.watch.note}
        </p>
      )}

      {/* Expanded detail — heavy content mounts ONLY here (charts stay closed until asked). */}
      {expanded && (
        <div className="mt-4 space-y-4 border-t border-white/[0.06] pt-4">
          {projectedPnl && (
            <div className="rounded-xl border border-white/8 bg-white/3 px-3.5 py-2.5">
              <p className="text-[11px] font-medium text-slate-500">
                Your position through this forecast (model estimate — value = qty × price quantile − basis; not realized profit)
              </p>
              <p className="mt-1 text-sm font-semibold tabular-nums">
                <span className={signTone(projectedPnl.median)}>{signedInr(projectedPnl.median)}</span>{' '}
                <span className="text-xs font-normal text-slate-500">
                  median by {fmtDateShort(projectedPnl.monthEnd)} · 80% range {signedInr(projectedPnl.p10)} to {signedInr(projectedPnl.p90)}
                </span>
              </p>
            </div>
          )}

          {row.held && <RecentActivity ticker={row.ticker} onEdit={onEditTransaction} />}

          {row.decision && (
            <div className="rounded-xl border border-white/8 bg-white/3 px-3.5 py-2.5">
              <p className="text-[11px] font-medium text-slate-500">
                Why: decision {row.decision.status} · published {fmtDateTime(row.decision.asOf)} (re-evaluated nightly after close)
              </p>
              {row.decision.topReason && (
                <p className="mt-1 text-xs leading-relaxed text-slate-400">{row.decision.topReason}</p>
              )}
              {row.decision.horizon?.reasons?.[0] && (
                <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
                  <span className="text-slate-600">Horizon:</span> {row.decision.horizon.reasons[0]}
                </p>
              )}
            </div>
          )}

          <DailyForecastCard ticker={row.ticker} />
        </div>
      )}

      {removeMut.isError && (
        <p className="mt-2 text-xs text-sell">
          {removeMut.error instanceof Error ? removeMut.error.message : 'Could not unfollow.'}
        </p>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* View                                                                */
/* ------------------------------------------------------------------ */

export function PortfolioView({
  pendingPurchaseTicker,
  onPendingPurchaseConsumed,
  onOpenStock,
}: {
  pendingPurchaseTicker: string | null;
  onPendingPurchaseConsumed: () => void;
  onOpenStock: (ticker: string) => void;
}) {
  const qc = useQueryClient();
  const { auth, loading: authLoading, error: authError } = useAuth();
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const [purchaseTicker, setPurchaseTicker] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState<TransactionRecord | null>(null);

  const overviewQ = useQuery({
    queryKey: ['portfolio-overview'],
    queryFn: getPortfolioOverview,
    staleTime: 60_000,
    retry: false,
    enabled: auth?.status === 'authenticated',
  });

  // Watchlist "Add purchase" hand-off (from Discover/Stock Detail) opens the form here.
  useEffect(() => {
    if (pendingPurchaseTicker) {
      setPurchaseTicker(pendingPurchaseTicker);
      setPurchaseOpen(true);
    }
  }, [pendingPurchaseTicker]);

  const addMut = useMutation({
    mutationFn: (ticker: string) => addWatchlistItem({ ticker, horizon: 'medium' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portfolio-overview'] }),
  });

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ['portfolio-overview'] });
    qc.invalidateQueries({ queryKey: ['holdings'] });
    qc.invalidateQueries({ queryKey: ['transactions'] });
  };

  const data = overviewQ.data;
  const hero = (
    <ViewHero
      eyebrow="follow & own — one place"
      title="Watchlist"
      subtitle="Every stock you follow or hold: observed price, this month's forecast, the nightly decision and a risk-based holding-horizon label. Following records no purchase; positions come only from your recorded transactions."
      right={
        data ? (
          <div className="flex flex-wrap gap-1.5">
            <Chip tone="cyan" glow>{data.totals.followed} followed</Chip>
            {data.totals.held > 0 && <Chip tone="zinc">{data.totals.held} held</Chip>}
          </div>
        ) : undefined
      }
    />
  );

  if (authLoading) {
    return (
      <div className="space-y-5">
        {hero}
        <CardSkeleton lines={3} />
        <CardSkeleton lines={3} />
      </div>
    );
  }

  if (authError) {
    return (
      <div className="space-y-5">
        {hero}
        <ErrorState message={authError} onRetry={() => qc.invalidateQueries({ queryKey: ['auth'] })} />
      </div>
    );
  }

  if (auth?.status === 'unauthenticated' || (overviewQ.isError && isUnauthorized(overviewQ.error))) {
    return <LoginPanel context="Your watchlist & holdings" />;
  }

  const backendPending = overviewQ.isError && isNotFound(overviewQ.error);
  const rows = data?.rows ?? [];
  const heldCount = data?.totals.held ?? 0;

  return (
    <div className="space-y-5">
      {hero}

      {auth?.status === 'unavailable' && (
        <p className="flex items-start gap-2 rounded-xl border border-amber-400/20 bg-amber-400/5 px-3.5 py-2 text-xs leading-relaxed text-slate-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden />
          {auth.note}
        </p>
      )}

      {/* Portfolio totals — actuals from the ledger, never projections. */}
      {data && heldCount > 0 && (
        <Stagger className="grid grid-cols-2 gap-4 xl:grid-cols-3">
          <StaggerItem>
            <StatTile label="Invested basis" value={inrSmart(data.totals.costBasis)} sub="cost incl. allocated charges" />
          </StaggerItem>
          <StaggerItem>
            <StatTile
              label="Unrealized P&L"
              value={
                <span className={data.totals.unrealizedGrossPnl != null ? signTone(data.totals.unrealizedGrossPnl) : ''}>
                  {data.totals.unrealizedGrossPnl != null ? signedInr(data.totals.unrealizedGrossPnl) : '—'}
                </span>
              }
              sub="marked, before sale charges"
            />
          </StaggerItem>
          <StaggerItem>
            <StatTile
              label="Realized P&L"
              value={<span className={signTone(data.totals.realizedPnl)}>{signedInr(data.totals.realizedPnl)}</span>}
              sub="actual net sale proceeds − sold basis"
            />
          </StaggerItem>
        </Stagger>
      )}

      {/* Follow a stock */}
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-1.5 text-xs font-medium text-slate-400">
            <Plus className="h-4 w-4 text-cyan-300" aria-hidden /> Follow a stock
          </span>
          <div className="min-w-0 flex-1">
            <SearchBox onSelect={(t) => addMut.mutate(t)} inputId="watchlist-add-input" className="max-w-xl" />
          </div>
          {addMut.isPending && <Loader2 className="h-4 w-4 animate-spin text-slate-500" aria-hidden />}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setPurchaseTicker(null);
              setPurchaseOpen((v) => !v);
            }}
            aria-expanded={purchaseOpen}
          >
            <ShoppingCart className="h-3.5 w-3.5" aria-hidden /> Record a purchase / sale
          </Button>
        </div>
        {addMut.isError && (
          <p className="mt-2 text-xs text-sell">
            {addMut.error instanceof Error ? addMut.error.message : 'Could not add the stock.'}
          </p>
        )}
      </Card>

      {/* Purchase / correction form — collapsed until asked for. */}
      {(purchaseOpen || correcting) && (
        <AddPurchaseForm
          initialTicker={purchaseTicker}
          correcting={correcting}
          onDone={() => {
            setCorrecting(null);
            setPurchaseOpen(false);
            setPurchaseTicker(null);
            if (pendingPurchaseTicker) onPendingPurchaseConsumed();
            refreshAll();
          }}
        />
      )}

      {overviewQ.isPending && (
        <>
          <CardSkeleton lines={3} />
          <CardSkeleton lines={3} />
        </>
      )}

      {backendPending && (
        <Card className="p-5">
          <EmptyState
            glyph="radar"
            title="The unified portfolio API has not shipped on this backend yet"
            message="GET /api/portfolio/overview is pending on this server. Nothing is fabricated in the meantime."
          />
        </Card>
      )}

      {overviewQ.isError && !backendPending && !isUnauthorized(overviewQ.error) && (
        <ErrorState
          message={overviewQ.error instanceof Error ? overviewQ.error.message : 'Could not load your portfolio.'}
          onRetry={() => overviewQ.refetch()}
        />
      )}

      {data && rows.length === 0 && (
        <Card className="p-5">
          <EmptyState
            glyph="slash"
            title="Nothing here yet"
            message="Follow a stock above (no purchase, no P&L) or record your first purchase — both live on this one screen now."
          />
        </Card>
      )}

      {rows.length > 0 && (
        <div className="space-y-3">
          {rows.map((row) => (
            <PortfolioRow
              key={row.instrumentId}
              row={row}
              onOpenStock={onOpenStock}
              onRecordPurchase={(t) => {
                setPurchaseTicker(t);
                setPurchaseOpen(true);
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
              onEditTransaction={(tx) => {
                setCorrecting(tx);
                setPurchaseOpen(true);
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
            />
          ))}
          {data?.notes && (
            <p className="px-1 text-[11px] leading-relaxed text-slate-500">{data.notes.join(' ')}</p>
          )}
        </div>
      )}

      {/* Transaction history — TransactionsPanel manages its own disclosure. */}
      <TransactionsPanel
        onEdit={(tx) => {
          setCorrecting(tx);
          setPurchaseOpen(true);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }}
      />
    </div>
  );
}
