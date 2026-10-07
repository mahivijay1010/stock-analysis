'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronDown, Gauge, Loader2, RefreshCw, ShieldAlert, Sparkles, TrendingUp } from 'lucide-react';
import { getConvictionBoard, runWideScan, ConvictionBoard, ScoredConviction, ConvictionTier } from '@/lib/api';
import { Button, Card, Chip, Input } from '@/components/ui';
import { useAuth } from '@/components/auth/useAuth';

/**
 * Conviction Board — the sub-₹100 shortlist, tiered by EVIDENCE strength and
 * reward:risk geometry. The one thing this panel must never do is read as a
 * profit promise, so the honest framing is load-bearing: the caveat is always
 * visible, an empty HIGH tier is shown as an honest "nothing qualifies", and
 * every card pairs its upside (reward:risk) with its risk (AI flags, EV).
 */

const TIER_META: Record<ConvictionTier, { label: string; sub: string; tone: 'emerald' | 'amber' | 'zinc'; ring: string; icon: typeof TrendingUp }> = {
  HIGH: { label: 'High conviction', sub: 'strongest evidence available today', tone: 'emerald', ring: 'border-emerald-500/30', icon: Sparkles },
  MEDIUM: { label: 'Medium conviction', sub: 'a real setup, a gate still unmet', tone: 'amber', ring: 'border-amber-500/25', icon: TrendingUp },
  LOW: { label: 'Low / avoid', sub: 'weak geometry or flagged risk', tone: 'zinc', ring: 'border-white/10', icon: ShieldAlert },
};

function money(n: number | null): string {
  return n == null ? '—' : `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

function rrTone(rr: number | null): string {
  if (rr == null) return 'text-slate-500';
  if (rr >= 1.5) return 'text-emerald-300';
  if (rr >= 1) return 'text-amber-300';
  return 'text-rose-300';
}

function ConvictionCard({ s, onOpen }: { s: ScoredConviction; onOpen: (t: string) => void }) {
  const [open, setOpen] = useState(false);
  const capLabel =
    s.aiCapAction === 'CAP_TO_NO_TRADE' ? 'AI: avoid' : s.aiCapAction === 'CAP_TO_WATCH' ? 'AI: watch only' : s.aiCapAction === 'AFFIRM' ? 'AI: no veto' : 'AI: not reviewed';
  return (
    <div className={clsx('rounded-xl border bg-white/[0.02] p-3 transition', TIER_META[s.tier].ring)}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <button onClick={() => onOpen(s.ticker)} className="truncate font-semibold text-slate-100 hover:text-cyan-300 hover:underline">
              {s.symbol}
            </button>
            {s.buyGrade && <Chip tone="emerald" glow>BUY-grade</Chip>}
            {s.tradeabilityBlocked && <Chip tone="rose" title={s.tradeabilityReasons.join(' · ')}>not tradeable</Chip>}
          </div>
          <p className="truncate text-[11px] text-slate-500">{s.companyName ?? s.industry ?? '—'}</p>
        </div>
        <div className="shrink-0 text-right">
          <div className="flex items-center gap-1 text-slate-300">
            <Gauge className="h-3.5 w-3.5 text-slate-500" aria-hidden />
            <span className="font-semibold tabular-nums">{s.score}</span>
          </div>
          <p className="text-[10px] uppercase tracking-wide text-slate-600">conviction</p>
        </div>
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
        <div>
          <p className="text-slate-600">Price</p>
          <p className="tabular-nums text-slate-300">{money(s.price)}</p>
        </div>
        <div>
          <p className="text-slate-600">Reward : risk</p>
          <p className={clsx('tabular-nums font-medium', rrTone(s.rewardRiskToT1))}>{s.rewardRiskToT1 != null ? s.rewardRiskToT1.toFixed(2) : '—'}</p>
        </div>
        <div>
          <p className="text-slate-600">EV / costs</p>
          <p className={clsx('tabular-nums', (s.evAfterCostsPct ?? -1) > 0 ? 'text-emerald-300' : 'text-slate-400')}>
            {s.evAfterCostsPct != null ? `${s.evAfterCostsPct.toFixed(2)}%` : '—'}
          </p>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Chip tone={s.decision === 'BUY' ? 'emerald' : s.decision === 'WATCH' || s.decision === 'WAIT' ? 'amber' : 'zinc'}>{s.decision}</Chip>
        <Chip tone={s.aiCapAction === 'CAP_TO_NO_TRADE' ? 'rose' : 'zinc'} title="AI risk scout — can only cap, never upgrade">
          {capLabel}
        </Chip>
        {s.aiRedFlags > 0 && <Chip tone={s.aiRedFlags >= 7 ? 'rose' : 'zinc'}>{s.aiRedFlags} flags</Chip>}
        <button onClick={() => setOpen((v) => !v)} className="ml-auto inline-flex items-center gap-0.5 text-[11px] text-slate-500 hover:text-slate-300">
          why <ChevronDown className={clsx('h-3 w-3 transition', open && 'rotate-180')} aria-hidden />
        </button>
      </div>

      {open && (
        <div className="mt-2 border-t border-white/10 pt-2">
          {s.entry != null && (
            <div className="mb-2 grid grid-cols-3 gap-2 text-[11px]">
              <div><p className="text-slate-600">Entry ≤</p><p className="tabular-nums text-slate-300">{money(s.entry)}</p></div>
              <div><p className="text-slate-600">Stop</p><p className="tabular-nums text-rose-300">{money(s.stop)}</p></div>
              <div><p className="text-slate-600">Target 1</p><p className="tabular-nums text-emerald-300">{money(s.target1)}</p></div>
            </div>
          )}
          {s.liquidity && (
            <div className="mb-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] sm:grid-cols-4">
              <div><p className="text-slate-600">Daily value</p><p className="tabular-nums text-slate-300">{s.liquidity.medianDailyValueInr20d != null ? `₹${(s.liquidity.medianDailyValueInr20d / 1e7).toFixed(2)}cr` : '—'}</p></div>
              <div><p className="text-slate-600">Days to exit ₹1cr</p><p className="tabular-nums text-slate-300">{s.liquidity.daysToExitAt1crore ?? '—'}</p></div>
              <div><p className="text-slate-600">Delivery 20d</p><p className="tabular-nums text-slate-300">{s.liquidity.delivPct20d != null ? `${s.liquidity.delivPct20d}%` : '—'}</p></div>
              <div><p className="text-slate-600">Circuit band</p><p className="tabular-nums text-slate-300">{s.liquidity.inferredCircuitBandPct != null ? `~${s.liquidity.inferredCircuitBandPct}%` : 'none'}</p></div>
            </div>
          )}
          <ul className="space-y-0.5 text-[11px] text-slate-500">
            {s.reasons.map((r, i) => (
              <li key={i}>• {r}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function TierColumn({ tier, rows, onOpen }: { tier: ConvictionTier; rows: ScoredConviction[]; onOpen: (t: string) => void }) {
  const meta = TIER_META[tier];
  const Icon = meta.icon;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Icon className={clsx('h-4 w-4', tier === 'HIGH' ? 'text-emerald-400' : tier === 'MEDIUM' ? 'text-amber-400' : 'text-slate-500')} aria-hidden />
        <div>
          <h3 className="text-sm font-semibold text-slate-200">{meta.label} <span className="text-slate-600">({rows.length})</span></h3>
          <p className="text-[11px] text-slate-600">{meta.sub}</p>
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/10 p-4 text-center text-[11px] text-slate-600">
          {tier === 'HIGH' ? 'No stock reached high conviction today. That emptiness is the honest answer — nothing qualifies.' : 'Nothing in this tier.'}
        </div>
      ) : (
        rows.map((s) => <ConvictionCard key={s.ticker} s={s} onOpen={onOpen} />)
      )}
    </div>
  );
}

export function ConvictionBoardPanel({ onOpen, scanParams }: { onOpen: (ticker: string) => void; scanParams?: { budgetInr?: number | null; horizon?: '1-3d' | '3-5d' | '5-10d' | '10-21d'; riskPerTradePct?: number | null } }) {
  const { auth } = useAuth();
  const isAuthenticated = auth?.status === 'authenticated';
  const { data, isLoading, isError, refetch } = useQuery<ConvictionBoard>({ queryKey: ['conviction-board'], queryFn: getConvictionBoard, staleTime: 60_000 });
  const [priceInput, setPriceInput] = useState('');

  // Re-evaluate at a new price ceiling: runs the wide-scan at that cap (so the
  // universe actually includes the ₹100–N stocks), then refreshes the board.
  const reEval = useMutation({
    mutationFn: (maxPrice: number) =>
      runWideScan({ priceMax: maxPrice, budgetInr: scanParams?.budgetInr ?? 50000, horizon: scanParams?.horizon ?? '5-10d', riskPerTradePct: scanParams?.riskPerTradePct ?? 0.5 }),
    onSuccess: () => refetch(),
  });

  const generated = useMemo(() => (data?.generatedAt ? new Date(data.generatedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : null), [data?.generatedAt]);
  const ceiling = data?.maxPrice ?? 100;

  const submitPrice = () => {
    const n = Number(priceInput);
    if (Number.isFinite(n) && n >= 6 && n <= 2000) reEval.mutate(Math.round(n));
  };

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-violet-400" aria-hidden />
            <h2 className="font-display text-sm font-semibold tracking-wide text-slate-200">Conviction Board — under ₹{ceiling}, ranked by evidence</h2>
          </div>
          <p className="mt-0.5 max-w-3xl text-[11px] text-slate-500">
            Tiers measure <span className="text-slate-300">how complete the setup is and its reward-to-risk</span> — not the odds of profit. The AI scout can only lower a tier, never raise it.
          </p>
        </div>
        {data && (
          <div className="flex items-center gap-1.5">
            {data.regime && (
              <Chip
                tone={data.regime.regime === 'TREND_UP' ? 'emerald' : data.regime.regime === 'CRISIS' || data.regime.regime === 'TREND_DOWN' ? 'rose' : 'amber'}
                title={data.regime.reasons.join(' · ')}
              >
                {data.regime.regime.replace('_', ' ').toLowerCase()}
              </Chip>
            )}
            <Chip tone={data.buyGradeCount > 0 ? 'emerald' : 'zinc'} glow={data.buyGradeCount > 0}>{data.buyGradeCount} buy-grade</Chip>
            <Chip tone="zinc">{data.evaluated} evaluated</Chip>
            {generated && <Chip tone="zinc" title="last background evaluation">{generated}</Chip>}
          </div>
        )}
      </div>

      {/* Price-ceiling control: the board reflects whatever cap was last scanned. */}
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="text-[11px] text-slate-500">
          Max price ₹
          <Input
            type="number"
            value={priceInput}
            onChange={(e) => setPriceInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submitPrice()}
            placeholder={String(ceiling)}
            className="mt-1 w-28"
            min={6}
            max={2000}
          />
        </label>
        <Button onClick={submitPrice} disabled={!isAuthenticated || reEval.isPending} className="h-9">
          {reEval.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />}
          Re-evaluate at this price
        </Button>
        <p className="text-[11px] text-slate-600">
          {!isAuthenticated
            ? 'Sign in to re-evaluate at a new price.'
            : reEval.isPending
              ? 'Scanning the wider universe and scoring setups — ~30s…'
              : `Showing stocks under ₹${ceiling}. Set a new ceiling (₹6–₹2000) to widen or narrow.`}
        </p>
        {reEval.isError && <p className="text-[11px] text-rose-300">Re-evaluation failed — try again.</p>}
      </div>

      {data && (
        <div className={clsx('mt-3 rounded-lg border p-3 text-[12px]', data.buyGradeCount > 0 ? 'border-emerald-500/25 bg-emerald-500/[0.04] text-emerald-100' : 'border-amber-500/25 bg-amber-500/[0.04] text-amber-100')}>
          {data.headline}
        </div>
      )}

      {isLoading && <p className="mt-4 text-xs text-slate-500">Loading the latest background evaluation…</p>}
      {isError && <p className="mt-4 text-xs text-rose-300">Could not load the board — run the sub-₹100 bot or a wide scan first.</p>}

      {data && (
        <>
          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <TierColumn tier="HIGH" rows={data.high} onOpen={onOpen} />
            <TierColumn tier="MEDIUM" rows={data.medium} onOpen={onOpen} />
            <TierColumn tier="LOW" rows={data.low} onOpen={onOpen} />
          </div>
          <p className="mt-4 border-t border-white/10 pt-3 text-[11px] leading-relaxed text-slate-600">{data.caveat}</p>
        </>
      )}
    </Card>
  );
}
