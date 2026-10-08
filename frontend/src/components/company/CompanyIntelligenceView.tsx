'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Microscope, ShieldAlert, Sparkles } from 'lucide-react';
import { AiStatement, getCompanyIntelligence, researchCompany, Sourced } from '@/lib/api';
import { fmtDateTime, inr } from '@/lib/format';
import { Button, CardSkeleton, Chip, ErrorState, StatTile, Tabs, ViewHero } from '@/components/ui';
import { useAuth } from '@/components/auth/useAuth';

/*
 * COMPANY INTELLIGENCE — the complete research page for one security. Every
 * value shows its source and as-of date; sections with no stored data say so.
 * AI statements are shown by kind (FACT / INFERENCE / HYPOTHESIS), each with
 * the evidence ids it cites. Nothing here is a recommendation.
 */

type Section = 'overview' | 'global' | 'technical' | 'fundamentals' | 'valuation' | 'ownership' | 'news' | 'events' | 'research' | 'setup' | 'risk' | 'decisions';
const SECTIONS: Array<{ value: Section; label: string }> = [
  { value: 'overview', label: 'Overview' }, { value: 'global', label: 'Global context' }, { value: 'technical', label: 'Technical' }, { value: 'fundamentals', label: 'Fundamentals' }, { value: 'valuation', label: 'Valuation' }, { value: 'ownership', label: 'Ownership' },
  { value: 'news', label: 'News' }, { value: 'events', label: 'Events' }, { value: 'research', label: 'Research' }, { value: 'setup', label: 'Short-term setup' }, { value: 'risk', label: 'Risk' }, { value: 'decisions', label: 'Decision history' },
];

function Val({ s, fmt }: { s: Sourced<number | string | null> | undefined; fmt?: (v: number) => string }) {
  if (!s || s.value == null) return <span className="text-slate-600">not on file</span>;
  const v = typeof s.value === 'number' ? (fmt ? fmt(s.value) : s.value.toLocaleString('en-IN', { maximumFractionDigits: 2 })) : String(s.value);
  return <span title={`${s.source} · as of ${s.asOf ?? '—'}`}>{v}<small className="ml-1 text-slate-500">{s.asOf ? s.asOf.slice(0, 10) : ''}</small></span>;
}
function Grid({ rows }: { rows: Array<[string, Sourced<number | string | null> | undefined, ((v: number) => string)?]> }) {
  return <dl className="desk-levels">{rows.map(([k, s, f]) => <div key={k}><dt>{k}</dt><dd><Val s={s} fmt={f} /></dd></div>)}</dl>;
}
function Statements({ items, tone }: { items: AiStatement[]; tone: 'buy' | 'sky' | 'amber' }) {
  if (!items.length) return <p className="desk-caveat">none</p>;
  return <ul className="lab-facts">{items.map((s, i) => <li key={i} className="lab-fact"><Chip tone={tone}>{s.kind}</Chip><div><p>{s.text}</p><small>cites {s.cites.join(', ')}</small></div></li>)}</ul>;
}

export function CompanyIntelligenceView({ symbol, onOpenStock, onBack }: { symbol: string | null; onOpenStock: (t: string) => void; onBack: () => void }) {
  const [section, setSection] = useState<Section>('overview');
  const { auth } = useAuth();
  const authed = auth?.status === 'authenticated';
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['company', symbol], queryFn: () => getCompanyIntelligence(symbol as string), enabled: !!symbol, staleTime: 5 * 60_000 });
  const research = useMutation({ mutationFn: (ai: boolean) => researchCompany(symbol as string, ai), onSuccess: () => qc.invalidateQueries({ queryKey: ['company', symbol] }) });
  if (!symbol) return <div className="desk-page space-y-5"><ErrorState message="No company selected." onRetry={onBack} /></div>;
  const d = q.data;
  const p = d?.profile;
  const m = p?.market ?? {};
  const f = p?.fundamentals ?? {};
  const v = p?.valuation.metrics ?? {};
  return (
    <div className="desk-page space-y-5">
      <ViewHero
        eyebrow={<span className="flex items-center gap-2"><Microscope className="h-3.5 w-3.5" aria-hidden /> Company intelligence</span>}
        title={p ? `${symbol} · ${p.identity.companyName}` : symbol}
        subtitle={p ? `${p.identity.instrumentType.toLowerCase()} · ${p.identity.sector ?? p.identity.industry ?? 'sector unknown'} · ${p.identity.marketCapBucket.toLowerCase()} cap (${p.identity.marketCapSource ?? 'unclassified'}) · liquidity tier ${p.identity.liquidityTier} · ${p.identity.indices.join(', ') || 'no index membership'}` : 'Loading the research profile…'}
        visual={false}
        right={d && (
          <div className="desk-hero-meta">
            <Chip tone="zinc">profile {d.profileSource === 'built-now' ? 'built now' : `stored ${fmtDateTime(d.profileBuiltAt)}`}</Chip>
            {p && <Chip tone={p.coverage.score != null && p.coverage.score >= 60 ? 'buy' : 'amber'}>coverage {p.coverage.score ?? '—'}/100</Chip>}
            <Button variant="secondary" size="sm" onClick={() => onOpenStock(symbol)}>Stock detail</Button>
            <Button variant="primary" size="sm" disabled={!authed} loading={research.isPending} onClick={() => research.mutate(true)} title={authed ? 'Rebuild the profile and ask the AI research assistant (budgeted)' : 'Sign in to research'}><Sparkles className="h-3.5 w-3.5" aria-hidden /> Research with AI</Button>
          </div>
        )}
      />
      {q.isLoading && <CardSkeleton lines={6} />}
      {q.isError && <ErrorState message={`Company intelligence unavailable: ${q.error instanceof Error ? q.error.message : 'unknown'}`} onRetry={() => q.refetch()} />}
      {d && p && (
        <>
          <Tabs items={SECTIONS} value={section} onChange={setSection} ariaLabel="Company sections" />
          <section className="glass desk-section space-y-4">
            {section === 'overview' && (
              <>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <StatTile label="Last close" value={m.currentPrice?.value != null ? inr(Number(m.currentPrice.value), 2) : '—'} sub={`exchange close · ${p.dataAsOf.price ?? '—'}`} />
                  <StatTile label="20d / 50d / 200d" value={`${m.return20dPct?.value ?? '—'}% / ${m.return50dPct?.value ?? '—'}% / ${m.return200dPct?.value ?? '—'}%`} sub="close-to-close returns" />
                  <StatTile label="Trend" value={String(m.trend?.value ?? '—').toLowerCase()} sub="SMA50 / SMA200 structure" />
                  <StatTile label="Engine verdict" value={p.shortTerm.action ? p.shortTerm.action.replace(/_/g, ' ').toLowerCase() : 'not evaluated'} sub={p.shortTerm.setupType ? `${p.shortTerm.setupType.replace(/_/g, ' ').toLowerCase()} · tier ${p.shortTerm.tier} · health ${p.shortTerm.modelHealth}` : p.shortTerm.source} />
                </div>
                <h3 className="lab-h3">Business</h3>
                <p>{p.business.summary ? <>{p.business.summary.value} <small className="text-slate-500">({p.business.summary.source}, {p.business.summary.asOf})</small></> : <span className="text-slate-500">No business summary on file.</span>}</p>
                {p.gaps.length > 0 && <div><h3 className="lab-h3">Data gaps</h3><ul className="lab-list">{p.gaps.map((g) => <li key={g}><ShieldAlert className="inline h-3.5 w-3.5 text-amber-400" aria-hidden /> {g}</li>)}</ul></div>}
                <p className="desk-caveat">Dates differ by section: price {p.dataAsOf.price ?? '—'} · fundamentals {p.dataAsOf.fundamentals?.slice(0, 10) ?? '—'} · results {p.dataAsOf.results ?? '—'} · news {p.dataAsOf.news ?? '—'} · engine {p.dataAsOf.shortTerm?.slice(0, 10) ?? '—'}.</p>
              </>
            )}
            {section === 'global' && (
              <>
                {p.globalContext ? (
                  <>
                    <div className="desk-chip-row">
                      <Chip tone={p.globalContext.globalRegime === 'RISK_ON' ? 'buy' : p.globalContext.globalRegime === 'NEUTRAL' ? 'zinc' : p.globalContext.globalRegime === 'CAUTIOUS' ? 'amber' : 'sell'}>global {(p.globalContext.globalRegime ?? 'unknown').replace(/_/g, ' ').toLowerCase()}</Chip>
                      <Chip tone="zinc">India {(p.globalContext.indiaRegime ?? 'unknown').replace(/_/g, ' ').toLowerCase()}</Chip>
                      <Chip tone={p.globalContext.transmission === 'TAILWIND' ? 'buy' : p.globalContext.transmission === 'NEUTRAL' ? 'zinc' : p.globalContext.transmission === 'HEADWIND' ? 'amber' : 'sell'}>transmission {(p.globalContext.transmission ?? 'unknown').toLowerCase()}</Chip>
                      {p.globalContext.sectorName && <Chip tone={p.globalContext.sectorLabel === 'TAILWIND' ? 'buy' : p.globalContext.sectorLabel === 'NEUTRAL' ? 'zinc' : 'amber'}>{p.globalContext.sectorName}: {(p.globalContext.sectorLabel ?? 'neutral').toLowerCase()}</Chip>}
                    </div>
                    <ul className="lab-facts">{p.globalContext.statements.map((st, i) => <li key={i} className="lab-fact"><Chip tone="zinc">measured</Chip><div><p>{st.text}</p><small>evidence: {st.evidence}</small></div></li>)}</ul>
                  </>
                ) : <p className="desk-caveat">Global context not available for this profile build.</p>}
                <p className="desk-caveat">Global and sector labels are measured relationships (5-session betas, shock studies) and regimes classified from closed sessions only. They are context, not a recommendation.</p>
              </>
            )}
            {section === 'technical' && <Grid rows={[['Close', m.currentPrice], ['20d return %', m.return20dPct], ['50d return %', m.return50dPct], ['200d return %', m.return200dPct], ['Volatility (20d, ann) %', m.volatility20AnnPct], ['ATR proxy %/day', m.atrProxyPct], ['Relative strength 60d vs NIFTY %', m.relativeStrength60Pct], ['52w high', m.high52w], ['52w low', m.low52w], ['Trend', m.trend], ['Median daily value ₹', m.medianDailyValueInr, (x) => `₹${(x / 1e7).toFixed(1)}cr`], ['Delivery % (20d)', m.deliveryPct20]]} />}
            {section === 'fundamentals' && <Grid rows={[['Revenue', f.revenue], ['Revenue growth %', f.revenueGrowthPct], ['EBITDA', f.ebitda], ['Operating margin %', f.operatingMarginPct], ['Net profit', f.netProfit], ['Profit growth %', f.profitGrowthPct], ['EPS', f.eps], ['ROE %', f.roePct], ['ROCE %', f.rocePct], ['Debt', f.debt], ['Debt / equity', f.debtToEquity], ['Free cash flow', f.freeCashFlow]]} />}
            {section === 'valuation' && <><Grid rows={[['P/E', v.pe], ['P/B', v.pb], ['EV / EBITDA', v.evToEbitda], ['Market cap', v.marketCapInr], ['Dividend yield %', v.dividendYieldPct], ['Book value', v.bookValue]]} />{p.valuation.context && <p className="desk-caveat">{p.valuation.context.value}</p>}</>}
            {section === 'ownership' && <><Grid rows={[['Promoter holding %', f.promoterHoldingPct], ['Promoter change QoQ (pp)', f.promoterHoldingChangeQoQ]]} /><p className="desk-caveat">Institutional (FII/DII) holding is not available from any configured source.</p></>}
            {section === 'news' && (p.news.length ? <ul className="lab-list">{p.news.map((n, i) => <li key={i}><Chip tone={n.sentiment === 'POSITIVE' ? 'buy' : n.sentiment === 'NEGATIVE' ? 'sell' : 'zinc'}>{n.kind.toLowerCase()}</Chip> {n.fact} <small className="text-slate-500">· {n.observedAt}{n.materiality ? ` · ${n.materiality.toLowerCase()} materiality` : ''}{n.sourceUrl ? <> · <a className="radar-text-link" href={n.sourceUrl} target="_blank" rel="noreferrer">source</a></> : ''}</small></li>)}</ul> : <p className="desk-caveat">No news facts on file for this symbol.</p>)}
            {section === 'events' && (
              <>
                {p.events.length ? <ul className="lab-list">{p.events.map((e, i) => <li key={i}><Chip tone={e.kind === 'REGULATORY' || e.kind === 'LEGAL' ? 'sell' : 'zinc'}>{e.kind.toLowerCase().replace(/_/g, ' ')}</Chip> {e.fact} <small className="text-slate-500">· {e.eventDate ?? e.observedAt} · {e.source}</small></li>)}</ul> : <p className="desk-caveat">No corporate events, results or announcements on file.</p>}
                {p.results.length > 0 && <><h3 className="lab-h3">Financial results (XBRL)</h3><div className="overflow-x-auto thin-scroll"><table className="w-full min-w-[520px] text-left text-xs"><thead><tr className="text-[10px] uppercase text-slate-500"><th className="px-2 py-1">Period end</th><th className="px-2 py-1">Type</th><th className="px-2 py-1">Concept</th><th className="px-2 py-1">Value</th></tr></thead><tbody>{p.results.slice(0, 24).map((r, i) => <tr key={i}><td className="px-2 py-1">{r.periodEnd}</td><td className="px-2 py-1">{r.periodType}</td><td className="px-2 py-1">{r.concept}</td><td className="px-2 py-1 tabular-nums">{r.value.toLocaleString('en-IN')}</td></tr>)}</tbody></table></div></>}
              </>
            )}
            {section === 'research' && (
              <>
                {d.ai ? (
                  <>
                    <p className="desk-caveat">AI research · model {d.ai.modelVersion} · prompt {d.ai.promptVersion} · {d.aiBuiltAt ? fmtDateTime(d.aiBuiltAt) : ''} · {d.ai.dropped} statement(s) dropped for citing nothing or inventing numbers.</p>
                    <h3 className="lab-h3">Facts</h3><Statements items={d.ai.facts} tone="buy" />
                    <h3 className="lab-h3">Inferences</h3><Statements items={d.ai.inferences} tone="sky" />
                    <h3 className="lab-h3">Hypotheses</h3><Statements items={d.ai.hypotheses} tone="amber" />
                  </>
                ) : <p className="desk-caveat">No AI research yet. {authed ? 'Use "Research with AI" above (cost-governed).' : 'Sign in to run it.'}</p>}
                <h3 className="lab-h3">Evidence items · {d.evidence.length}</h3>
                <ul className="lab-facts">{d.evidence.map((e) => <li key={e.id} className="lab-fact"><Chip tone="zinc">{e.id}</Chip><div><p>{e.statement}</p><small>{e.section} · {e.source} · {e.asOf ?? '—'}{e.sourceUrl ? <> · <a className="radar-text-link" href={e.sourceUrl} target="_blank" rel="noreferrer">link</a></> : ''}</small></div></li>)}</ul>
              </>
            )}
            {section === 'setup' && (
              <>
                <p className="desk-caveat">{p.shortTerm.source}{p.shortTerm.evaluatedAt ? ` · ${fmtDateTime(p.shortTerm.evaluatedAt)}` : ''}</p>
                <dl className="desk-levels">
                  <div><dt>Trend</dt><dd>{p.shortTerm.trend ?? '—'}</dd></div>
                  <div><dt>Setup</dt><dd>{p.shortTerm.setupType?.replace(/_/g, ' ').toLowerCase() ?? '—'}</dd></div>
                  <div><dt>Action</dt><dd>{p.shortTerm.action?.replace(/_/g, ' ').toLowerCase() ?? '—'}</dd></div>
                  <div><dt>Evidence tier</dt><dd>{p.shortTerm.tier ?? '—'}</dd></div>
                  <div><dt>Model health</dt><dd>{p.shortTerm.modelHealth ?? '—'}</dd></div>
                  <div><dt>Support / resistance</dt><dd>{p.shortTerm.support ?? '—'} / {p.shortTerm.resistance ?? '—'}</dd></div>
                  <div><dt>Entry zone</dt><dd className="text-info">{p.shortTerm.entryZoneLow ?? '—'}–{p.shortTerm.entryZoneHigh ?? '—'}</dd></div>
                  <div><dt>Stop</dt><dd className="text-sell">{p.shortTerm.stop ?? '—'}</dd></div>
                  <div><dt>Targets</dt><dd className="text-buy">{p.shortTerm.target1 ?? '—'} / {p.shortTerm.target2 ?? '—'}</dd></div>
                  <div><dt>Reward / risk</dt><dd>{p.shortTerm.rewardRisk != null ? `${p.shortTerm.rewardRisk.toFixed(2)}×` : '—'}</dd></div>
                  <div><dt>EV80 lower bound</dt><dd className={clsx(p.shortTerm.ev80LowerPct != null && (p.shortTerm.ev80LowerPct > 0 ? 'text-buy' : 'text-sell'))}>{p.shortTerm.ev80LowerPct != null ? `${p.shortTerm.ev80LowerPct.toFixed(2)}%` : '—'}</dd></div>
                </dl>
                {p.shortTerm.whyNotEntry.length > 0 && <><h3 className="lab-h3">Why not entry</h3><ul className="lab-list">{p.shortTerm.whyNotEntry.map((w) => <li key={w}>{w}</li>)}</ul></>}
                <Button variant="secondary" size="sm" onClick={() => onOpenStock(symbol)}>Open stock detail</Button>
              </>
            )}
            {section === 'risk' && (
              <dl className="desk-levels">
                <div><dt>Liquidity tier</dt><dd>{d.risk?.liquidity_tier ?? '—'}</dd></div>
                <div><dt>Median daily value</dt><dd>{d.risk?.liquidity_median_value_inr ? `₹${(Number(d.risk.liquidity_median_value_inr) / 1e7).toFixed(1)}cr` : '—'}</dd></div>
                <div><dt>Surveillance</dt><dd className={d.risk?.surveillance ? 'text-sell' : ''}>{d.risk?.surveillance ?? 'none'}</dd></div>
                <div><dt>Tradable (short-term universe)</dt><dd>{d.risk?.is_tradable ? 'yes' : 'no'}</dd></div>
                <div><dt>Data status</dt><dd>{d.risk?.data_status ?? '—'}</dd></div>
                <div><dt>Volatility (20d ann)</dt><dd><Val s={m.volatility20AnnPct} /></dd></div>
              </dl>
            )}
            {section === 'decisions' && (
              <>
                <h3 className="lab-h3">Money Desk decisions</h3>
                {d.decisionHistory.length ? <ul className="lab-list">{d.decisionHistory.map((x, i) => <li key={i}><Chip tone={x.action === 'ALLOCATE' ? 'buy' : x.action === 'EXIT' || x.action === 'REDUCE' ? 'sell' : 'zinc'}>{x.action}</Chip> {x.plan_date} · {x.decision_status} · {x.risk_profile.toLowerCase()} · regime {x.market_regime.toLowerCase()}{x.entry_price ? ` · entry ${x.entry_price} stop ${x.stop_price} T1 ${x.target1}` : ''} <small className="text-slate-500">{(x.reason_codes ?? []).join(', ')}</small></li>)}</ul> : <p className="desk-caveat">No Money Desk decision has referenced this symbol.</p>}
                <h3 className="lab-h3">Scan history</h3>
                {d.scanHistory.length ? <ul className="lab-list">{d.scanHistory.map((x, i) => <li key={i}><Chip tone={x.stage_reached === 'MONEY_DESK' ? 'buy' : 'zinc'}>{x.stage_reached.replace(/_/g, ' ').toLowerCase()}</Chip> {x.as_of} · signals {x.signals.join(', ') || 'none'} · {x.setup_type ?? 'not reached'} {x.tier ? `tier ${x.tier}` : ''} <small className="text-slate-500">{(x.rejection_reasons ?? []).slice(0, 2).join('; ')}</small></li>)}</ul> : <p className="desk-caveat">Not yet in a broad scan.</p>}
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}
