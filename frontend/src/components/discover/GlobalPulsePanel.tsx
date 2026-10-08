'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Globe2, RefreshCw, ShieldAlert } from 'lucide-react';
import { EnvLabel, getGlobalPulse, getGlobalStudies, getGlobalTrackRecord, GlobalObservation, runGlobalSnapshot } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { Button, CardSkeleton, Chip, Collapsible, ErrorState, StatTile } from '@/components/ui';
import { useAuth } from '@/components/auth/useAuth';

/*
 * GLOBAL PULSE — diagnoses the global risk environment and shows how global
 * conditions have historically transmitted to Indian equities. It predicts
 * nothing. Every number carries its session date, timezone and freshness;
 * an open Asian market is never compared with a closed US one as "now".
 */

const regimeTone = (r: string | null | undefined): 'buy' | 'zinc' | 'amber' | 'sell' => (r === 'RISK_ON' ? 'buy' : r === 'NEUTRAL' ? 'zinc' : r === 'CAUTIOUS' ? 'amber' : 'sell');
const envTone = (e: EnvLabel | string | null | undefined): 'buy' | 'zinc' | 'amber' | 'sell' => (e === 'TAILWIND' ? 'buy' : e === 'NEUTRAL' ? 'zinc' : e === 'HEADWIND' ? 'amber' : 'sell');
const pct = (v: number | null | undefined, d = 1) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`);
const bps = (v: number | null | undefined) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${Math.round(v)} bps`);
const GROUPS: Array<{ title: string; match: (o: GlobalObservation) => boolean }> = [
  { title: 'US', match: (o) => o.region === 'US' && o.assetClass === 'EQUITY' },
  { title: 'Europe', match: (o) => o.region === 'EUROPE' && o.assetClass === 'EQUITY' },
  { title: 'Asia', match: (o) => o.region === 'ASIA' && o.assetClass === 'EQUITY' },
  { title: 'Rates', match: (o) => o.assetClass === 'RATES' },
  { title: 'Dollar / FX', match: (o) => o.assetClass === 'FX' },
  { title: 'Commodities', match: (o) => o.assetClass === 'COMMODITY' },
  { title: 'Volatility', match: (o) => o.assetClass === 'VOLATILITY' },
  { title: 'India', match: (o) => o.region === 'INDIA' && o.assetClass === 'EQUITY' },
];

export function GlobalPulsePanel() {
  const { auth } = useAuth();
  const authed = auth?.status === 'authenticated';
  const qc = useQueryClient();
  const pulse = useQuery({ queryKey: ['global-pulse'], queryFn: getGlobalPulse, staleTime: 5 * 60_000 });
  const studies = useQuery({ queryKey: ['global-studies'], queryFn: getGlobalStudies, staleTime: 30 * 60_000 });
  const record = useQuery({ queryKey: ['global-track-record'], queryFn: getGlobalTrackRecord, staleTime: 30 * 60_000 });
  const snap = useMutation({ mutationFn: runGlobalSnapshot, onSuccess: () => qc.invalidateQueries({ queryKey: ['global-pulse'] }) });
  const d = pulse.data;
  return (
    <section className="glass desk-section" aria-label="Global pulse">
      <div className="desk-section-head">
        <div><h2><Globe2 className="h-4 w-4" aria-hidden /> Global pulse</h2><p>Global regime, region by region, and the measured transmission into Indian equities. Context and a risk input for the Money Desk; never a forecast and never a veto.</p></div>
        <Button variant="secondary" size="sm" disabled={!authed} loading={snap.isPending} onClick={() => snap.mutate()}><RefreshCw className="h-3.5 w-3.5" aria-hidden /> Snapshot now</Button>
      </div>
      {pulse.isLoading && <CardSkeleton lines={5} />}
      {pulse.isError && <ErrorState message={`Global pulse unavailable: ${pulse.error instanceof Error ? pulse.error.message : 'unknown'}`} onRetry={() => pulse.refetch()} />}
      {d && d.empty && <p className="desk-caveat">No global snapshot yet. {authed ? 'Use Snapshot now.' : 'Sign in to build one, or wait for the 08:40 job.'}</p>}
      {d && !d.empty && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Global regime" value={<Chip tone={regimeTone(d.regime.regime)} glow>{d.regime.regime.replace(/_/g, ' ').toLowerCase()}</Chip>} sub={`component score ${d.regime.score} · ${d.regime.dataCoverage.covered}/${d.regime.dataCoverage.total} components covered`} />
            <StatTile label="India transmission" value={<Chip tone={envTone(d.transmission.label)}>{d.transmission.label.toLowerCase()}</Chip>} sub={d.transmission.activeShocks.length ? `${d.transmission.activeShocks.length} active shock(s)` : 'no active shock'} />
            <StatTile label="India regime" value={(d.india.regime ?? '—').replace(/_/g, ' ').toLowerCase()} sub={d.india.diagnosis ? `diagnosis ${d.india.diagnosis.state.toLowerCase()} (${d.india.diagnosis.score}) · ${d.india.diagnosis.date}` : (d.india.reasons[0] ?? '')} />
            <StatTile label="Data as of" value={<span className="text-sm">global {d.globalDataAsOf ? fmtDateTime(d.globalDataAsOf) : '—'}</span>} sub={`India ${d.indiaDataAsOf ? fmtDateTime(d.indiaDataAsOf) : '—'} · snapshot ${fmtDateTime(d.cutoffUtc)} for session ${d.indiaSessionDate}`} />
          </div>
          <h3 className="lab-h3">Regime components</h3>
          <ul className="lab-gates">{d.regime.components.map((c) => <li key={c.name}><Chip tone={c.score == null ? 'zinc' : c.score >= 1 ? 'buy' : c.score <= -1 ? (c.score <= -2 ? 'sell' : 'amber') : 'zinc'}>{c.score == null ? 'n/a' : `${c.score > 0 ? '+' : ''}${c.score}`}</Chip><div><strong>{c.name}</strong><small>{c.value != null ? `${c.value} ${c.unit}` : c.unit} · inputs {c.inputs.join(', ')}</small><small>{c.reasons.join(' · ')}{!c.covered ? ' · NOT COVERED' : ''}</small></div></li>)}</ul>
          {GROUPS.map((g) => {
            const rows = d.observations.filter(g.match);
            if (!rows.length) return null;
            return (
              <div key={g.title}>
                <h3 className="lab-h3">{g.title}</h3>
                <div className="overflow-x-auto thin-scroll"><table className="w-full min-w-[720px] text-left text-xs"><thead><tr className="text-[10px] uppercase tracking-wide text-slate-500"><th className="px-2 py-1">Instrument</th><th className="px-2 py-1">Level</th><th className="px-2 py-1">1D</th><th className="px-2 py-1">5D</th><th className="px-2 py-1">20D</th><th className="px-2 py-1">Vol</th><th className="px-2 py-1">Session (local)</th><th className="px-2 py-1">Status</th><th className="px-2 py-1">Freshness</th></tr></thead>
                  <tbody>{rows.map((o) => <tr key={o.instrument}><td className="px-2 py-1.5"><strong>{o.name}</strong><br /><small className="text-slate-500">{o.instrument} · {o.exchangeTz}</small></td><td className="px-2 py-1.5 tabular-nums">{o.isYield ? `${o.price.toFixed(2)}%` : o.price.toLocaleString('en-US', { maximumFractionDigits: 2 })}</td><td className={clsx('px-2 py-1.5 tabular-nums', (o.return1d ?? 0) > 0 ? 'text-buy' : (o.return1d ?? 0) < 0 ? 'text-sell' : '')}>{o.isYield ? '—' : pct(o.return1d)}</td><td className={clsx('px-2 py-1.5 tabular-nums', (o.isYield ? o.chg5bps : o.return5d) ?? 0 > 0 ? '' : '')}>{o.isYield ? bps(o.chg5bps) : pct(o.return5d)}</td><td className="px-2 py-1.5 tabular-nums">{o.isYield ? bps(o.chg20bps) : pct(o.return20d)}</td><td className="px-2 py-1.5 tabular-nums">{o.volatility20 != null ? `${o.volatility20.toFixed(0)}%` : '—'}</td><td className="px-2 py-1.5">{o.sessionDate}<br /><small className="text-slate-500">closes {o.localCloseAt.split(' ')[0].slice(11, 16)} local · {fmtDateTime(o.utcCloseAt)} IST</small></td><td className="px-2 py-1.5">{o.marketStatus.toLowerCase().replace('_', ' ')}</td><td className="px-2 py-1.5"><Chip tone={o.freshness === 'FRESH' ? 'buy' : o.freshness === 'DELAYED' ? 'amber' : 'sell'}>{o.freshness.toLowerCase()}</Chip></td></tr>)}</tbody></table></div>
              </div>
            );
          })}
          {(d.missing.length > 0 || d.excludedForCutoff.length > 0) && <p className="desk-caveat"><ShieldAlert className="h-3.5 w-3.5" aria-hidden /> Not covered: {d.missing.map((m) => `${m.instrument} (${m.reason})`).join(', ') || 'none'}. {d.excludedForCutoff.length > 0 && `Excluded for the cutoff: ${d.excludedForCutoff.map((e) => `${e.instrument} ${e.sessionDate}`).join(', ')}.`}</p>}
          <h3 className="lab-h3">Impact on India</h3>
          <ul className="lab-list">{d.transmission.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {d.sectors.map((s) => <StatTile key={s.sector} label={s.name} value={<Chip tone={envTone(s.label)}>{s.label.toLowerCase()}</Chip>} sub={s.reasons[0]} />)}
          </div>
          {d.events.length > 0 && <><h3 className="lab-h3">Scheduled events</h3><ul className="lab-list">{d.events.map((e, i) => <li key={i}><Chip tone={e.importance === 'HIGH' ? 'amber' : 'zinc'}>{e.importance.toLowerCase()}</Chip> <strong>{e.event}</strong> <span className="text-slate-500">· {e.region} · {fmtDateTime(e.scheduledAt)} IST{e.actual ? ` · actual ${e.actual}` : ''}</span></li>)}</ul></>}
          <Collapsible id="global-studies" title="What has historically followed global shocks (NIFTY, 5 sessions)" subtitle={studies.data?.caveat ?? ''} defaultOpen={false}>
            {studies.data && (
              <div className="overflow-x-auto thin-scroll"><table className="w-full min-w-[760px] text-left text-xs"><thead><tr className="text-[10px] uppercase tracking-wide text-slate-500"><th className="px-2 py-1">Shock</th><th className="px-2 py-1">Target</th><th className="px-2 py-1">h</th><th className="px-2 py-1">n</th><th className="px-2 py-1">Median</th><th className="px-2 py-1">Mean</th><th className="px-2 py-1">Win rate</th><th className="px-2 py-1">Vol</th><th className="px-2 py-1">Avg max DD</th><th className="px-2 py-1">Unconditional</th></tr></thead>
                <tbody>{studies.data.studies.filter((r) => ['NIFTY', 'BANKNIFTY', 'NIFTYIT'].includes(r.target) && r.horizon === 5).map((r, i) => <tr key={i} className={clsx(!r.displayable && 'opacity-50')}><td className="px-2 py-1">{r.shock}</td><td className="px-2 py-1">{r.target}</td><td className="px-2 py-1">{r.horizon}</td><td className="px-2 py-1 tabular-nums">{r.n}{!r.displayable && ` (< ${studies.data!.minN})`}</td><td className="px-2 py-1 tabular-nums">{r.displayable ? pct(r.medianPct, 2) : 'withheld'}</td><td className="px-2 py-1 tabular-nums">{r.displayable ? pct(r.meanPct, 2) : '—'}</td><td className="px-2 py-1 tabular-nums">{r.displayable ? `${r.winRatePct}% (LB ${r.wilsonLb95Pct}%)` : '—'}</td><td className="px-2 py-1 tabular-nums">{r.displayable ? `${r.volPct}%` : '—'}</td><td className="px-2 py-1 tabular-nums">{r.displayable ? pct(r.maxDrawdownPct, 2) : '—'}</td><td className="px-2 py-1 tabular-nums">{pct(r.benchmarkMeanPct, 2)} (n={r.benchmarkN})</td></tr>)}</tbody></table></div>
            )}
          </Collapsible>
          <Collapsible id="global-sensitivities" title="Measured sector sensitivities (5-session beta / correlation)" defaultOpen={false}>
            {studies.data && <ul className="lab-list">{studies.data.sensitivities.filter((s) => s.displayable).map((s, i) => <li key={i}><strong>{s.target}</strong> vs <strong>{s.driver}</strong>: beta {s.beta} · corr {s.correlation} · n={s.n} <small className="text-slate-500">{s.note}</small></li>)}{studies.data.sensitivities.filter((s) => !s.displayable).length > 0 && <li className="text-slate-500">{studies.data.sensitivities.filter((s) => !s.displayable).length} pair(s) withheld for insufficient history.</li>}</ul>}
          </Collapsible>
          <Collapsible id="global-regime-record" title="Global regime track record" subtitle={record.data?.caveat ?? ''} defaultOpen={false}>
            {record.data && (
              <div className="overflow-x-auto thin-scroll"><table className="w-full min-w-[720px] text-left text-xs"><thead><tr className="text-[10px] uppercase tracking-wide text-slate-500"><th className="px-2 py-1">Regime</th><th className="px-2 py-1">N days</th><th className="px-2 py-1">NIFTY 1D med</th><th className="px-2 py-1">NIFTY 5D med</th><th className="px-2 py-1">5D win</th><th className="px-2 py-1">NIFTY 20D med</th><th className="px-2 py-1">Setups (shadow ledger)</th></tr></thead>
                <tbody>{record.data.regimes.map((r) => <tr key={r.regime}><td className="px-2 py-1"><Chip tone={regimeTone(r.regime)}>{r.regime.replace(/_/g, ' ').toLowerCase()}</Chip></td><td className="px-2 py-1 tabular-nums">{r.n}</td><td className="px-2 py-1 tabular-nums">{pct(r.nifty['1d']?.median, 2)}</td><td className="px-2 py-1 tabular-nums">{pct(r.nifty['5d']?.median, 2)}</td><td className="px-2 py-1 tabular-nums">{r.nifty['5d']?.winRatePct != null ? `${r.nifty['5d'].winRatePct}%` : '—'}</td><td className="px-2 py-1 tabular-nums">{pct(r.nifty['20d']?.median, 2)}</td><td className="px-2 py-1">{r.setups.length ? r.setups.map((s) => `${s.setupType.replace(/_/g, ' ').toLowerCase()}: ${s.withheld ? `n=${s.n} withheld` : `${s.winRatePct}% win, ${s.expectancyR}R (n=${s.n})`}`).join(' · ') : 'no resolved setups in this regime'}</td></tr>)}</tbody></table></div>
            )}
            {record.data?.unconditional5dMedian != null && <p className="desk-caveat">Unconditional NIFTY 5-session median over the same history: {pct(record.data.unconditional5dMedian, 2)}.</p>}
          </Collapsible>
        </>
      )}
    </section>
  );
}
