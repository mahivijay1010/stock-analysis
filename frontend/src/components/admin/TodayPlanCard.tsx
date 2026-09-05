'use client';

import { CalendarCheck2, Target } from 'lucide-react';
import type { DailyPlanResponse, MarketRegime, RecordTradeRequest } from '@/lib/types';
import { fmtDateTime, inr, inrSmart, pct, plain, signedInr } from '@/lib/format';
import type { Tone } from '@/components/ui';
import { Card, Chip, EmptyState, SectionTitle } from '@/components/ui';
import { MiniStat, TradeButton } from './desk-ui';

const REGIME_TONE: Record<MarketRegime['regime'], Tone> = {
  'risk-on': 'buy',
  neutral: 'zinc',
  'risk-off': 'sell',
};

/**
 * Today's plan — the desk's primary action card. One vetted pick with its
 * exact entry/stop/target math, the honest odds line, and the Record BUY
 * action (paper only, always labeled as such).
 */
export function TodayPlanCard({
  plan,
  onRecordBuy,
  buying,
  buyError,
  onAnalyze,
}: {
  plan: DailyPlanResponse;
  onRecordBuy: (req: RecordTradeRequest) => void;
  buying: boolean;
  buyError: string | null;
  onAnalyze: (ticker: string) => void;
}) {
  const { pick, marketRegime } = plan;

  return (
    <Card elevated className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <CalendarCheck2 className="h-4 w-4 text-cyan-400" aria-hidden />
          <SectionTitle>Today&apos;s plan</SectionTitle>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone={REGIME_TONE[marketRegime.regime]}>
            {marketRegime.regime} · {Math.round(marketRegime.score)}/100
          </Chip>
          <Chip tone="zinc">
            VIX {plain(marketRegime.vix.value, 1)} ({marketRegime.vix.zone})
          </Chip>
        </div>
      </div>
      <p className="mt-1 text-xs text-slate-500">
        as of {fmtDateTime(plan.asOf)} · cash available {inrSmart(plan.cash)}
      </p>

      {pick ? (
        <div className="mt-4">
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => onAnalyze(pick.ticker)}
              className="font-display text-lg font-semibold tracking-tight text-slate-100 underline-offset-4 transition-colors hover:text-cyan-400 hover:underline"
            >
              {pick.name}
            </button>
            <Chip tone="zinc">{pick.ticker}</Chip>
            <Chip tone="buy">score {Math.round(pick.score)}</Chip>
            <Chip tone="cyan">P(up, 7d) {pct(pick.directionProb7d * 100, 0)}</Chip>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <MiniStat label="Entry" value={inr(pick.entry)} />
            <MiniStat label="Stop loss" value={inr(pick.stopLoss)} valueClassName="text-sell" />
            <MiniStat label="Target" value={inr(pick.target)} valueClassName="text-buy" />
            <MiniStat label="Qty × price" value={`${plain(pick.qty, 0)} × ${inr(pick.price)}`} />
            <MiniStat label="Invested" value={inrSmart(pick.invested)} />
            <MiniStat label="Max loss" value={signedInr(-Math.abs(pick.maxLoss))} valueClassName="text-sell" />
            <MiniStat
              label="Potential gain"
              value={signedInr(Math.abs(pick.potentialGain))}
              valueClassName="text-buy"
            />
            <MiniStat label="Est. fees" value={inr(pick.fees)} />
          </div>

          {pick.reasons.length > 0 && (
            <ul className="mt-3 space-y-1">
              {pick.reasons.map((r, i) => (
                <li key={i} className="flex items-start gap-2 text-sm leading-relaxed text-slate-300">
                  <span aria-hidden className="mt-2 h-1 w-1 shrink-0 rounded-full bg-buy" />
                  {r}
                </li>
              ))}
            </ul>
          )}

          {pick.historicalOdds && (
            <p className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-slate-400">
              <Target className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cyan-400" aria-hidden />
              {pick.historicalOdds}
            </p>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <TradeButton
              side="BUY"
              loading={buying}
              disabled={pick.qty <= 0}
              onClick={() => onRecordBuy({ ticker: pick.ticker, side: 'BUY', qty: pick.qty })}
            >
              Record BUY — {plain(pick.qty, 0)} × {pick.ticker}
            </TradeButton>
            <span className="text-xs text-slate-500">Paper trade only — no real order is placed.</span>
          </div>
          {buyError && <p className="mt-2 text-xs text-sell">{buyError}</p>}
        </div>
      ) : (
        <EmptyState
          glyph="radar"
          className="mt-4"
          title="No pick today"
          message={plan.noPickReason || 'No affordable BUY setups pass the filters today — holding cash is the right move.'}
        />
      )}

      {plan.exitAdvice.length > 0 && (
        <div className="mt-4 border-t border-white/8 pt-3">
          <p className="text-xs font-semibold text-slate-300">Exit advice for open positions</p>
          <ul className="mt-2 space-y-1.5">
            {plan.exitAdvice.map((e, i) => (
              <li key={`${e.ticker}-${i}`} className="flex flex-wrap items-center gap-2 text-sm">
                <Chip tone="zinc">{e.ticker}</Chip>
                <span className="font-medium text-slate-100">{e.action}</span>
                <span className="text-xs text-slate-500">{e.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {marketRegime.notes.length > 0 && (
        <div className="mt-4 border-t border-white/8 pt-3">
          <p className="text-xs font-semibold text-slate-300">Market regime notes</p>
          <ul className="mt-1.5 space-y-0.5">
            {marketRegime.notes.map((nItem, i) => (
              <li key={i} className="text-xs leading-relaxed text-slate-500">
                — {nItem}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
