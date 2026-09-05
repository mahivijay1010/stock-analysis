'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlertTriangle, Calculator, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import { getAdminAccount, getAdminDailyPlan, getAdminTrades, recordAdminTrade } from '@/lib/api';
import type { AdminAccountResponse, LossGuard, RecordTradeRequest } from '@/lib/types';
import { fmtDate, inr, inrSmart, plain, signedInr } from '@/lib/format';
import {
  AnimatedNumber,
  Card,
  CardSkeleton,
  Chip,
  Collapsible,
  ErrorState,
  SectionTitle,
  Skeleton,
  ViewHero,
} from '@/components/ui';
import { signTone } from './desk-ui';
import { MilestonePath } from './GoalStepper';
import { SettingsCard } from './SettingsCard';
import { TodayPlanCard } from './TodayPlanCard';
import { PositionsTable } from './PositionsTable';
import { TradeHistoryTable } from './TradeHistoryTable';
import { EquityCurveChart } from './EquityCurveChart';
import { PredictionAudit } from './PredictionAudit';
import { PerformanceFeedbackCard } from './PerformanceFeedbackCard';
import { ForecastLockCard } from './ForecastLockCard';
import { AllocationCard } from '@/components/AllocationCard';
import { HoldingCalculator } from '@/components/HoldingCalculator';
import { StressTestCard } from '@/components/StressTestCard';

/**
 * The reality check is REQUIRED honest copy — always rendered first, full
 * width, never collapsible, never dismissable. Do not remove or minimize it.
 */
function RealityCheckCallout({
  text,
  loading,
  error,
  onRetry,
}: {
  text: string | null;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  return (
    <div
      className="rounded-2xl border border-amber-400/40 bg-amber-400/10 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-xl"
      role="note"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-display text-sm font-semibold tracking-wide text-amber-400">Reality check — read this first</p>
          {/* Height ladder mirrors the measured height of the real reality-check
              paragraph (250px @412px … 68px @1440px) so the swap-in doesn't
              shove the whole desk down (was the top CLS contributor, 0.251). */}
          {loading && <Skeleton className="mt-2 h-[246px] sm:h-32 md:h-24 lg:h-20 xl:h-16" />}
          {!loading && error && (
            <div className="mt-1">
              <p className="text-sm leading-relaxed text-slate-200">
                Could not load the reality check from the server. The milestone path shown below is aspirational, not
                a promise — do not trade against it without reading the measured-odds context.
              </p>
              <button
                type="button"
                onClick={onRetry}
                className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-amber-400/40 px-3 py-1.5 text-xs font-medium text-amber-400 transition-colors hover:bg-amber-400/10"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                Retry
              </button>
            </div>
          )}
          {!loading && !error && text && (
            <p className="mt-1 text-sm leading-relaxed text-slate-200">{text}</p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Daily 3% loss circuit-breaker. Halted → prominent sell-red banner (the
 * plan's pick/allocation will be null with the same reason). Not halted → one
 * slim reassuring line so the guard is visibly on duty.
 */
function LossGuardBanner({ guard }: { guard: LossGuard }) {
  if (guard.halted) {
    return (
      <div
        className="rounded-2xl border border-sell/40 bg-sell/10 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_0_30px_rgba(255,77,109,0.12)] backdrop-blur-xl"
        role="alert"
      >
        <div className="flex items-start gap-3">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-sell" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-display text-sm font-semibold tracking-wide text-sell">
              Daily loss guard tripped — trading halted for today
            </p>
            <p className="mt-1 text-sm leading-relaxed text-slate-200">{guard.message}</p>
            <p className="mt-2 text-xs text-slate-400">
              Drawdown counted {signedInr(-Math.abs(guard.effectiveDrawdown))} of the {inr(guard.limit, 0)} cap (
              {guard.limitPct}% of equity) — realized {signedInr(guard.todayRealizedPnl)} · open{' '}
              {signedInr(guard.openUnrealizedPnl)}.
            </p>
          </div>
        </div>
      </div>
    );
  }
  return (
    <p className="flex items-center gap-2 rounded-xl border border-buy/20 bg-buy/5 px-3.5 py-2 text-xs text-slate-400">
      <ShieldCheck className="h-4 w-4 shrink-0 text-buy" aria-hidden />
      <span>
        Daily loss guard: cap <span className="font-semibold text-slate-200 tabular-nums">{inr(guard.limit, 0)}</span> (
        {guard.limitPct}% of equity) — <span className="font-medium text-buy">trading allowed</span>
        <span className="text-slate-500">
          {' '}
          · counted so far: realized {signedInr(guard.todayRealizedPnl)}, open drawdown {signedInr(guard.openUnrealizedPnl)}
        </span>
      </span>
    </p>
  );
}

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

/**
 * Command deck — equity headline (animated), cash/P&L/day stats and the
 * animated milestone path in one surface. Renders strictly BELOW the reality
 * check; the path keeps its own aspirational label.
 */
function CommandDeck({ account }: { account: AdminAccountResponse }) {
  const unrealized = account.openPositions.reduce((s, p) => s + p.unrealizedPnl, 0);
  const totalPnl = account.equity - account.account.startCapital;
  const milestones = account.goals.milestones;
  const lastDay = milestones.length > 0 ? Math.max(...milestones.map((m) => m.day)) : 30;

  return (
    <Card elevated className="p-5">
      <div className="grid grid-cols-1 gap-x-8 gap-y-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] lg:items-end">
        <div className="min-w-0">
          <p className="text-[11px] font-medium tracking-[0.08em] text-slate-500 uppercase">Desk equity</p>
          <p className="font-display mt-1 text-display-sm font-semibold tracking-tight text-slate-100">
            <AnimatedNumber value={account.equity} format={inrSmart} />
          </p>
          <p className="mt-1 text-xs text-slate-500">cash + open positions at live prices · paper money only</p>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
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
          <DeckStat
            label="Challenge day"
            value={`Day ${plain(account.goals.currentDay, 0)} of ${plain(lastDay, 0)}`}
            sub={`started ${fmtDate(account.goals.startedAt)}`}
          />
        </div>
      </div>

      <div className="mt-5 border-t border-white/8 pt-4">
        <MilestonePath goals={account.goals} startCapital={account.account.startCapital} />
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
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="glass-inset px-4 py-3">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="mt-2 h-5 w-24" />
            </div>
          ))}
        </div>
      </div>
      {/* Milestone-path placeholder sized to the real path's measured height
          (deck total 705px @412 / 362px @1440) — h-24 undershot by ~230px and
          let the whole page jump when the account arrived. */}
      <Skeleton className="mt-6 h-[330px] sm:h-64 lg:h-56" />
    </Card>
  );
}

export function AdminView({ onAnalyze }: { onAnalyze: (ticker: string) => void }) {
  const qc = useQueryClient();
  const [recordingAll, setRecordingAll] = useState(false);
  const [recordAllError, setRecordAllError] = useState<string | null>(null);

  const accountQ = useQuery({
    queryKey: ['admin', 'account'],
    queryFn: getAdminAccount,
    staleTime: 30_000,
    refetchInterval: 60_000, // keep live P&L fresh
  });

  const planQ = useQuery({
    queryKey: ['admin', 'daily-plan'],
    queryFn: getAdminDailyPlan,
    staleTime: 5 * 60_000,
  });

  const historyFromAccount = accountQ.data?.trades ?? accountQ.data?.history ?? null;
  const tradesQ = useQuery({
    queryKey: ['admin', 'trades'],
    queryFn: getAdminTrades,
    staleTime: 30_000,
    retry: false,
    enabled: accountQ.isSuccess && !historyFromAccount,
  });

  const tradeMut = useMutation({
    mutationFn: (req: RecordTradeRequest) => recordAdminTrade(req),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin'] });
    },
  });

  // Record every leg of the allocation sequentially (stops at the first failure).
  const recordAll = async () => {
    const stocks = planQ.data?.allocation?.stocks ?? [];
    if (stocks.length === 0 || recordingAll) return;
    setRecordingAll(true);
    setRecordAllError(null);
    try {
      for (const s of stocks) {
        await recordAdminTrade({ ticker: s.ticker, side: 'BUY', qty: s.qty });
      }
    } catch (err) {
      setRecordAllError(err instanceof Error ? err.message : 'One of the BUYs could not be recorded.');
    } finally {
      setRecordingAll(false);
      qc.invalidateQueries({ queryKey: ['admin'] });
    }
  };

  const pendingVars = tradeMut.isPending ? tradeMut.variables : null;
  const errorVars = tradeMut.isError ? tradeMut.variables : null;
  const mutErrMsg = tradeMut.error instanceof Error ? tradeMut.error.message : 'Trade could not be recorded.';
  const buyError = errorVars?.side === 'BUY' ? mutErrMsg : null;
  const sellError = errorVars?.side === 'SELL' ? mutErrMsg : null;

  const account = accountQ.data;

  // V7 — stress-test input from open positions: market-value weights per ticker
  // (duplicate tickers merged). Null when there are no live-priced positions
  // → the stress card is hidden entirely.
  const stressInput = useMemo(() => {
    const positions = accountQ.data?.openPositions ?? [];
    const byTicker = new Map<string, number>();
    for (const p of positions) {
      const mv = p.trade.qty * p.livePrice;
      if (!Number.isFinite(mv) || mv <= 0) continue;
      byTicker.set(p.trade.ticker, (byTicker.get(p.trade.ticker) ?? 0) + mv);
    }
    const total = Array.from(byTicker.values()).reduce((s, v) => s + v, 0);
    if (byTicker.size === 0 || total <= 0) return null;
    return {
      tickers: Array.from(byTicker.keys()),
      weights: Array.from(byTicker.values()).map((v) => Number((v / total).toFixed(4))),
    };
  }, [accountQ.data]);

  const trades = historyFromAccount ?? tradesQ.data ?? null;
  const historyUnavailable = !historyFromAccount && (tradesQ.isError || accountQ.isError);
  const historyLoading =
    !historyFromAccount && !tradesQ.isError && !accountQ.isError && trades == null;

  return (
    <div className="space-y-5">
      <ViewHero
        eyebrow="Command center"
        title="Trading Desk"
        subtitle={
          <>
            <span className="font-medium text-slate-300">Practice, validate, improve.</span> Paper money only. Every
            suggestion is logged BEFORE the outcome and verified against real closes — the desk exists to prove the
            model right or catch it being wrong.
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

      {/* Always-visible, non-dismissable reality check — stays FIRST */}
      <RealityCheckCallout
        text={planQ.data?.realityCheck ?? null}
        loading={planQ.isPending}
        error={planQ.isError}
        onRetry={() => planQ.refetch()}
      />

      {/* Daily loss circuit-breaker (from the daily plan). While the plan
          loads, hold the slot (measured 66px @412 / 34px @1440) so the line
          doesn't pop in and shift everything below it. */}
      {planQ.isPending && <Skeleton className="h-[66px] rounded-xl sm:h-10 lg:h-[34px]" />}
      {planQ.data?.lossGuard && <LossGuardBanner guard={planQ.data.lossGuard} />}

      {accountQ.isPending && <AccountSkeleton />}
      {accountQ.isError && (
        <ErrorState
          message={accountQ.error instanceof Error ? accountQ.error.message : 'Could not load the paper account.'}
          onRetry={() => accountQ.refetch()}
        />
      )}

      {/* Equity headline + animated milestone path */}
      {account && <CommandDeck account={account} />}

      {/* Action cards — today's pick and the allocation legs */}
      {planQ.isPending && <CardSkeleton lines={5} />}
      {planQ.isError && (
        <Card className="p-5">
          <SectionTitle>Today&apos;s plan</SectionTitle>
          <div className="mt-3">
            <ErrorState
              compact
              message={planQ.error instanceof Error ? planQ.error.message : 'Could not load the daily plan.'}
              onRetry={() => planQ.refetch()}
            />
          </div>
        </Card>
      )}
      {planQ.data && (
        <>
          <TodayPlanCard
            plan={planQ.data}
            onRecordBuy={(req) => tradeMut.mutate(req)}
            buying={pendingVars?.side === 'BUY'}
            buyError={buyError}
            onAnalyze={onAnalyze}
          />
          <AllocationCard
            allocation={planQ.data.allocation}
            reason={planQ.data.allocationReason}
            title="How to split your cash today"
            onAnalyze={onAnalyze}
            onRecordBuy={(req) => tradeMut.mutate(req)}
            recordingTicker={pendingVars?.side === 'BUY' ? pendingVars.ticker : null}
            onRecordAll={recordAll}
            recordingAll={recordingAll}
            recordError={recordAllError ?? buyError}
          />
        </>
      )}

      {account && (
        <>
          <PositionsTable
            positions={account.openPositions}
            onRecordSell={(req) => tradeMut.mutate(req)}
            sellingTicker={pendingVars?.side === 'SELL' ? pendingVars.ticker : null}
            sellError={sellError}
            onAnalyze={onAnalyze}
          />

          <EquityCurveChart
            curve={account.equityCurve}
            goals={account.goals}
            startCapital={account.account.startCapital}
          />

          {/* V7 — stress test of the OPEN positions (hidden when none, or when
              the backend hasn't shipped /api/portfolio/stress) */}
          {stressInput && (
            <StressTestCard
              title="Stress test — open positions"
              tickers={stressInput.tickers}
              weights={stressInput.weights}
            />
          )}
        </>
      )}

      {/* ---- Collapsible dashboard sections (open state persists per id) ---- */}

      {/* The model confronting reality — verdict always visible, evidence collapsible */}
      <PredictionAudit />

      {/* V9 — measured feedback loop over the SAME ledger the log below shows.
          Hides itself on an older backend (404 on /api/execution/summary). */}
      <PerformanceFeedbackCard />

      {/* Forecast Lock — every BUY freezes its purchase-day 7d/30d forecast;
          reality grades it at the target date. Hides itself on an older
          backend (404 on /api/admin/forecast-locks). */}
      <ForecastLockCard />

      <TradeHistoryTable trades={trades} loading={historyLoading} unavailable={historyUnavailable} />

      {/* "I bought at X — what can I book?" — works for any stock, not just paper positions */}
      <Collapsible
        id="desk.holdings"
        className="px-1"
        title={
          <span className="flex items-center gap-2">
            <Calculator className="h-4 w-4 shrink-0 text-cyan-400" aria-hidden />
            Holdings calculator
          </span>
        }
        subtitle="Already holding? Bookable profit after real delivery fees — any stock, not just paper positions."
        defaultOpen={false}
      >
        <HoldingCalculator />
      </Collapsible>

      {account && <SettingsCard startCapital={account.account.startCapital} goals={account.goals} />}

      <p className={clsx('px-1 text-xs leading-relaxed text-slate-500')}>
        This desk is for disciplined practice, not promises. Position advice comes from measured signals (stop/target
        hits and quant momentum), and the milestone path stays visible only alongside its reality check.
      </p>
    </div>
  );
}
