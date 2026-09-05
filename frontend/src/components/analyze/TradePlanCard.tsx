'use client';

import clsx from 'clsx';
import { AlertTriangle, ShieldOff } from 'lucide-react';
import type { InvestmentPlan, TradePlan } from '@/lib/types';
import { inr, inrSmart, pct, plain, signedInr } from '@/lib/format';
import { Card, Chip, SectionTitle } from '@/components/ui';

/**
 * Horizontal price ladder: stop (rose) — entry (ink tick) — target (emerald).
 * Status colors always ship with text labels, never color alone.
 */
function PriceLadder({ plan }: { plan: TradePlan }) {
  const span = plan.target - plan.stopLoss;
  const rawPos = span > 0 ? ((plan.entry - plan.stopLoss) / span) * 100 : 50;
  const entryPos = Math.min(92, Math.max(8, rawPos));

  return (
    <div className="mt-2">
      {/* Entry label above the tick */}
      <div className="relative h-5">
        <p
          className="absolute -translate-x-1/2 text-xs font-medium whitespace-nowrap text-slate-200"
          style={{ left: `${entryPos}%` }}
        >
          Entry {inr(plan.entry)}
        </p>
      </div>
      <div className="relative">
        <div className="flex h-2 overflow-hidden rounded-full">
          <div className="bg-sell/70" style={{ width: `${entryPos}%` }} aria-hidden />
          <div className="flex-1 bg-buy/70" aria-hidden />
        </div>
        <div
          aria-hidden
          className="absolute -top-1 h-4 w-1 -translate-x-1/2 rounded-full bg-slate-100"
          style={{ left: `${entryPos}%` }}
        />
      </div>
      <div className="mt-2 flex items-start justify-between gap-4 text-xs">
        <div>
          <p className="font-semibold text-sell">Stop {inr(plan.stopLoss)}</p>
          <p className="mt-0.5 text-slate-500">−{plain(Math.abs(plan.stopLossPct), 1)}% risk</p>
        </div>
        <div className="text-right">
          <p className="font-semibold text-buy">Target {inr(plan.target)}</p>
          <p className="mt-0.5 text-slate-500">+{plain(Math.abs(plan.targetPct), 1)}% reward</p>
        </div>
      </div>
    </div>
  );
}

function PlanStat({
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
    <div className="glass-inset px-3 py-2.5">
      <p className="text-[11px] text-slate-500">{label}</p>
      <p className={clsx('font-display mt-0.5 text-sm font-semibold text-slate-100 tabular-nums', valueClassName)}>
        {value}
      </p>
      {sub != null && <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{sub}</p>}
    </div>
  );
}

export function TradePlanCard({
  tradePlan,
  investmentPlan,
}: {
  tradePlan: TradePlan | null;
  investmentPlan: InvestmentPlan | null;
}) {
  if (!tradePlan) {
    return (
      <Card className="flex items-start gap-3 p-5">
        <ShieldOff className="mt-0.5 h-5 w-5 shrink-0 text-slate-500" aria-hidden />
        <div>
          <SectionTitle>No trade plan</SectionTitle>
          <p className="mt-1 text-sm leading-relaxed text-slate-400">
            The recommendation for this stock is AVOID, so no entry/stop/target is suggested. Capital preservation
            comes before opportunity.
          </p>
        </div>
      </Card>
    );
  }

  const feesPctHigh = investmentPlan ? investmentPlan.estimatedFees.roundTripPct > 0.5 : false;

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionTitle>Trade plan</SectionTitle>
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone="sky">R:R {plain(tradePlan.rewardRiskRatio, 1)} : 1</Chip>
          {tradePlan.meetsRewardRisk ? (
            <Chip tone="emerald">reward:risk met</Chip>
          ) : (
            <Chip tone="amber">reward:risk not met</Chip>
          )}
        </div>
      </div>

      <PriceLadder plan={tradePlan} />

      {tradePlan.note && (
        <p
          className={clsx(
            'mt-3 text-xs leading-relaxed',
            tradePlan.meetsRewardRisk ? 'text-slate-500' : 'text-amber-400',
          )}
        >
          {tradePlan.note}
        </p>
      )}

      {investmentPlan && (
        <div className="mt-5 border-t border-white/8 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-slate-100">Your {inr(investmentPlan.amount, 0)} plan</p>
            <p className="text-xs text-slate-500">
              {investmentPlan.shares} share{investmentPlan.shares === 1 ? '' : 's'} · cash left{' '}
              {inrSmart(investmentPlan.cashLeft)}
            </p>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
            <PlanStat label="Shares" value={plain(investmentPlan.shares, 0)} />
            <PlanStat label="Invested" value={inrSmart(investmentPlan.invested)} />
            <PlanStat
              label="Max loss at stop"
              value={signedInr(-Math.abs(investmentPlan.maxLossAtStop))}
              valueClassName="text-sell"
            />
            <PlanStat
              label="Gain at target"
              value={signedInr(Math.abs(investmentPlan.gainAtTarget))}
              valueClassName="text-buy"
            />
            <PlanStat
              label="Est. fees (round trip)"
              value={
                <span className={clsx('inline-flex items-center gap-1.5', feesPctHigh && 'text-amber-400')}>
                  {feesPctHigh && <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />}
                  {inr(investmentPlan.estimatedFees.roundTrip)} ({pct(investmentPlan.estimatedFees.roundTripPct, 2)})
                </span>
              }
              sub={investmentPlan.estimatedFees.note}
            />
            <PlanStat
              label="2% rule sizing"
              value={`${plain(investmentPlan.positionSizing2pct.suggestedShares, 0)} shares (${inrSmart(
                investmentPlan.positionSizing2pct.suggestedInvestment,
              )})`}
              sub={`Risk budget ${inrSmart(investmentPlan.positionSizing2pct.riskBudget)} — ${investmentPlan.positionSizing2pct.note}`}
            />
          </div>

          {feesPctHigh && (
            <p className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-amber-400">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              Fees are {pct(investmentPlan.estimatedFees.roundTripPct, 2)} of this position — above 0.5%, small
              positions are fee-inefficient.
            </p>
          )}

          {investmentPlan.warnings.length > 0 && (
            <ul className="mt-3 space-y-1.5">
              {investmentPlan.warnings.map((w, i) => (
                <li key={i} className="flex items-start gap-2 text-xs leading-relaxed text-amber-400">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  {w}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}
