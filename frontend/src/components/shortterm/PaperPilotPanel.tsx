'use client';

import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Beaker, ArrowRight } from 'lucide-react';
import { getPaperAccount, PaperAccountView } from '@/lib/api';
import { Card, Chip } from '@/components/ui';

/**
 * Paper pilot — the system running the full decision flow on fake money. This
 * is what turns "the system says" into "the system did": real timing, fills,
 * slippage, position management. Explicitly LEARNING trades that build a
 * prospective track record — never advice, never real fills.
 */

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

/** Minimal equity sparkline, pure SVG. */
function EquitySpark({ curve, start }: { curve: Array<{ equityInr: number }>; start: number }) {
  if (curve.length < 2) return null;
  const vals = curve.map((p) => p.equityInr);
  const min = Math.min(start, ...vals);
  const max = Math.max(start, ...vals);
  const span = Math.max(max - min, 1);
  const W = 240;
  const H = 40;
  const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * W},${H - ((v - min) / span) * H}`).join(' ');
  const last = vals[vals.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-10 w-full max-w-[240px]" aria-hidden>
      <line x1={0} y1={H - ((start - min) / span) * H} x2={W} y2={H - ((start - min) / span) * H} stroke="rgba(148,163,184,0.3)" strokeDasharray="3 3" />
      <polyline points={pts} fill="none" stroke={last >= start ? 'rgb(58,214,200)' : 'rgb(244,63,94)'} strokeWidth={1.5} />
    </svg>
  );
}

export function PaperPilotPanel() {
  const { data, isLoading } = useQuery<PaperAccountView>({ queryKey: ['paper-account'], queryFn: getPaperAccount, staleTime: 60_000 });
  if (isLoading) return <Card className="p-4 text-xs text-slate-500">Loading the paper pilot…</Card>;
  if (!data) return null;

  const up = data.totalReturnPct >= 0;
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Beaker className="h-4 w-4 text-violet-400" aria-hidden />
            <h2 className="font-display text-sm font-semibold tracking-wide text-slate-200">Paper pilot — the system running on fake money</h2>
          </div>
          <p className="mt-0.5 max-w-3xl text-[11px] text-slate-500">
            The full decision flow — board → circuit breaker → regime gate → sizing → portfolio caps → fill — on a <span className="text-slate-300">₹1,00,000</span> paper account. Learning trades to build a track record, never advice.
          </p>
        </div>
        <div className="text-right">
          <p className={clsx('font-display text-xl font-semibold tabular-nums', up ? 'text-emerald-300' : 'text-rose-300')}>{inr(data.equityInr)}</p>
          <p className="text-[11px] text-slate-500">
            <span className={up ? 'text-emerald-400' : 'text-rose-400'}>{data.totalReturnPct > 0 ? '+' : ''}{data.totalReturnPct}%</span> · dd {data.drawdownFromPeakPct}%
          </p>
        </div>
      </div>

      <div className="mt-3 grid gap-4 lg:grid-cols-[240px_1fr]">
        <div>
          <EquitySpark curve={data.equityCurve} start={data.account.startingCapitalInr} />
          <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
            <div><p className="text-slate-600">Cash</p><p className="tabular-nums text-slate-300">{inr(data.account.cashInr)}</p></div>
            <div><p className="text-slate-600">Last cycle</p><p className="tabular-nums text-slate-300">{data.account.lastCycleDate ?? '—'}</p></div>
            <div><p className="text-slate-600">Closed trades</p><p className="tabular-nums text-slate-300">{data.stats.closed}</p></div>
            <div><p className="text-slate-600">Win rate</p><p className="tabular-nums text-slate-300">{data.stats.winRatePct != null ? `${data.stats.winRatePct}%` : '—'}</p></div>
            <div><p className="text-slate-600">Expectancy</p><p className="tabular-nums text-slate-300">{data.stats.expectancyR != null ? `${data.stats.expectancyR}R` : '—'}</p></div>
            <div><p className="text-slate-600">Mean slippage</p><p className="tabular-nums text-slate-300">{data.stats.meanSlippageBps != null ? `${data.stats.meanSlippageBps}bps` : '—'}</p></div>
          </div>
        </div>

        <div>
          <p className="mb-1.5 text-[11px] uppercase tracking-wide text-slate-500">Open positions ({data.openPositions.length})</p>
          {data.openPositions.length === 0 ? (
            <p className="rounded-lg border border-dashed border-white/10 p-3 text-[11px] text-slate-600">No open positions — the pilot stayed flat (regime/gates refused every candidate). Staying out is a decision.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-[10px] uppercase tracking-wide text-slate-600"><tr>
                  <th className="px-1.5 py-1 text-left">Stock</th><th className="px-1.5 py-1 text-right">Qty</th><th className="px-1.5 py-1 text-right">Entry</th><th className="px-1.5 py-1 text-right">Stop</th><th className="px-1.5 py-1 text-right">Target</th><th className="px-1.5 py-1 text-right">Slip</th><th className="px-1.5 py-1 text-right">Conv</th>
                </tr></thead>
                <tbody className="divide-y divide-white/5">
                  {data.openPositions.map((p) => (
                    <tr key={p.ticker}>
                      <td className="px-1.5 py-1 text-slate-300">{p.ticker.replace('.NS', '')}</td>
                      <td className="px-1.5 py-1 text-right tabular-nums text-slate-400">{p.qty}</td>
                      <td className="px-1.5 py-1 text-right tabular-nums text-slate-300">₹{p.entry}</td>
                      <td className="px-1.5 py-1 text-right tabular-nums text-rose-300">₹{p.stop}</td>
                      <td className="px-1.5 py-1 text-right tabular-nums text-emerald-300">₹{p.target}</td>
                      <td className="px-1.5 py-1 text-right tabular-nums text-slate-500">{p.slippageBps}bps</td>
                      <td className="px-1.5 py-1 text-right tabular-nums text-slate-400">{p.conviction ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {data.closedTrades.length > 0 && (
            <>
              <p className="mb-1.5 mt-3 text-[11px] uppercase tracking-wide text-slate-500">Recent closed</p>
              <div className="flex flex-col gap-1">
                {data.closedTrades.slice(0, 5).map((t, i) => (
                  <div key={i} className="flex items-center justify-between gap-2 rounded-lg border border-white/8 bg-white/[0.02] px-3 py-1.5 text-[11px]">
                    <span className="font-medium text-slate-200">{t.ticker.replace('.NS', '')}</span>
                    <span className="flex items-center gap-1.5 text-slate-400">
                      <span className="tabular-nums">₹{t.entry}</span><ArrowRight className="h-3 w-3 text-slate-600" aria-hidden /><span className="tabular-nums">₹{t.exit ?? '—'}</span>
                      <Chip tone={t.exitReason === 'TARGET' ? 'emerald' : t.exitReason === 'STOP' ? 'rose' : 'zinc'}>{t.exitReason}</Chip>
                    </span>
                    <span className={clsx('tabular-nums font-medium', (t.pnlInr ?? 0) >= 0 ? 'text-emerald-300' : 'text-rose-300')}>{t.pnlInr != null ? inr(t.pnlInr) : '—'} {t.realizedR != null && `(${t.realizedR}R)`}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      <p className="mt-3 border-t border-white/10 pt-2.5 text-[11px] leading-relaxed text-slate-600">{data.caveat}</p>
    </Card>
  );
}
