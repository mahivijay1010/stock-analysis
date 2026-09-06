'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { getAdminAccount, getPredictionAudit, recordAdminTrade } from '@/lib/api';
import type { AdminAccountResponse, RecordTradeRequest } from '@/lib/types';
import { inr, inrSmart, signedInr } from '@/lib/format';
import {
  AnimatedNumber,
  Card,
  Chip,
  ErrorState,
  Skeleton,
  ViewHero,
} from '@/components/ui';
import { signTone } from './desk-ui';
import { PositionsTable } from './PositionsTable';
import { TradeHistoryTable } from './TradeHistoryTable';
import { EquityCurveChart } from './EquityCurveChart';
import { PredictionAudit } from './PredictionAudit';
import { ForecastLockCard } from './ForecastLockCard';

/*
 * v2 upgrade (upgrade-spec §2): the paper desk is now an isolated SANDBOX in
 * secondary navigation. Records preserved; the daily pick / cash-split
 * allocation / goal-milestone path / Kelly feedback were removed from the
 * product. What remains is honest record-keeping: account state, manual paper
 * trades, positions with exit advice, prediction audit (incl. the daily loss
 * guard), forecast locks, and the trade log.
 */

function DeckStat({
  label,
  value,
  sub,
  valueClassName,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className="glass-inset px-4 py-3">
      <p className="text-[11px] font-medium tracking-[0.08em] text-slate-500 uppercase">{label}</p>
      <p className={clsx('font-display mt-1 text-lg font-semibold tracking-tight text-slate-100 tabular-nums', valueClassName)}>
        {value}
      </p>
      {sub != null && <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{sub}</p>}
    </div>
  );
}

function CommandDeck({ account }: { account: AdminAccountResponse }) {
  const unrealized = account.openPositions.reduce((s, p) => s + p.unrealizedPnl, 0);
  const totalPnl = account.equity - account.account.startCapital;

  return (
    <Card elevated className="p-5">
      <div className="grid grid-cols-1 gap-x-8 gap-y-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] lg:items-end">
        <div className="min-w-0">
          <p className="text-[11px] font-medium tracking-[0.08em] text-slate-500 uppercase">Sandbox equity</p>
          <p className="font-display mt-1 text-display-sm font-semibold tracking-tight text-slate-100">
            <AnimatedNumber value={account.equity} format={inrSmart} />
          </p>
          <p className="mt-1 text-xs text-slate-500">cash + open positions at live prices · paper money only</p>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <DeckStat
            label="Cash"
            value={<AnimatedNumber value={account.account.cash} format={inrSmart} />}
            sub={`start capital ${inr(account.account.startCapital, 0)}`}
          />
          <DeckStat
            label="Total P&L"
            value={
              <span className={signTone(totalPnl)}>
                <AnimatedNumber value={totalPnl} format={signedInr} />
              </span>
            }
            sub={`realized ${signedInr(account.realizedPnl)} · unrealized ${signedInr(unrealized)}`}
          />
        </div>
      </div>
    </Card>
  );
}

function AccountSkeleton() {
  return (
    <Card elevated className="p-5">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div>
          <Skeleton className="h-3 w-24" />
          <Skeleton className="mt-2 h-8 w-40" />
          <Skeleton className="mt-2 h-3 w-52" />
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="glass-inset px-4 py-3">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="mt-2 h-5 w-24" />
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

/** Manual paper trade entry (BUY/SELL by ticker + qty at live quote). */
function RecordTradeCard({
  onRecord,
  pending,
  error,
}: {
  onRecord: (req: RecordTradeRequest) => void;
  pending: boolean;
  error: string | null;
}) {
  const [ticker, setTicker] = useState('');
  const [qty, setQty] = useState('');
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');

  const canSubmit = ticker.trim().length > 0 && Number(qty) > 0 && !pending;

  return (
    <Card className="p-5">
      <p className="font-display text-sm font-semibold tracking-wide text-slate-100">Record a paper trade</p>
      <p className="mt-1 text-xs text-slate-500">
        Fills at the live quote with real delivery-fee estimates. Paper money only — no real order is placed.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="sbx-ticker" className="text-[11px] text-slate-500">Ticker / company</label>
          <input
            id="sbx-ticker"
            type="text"
            value={ticker}
            onChange={(e) => setTicker(e.target.value)}
            placeholder="e.g. SBIN"
            className="input-glass mt-1 px-3 py-2"
          />
        </div>
        <div>
          <label htmlFor="sbx-qty" className="text-[11px] text-slate-500">Quantity</label>
          <input
            id="sbx-qty"
            type="text"
            inputMode="numeric"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            placeholder="shares"
            className="input-glass mt-1 w-28 px-3 py-2"
          />
        </div>
        <div className="inline-flex rounded-lg border border-white/8 bg-white/4 p-0.5">
          {(['BUY', 'SELL'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSide(s)}
              className={clsx(
                'rounded-md px-3 py-1.5 text-xs font-semibold transition-colors',
                side === s ? (s === 'BUY' ? 'bg-buy/20 text-buy' : 'bg-sell/20 text-sell') : 'text-slate-400',
              )}
            >
              {s}
            </button>
          ))}
        </div>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => onRecord({ ticker: ticker.trim(), side, qty: Math.floor(Number(qty)) })}
          className="btn-primary px-4 py-2 text-sm"
        >
          Record {side}
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-sell">{error}</p>}
    </Card>
  );
}

export function SandboxView({ onOpenStock }: { onOpenStock: (ticker: string) => void }) {
  const qc = useQueryClient();

  const accountQ = useQuery({
    queryKey: ['admin', 'account'],
    queryFn: getAdminAccount,
    staleTime: 30_000,
    refetchInterval: 60_000, // keep live P&L fresh
  });

  // Loss guard now lives in the prediction audit response.
  const auditQ = useQuery({
    queryKey: ['admin', 'prediction-audit'],
    queryFn: getPredictionAudit,
    staleTime: 5 * 60_000,
  });

  const tradeMut = useMutation({
    mutationFn: (req: RecordTradeRequest) => recordAdminTrade(req),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin'] });
    },
  });

  const pendingVars = tradeMut.isPending ? tradeMut.variables : null;
  const errorVars = tradeMut.isError ? tradeMut.variables : null;
  const mutErrMsg = tradeMut.error instanceof Error ? tradeMut.error.message : 'Trade could not be recorded.';
  const buyError = errorVars?.side === 'BUY' ? mutErrMsg : null;
  const sellError = errorVars?.side === 'SELL' ? mutErrMsg : null;

  const account = accountQ.data;
  const trades = account?.trades ?? account?.history ?? null;
  const guard = auditQ.data?.lossGuard ?? null;

  return (
    <div className="space-y-5">
      <ViewHero
        eyebrow="Isolated sandbox"
        title="Paper Trading Sandbox"
        subtitle={
          <>
            <span className="font-medium text-slate-300">Practice and validation only — paper money.</span> Every
            forecast here was logged before its outcome was knowable and is graded against real closes. Nothing on
            this page is a recommendation.
          </>
        }
        right={
          account ? (
            <>
              <Chip tone="cyan" glow>
                equity&nbsp;
                <span className="font-display font-semibold">
                  <AnimatedNumber value={account.equity} format={inrSmart} />
                </span>
              </Chip>
              <Chip tone="zinc">account: {account.account.name}</Chip>
            </>
          ) : undefined
        }
      />

      {guard?.halted && (
        <div className="rounded-2xl border border-sell/40 bg-sell/10 p-4" role="alert">
          <p className="font-display text-sm font-semibold tracking-wide text-sell">
            Daily loss guard tripped — paper trading halted for today
          </p>
          <p className="mt-1 text-sm leading-relaxed text-slate-200">{guard.message}</p>
        </div>
      )}

      {accountQ.isPending && <AccountSkeleton />}
      {accountQ.isError && (
        <ErrorState
          message={accountQ.error instanceof Error ? accountQ.error.message : 'Could not load the paper account.'}
          onRetry={() => accountQ.refetch()}
        />
      )}

      {account && <CommandDeck account={account} />}

      <RecordTradeCard
        onRecord={(req) => tradeMut.mutate(req)}
        pending={tradeMut.isPending}
        error={buyError ?? sellError}
      />

      {account && (
        <>
          <PositionsTable
            positions={account.openPositions}
            onRecordSell={(req) => tradeMut.mutate(req)}
            sellingTicker={pendingVars?.side === 'SELL' ? pendingVars.ticker : null}
            sellError={sellError}
            onAnalyze={onOpenStock}
          />
          <EquityCurveChart curve={account.equityCurve} startCapital={account.account.startCapital} />
        </>
      )}

      {/* The model confronting reality — includes the daily loss guard */}
      <PredictionAudit />

      {/* Forecast Lock — every BUY freezes its purchase-day 7d/30d forecast */}
      <ForecastLockCard />

      <TradeHistoryTable trades={trades} loading={accountQ.isPending} unavailable={accountQ.isError} />

      <p className="px-1 text-xs leading-relaxed text-slate-500">
        This sandbox is for disciplined practice, not promises. Position advice comes from measured signals
        (stop/target hits and quant momentum). Paper fills assume zero slippage — real results will be worse.
      </p>
    </div>
  );
}
