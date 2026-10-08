'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Database, RefreshCw } from 'lucide-react';
import { getUniverseHealth, runUniverseSync } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { Button, CardSkeleton, Chip, Collapsible, ErrorState, StatTile } from '@/components/ui';
import { useAuth } from '@/components/auth/useAuth';

export function UniverseHealthPanel() {
  const { auth } = useAuth();
  const authed = auth?.status === 'authenticated';
  const h = useQuery({ queryKey: ['universe-health'], queryFn: getUniverseHealth, staleTime: 5 * 60_000 });
  const qc = useQueryClient();
  const sync = useMutation({ mutationFn: runUniverseSync, onSuccess: () => qc.invalidateQueries({ queryKey: ['universe-health'] }) });
  const d = h.data;
  const pct = (n: number, of: number) => (of > 0 ? `${((n / of) * 100).toFixed(0)}%` : '—');
  return (
    <section className="glass desk-section" aria-label="Universe health">
      <div className="desk-section-head">
        <div><h2><Database className="h-4 w-4" aria-hidden /> Universe health</h2><p>What is discovered, what is tradable, and how much data actually exists for it. Counts are stored data, not claims.</p></div>
        <Button variant="secondary" size="sm" disabled={!authed} loading={sync.isPending} onClick={() => sync.mutate()}><RefreshCw className="h-3.5 w-3.5" aria-hidden /> Sync now</Button>
      </div>
      {h.isLoading && <CardSkeleton lines={4} />}
      {h.isError && <ErrorState message={`Universe health unavailable: ${h.error instanceof Error ? h.error.message : 'unknown'}`} onRetry={() => h.refetch()} />}
      {d && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
            <StatTile label="Discovered" value={d.securities.total.toLocaleString('en-IN')} sub={Object.entries(d.securities.byType).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(' · ')} />
            <StatTile label="Active" value={d.securities.active.toLocaleString('en-IN')} sub="traded in the last 20 sessions" />
            <StatTile label="Tradable" value={<span className="text-buy">{d.securities.tradable.toLocaleString('en-IN')}</span>} sub="EQ series, tier A/B, no surveillance" />
            <StatTile label="Tier A" value={d.securities.tierA} sub="≥ ₹10cr/day" />
            <StatTile label="Tier B" value={d.securities.tierB} sub="₹2–10cr/day" />
            <StatTile label="Tier C" value={d.securities.tierC} sub="₹50L–2cr · research only" />
            <StatTile label="Excluded" value={d.securities.excluded} sub={`${d.securities.surveillance} under surveillance`} />
          </div>
          <h3 className="lab-h3">Data coverage · {d.coverage.computedAt ? fmtDateTime(d.coverage.computedAt) : '—'}</h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            <StatTile label="OHLCV bars" value={d.coverage.ohlcv} sub={`${pct(d.coverage.ohlcv, d.securities.total)} · ${d.coverage.closeOnly} close-only (exchange feed)`} />
            <StatTile label="Fundamentals" value={d.coverage.fundamentals} sub={`${pct(d.coverage.fundamentals, d.securities.total)} · results ${d.coverage.financialResults}`} />
            <StatTile label="News" value={d.coverage.news} sub={pct(d.coverage.news, d.securities.total)} />
            <StatTile label="Corporate events" value={d.coverage.corporateActions + d.coverage.announcements} sub={`${d.coverage.corporateActions} actions · ${d.coverage.announcements} announcements`} />
            <StatTile label="Technical features" value={d.coverage.technicalFeatures} sub={`${d.coverage.tradableWithTechnical} of ${d.securities.tradable} tradable`} />
            <StatTile label="Mean coverage" value={d.coverage.meanScore != null ? `${d.coverage.meanScore}/100` : '—'} sub="informational; never decides tradability" />
          </div>
          <div className="desk-chip-row">
            <Chip tone="zinc">exchange feed as of {d.freshness.deliveryAsOf ?? '—'}</Chip>
            <Chip tone="zinc">OHLCV as of {d.freshness.ohlcvAsOf ?? '—'}</Chip>
            <Chip tone="zinc">master synced {d.freshness.masterSyncedAt ? fmtDateTime(d.freshness.masterSyncedAt) : 'never'}</Chip>
            {d.providers.map((p) => <Chip key={p.provider} tone={p.state === 'OK' ? 'buy' : p.state === 'DOWN' ? 'sell' : p.state === 'DEGRADED' ? 'amber' : 'zinc'} title={p.lastError ?? ''}>{p.provider}: {p.state.toLowerCase()} · {p.calls} calls / {p.failures} failures</Chip>)}
          </div>
          <Collapsible id="universe-sync-runs" title={`Sync runs · ${d.syncRuns.length}`} defaultOpen={false}>
            <ul className="lab-list">{d.syncRuns.map((r, i) => <li key={i}><Chip tone={r.status === 'success' ? 'buy' : r.status === 'failed' ? 'sell' : 'amber'}>{r.status}</Chip> <strong>{r.job}</strong> <span className="text-slate-500">· {r.source} · {fmtDateTime(r.startedAt)}</span>{r.error && <small className="block text-sell">{r.error}</small>}<small className="block text-slate-500">{JSON.stringify(r.counts).slice(0, 220)}</small></li>)}</ul>
          </Collapsible>
          <Collapsible id="universe-failed" title={`Failed symbols / retry queue · ${d.failedSymbols.length}`} subtitle="Tradable names without stored OHLCV; the broad scan backfills them as they reach the setup engine." defaultOpen={false}>
            <ul className="lab-list">{d.failedSymbols.slice(0, 50).map((f) => <li key={f.symbol}><strong>{f.symbol}</strong> <span className="text-slate-500">— {f.reason}</span></li>)}</ul>
          </Collapsible>
          <Collapsible id="universe-changes" title={`Recent master changes · ${d.recentChanges.length}`} defaultOpen={false}>
            <ul className="lab-list">{d.recentChanges.map((c, i) => <li key={i}><Chip tone="zinc">{c.changeType.replace(/_/g, ' ').toLowerCase()}</Chip> <strong>{c.symbol}</strong> <span className="text-slate-500">{c.oldValue ? `${c.oldValue} → ` : ''}{c.newValue ?? ''} · {c.observedAt}</span></li>)}</ul>
          </Collapsible>
          <p className="desk-caveat">{d.caveat}</p>
        </>
      )}
    </section>
  );
}
