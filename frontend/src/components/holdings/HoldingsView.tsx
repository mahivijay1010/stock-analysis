'use client';

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlertTriangle, ArrowUpRight, Clock3 } from 'lucide-react';
import { analyzeStock, getHoldings, isNotFound, isUnauthorized } from '@/lib/api';
import type { HoldingPosition, TransactionRecord } from '@/lib/types';
import { quoteFreshness } from '@/lib/freshness';
import { fmtDateTime, inr, inrSmart, signedInr, signedPct } from '@/lib/format';
import {
  Button,
  Card,
  CardSkeleton,
  Chip,
  EmptyState,
  ErrorState,
  Skeleton,
  StatTile,
  ViewHero,
} from '@/components/ui';
import { Stagger, StaggerItem } from '@/components/motion';
import { LoginPanel } from '@/components/auth/LoginPanel';
import { useAuth } from '@/components/auth/useAuth';
import { AddPurchaseForm } from './AddPurchaseForm';
import { TransactionsPanel } from './TransactionsPanel';

const signTone = (v: number) => (v > 0 ? 'text-buy' : v < 0 ? 'text-sell' : 'text-slate-400');

/* ------------------------------------------------------------------ */
/* Derived totals (tolerant: prefer backend totals, else sum rows)     */
/* ------------------------------------------------------------------ */

function num(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function positionBasis(p: HoldingPosition): number | null {
  return num(p.costBasis) ?? num(p.invested) ?? (num(p.avgCost) != null ? (p.avgCost as number) * p.qty : null);
}

function positionValue(p: HoldingPosition): number | null {
  return num(p.marketValue) ?? (num(p.currentPrice) != null ? (p.currentPrice as number) * p.qty : null);
}

/* ------------------------------------------------------------------ */
/* Projection row — the SAME 30d distribution Stock Detail shows,      */
/* transformed to position value. Clearly labeled model estimate.      */
/* ------------------------------------------------------------------ */

function ProjectionCells({ p }: { p: HoldingPosition }) {
  const enrich = useQuery({
    queryKey: ['analyze', p.ticker, null],
    queryFn: () => analyzeStock(p.ticker, null),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  if (enrich.isPending) return <Skeleton className="h-10 w-44" />;
  const p30 = enrich.data?.analysis.predictions.find((x) => x.horizonDays === 30) ?? null;
  const anchor = enrich.data?.quote.price ?? null;
  if (!p30 || anchor == null) return <span className="text-xs text-slate-500">no 30d forecast</span>;

  const projectedValue = p.qty * p30.expectedPrice;
  const changeFromToday = p.qty * (p30.expectedPrice - anchor);
  const lowV = p.qty * p30.lowPrice;
  const highV = p.qty * p30.highPrice;

  return (
    <div className="text-right">
      <p className="text-sm font-semibold text-slate-100 tabular-nums">{inrSmart(projectedValue)}</p>
      <p className={clsx('text-xs font-medium tabular-nums', signTone(changeFromToday))}>
        {signedInr(changeFromToday)} vs today
      </p>
      <p className="text-[11px] text-slate-500 tabular-nums">
        80% range {inrSmart(lowV)} – {inrSmart(highV)}
      </p>
    </div>
  );
}

function PositionRow({ p, onOpenStock }: { p: HoldingPosition; onOpenStock: (t: string) => void }) {
  const basis = positionBasis(p);
  const value = positionValue(p);
  const unrealized = num(p.unrealizedPnl) ?? (basis != null && value != null ? value - basis : null);
  const freshness = p.priceAsOf ? quoteFreshness({ asOf: p.priceAsOf, marketState: null }) : null;

  return (
    <tr>
      <td>
        <button type="button" onClick={() => onOpenStock(p.ticker)} className="group text-left">
          <p className="font-medium text-slate-100 group-hover:text-cyan-300">{p.name ?? p.ticker}</p>
          <p className="text-xs text-slate-500">{p.ticker} · {p.qty} sh</p>
        </button>
      </td>
      <td className="num text-slate-200">{basis != null ? inrSmart(basis) : '—'}</td>
      <td className="num">
        {num(p.currentPrice) != null ? (
          <div className="text-right">
            <p className="text-slate-100 tabular-nums">{inr(p.currentPrice as number)}</p>
            {freshness && (
              <p className="flex items-center justify-end gap-1 text-[10px] text-slate-500" title={freshness.detail}>
                <Clock3 className="h-3 w-3" aria-hidden />{freshness.label}
              </p>
            )}
          </div>
        ) : (
          '—'
        )}
      </td>
      <td className="num text-slate-100">{value != null ? inrSmart(value) : '—'}</td>
      <td className={clsx('num font-medium', unrealized != null ? signTone(unrealized) : 'text-slate-500')}>
        {unrealized != null ? signedInr(unrealized) : '—'}
        {num(p.unrealizedPnlPct) != null && (
          <span className="block text-[11px] font-normal">{signedPct(p.unrealizedPnlPct as number)}</span>
        )}
      </td>
      <td className={clsx('num', num(p.realizedPnl) != null ? signTone(p.realizedPnl as number) : 'text-slate-500')}>
        {num(p.realizedPnl) != null ? signedInr(p.realizedPnl as number) : '—'}
      </td>
      <td className="num"><ProjectionCells p={p} /></td>
      <td className="text-right">
        <Button variant="ghost" size="sm" onClick={() => onOpenStock(p.ticker)} aria-label={`Open ${p.ticker} details`}>
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </td>
    </tr>
  );
}

/* ------------------------------------------------------------------ */
/* View                                                                */
/* ------------------------------------------------------------------ */

export function HoldingsView({
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
  const [correcting, setCorrecting] = useState<TransactionRecord | null>(null);

  const holdingsQ = useQuery({
    queryKey: ['holdings'],
    queryFn: getHoldings,
    staleTime: 60_000,
    retry: false,
    enabled: auth?.status !== 'unauthenticated',
  });

  const totals = useMemo(() => {
    const d = holdingsQ.data;
    if (!d) return null;
    const t = d.totals ?? {};
    const positions = d.positions ?? [];
    const sum = (f: (p: HoldingPosition) => number | null): number | null => {
      let acc = 0;
      let any = false;
      for (const p of positions) {
        const v = f(p);
        if (v != null) {
          acc += v;
          any = true;
        }
      }
      return any ? acc : null;
    };
    return {
      basis: num(t.costBasis) ?? num(t.invested) ?? sum(positionBasis),
      value: num(t.marketValue) ?? sum(positionValue),
      unrealized: num(t.unrealizedPnl) ?? sum((p) => num(p.unrealizedPnl)),
      realized: num(t.realizedPnl) ?? sum((p) => num(p.realizedPnl)),
    };
  }, [holdingsQ.data]);

  const hero = (
    <ViewHero
      eyebrow="your ledger"
      title="Holdings"
      subtitle="Positions are derived from your recorded transactions — invested basis includes allocated charges, P&L separates realized from unrealized, and projections are model estimates never mixed with actuals."
      right={holdingsQ.data?.asOf ? <Chip tone="zinc">as of {fmtDateTime(holdingsQ.data.asOf)}</Chip> : undefined}
    />
  );

  if (authLoading) {
    return (
      <div className="space-y-5">
        {hero}
        <CardSkeleton lines={4} />
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

  if (auth?.status === 'unauthenticated' || (holdingsQ.isError && isUnauthorized(holdingsQ.error))) {
    return <LoginPanel context="Your holdings ledger" />;
  }

  const backendPending = holdingsQ.isError && isNotFound(holdingsQ.error);
  const positions = holdingsQ.data?.positions ?? [];

  return (
    <div className="space-y-5">
      {hero}

      {auth?.status === 'unavailable' && (
        <p className="flex items-start gap-2 rounded-xl border border-amber-400/20 bg-amber-400/5 px-3.5 py-2 text-xs leading-relaxed text-slate-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden />
          {auth.note}
        </p>
      )}

      {/* Summary tiles — actuals only; projections stay in their own labeled column */}
      {holdingsQ.isPending && <CardSkeleton lines={3} />}
      {totals && positions.length > 0 && (
        <Stagger className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          <StaggerItem>
            <StatTile label="Invested basis" value={totals.basis != null ? inrSmart(totals.basis) : '—'} sub="cost incl. allocated charges" />
          </StaggerItem>
          <StaggerItem>
            <StatTile label="Observed value" value={totals.value != null ? inrSmart(totals.value) : '—'} sub="marked at last observed prices" />
          </StaggerItem>
          <StaggerItem>
            <StatTile
              label="Unrealized P&L"
              value={
                <span className={totals.unrealized != null ? signTone(totals.unrealized) : ''}>
                  {totals.unrealized != null ? signedInr(totals.unrealized) : '—'}
                </span>
              }
              sub="marked, before sale charges"
            />
          </StaggerItem>
          <StaggerItem>
            <StatTile
              label="Realized P&L"
              value={
                <span className={totals.realized != null ? signTone(totals.realized) : ''}>
                  {totals.realized != null ? signedInr(totals.realized) : '—'}
                </span>
              }
              sub="actual net sale proceeds − sold basis"
            />
          </StaggerItem>
        </Stagger>
      )}

      {/* Add purchase (or correction) — prefilled from the Watchlist hand-off */}
      <AddPurchaseForm
        initialTicker={pendingPurchaseTicker}
        correcting={correcting}
        onDone={() => {
          setCorrecting(null);
          if (pendingPurchaseTicker) onPendingPurchaseConsumed();
        }}
      />

      {backendPending && (
        <Card className="p-5">
          <EmptyState
            glyph="radar"
            title="The holdings ledger has not shipped on this backend yet"
            message="GET /api/holdings (upgrade slice B2) is pending on this server, so no positions can be shown. Nothing is fabricated — this screen activates as soon as the backend slice lands."
          />
        </Card>
      )}

      {holdingsQ.isError && !backendPending && !isUnauthorized(holdingsQ.error) && (
        <ErrorState
          message={holdingsQ.error instanceof Error ? holdingsQ.error.message : 'Could not load holdings.'}
          onRetry={() => holdingsQ.refetch()}
        />
      )}

      {holdingsQ.data && positions.length === 0 && (
        <Card className="p-5">
          <EmptyState
            glyph="slash"
            title="No holdings yet"
            message="Record your first purchase above — date, quantity, price and charges. Watch-only stocks never appear here."
          />
        </Card>
      )}

      {positions.length > 0 && (
        <Card className="overflow-hidden p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="font-display text-sm font-semibold tracking-tight text-slate-100">Positions</h3>
            <p className="text-[11px] text-slate-500">
              &ldquo;Projected 30d&rdquo; is a <strong>model estimate</strong> from the same forecast Stock Detail
              shows — it is not realized profit and no sale charges are subtracted.
            </p>
          </div>
          <div className="thin-scroll mt-3 overflow-x-auto rounded-xl border border-white/6">
            <table className="table-premium min-w-[860px]">
              <thead>
                <tr>
                  <th>Position</th>
                  <th className="num">Basis</th>
                  <th className="num">Price</th>
                  <th className="num">Value</th>
                  <th className="num">Unrealized</th>
                  <th className="num">Realized</th>
                  <th className="num">Projected 30d (model estimate)</th>
                  <th aria-label="actions" />
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => (
                  <PositionRow key={p.ticker} p={p} onOpenStock={onOpenStock} />
                ))}
              </tbody>
            </table>
          </div>
          {holdingsQ.data?.note && (
            <p className="mt-2 text-[11px] leading-relaxed text-slate-500">{holdingsQ.data.note}</p>
          )}
        </Card>
      )}

      {/* Immutable transactions history + corrections + CSV import/export */}
      <TransactionsPanel onCorrect={(tx) => setCorrecting(tx)} />
    </div>
  );
}
