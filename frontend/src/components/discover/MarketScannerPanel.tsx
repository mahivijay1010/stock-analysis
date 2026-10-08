'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronDown, Eye, FlaskConical, Microscope, RefreshCw, Search, ShieldAlert } from 'lucide-react';
import { addWatchlistItem, getScannerLatest, isUnauthorized, researchCompany, runUniverseScan, ScannerFilters, ScannerRow } from '@/lib/api';
import { inr } from '@/lib/format';
import { Button, CardSkeleton, Chip, Collapsible, EmptyState, ErrorState, Input, Select } from '@/components/ui';
import { useAuth } from '@/components/auth/useAuth';

/*
 * MARKET SCANNER — the broad-universe funnel table. Every row shows which
 * stage it reached and why it stopped. Scores are evidence dimensions
 * (0–100), never summed into a prediction. "Setup" and "R:R" come from the
 * existing engine, unchanged.
 */

const STAGE_LABEL: Record<string, string> = { UNIVERSE: 'Universe', DATA_VALIDATION: 'Data valid', LIQUIDITY: 'Liquid', TECHNICAL: 'Technical screen', FUNDAMENTAL_EVENT: 'Fundamentals / events', SETUP_ENGINE: 'Setup engine', DECISION_GATES: 'Decision gates', RISK: 'Risk', MODEL_HEALTH: 'Model health', MONEY_DESK: 'Money Desk' };
const num = (v: string | number | null | undefined, d = 0): string => (v == null || v === '' ? '—' : Number(v).toFixed(d));
const stageTone = (s: string): 'buy' | 'amber' | 'sell' | 'zinc' | 'sky' => (s === 'MONEY_DESK' ? 'buy' : s === 'MODEL_HEALTH' || s === 'RISK' || s === 'DECISION_GATES' ? 'amber' : s === 'SETUP_ENGINE' ? 'sky' : 'zinc');

function Row({ r, onOpenCompany, onOpenStock, authed }: { r: ScannerRow; onOpenCompany: (s: string) => void; onOpenStock: (t: string) => void; authed: boolean }) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const research = useMutation({ mutationFn: () => researchCompany(r.symbol, true), onSuccess: () => qc.invalidateQueries({ queryKey: ['scanner'] }) });
  const watch = useMutation({ mutationFn: () => addWatchlistItem({ ticker: r.symbol, horizon: 'short', note: `Scanner: ${r.signals.join(', ') || 'no signal'}` }) });
  const f = r.features;
  const rr = r.plan?.rewardRiskToTarget1;
  return (
    <>
      <tr className="row-hover">
        <td className="px-2 py-2"><button type="button" className="desk-ticker !text-sm" onClick={() => onOpenCompany(r.symbol)}>{r.symbol}</button><br /><small className="text-slate-500">{r.company_name}</small></td>
        <td className="px-2 py-2 tabular-nums">{f.price != null ? inr(Number(f.price), 2) : '—'}</td>
        <td className="px-2 py-2"><Chip tone="zinc">{r.market_cap_bucket.toLowerCase()}</Chip></td>
        <td className="px-2 py-2 text-slate-400">{r.sector ?? '—'}</td>
        <td className="px-2 py-2"><span className={clsx(f.trend === 'UP' ? 'text-buy' : f.trend === 'DOWN' ? 'text-sell' : 'text-slate-400')}>{String(f.trend ?? '—').toLowerCase()}</span></td>
        <td className="px-2 py-2 tabular-nums"><span className={Number(f.r20Pct) >= 0 ? 'text-buy' : 'text-sell'}>{num(f.r20Pct as number, 1)}%</span><br /><small className="text-slate-500">RS {num(f.relNifty60Pct as number, 1)}%</small></td>
        <td className="px-2 py-2 tabular-nums">{num(f.volumeRatio20 as number, 1)}×</td>
        <td className="px-2 py-2">{r.setup_type ? <Chip tone={r.setup_type === 'NO_SETUP' ? 'zinc' : 'sky'}>{r.setup_type.replace(/_/g, ' ').toLowerCase()}</Chip> : <span className="text-slate-600">not reached</span>}</td>
        <td className="px-2 py-2 tabular-nums">{rr != null ? `${Number(rr).toFixed(2)}×` : '—'}</td>
        <td className="px-2 py-2">{r.research_status === 'RESEARCHED' ? <Chip tone="buy">researched</Chip> : r.research_status === 'PENDING' ? <Chip tone="amber">queued</Chip> : <span className="text-slate-600">—</span>}</td>
        <td className="px-2 py-2 tabular-nums">{num(r.coverage_score)}<br /><small className="text-slate-500">{r.ohlcv_available ? 'ohlcv' : 'close-only'}{r.fundamentals_available ? ' · fund' : ''}{r.news_available ? ' · news' : ''}</small></td>
        <td className="px-2 py-2"><Chip tone={stageTone(r.stage_reached)}>{STAGE_LABEL[r.stage_reached] ?? r.stage_reached}</Chip></td>
        <td className="px-2 py-2">
          <div className="flex flex-wrap gap-1">
            <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>Why <ChevronDown className={clsx('h-3 w-3 transition-transform', open && 'rotate-180')} aria-hidden /></Button>
            <Button variant="ghost" size="sm" onClick={() => onOpenCompany(r.symbol)}><Microscope className="h-3 w-3" aria-hidden /> Company</Button>
            <Button variant="ghost" size="sm" onClick={() => onOpenStock(r.symbol)}>Setup</Button>
            <Button variant="ghost" size="sm" disabled={!authed} loading={research.isPending} onClick={() => research.mutate()} title={authed ? 'Build the research profile (AI within budget)' : 'Sign in to research'}>Research</Button>
            <Button variant="ghost" size="sm" disabled={!authed || watch.isSuccess} loading={watch.isPending} onClick={() => watch.mutate()}><Eye className="h-3 w-3" aria-hidden /> {watch.isSuccess ? 'Watching' : 'Watch'}</Button>
            <Button variant="ghost" size="sm" onClick={() => { window.location.hash = '#money-desk'; }}><FlaskConical className="h-3 w-3" aria-hidden /> Simulate</Button>
          </div>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={13} className="px-3 pb-3">
            <div className="desk-card-panel grid gap-3 md:grid-cols-3">
              <div>
                <strong className="text-slate-200">Evidence dimensions</strong>
                <ul>
                  <li>technical {num(r.technical_score)} · liquidity {num(r.liquidity_score)} · risk {num(r.risk_score)}</li>
                  <li>fundamental {r.fundamental_score == null ? 'no stored data' : num(r.fundamental_score)} · event {r.event_score == null ? 'no stored data' : num(r.event_score)} · research evidence {num(r.research_evidence_score)}</li>
                  <li>model health {r.model_health_score == null ? 'not evaluated' : num(r.model_health_score)} · tier {r.tier ?? '—'} · action {r.action ?? '—'}</li>
                  <li>signals: {r.signals.length ? r.signals.map((s) => s.toLowerCase().replace(/_/g, ' ')).join(', ') : 'none'}</li>
                </ul>
              </div>
              <div>
                <strong className="text-slate-200">Features (close-only, as of {String(f.asOf ?? '')})</strong>
                <ul>
                  <li>52w position {num(f.pos52wPct as number)}% · from 20d high {num(f.pullbackFrom20dHighPct as number, 1)}% · vol {num(f.realizedVol20AnnPct as number, 1)}% ann</li>
                  <li>vs SMA20/50/200: {num(f.distSma20Pct as number, 1)}% / {num(f.distSma50Pct as number, 1)}% / {num(f.distSma200Pct as number, 1)}%</li>
                  <li>ATR proxy {num(f.atrProxyPct as number, 2)}%/day (close-to-close) · gap {num(f.gapPct as number, 1)}% · delivery {num(f.delivPct20 as number)}%</li>
                  <li>median traded value {f.medianValue20Inr != null ? `₹${(Number(f.medianValue20Inr) / 1e7).toFixed(1)}cr` : '—'}</li>
                </ul>
              </div>
              <div>
                <strong className="text-slate-200">{r.rejected_at_stage ? `Stopped at ${STAGE_LABEL[r.rejected_at_stage] ?? r.rejected_at_stage}` : 'Passed every stage'}</strong>
                <ul>{r.rejection_reasons.length ? r.rejection_reasons.map((x) => <li key={x}>{x}</li>) : <li>no rejection recorded</li>}</ul>
                {r.plan && r.plan.initialStop != null && <p className="mt-2 text-slate-400">Engine plan: entry {r.plan.entryZoneHigh ?? r.plan.entryTriggerPrice ?? '—'} · stop {r.plan.initialStop} · T1 {r.plan.target1} · EV80 LB {r.plan.ev80LowerPct ?? '—'}%</p>}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export function MarketScannerPanel({ onOpenCompany, onOpenStock }: { onOpenCompany: (s: string) => void; onOpenStock: (t: string) => void }) {
  const { auth } = useAuth();
  const authed = auth?.status === 'authenticated';
  const [filters, setFilters] = useState<ScannerFilters>({ stage: '', sort: 'technical_score', limit: 150 });
  const [q, setQ] = useState('');
  const applied = useMemo(() => ({ ...filters, q: q.trim() || undefined }), [filters, q]);
  const scan = useQuery({ queryKey: ['scanner', applied], queryFn: () => getScannerLatest(applied), staleTime: 5 * 60_000 });
  const qc = useQueryClient();
  const rerun = useMutation({ mutationFn: () => runUniverseScan(), onSuccess: () => qc.invalidateQueries({ queryKey: ['scanner'] }) });
  const d = scan.data;
  const set = (k: keyof ScannerFilters, v: string | number | undefined) => setFilters((f) => ({ ...f, [k]: v === '' ? undefined : v }));
  const funnel = d?.stages ?? [];
  return (
    <section className="glass desk-section" aria-label="Market scanner">
      <div className="desk-section-head">
        <div><h2><Search className="h-4 w-4" aria-hidden /> Market scanner</h2><p>{d?.asOf ? `Broad scan as of ${d.asOf} · regime ${(d.regime ?? 'unknown').toLowerCase()} · ${d.total} rows match` : 'No broad scan yet.'} Stage-1 is deterministic and close-only; the setup engine and gates are the existing ones.</p></div>
        <Button variant="secondary" size="sm" disabled={!authed} loading={rerun.isPending} onClick={() => rerun.mutate()} title={authed ? 'Run the broad scan now (≈30s)' : 'Sign in to run a scan'}><RefreshCw className="h-3.5 w-3.5" aria-hidden /> Run scan</Button>
      </div>
      {funnel.length > 0 && (
        <ol className="scanner-funnel" aria-label="Scan funnel">
          {funnel.map((s) => (
            <li key={s.stage} className={clsx(s.passed === 0 && s.entered > 0 && 'scanner-funnel-zero')}>
              <button type="button" onClick={() => set('stage', filters.stage === s.stage ? '' : s.stage)} aria-pressed={filters.stage === s.stage}>
                <span>{STAGE_LABEL[s.stage] ?? s.stage}</span><strong>{s.passed}</strong><small>of {s.entered}</small>
              </button>
            </li>
          ))}
        </ol>
      )}
      <div className="desk-controls !p-0 !bg-transparent !border-0">
        <Input label="Search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="symbol or company" />
        <Select label="Liquidity" value={filters.tier ?? ''} onChange={(v) => set('tier', v)} options={[{ value: '', label: 'A + B' }, { value: 'A', label: 'Tier A (≥₹10cr/day)' }, { value: 'B', label: 'Tier B (₹2–10cr)' }]} />
        <Select label="Market cap" value={filters.cap ?? ''} onChange={(v) => set('cap', v)} options={[{ value: '', label: 'Any' }, { value: 'LARGE', label: 'Large' }, { value: 'MID', label: 'Mid' }, { value: 'SMALL', label: 'Small' }, { value: 'MICRO', label: 'Micro' }, { value: 'UNKNOWN', label: 'Unclassified' }]} />
        <Select label="Sector" value={filters.sector ?? ''} onChange={(v) => set('sector', v)} options={[{ value: '', label: 'Any' }, ...(d?.sectors ?? []).map((s) => ({ value: s, label: s }))]} />
        <Select label="Trend" value={filters.trend ?? ''} onChange={(v) => set('trend', v)} options={[{ value: '', label: 'Any' }, { value: 'UP', label: 'Up' }, { value: 'SIDEWAYS', label: 'Sideways' }, { value: 'DOWN', label: 'Down' }]} />
        <Select label="Signal" value={filters.signal ?? ''} onChange={(v) => set('signal', v)} options={[{ value: '', label: 'Any' }, { value: 'BREAKOUT', label: 'Breakout' }, { value: 'PULLBACK', label: 'Pullback' }, { value: 'MOMENTUM', label: 'Momentum' }, { value: 'MEAN_REVERSION', label: 'Mean reversion' }, { value: 'UNUSUAL_VOLUME', label: 'Unusual volume' }, { value: 'GAP', label: 'Gap' }, { value: 'NEAR_52W_HIGH', label: 'Near 52w high' }]} />
        <Select label="Setup (engine)" value={filters.setup ?? ''} onChange={(v) => set('setup', v)} options={[{ value: '', label: 'Any' }, { value: 'PULLBACK_IN_UPTREND', label: 'Pullback in uptrend' }, { value: 'BREAKOUT_CONFIRMATION', label: 'Breakout confirmation' }, { value: 'MOMENTUM_CONTINUATION', label: 'Momentum continuation' }, { value: 'MEAN_REVERSION', label: 'Mean reversion' }, { value: 'VOLATILITY_CONTRACTION', label: 'Volatility contraction' }, { value: 'NO_SETUP', label: 'No setup' }]} />
        <Input label="Min price ₹" type="number" value={filters.minPrice ?? ''} onChange={(e) => set('minPrice', e.target.value ? Number(e.target.value) : undefined)} />
        <Input label="Max price ₹" type="number" value={filters.maxPrice ?? ''} onChange={(e) => set('maxPrice', e.target.value ? Number(e.target.value) : undefined)} />
        <Input label="Min rel. volume ×" type="number" step="0.1" value={filters.minRelVol ?? ''} onChange={(e) => set('minRelVol', e.target.value ? Number(e.target.value) : undefined)} />
        <Input label="Max vol % ann" type="number" value={filters.maxVol ?? ''} onChange={(e) => set('maxVol', e.target.value ? Number(e.target.value) : undefined)} />
        <Input label="Min 52w position %" type="number" value={filters.min52w ?? ''} onChange={(e) => set('min52w', e.target.value ? Number(e.target.value) : undefined)} />
        <Input label="Min fundamental" type="number" value={filters.minFundamental ?? ''} onChange={(e) => set('minFundamental', e.target.value ? Number(e.target.value) : undefined)} />
        <Select label="Sort" value={filters.sort ?? 'technical_score'} onChange={(v) => set('sort', v)} options={[{ value: 'technical_score', label: 'Technical evidence' }, { value: 'fundamental_score', label: 'Fundamental evidence' }, { value: 'liquidity_score', label: 'Liquidity' }, { value: 'risk_score', label: 'Risk (high first)' }, { value: 'screen_rank', label: 'Screen rank' }]} />
      </div>
      {scan.isLoading && <CardSkeleton lines={5} />}
      {scan.isError && <ErrorState message={`Scanner unavailable: ${scan.error instanceof Error ? scan.error.message : 'unknown'}`} onRetry={() => scan.refetch()} />}
      {d && d.rows.length === 0 && <EmptyState title="No rows match" message={d.asOf ? 'Loosen a filter or clear the stage.' : 'Run the broad scan (sign in) or wait for the 20:25 job.'} />}
      {d && d.rows.length > 0 && (
        <div className="overflow-x-auto thin-scroll">
          <table className="w-full min-w-[1180px] text-left text-xs">
            <thead><tr className="text-[10px] uppercase tracking-wide text-slate-500"><th className="px-2 py-1">Symbol</th><th className="px-2 py-1">Price</th><th className="px-2 py-1">Cap</th><th className="px-2 py-1">Sector</th><th className="px-2 py-1">Trend</th><th className="px-2 py-1">20d / RS60</th><th className="px-2 py-1">Rel vol</th><th className="px-2 py-1">Setup (engine)</th><th className="px-2 py-1">R:R</th><th className="px-2 py-1">Research</th><th className="px-2 py-1">Coverage</th><th className="px-2 py-1">Stage</th><th className="px-2 py-1">Actions</th></tr></thead>
            <tbody>{d.rows.map((r) => <Row key={r.symbol} r={r} onOpenCompany={onOpenCompany} onOpenStock={onOpenStock} authed={authed} />)}</tbody>
          </table>
        </div>
      )}
      <p className="desk-caveat"><ShieldAlert className="h-3.5 w-3.5" aria-hidden /> Technical, fundamental, event, liquidity and risk are separate evidence dimensions; they are not summed into a prediction. Prices are exchange closes as of the scan date; fundamentals carry their own dates. {!authed && 'Sign in to research or watch a stock.'}</p>
      {scan.isError && isUnauthorized(scan.error) && <p className="desk-caveat">Sign in required.</p>}
      <Collapsible id="scanner-definitions" title="How to read this table" defaultOpen={false}>
        <ul className="lab-list"><li><strong>Stage</strong> — the furthest funnel stage the stock reached today; the Why button lists the exact reason it stopped.</li><li><strong>Setup / R:R</strong> — from the existing short-term engine; only names that reached the setup engine have them.</li><li><strong>Coverage</strong> — how much stored data exists (OHLCV, fundamentals, news); it never decides tradability.</li><li><strong>Research</strong> — whether a structured research profile (and budgeted AI research) exists; built from stored evidence only.</li></ul>
      </Collapsible>
    </section>
  );
}
