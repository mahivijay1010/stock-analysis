'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, TrendingDown, TrendingUp, X, XCircle } from 'lucide-react';
import { getLiveDetail } from '@/lib/api';
import type { LiveCandle, LiveDetail } from '@/lib/types';

const POLL_MS = 3000;

/**
 * Per-stock drawer: the live quote, this session's 1-minute candles, the open
 * forecasts, and every graded result for THIS name.
 *
 * Per-ticker history matters because an aggregate hit rate across 151 stocks
 * can hide a model that is systematically wrong on the one name you care
 * about. The drawer shows this security's own record, not the universe's.
 *
 * Every number here is observed. Where the feed has not supplied something —
 * an exchange previous close, a bid/ask — it renders as absent rather than
 * being derived from our own first tick.
 */
export function StockDrawer({ ticker, onClose }: { ticker: string; onClose: () => void }) {
  const [detail, setDetail] = useState<LiveDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setDetail(await getLiveDetail(ticker));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this stock');
    }
  }, [ticker]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  // Escape closes, matching normal drawer behaviour.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const row = detail?.row ?? null;

  return (
    <div className="fixed inset-0 z-[60] flex justify-end" role="dialog" aria-modal="true" aria-label={`${ticker} detail`}>
      <button className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} aria-label="Close" />
      <aside className="relative flex h-full w-full max-w-2xl flex-col overflow-y-auto border-l border-white/10 bg-[#0b0f17] shadow-2xl">
        <header className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-white/10 bg-[#0b0f17]/95 px-5 py-4 backdrop-blur">
          <div>
            <h2 className="font-display text-lg font-semibold text-slate-100">
              {ticker.replace(/\.NS$/, '')}
            </h2>
            <p className="text-xs text-slate-400">
              {detail?.name ?? '—'}
              {detail?.sector && detail.sector !== 'UNKNOWN' && (
                <span className="text-slate-600"> · {detail.sector}</span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {row?.price != null && (
              <div className="text-right">
                <p className="font-display text-xl font-semibold tabular-nums text-slate-100">
                  ₹{row.price.toFixed(2)}
                </p>
                <p className="text-[11px] text-slate-500">
                  {row.changePct != null ? `${row.changePct > 0 ? '+' : ''}${row.changePct.toFixed(2)}%` : 'change n/a'}
                </p>
              </div>
            )}
            <button onClick={onClose} className="rounded-lg border border-white/10 p-1.5 text-slate-400 hover:bg-white/5">
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        <div className="space-y-5 px-5 py-5">
          {error && <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-200">{error}</div>}
          {!detail && !error && <p className="text-sm text-slate-400">Loading…</p>}

          {detail && (
            <>
              <section className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                <Fact label="Bid / Ask" value={detail.bid != null && detail.ask != null ? `${detail.bid.toFixed(2)} / ${detail.ask.toFixed(2)}` : '—'} />
                <Fact label="Session range" value={row?.dayLow != null && row?.dayHigh != null ? `${row.dayLow.toFixed(2)} – ${row.dayHigh.toFixed(2)}` : '—'} />
                <Fact label="Ticks" value={detail.tickCount.toLocaleString('en-IN')} />
                <Fact label="Candles" value={String(detail.bars.length)} />
              </section>

              {/* Provenance caveats stay visible, not tucked into a tooltip. */}
              {(detail.joinedMidSession || detail.previousClose == null) && (
                <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
                  {detail.joinedMidSession && (
                    <p>
                      We joined mid-session — the open/high/low here are <strong>our observed</strong> values, not the
                      exchange&apos;s session range.
                    </p>
                  )}
                  {detail.previousClose == null && (
                    <p>No exchange previous close available, so change % is withheld rather than derived from our own first tick.</p>
                  )}
                </div>
              )}

              <section>
                <h3 className="mb-2 text-sm font-medium text-slate-200">
                  1-minute candles <span className="text-slate-500">· this session</span>
                </h3>
                <CandleChart bars={detail.bars} />
              </section>

              <section>
                <h3 className="mb-2 text-sm font-medium text-slate-200">Open forecasts</h3>
                {detail.forecasts.open.length === 0 ? (
                  <Empty>
                    No open forecast. A call needs 10 completed candles, and a new one is only made once the previous
                    one for that horizon has resolved.
                  </Empty>
                ) : (
                  <div className="space-y-2">
                    {detail.forecasts.open.map((f) => {
                      const up = f.direction === 'UP';
                      const secs = Math.max(0, Math.round((f.resolveAt - Date.now()) / 1000));
                      return (
                        <div key={f.horizonMin} className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-medium text-slate-300">{f.horizonMin} min</span>
                              <span
                                className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ${
                                  up ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300'
                                }`}
                              >
                                {up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                                {f.direction} {(f.probabilityUp * 100).toFixed(1)}%
                              </span>
                            </div>
                            <span className="text-[11px] text-slate-500">resolves in {secs}s</span>
                          </div>
                          <p className="mt-1.5 text-xs text-slate-400">
                            Expected{' '}
                            <span className={up ? 'text-emerald-300' : 'text-rose-300'}>
                              {f.expectedReturnPct > 0 ? '+' : ''}
                              {f.expectedReturnPct.toFixed(3)}%
                            </span>{' '}
                            from ₹{f.basePrice.toFixed(2)} · 80% range {f.low80Pct.toFixed(3)}% to {f.high80Pct.toFixed(3)}%
                          </p>
                          <p className="mt-0.5 text-[10px] text-slate-600">
                            from {f.barsUsed} candles · bar volatility {f.barVolPct.toFixed(3)}%
                          </p>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>

              <section>
                <h3 className="mb-2 flex flex-wrap items-baseline gap-2 text-sm font-medium text-slate-200">
                  This stock&apos;s results
                  {detail.forecasts.graded.length > 0 && (
                    <span className="text-xs font-normal text-slate-400">
                      {detail.forecasts.correct} correct / {detail.forecasts.wrong} wrong
                      {detail.forecasts.graded.length < 10 && (
                        <span className="text-amber-300"> · too few to mean anything yet</span>
                      )}
                    </span>
                  )}
                </h3>
                {detail.forecasts.graded.length === 0 ? (
                  <Empty>Nothing graded for this stock yet.</Empty>
                ) : (
                  <div className="overflow-x-auto rounded-xl border border-white/10">
                    <table className="w-full text-sm">
                      <thead className="bg-white/[0.03] text-[11px] uppercase tracking-wide text-slate-500">
                        <tr>
                          <th className="px-3 py-2 text-left">Result</th>
                          <th className="px-3 py-2 text-left">H</th>
                          <th className="px-3 py-2 text-left">Called</th>
                          <th className="px-3 py-2 text-right">Expected</th>
                          <th className="px-3 py-2 text-right">Actual</th>
                          <th className="px-3 py-2 text-right">Miss</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5">
                        {detail.forecasts.graded.slice(0, 25).map((g) => {
                          const wrong = g.outcome === 'WRONG';
                          return (
                            <tr key={`${g.horizonMin}-${g.gradedAt}`} className={wrong ? 'bg-rose-500/[0.04]' : undefined}>
                              <td className="px-3 py-2">
                                {wrong ? (
                                  <span className="inline-flex items-center gap-1 text-[11px] font-medium text-rose-300">
                                    <XCircle className="h-3 w-3" /> WRONG
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-300">
                                    <CheckCircle2 className="h-3 w-3" /> correct
                                  </span>
                                )}
                              </td>
                              <td className="px-3 py-2 text-xs text-slate-400">{g.horizonMin}m</td>
                              <td className="px-3 py-2 text-xs text-slate-300">
                                {g.direction}
                                {g.actualDirection !== g.direction && (
                                  <span className="text-rose-300"> → {g.actualDirection}</span>
                                )}
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums text-xs text-slate-400">
                                {g.expectedReturnPct > 0 ? '+' : ''}
                                {g.expectedReturnPct.toFixed(3)}%
                              </td>
                              <td
                                className={`px-3 py-2 text-right tabular-nums text-xs ${
                                  g.actualReturnPct < 0 ? 'text-rose-300' : 'text-emerald-300'
                                }`}
                              >
                                {g.actualReturnPct > 0 ? '+' : ''}
                                {g.actualReturnPct.toFixed(3)}%
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums text-xs text-slate-400">
                                {g.errorPct > 0 ? '+' : ''}
                                {g.errorPct.toFixed(3)}pp
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <p className="text-[11px] text-slate-500">{detail.note}</p>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

/**
 * Candlestick chart in plain SVG.
 *
 * Deliberately not a charting library: the data is ~400 OHLC bars and the
 * honest rendering is a wick plus a body. A library would add weight and, more
 * importantly, interpolation behaviour that could smooth over gaps in the
 * feed — gaps that are real information here.
 */
function CandleChart({ bars }: { bars: LiveCandle[] }) {
  const shown = useMemo(() => bars.slice(-120), [bars]);

  if (shown.length === 0) {
    return <Empty>No completed candles yet — the first appears one minute after the feed starts.</Empty>;
  }

  const W = 640;
  const H = 220;
  const padL = 46;
  const padR = 8;
  const padT = 8;
  const padB = 18;

  const lo = Math.min(...shown.map((b) => b.low));
  const hi = Math.max(...shown.map((b) => b.high));
  const span = hi - lo || hi * 0.001 || 1;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const step = plotW / shown.length;
  const bodyW = Math.max(1, Math.min(7, step * 0.62));

  const y = (price: number) => padT + ((hi - price) / span) * plotH;
  const x = (i: number) => padL + i * step + step / 2;

  // Four gridlines, labelled with real prices.
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => lo + f * span);

  return (
    <div className="overflow-x-auto rounded-xl border border-white/10 bg-white/[0.02] p-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-[220px] w-full" role="img" aria-label="1-minute candles">
        {ticks.map((p) => (
          <g key={p}>
            <line x1={padL} x2={W - padR} y1={y(p)} y2={y(p)} stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
            <text x={4} y={y(p) + 3} fill="rgba(148,163,184,0.7)" fontSize={9} className="tabular-nums">
              {p.toFixed(2)}
            </text>
          </g>
        ))}
        {shown.map((b, i) => {
          const up = b.close >= b.open;
          const colour = up ? '#34d399' : '#fb7185';
          const bodyTop = y(Math.max(b.open, b.close));
          const bodyBot = y(Math.min(b.open, b.close));
          return (
            <g key={b.startAt}>
              <line x1={x(i)} x2={x(i)} y1={y(b.high)} y2={y(b.low)} stroke={colour} strokeWidth={1} opacity={0.85} />
              <rect
                x={x(i) - bodyW / 2}
                y={bodyTop}
                width={bodyW}
                // A doji would be 0px tall and vanish; floor it at 1px so an
                // unchanged minute is still visibly a candle.
                height={Math.max(1, bodyBot - bodyTop)}
                fill={colour}
                opacity={0.9}
              />
            </g>
          );
        })}
      </svg>
      <p className="px-1 pt-1 text-[10px] text-slate-500">
        Last {shown.length} completed 1-minute candles{bars.length > shown.length && ` (of ${bars.length} this session)`}.
        Built from our observed ticks.
      </p>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-2.5">
      <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-0.5 font-display text-sm font-semibold tabular-nums text-slate-200">{value}</p>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3 text-xs text-slate-500">{children}</div>;
}
