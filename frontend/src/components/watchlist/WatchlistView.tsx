'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  AlertTriangle,
  ArrowUpRight,
  Clock3,
  Loader2,
  Pencil,
  Plus,
  ShoppingCart,
  Trash2,
} from 'lucide-react';
import {
  addWatchlistItem,
  analyzeStock,
  getWatchlist,
  isNotFound,
  isUnauthorized,
  removeWatchlistItem,
  updateWatchlistItem,
} from '@/lib/api';
import type { AnalyzeResponse, HorizonBucket, WatchlistItem } from '@/lib/types';
import { HORIZON_BUCKET_LABELS } from '@/lib/types';
import { quoteFreshness } from '@/lib/freshness';
import { fmtDate, inr, signedPct } from '@/lib/format';
import {
  Button,
  Card,
  CardSkeleton,
  Chip,
  EmptyState,
  EntryChip,
  ErrorState,
  Select,
  type SelectOption,
  Skeleton,
  ViewHero,
} from '@/components/ui';
import { SearchBox } from '@/components/analyze/SearchBox';
import { LoginPanel } from '@/components/auth/LoginPanel';
import { useAuth } from '@/components/auth/useAuth';

const HORIZON_OPTIONS: SelectOption[] = [
  { value: 'short', label: HORIZON_BUCKET_LABELS.short },
  { value: 'medium', label: HORIZON_BUCKET_LABELS.medium },
  { value: 'long', label: HORIZON_BUCKET_LABELS.long },
];

function horizonLabel(h: WatchlistItem['horizon']): string {
  if (h === 'short' || h === 'medium' || h === 'long') return HORIZON_BUCKET_LABELS[h];
  if (typeof h === 'string' && h.trim()) return h;
  return 'horizon not set';
}

/* ------------------------------------------------------------------ */
/* One row — enriched from the SAME analysis pipeline Stock Detail     */
/* uses (one decision source across surfaces, spec §13.14).            */
/* ------------------------------------------------------------------ */

function RowForecast({ data }: { data: AnalyzeResponse }) {
  const p30 = data.analysis.predictions.find((p) => p.horizonDays === 30) ?? null;
  if (!p30) {
    return <p className="text-xs text-slate-500">30d forecast not available for this stock.</p>;
  }
  return (
    <div>
      <p className="text-[11px] text-slate-500">Next 30 days · model estimate</p>
      <p className="text-sm font-semibold text-slate-100 tabular-nums">
        {inr(p30.expectedPrice)}{' '}
        <span className={clsx('text-xs font-medium', p30.expectedReturnPct >= 0 ? 'text-buy' : 'text-sell')}>
          {signedPct(p30.expectedReturnPct)}
        </span>
      </p>
      <p className="text-[11px] text-slate-500 tabular-nums">
        80% range {inr(p30.lowPrice)} – {inr(p30.highPrice)}
      </p>
    </div>
  );
}

function WatchlistRow({
  item,
  onOpenStock,
  onAddPurchase,
}: {
  item: WatchlistItem;
  onOpenStock: (ticker: string) => void;
  onAddPurchase: (ticker: string) => void;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(item.note ?? '');
  const [horizon, setHorizon] = useState<string>(
    item.horizon === 'short' || item.horizon === 'medium' || item.horizon === 'long' ? item.horizon : 'medium',
  );
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  // Same analysis pipeline as Stock Detail — cached & shared via the query key.
  const enrich = useQuery({
    queryKey: ['analyze', item.ticker, null],
    queryFn: () => analyzeStock(item.ticker, null),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  const saveMut = useMutation({
    mutationFn: () =>
      updateWatchlistItem(item.id, { note: note.trim() || null, horizon: horizon as HorizonBucket }),
    onSuccess: () => {
      setEditing(false);
      qc.invalidateQueries({ queryKey: ['watchlist'] });
    },
  });

  const removeMut = useMutation({
    mutationFn: () => removeWatchlistItem(item.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['watchlist'] }),
  });

  const data = enrich.data;
  const freshness = data ? quoteFreshness(data.quote) : null;
  const keyRisk = data ? (data.analysis.reasons.negative[0] ?? `${data.analysis.riskLevel} risk (measured volatility bucket)`) : null;

  return (
    <Card className="p-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)] lg:items-start">
        {/* Identity + observed price + freshness */}
        <div className="min-w-0">
          <button
            type="button"
            onClick={() => onOpenStock(item.ticker)}
            className="group block min-w-0 text-left"
          >
            <p className="truncate font-display text-sm font-semibold tracking-tight text-slate-100 group-hover:text-cyan-300">
              {data?.name ?? item.name ?? item.ticker}
            </p>
            <p className="text-xs text-slate-500">{item.ticker}</p>
          </button>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {enrich.isPending && <Skeleton className="h-5 w-28" />}
            {data && (
              <>
                <span className="text-sm font-semibold text-slate-100 tabular-nums">{inr(data.quote.price)}</span>
                <span
                  className={clsx(
                    'inline-flex items-center gap-1 text-[10px]',
                    freshness?.kind === 'live' ? 'text-buy' : 'text-slate-500',
                  )}
                  title={freshness?.detail}
                >
                  <Clock3 className="h-3 w-3" aria-hidden />
                  {freshness?.label}
                </span>
              </>
            )}
            {enrich.isError && <span className="text-[11px] text-slate-500">price unavailable right now</span>}
          </div>
        </div>

        {/* Forecast */}
        <div>
          {enrich.isPending && <Skeleton className="h-12 w-40" />}
          {data && <RowForecast data={data} />}
          {enrich.isError && <p className="text-xs text-slate-500">Forecast unavailable — analysis failed for this ticker.</p>}
        </div>

        {/* Entry status + horizon + key risk */}
        <div className="space-y-1.5">
          {enrich.isPending && <Skeleton className="h-5 w-24" />}
          {data?.entryTiming && (
            <div className="flex flex-wrap items-center gap-1.5">
              <EntryChip action={data.entryTiming.action} />
              <span className="text-[10px] text-slate-500" title="Entry timing comes from the existing rule-based score. It has NOT passed Phase D validation — treat it as a heuristic, not a measured edge.">
                heuristic baseline
              </span>
            </div>
          )}
          <Chip tone="zinc" className="px-2 py-0.5 text-[10px]">{horizonLabel(item.horizon)}</Chip>
          {keyRisk && (
            <p className="flex items-start gap-1 text-[11px] leading-relaxed text-slate-400">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-400" aria-hidden />
              <span className="line-clamp-2">{keyRisk}</span>
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2 lg:justify-end">
          <Button variant="secondary" size="sm" onClick={() => onAddPurchase(item.ticker)}>
            <ShoppingCart className="h-3.5 w-3.5" aria-hidden /> Add purchase
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onOpenStock(item.ticker)}>
            Details <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setEditing((v) => !v)} aria-expanded={editing}>
            <Pencil className="h-3.5 w-3.5" aria-hidden /> {editing ? 'Close' : 'Edit'}
          </Button>
          {!confirmingRemove ? (
            <Button variant="ghost" size="sm" onClick={() => setConfirmingRemove(true)} aria-label={`Remove ${item.ticker} from watchlist`}>
              <Trash2 className="h-3.5 w-3.5 text-slate-500" aria-hidden />
            </Button>
          ) : (
            <span className="flex items-center gap-2 text-[11px] text-slate-400">
              Remove? Holdings and history stay untouched.
              <Button variant="secondary" size="sm" className="text-sell" onClick={() => removeMut.mutate()} disabled={removeMut.isPending}>
                {removeMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : 'Remove'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmingRemove(false)}>Keep</Button>
            </span>
          )}
        </div>
      </div>

      {item.note && !editing && (
        <p className="mt-3 border-t border-white/[0.06] pt-2 text-xs leading-relaxed text-slate-400">
          <span className="text-slate-600">Note:</span> {item.note}
        </p>
      )}

      {editing && (
        <div className="mt-3 grid grid-cols-1 gap-3 border-t border-white/[0.06] pt-3 sm:grid-cols-[minmax(0,1fr)_220px_auto]">
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-slate-500">Note</span>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why you follow this stock…"
              className="input-glass w-full px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-slate-500">Holding horizon</span>
            <Select options={HORIZON_OPTIONS} value={horizon} onChange={setHorizon} ariaLabel="Holding horizon" />
          </label>
          <div className="flex items-end gap-2">
            <Button variant="primary" size="sm" onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>
              {saveMut.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />} Save
            </Button>
          </div>
          {saveMut.isError && (
            <p className="text-xs text-sell sm:col-span-3">
              {saveMut.error instanceof Error ? saveMut.error.message : 'Could not save the item.'}
            </p>
          )}
        </div>
      )}
      {removeMut.isError && (
        <p className="mt-2 text-xs text-sell">
          {removeMut.error instanceof Error ? removeMut.error.message : 'Could not remove the item.'}
        </p>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* View                                                                */
/* ------------------------------------------------------------------ */

export function WatchlistView({
  onOpenStock,
  onAddPurchase,
}: {
  onOpenStock: (ticker: string) => void;
  onAddPurchase: (ticker: string) => void;
}) {
  const qc = useQueryClient();
  const { auth, loading: authLoading, error: authError } = useAuth();

  const listQ = useQuery({
    queryKey: ['watchlist'],
    queryFn: getWatchlist,
    staleTime: 60_000,
    retry: false,
    enabled: auth?.status !== 'unauthenticated',
  });

  const addMut = useMutation({
    mutationFn: (ticker: string) => addWatchlistItem({ ticker, horizon: 'medium' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['watchlist'] }),
  });

  const hero = (
    <ViewHero
      eyebrow="what you follow"
      title="Watchlist"
      subtitle="Following a stock records no purchase and creates no P&L. Prices carry honest freshness labels, forecasts are model estimates with 80% ranges, and entry status is a heuristic baseline pending validation."
      right={
        listQ.data ? <Chip tone="cyan" glow>{listQ.data.length} followed</Chip> : undefined
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

  if (auth?.status === 'unauthenticated' || (listQ.isError && isUnauthorized(listQ.error))) {
    return <LoginPanel context="Your watchlist" />;
  }

  const backendPending = listQ.isError && isNotFound(listQ.error);

  return (
    <div className="space-y-5">
      {hero}

      {auth?.status === 'unavailable' && (
        <p className="flex items-start gap-2 rounded-xl border border-amber-400/20 bg-amber-400/5 px-3.5 py-2 text-xs leading-relaxed text-slate-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden />
          {auth.note}
        </p>
      )}

      {/* Add a stock — the same resolver Stock Detail uses. */}
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-1.5 text-xs font-medium text-slate-400">
            <Plus className="h-4 w-4 text-cyan-300" aria-hidden /> Follow a stock
          </span>
          <div className="min-w-0 flex-1">
            <SearchBox onSelect={(t) => addMut.mutate(t)} inputId="watchlist-add-input" className="max-w-xl" />
          </div>
          {addMut.isPending && <Loader2 className="h-4 w-4 animate-spin text-slate-500" aria-hidden />}
        </div>
        {addMut.isError && (
          <p className="mt-2 text-xs text-sell">
            {addMut.error instanceof Error ? addMut.error.message : 'Could not add the stock.'}
          </p>
        )}
      </Card>

      {listQ.isPending && (
        <>
          <CardSkeleton lines={3} />
          <CardSkeleton lines={3} />
        </>
      )}

      {backendPending && (
        <Card className="p-5">
          <EmptyState
            glyph="radar"
            title="Watchlist storage has not shipped on this backend yet"
            message="The watchlist API (upgrade slice B2) is pending on this server, so nothing can be saved or listed. This screen will work without changes once the backend slice lands — no data was fabricated in the meantime."
          />
        </Card>
      )}

      {listQ.isError && !backendPending && !isUnauthorized(listQ.error) && (
        <ErrorState
          message={listQ.error instanceof Error ? listQ.error.message : 'Could not load the watchlist.'}
          onRetry={() => listQ.refetch()}
        />
      )}

      {listQ.data && listQ.data.length === 0 && (
        <Card className="p-5">
          <EmptyState
            glyph="slash"
            title="You are not following any stocks yet"
            message="Search above to follow a stock, or explore Discover. Following is free of side effects — no purchase, no P&L, nothing to unwind."
          />
        </Card>
      )}

      {listQ.data && listQ.data.length > 0 && (
        <div className="space-y-3">
          {listQ.data.map((item) => (
            <WatchlistRow key={String(item.id)} item={item} onOpenStock={onOpenStock} onAddPurchase={onAddPurchase} />
          ))}
          <p className="px-1 text-[11px] leading-relaxed text-slate-500">
            Added {listQ.data[0]?.createdAt ? `· oldest entry ${fmtDate(listQ.data[listQ.data.length - 1]?.createdAt ?? '')}` : ''} —
            forecasts and entry status come from the same analysis pipeline as Stock Detail. Removing an item never
            touches holdings or their history.
          </p>
        </div>
      )}
    </div>
  );
}
