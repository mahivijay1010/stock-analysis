'use client';

import clsx from 'clsx';
import type { OpenPosition, PositionAdvice, RecordTradeRequest } from '@/lib/types';
import type { Tone } from '@/components/ui';
import { inr, inrSmart, plain, signedInr, signedPct } from '@/lib/format';
import { Card, Chip, EmptyState, SectionTitle } from '@/components/ui';
import { signTone, TradeButton } from './desk-ui';

const ADVICE_META: Record<PositionAdvice, { label: string; tone: Tone; pulse?: boolean }> = {
  SELL_NOW_STOP_HIT: { label: 'SELL NOW', tone: 'sell', pulse: true },
  BOOK_PROFIT_TARGET_HIT: { label: 'BOOK PROFIT', tone: 'buy' },
  EXIT_MOMENTUM_LOST: { label: 'EXIT MOMENTUM', tone: 'wait' },
  RAISE_STOP_TRAIL: { label: 'RAISE STOP', tone: 'cyan' },
  HOLD: { label: 'HOLD', tone: 'zinc' },
};

export function PositionsTable({
  positions,
  onRecordSell,
  sellingTicker,
  sellError,
  onAnalyze,
}: {
  positions: OpenPosition[];
  onRecordSell: (req: RecordTradeRequest) => void;
  sellingTicker: string | null;
  sellError: string | null;
  onAnalyze: (ticker: string) => void;
}) {
  return (
    <Card className="p-5">
      <SectionTitle>Open positions</SectionTitle>
      {positions.length === 0 ? (
        <EmptyState
          glyph="slash"
          className="mt-3"
          title="No open positions"
          message="All cash is available — the next recorded BUY appears here with live P&L and exit advice."
        />
      ) : (
        <div className="thin-scroll mt-4 overflow-x-auto rounded-xl border border-white/6">
          <table className="table-premium min-w-[860px]">
            <thead>
              <tr>
                <th>Stock</th>
                <th className="num">Qty</th>
                <th className="num">Avg buy</th>
                <th className="num">Live</th>
                <th className="num">Stop / Target</th>
                <th className="num">Unrealized P&amp;L</th>
                <th>Advice</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => {
                const meta = ADVICE_META[p.advice] ?? ADVICE_META.HOLD;
                const key = String(p.trade.id);
                const selling = sellingTicker === p.trade.ticker;
                return (
                  <tr key={key}>
                    <td>
                      <button
                        type="button"
                        onClick={() => onAnalyze(p.trade.ticker)}
                        className="text-left font-medium text-slate-100 underline-offset-4 transition-colors hover:text-cyan-400 hover:underline"
                      >
                        {p.trade.name || p.trade.ticker}
                      </button>
                      <p className="text-xs text-slate-500">{p.trade.ticker}</p>
                    </td>
                    <td className="num text-slate-200">{plain(p.trade.qty, 0)}</td>
                    <td className="num whitespace-nowrap text-slate-200">{inr(p.trade.price)}</td>
                    <td className="num whitespace-nowrap text-slate-100">{inr(p.livePrice)}</td>
                    <td className="num text-xs whitespace-nowrap">
                      <span className="text-sell">{p.trade.stopLoss != null ? inr(p.trade.stopLoss) : '—'}</span>
                      <span className="text-slate-600"> / </span>
                      <span className="text-buy">{p.trade.target != null ? inr(p.trade.target) : '—'}</span>
                    </td>
                    <td className={clsx('num whitespace-nowrap', signTone(p.unrealizedPnl))}>
                      <span className="font-display font-semibold">{signedInr(p.unrealizedPnl)}</span>
                      <span className="ml-1 text-xs">({signedPct(p.unrealizedPnlPct)})</span>
                    </td>
                    <td>
                      <Chip tone={meta.tone} glow className={meta.pulse ? 'animate-pulse' : undefined} title={p.adviceReason}>
                        {meta.label}
                      </Chip>
                      <p className="mt-1 max-w-52 truncate text-[11px] text-slate-500" title={p.adviceReason}>
                        {p.adviceReason}
                      </p>
                    </td>
                    <td className="text-right">
                      <TradeButton
                        side="SELL"
                        size="sm"
                        loading={selling}
                        disabled={sellingTicker != null}
                        onClick={() => onRecordSell({ ticker: p.trade.ticker, side: 'SELL', qty: p.trade.qty })}
                      >
                        Record SELL
                      </TradeButton>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {positions.length > 0 && (
        <p className="mt-2 text-[11px] text-slate-600">
          Cash impact of a position: {inrSmart(positions.reduce((s, p) => s + p.trade.qty * p.trade.price, 0))} at cost
          across {positions.length} position{positions.length === 1 ? '' : 's'}.
        </p>
      )}
      {sellError && <p className="mt-2 text-xs text-sell">{sellError}</p>}
    </Card>
  );
}
