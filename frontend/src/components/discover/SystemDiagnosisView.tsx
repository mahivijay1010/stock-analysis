'use client';

import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Activity } from 'lucide-react';
import { getGlobalPulse, getIndiaPulse, getIndiaSectors, getUniverseFunnel, getUniverseHealth } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { CardSkeleton, Chip, ErrorState, StatTile, ViewHero } from '@/components/ui';

/*
 * SYSTEM DIAGNOSIS — one page for "why am I seeing these stocks today?":
 * GLOBAL → INDIA → SECTORS → UNIVERSE → the funnel stage by stage → the exact
 * rejection chain when the answer is zero. Composed read-only from the same
 * endpoints the individual panels use; nothing is recomputed here.
 */

const tone = (s: string | null | undefined): 'buy' | 'zinc' | 'amber' | 'sell' =>
  s === 'RISK_ON' || s === 'STRONG' || s === 'TAILWIND' || s === 'TREND_UP' ? 'buy'
  : s === 'CAUTIOUS' || s === 'WEAK' || s === 'HEADWIND' || s === 'CHOPPY' || s === 'HIGH_VOL' ? 'amber'
  : s === 'RISK_OFF' || s === 'STRESSED' || s === 'STRESS' || s === 'TREND_DOWN' || s === 'CRISIS' ? 'sell' : 'zinc';
const STAGE_LABEL: Record<string, string> = { UNIVERSE: 'Universe', DATA_VALIDATION: 'Data valid', LIQUIDITY: 'Liquidity', TECHNICAL: 'Technical', FUNDAMENTAL_EVENT: 'Fundamentals / events', SETUP_ENGINE: 'Setup engine', DECISION_GATES: 'Decision gates', RISK: 'Risk', MODEL_HEALTH: 'Model health', MONEY_DESK: 'Money Desk' };

export function SystemDiagnosisView() {
  const g = useQuery({ queryKey: ['global-pulse'], queryFn: getGlobalPulse, staleTime: 5 * 60_000 });
  const i = useQuery({ queryKey: ['india-pulse'], queryFn: getIndiaPulse, staleTime: 5 * 60_000 });
  const s = useQuery({ queryKey: ['india-sectors'], queryFn: getIndiaSectors, staleTime: 5 * 60_000 });
  const f = useQuery({ queryKey: ['universe-funnel'], queryFn: getUniverseFunnel, staleTime: 5 * 60_000 });
  const h = useQuery({ queryKey: ['universe-health'], queryFn: getUniverseHealth, staleTime: 5 * 60_000 });
  const loading = g.isLoading || i.isLoading || f.isLoading;
  const stages = f.data?.stages ?? [];
  const bottleneck = stages.find((x) => x.entered > 0 && x.passed === 0);
  const sectors = s.data?.regimes ?? [];
  return (
    <div className="desk-page space-y-5">
      <ViewHero
        eyebrow={<span className="flex items-center gap-2"><Activity className="h-3.5 w-3.5" aria-hidden /> System diagnosis</span>}
        title={f.data?.finalQualified ? `${f.data.finalQualified} setup(s) survived the full pipeline` : 'Why am I seeing zero stocks today?'}
        subtitle="Global conditions → India → sectors → the broad universe → every gate, with the exact chain of eliminations. Zero is a valid, explained outcome — nothing below was weakened to force a trade."
        visual={false}
      />
      {loading && <CardSkeleton lines={6} />}
      {g.isError && <ErrorState message="Global pulse unavailable" onRetry={() => g.refetch()} />}
      {!loading && (
        <>
          <section className="glass desk-section">
            <div className="desk-section-head"><div><h2>1 · Environment</h2><p>Context and risk inputs. None of these vetoes a stock.</p></div></div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile label="Global regime" value={<Chip tone={tone(g.data?.regime?.regime)} glow>{(g.data?.regime?.regime ?? '—').replace(/_/g, ' ').toLowerCase()}</Chip>} sub={g.data ? `score ${g.data.regime.score} · ${g.data.coverage.valid}/${g.data.coverage.scanned} instruments valid · global data ${g.data.globalDataAsOf ? fmtDateTime(g.data.globalDataAsOf) : '—'}` : 'no snapshot'} />
              <StatTile label="India transmission" value={<Chip tone={tone(g.data?.transmission?.label)}>{(g.data?.transmission?.label ?? '—').toLowerCase()}</Chip>} sub={g.data?.transmission?.activeShocks.length ? g.data.transmission.activeShocks.join(' · ') : 'no active global shock'} />
              <StatTile label="India diagnosis" value={<Chip tone={tone(i.data?.diagnosis?.state)}>{(i.data?.diagnosis?.state ?? '—').toLowerCase()}</Chip>} sub={i.data?.diagnosis ? `score ${i.data.diagnosis.score} · session ${i.data.diagnosis.sessionDate} · regime (gates) ${i.data.diagnosis.authoritativeRegime?.regime ?? '—'}` : 'no diagnosis'} />
              <StatTile label="Sectors" value={sectors.length ? `${sectors.filter((x) => x.state === 'STRONG').length} strong · ${sectors.filter((x) => x.state === 'WEAK').length} weak · ${sectors.filter((x) => x.state === 'STRESSED').length} stressed` : '—'} sub={sectors.length ? `of ${sectors.length} proxies · ${sectors[0].sessionDate}` : 'no sector regimes'} />
            </div>
            {sectors.length > 0 && <div className="desk-chip-row">{sectors.map((x) => <Chip key={x.sector} tone={tone(x.state)} title={x.reasons[1] ?? ''}>{x.name.replace(' (proxy)', '')}: {x.state.toLowerCase()}</Chip>)}</div>}
          </section>
          <section className="glass desk-section">
            <div className="desk-section-head"><div><h2>2 · Universe & data</h2><p>What is tradable and how much data exists for it.</p></div></div>
            <ol className="scanner-funnel">
              {[['Securities', h.data?.securities.total], ['Active', h.data?.securities.active], ['Tradable (tier A/B)', h.data?.securities.tradable], ['With OHLCV', h.data?.coverage.ohlcv], ['With fundamentals', h.data?.coverage.fundamentals], ['With events', (h.data?.coverage.announcements ?? 0) + (h.data?.coverage.corporateActions ?? 0)], ['With news', h.data?.coverage.news]].map(([l, v]) => (
                <li key={String(l)}><div className="scanner-funnel-static"><span>{l}</span><strong>{v != null ? Number(v).toLocaleString('en-IN') : '—'}</strong></div></li>
              ))}
            </ol>
          </section>
          <section className="glass desk-section">
            <div className="desk-section-head"><div><h2>3 · The funnel today</h2><p>{f.data?.asOf ? `Broad scan as of ${f.data.asOf} (regime ${(f.data.regime ?? 'unknown').toLowerCase()}).` : 'No broad scan has run yet.'}</p></div></div>
            <ol className="scanner-funnel">
              {stages.map((st) => <li key={st.stage} className={clsx(st.entered > 0 && st.passed === 0 && 'scanner-funnel-zero')}><div className="scanner-funnel-static"><span>{STAGE_LABEL[st.stage] ?? st.stage}</span><strong>{st.passed}</strong><small>of {st.entered}</small></div></li>)}
            </ol>
            {bottleneck && (
              <div className="desk-card-panel">
                <strong className="text-slate-200">Bottleneck: {STAGE_LABEL[bottleneck.stage] ?? bottleneck.stage} rejected {bottleneck.entered}/{bottleneck.entered}.</strong>
                <ul>{Object.entries(bottleneck.reasons).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => <li key={k}>{n} × {k}</li>)}</ul>
              </div>
            )}
            {(f.data?.zeroBecause?.length ?? 0) > 0 && <ul className="desk-why-cash">{f.data!.zeroBecause.slice(0, 6).map((z) => <li key={z}>{z}</li>)}</ul>}
            <p className="desk-caveat">The two binding constraints are evidence floors, not settings: no setup×horizon cell has reached tier A, and the model health of every setup is still SHADOW. They resolve through sample accrual (the nightly broad scan), never through lowered thresholds.</p>
          </section>
        </>
      )}
    </div>
  );
}
