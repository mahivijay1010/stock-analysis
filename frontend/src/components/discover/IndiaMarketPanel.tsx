'use client';

import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Landmark } from 'lucide-react';
import { getIndiaPulse, getIndiaSectors } from '@/lib/api';
import { CardSkeleton, Chip, ErrorState, StatTile } from '@/components/ui';

/*
 * INDIA MARKET — the §4.5 diagnosis: trend, financials, India VIX, exchange-wide
 * breadth, turnover, INR, sector relative strength, and FII/DII stated as
 * uncovered. Diagnostic context only; the authoritative gate input remains the
 * short-term regime service, shown alongside.
 */

const stateTone = (s: string | null | undefined): 'buy' | 'zinc' | 'amber' | 'sell' => (s === 'STRONG' ? 'buy' : s === 'NEUTRAL' ? 'zinc' : s === 'WEAK' ? 'amber' : 'sell');

export function IndiaMarketPanel() {
  const q = useQuery({ queryKey: ['india-pulse'], queryFn: getIndiaPulse, staleTime: 5 * 60_000 });
  const sec = useQuery({ queryKey: ['india-sectors'], queryFn: getIndiaSectors, staleTime: 5 * 60_000 });
  const d = q.data?.diagnosis;
  return (
    <section className="glass desk-section" aria-label="India market">
      <div className="desk-section-head">
        <div><h2><Landmark className="h-4 w-4" aria-hidden /> India market</h2><p>Breadth, participation, volatility, currency and sector leadership from closed sessions. Context for the desk; the sizing gates still run on the authoritative regime shown below.</p></div>
      </div>
      {q.isLoading && <CardSkeleton lines={4} />}
      {q.isError && <ErrorState message={`India diagnosis unavailable: ${q.error instanceof Error ? q.error.message : 'unknown'}`} onRetry={() => q.refetch()} />}
      {q.data && !d && <p className="desk-caveat">No diagnosis yet — the exchange feed has no sessions loaded.</p>}
      {d && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Diagnostic state" value={<Chip tone={stateTone(d.state)} glow>{d.state.toLowerCase()}</Chip>} sub={`score ${d.score} · session ${d.sessionDate} · ${d.coverage.covered}/${d.coverage.total} components covered`} />
            <StatTile label="Authoritative regime (gates)" value={(d.authoritativeRegime?.regime ?? '—').replace(/_/g, ' ').toLowerCase()} sub={d.authoritativeRegime?.reasons[0] ?? 'unavailable'} />
            <StatTile label="Breadth" value={`${d.components.find((c) => c.name === 'Breadth')?.value ?? '—'}%`} sub={d.components.find((c) => c.name === 'Breadth')?.reasons[0] ?? ''} />
            <StatTile label="India VIX" value={d.components.find((c) => c.name === 'Volatility')?.value ?? '—'} sub={d.components.find((c) => c.name === 'Volatility')?.reasons.join(' · ') ?? ''} />
          </div>
          <ul className="lab-gates">
            {d.components.map((c) => (
              <li key={c.name}>
                <Chip tone={c.score == null ? 'zinc' : c.score >= 1 ? 'buy' : c.score <= -2 ? 'sell' : c.score < 0 ? 'amber' : 'zinc'}>{c.score == null ? 'n/a' : `${c.score > 0 ? '+' : ''}${c.score}`}</Chip>
                <div><strong>{c.name}</strong><small>{c.value != null ? `${c.value} ${c.unit}` : c.unit}{!c.covered ? ' · NOT COVERED' : ''}</small><small>{c.reasons.join(' · ')}</small></div>
              </li>
            ))}
          </ul>
          {q.data!.history.length > 5 && (
            <div>
              <h3 className="lab-h3">Last {q.data!.history.length} sessions (point-in-time)</h3>
              <div className="india-history" aria-label="India state history">
                {q.data!.history.map((h) => <span key={h.date} title={`${h.date}: ${h.state} (${h.score})`} className={clsx('india-history-cell', `india-history-${h.state.toLowerCase()}`)} />)}
              </div>
            </div>
          )}
          {sec.data && sec.data.regimes.length > 0 && (
            <div>
              <h3 className="lab-h3">Sector regimes · {sec.data.regimes[0].sessionDate}</h3>
              <div className="overflow-x-auto thin-scroll"><table className="w-full min-w-[860px] text-left text-xs"><thead><tr className="text-[10px] uppercase tracking-wide text-slate-500"><th className="px-2 py-1">Sector</th><th className="px-2 py-1">State</th><th className="px-2 py-1">20d vs NIFTY</th><th className="px-2 py-1">Trend 20d</th><th className="px-2 py-1">Breadth</th><th className="px-2 py-1">Turnover</th><th className="px-2 py-1">Vol (ann)</th><th className="px-2 py-1">Global</th><th className="px-2 py-1">Why</th></tr></thead>
                <tbody>{sec.data.regimes.map((r) => {
                  const c = (n: string) => r.components.find((x) => x.name === n);
                  return (
                    <tr key={r.sector}>
                      <td className="px-2 py-1.5"><strong>{r.name.replace(' (proxy)', '')}</strong></td>
                      <td className="px-2 py-1.5"><Chip tone={stateTone(r.state)}>{r.state.toLowerCase()}</Chip></td>
                      <td className={clsx('px-2 py-1.5 tabular-nums', (c('RelStrength')?.value ?? 0) >= 0 ? 'text-buy' : 'text-sell')}>{c('RelStrength')?.value ?? '—'} pp</td>
                      <td className="px-2 py-1.5 tabular-nums">{c('Trend')?.value ?? '—'}%</td>
                      <td className="px-2 py-1.5 tabular-nums">{c('Breadth')?.value ?? '—'}%</td>
                      <td className="px-2 py-1.5 tabular-nums">{c('Turnover')?.value ?? '—'}×</td>
                      <td className="px-2 py-1.5 tabular-nums">{c('Volatility')?.value ?? '—'}%</td>
                      <td className="px-2 py-1.5 text-slate-400">{c('GlobalTransmission')?.covered ? c('GlobalTransmission')!.reasons[0].split(':')[0] : '—'}</td>
                      <td className="px-2 py-1.5 text-slate-400">{r.reasons[1]?.slice(0, 70) ?? ''}</td>
                    </tr>
                  );
                })}</tbody></table></div>
              <p className="desk-caveat">{sec.data.note}</p>
            </div>
          )}
          <p className="desk-caveat">{q.data!.note}</p>
        </>
      )}
    </section>
  );
}
