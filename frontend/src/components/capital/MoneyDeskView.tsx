'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpRight,
  Ban,
  ChevronDown,
  Eye,
  FlaskConical,
  PiggyBank,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Wallet,
} from 'lucide-react';
import {
  addWatchlistItem,
  CapitalHorizon,
  CapitalPlanResponse,
  getCapitalHistory,
  getCapitalToday,
  getCapitalTrackRecord,
  getDeskSettings,
  isUnauthorized,
  PlannedAllocation,
  putDeskSettings,
  RejectedCandidate,
  RiskProfileName,
  simulateCapital,
  WithdrawalDecision,
} from '@/lib/api';
import { fmtDateTime, inr } from '@/lib/format';
import { Button, CardSkeleton, Chip, Collapsible, EmptyState, ErrorState, Input, Select, StatTile, ViewHero } from '@/components/ui';
import { useAuth } from '@/components/auth/useAuth';
import { LoginPanel } from '@/components/auth/LoginPanel';

/*
 * MONEY DESK — the action-oriented front door. Hierarchy: ACTION → RISK →
 * EVIDENCE → DETAILS. The user's money decision is the hero; AI is never the
 * hero (it only caps). Vocabulary: "system recommendation", "qualified setup",
 * "conditional allocation", "evidence strength", "scenario". Never "guaranteed",
 * "will rise", "safe profit", "best stock". Probability only when AVAILABLE.
 */

const PROFILE_OPTIONS: Array<{ value: RiskProfileName; label: string }> = [
  { value: 'CONSERVATIVE', label: 'Conservative' },
  { value: 'BALANCED', label: 'Balanced' },
  { value: 'AGGRESSIVE', label: 'Aggressive' },
];
const HORIZON_OPTIONS: Array<{ value: CapitalHorizon; label: string }> = [
  { value: '3-5d', label: '3–5 sessions' },
  { value: '5-10d', label: '5–10 sessions' },
  { value: '10-21d', label: '10–21 sessions' },
];
const MAXPOS_OPTIONS = [
  { value: '0', label: 'Profile default' },
  ...[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `${n} position${n > 1 ? 's' : ''}` })),
];
const PREFS_KEY = 'stocksense.moneyDesk.controls';

interface Controls {
  capital: number;
  profile: RiskProfileName;
  horizon: CapitalHorizon;
  maxPositions: number;
}
const DEFAULT_CONTROLS: Controls = { capital: 20000, profile: 'BALANCED', horizon: '5-10d', maxPositions: 0 };

function freshnessTone(q: CapitalPlanResponse['freshness']['quoteType']): 'buy' | 'amber' | 'sell' | 'zinc' {
  return q === 'LIVE' ? 'buy' : q === 'EOD_FINAL' ? 'zinc' : q === 'DELAYED_INTRADAY' ? 'amber' : 'sell';
}
function freshnessLabel(f: CapitalPlanResponse['freshness']): string {
  const kind = f.quoteType === 'EOD_FINAL' ? 'EOD' : f.quoteType === 'DELAYED_INTRADAY' ? 'DELAYED' : f.quoteType;
  return `${kind}${f.latestCompletedBarDate ? ` · bar ${f.latestCompletedBarDate}` : ''} · ${f.marketState.toLowerCase()}`;
}
function regimeTone(r: string): 'buy' | 'amber' | 'sell' | 'zinc' {
  return r === 'TREND_UP' ? 'buy' : r === 'CRISIS' || r === 'TREND_DOWN' ? 'sell' : r === 'HIGH_VOL' || r === 'CHOPPY' ? 'amber' : 'zinc';
}
const money0 = (v: number | null | undefined) => (v == null ? '—' : inr(v, 0));

/* ── Section A card ─────────────────────────────────────────────────────── */
function AllocationCard({ a, onOpenStock, onSimulate }: { a: PlannedAllocation; onOpenStock: (t: string) => void; onSimulate: () => void }) {
  const [panel, setPanel] = useState<'why' | 'risks' | 'changes' | null>(null);
  const qc = useQueryClient();
  const watch = useMutation({
    mutationFn: () => addWatchlistItem({ ticker: a.ticker.replace(/\.NS$/, ''), horizon: 'short', note: `Money Desk ${a.action}: entry ${a.entryPrice}, stop ${a.stopPrice}, T1 ${a.target1}` }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portfolio-overview'] }),
  });
  const toggle = (p: typeof panel) => setPanel((cur) => (cur === p ? null : p));
  return (
    <article className={clsx('desk-card glass', a.action === 'ALLOCATE' ? 'desk-card-allocate' : 'desk-card-watch')}>
      <header className="desk-card-head">
        <div>
          <button type="button" className="desk-ticker" onClick={() => onOpenStock(a.ticker.replace(/\.NS$/, ''))}>
            {a.ticker.replace(/\.NS$/, '')} <ArrowUpRight aria-hidden className="h-3.5 w-3.5" />
          </button>
          <p className="desk-card-sub">{a.name}{a.sector ? ` · ${a.sector}` : ''} · {a.setupType.replace(/_/g, ' ').toLowerCase()}</p>
        </div>
        <Chip tone={a.action === 'ALLOCATE' ? 'buy' : 'amber'} glow={a.action === 'ALLOCATE'}>
          {a.action === 'ALLOCATE' ? `ALLOCATE ${money0(a.recommendedAmountInr)}` : `CONDITIONAL · max ${money0(a.maxAmountInr)}`}
        </Chip>
      </header>
      {a.environment && (
        <div className="desk-chip-row" aria-label="Environment">
          <Chip tone="zinc" title="Environment is context: it never vetoes the setup">{a.environment.label}</Chip>
          {(['global', 'india', 'sector'] as const).map((k) => <Chip key={k} tone={a.environment[k] === 'TAILWIND' ? 'buy' : a.environment[k] === 'NEUTRAL' ? 'zinc' : a.environment[k] === 'HEADWIND' ? 'amber' : 'sell'}>{k} {a.environment[k].toLowerCase()}</Chip>)}
          <Chip tone={a.environment.setup === 'PASS' ? 'buy' : 'amber'}>setup {a.environment.setup}</Chip>
          {a.environment.macroRiskMultiplier < 1 && <Chip tone="amber">size ×{a.environment.macroRiskMultiplier} macro</Chip>}
        </div>
      )}
      <dl className="desk-levels">
        <div><dt>Amount · qty</dt><dd>{money0(a.recommendedAmountInr)} · {a.recommendedQuantity}</dd></div>
        <div><dt>Entry</dt><dd className="text-info">{a.entryZoneLow != null && a.entryZoneHigh != null ? `${a.entryZoneLow}–${a.entryZoneHigh}` : a.entryPrice}</dd></div>
        <div><dt>Stop</dt><dd className="text-sell">{a.stopPrice}</dd></div>
        <div><dt>Target 1</dt><dd className="text-buy">{a.target1}</dd></div>
        <div><dt>Risk ₹</dt><dd className="text-sell">{money0(a.riskAmountInr)}</dd></div>
        <div><dt>R:R</dt><dd>{a.rewardRisk.toFixed(2)}×</dd></div>
        <div><dt>Horizon</dt><dd>{a.expectedHoldingSessions} sessions</dd></div>
        <div><dt>Evidence</dt><dd>tier {a.evidenceTier}{a.ev80LowerPct != null ? ` · EV80 LB ${a.ev80LowerPct > 0 ? '+' : ''}${a.ev80LowerPct.toFixed(2)}%` : ''}</dd></div>
        <div><dt>Probability</dt><dd>{a.probability.status === 'AVAILABLE' && a.probability.targetBeforeStop != null ? `${(a.probability.targetBeforeStop * 100).toFixed(0)}% (calibrated)` : 'unavailable — not calibrated'}</dd></div>
        <div><dt>Share of capital</dt><dd>{a.percentageOfCapital.toFixed(1)}%</dd></div>
      </dl>
      <div className="desk-card-actions">
        <Button variant="secondary" size="sm" aria-pressed={panel === 'why'} onClick={() => toggle('why')}>Why?</Button>
        <Button variant="secondary" size="sm" aria-pressed={panel === 'risks'} onClick={() => toggle('risks')}>Risks</Button>
        <Button variant="secondary" size="sm" aria-pressed={panel === 'changes'} onClick={() => toggle('changes')}>What changes this?</Button>
        <Button variant="ghost" size="sm" onClick={() => onOpenStock(a.ticker.replace(/\.NS$/, ''))}>View full plan</Button>
        <Button variant="ghost" size="sm" onClick={onSimulate}><FlaskConical className="h-3.5 w-3.5" aria-hidden /> Simulate</Button>
        <Button variant="ghost" size="sm" loading={watch.isPending} disabled={watch.isSuccess} onClick={() => watch.mutate()}><Eye className="h-3.5 w-3.5" aria-hidden /> {watch.isSuccess ? 'On watchlist' : 'Add to watchlist'}</Button>
      </div>
      {panel && (
        <div className="desk-card-panel" role="region" aria-live="polite">
          {panel === 'why' && (
            <ul>
              {a.reasonCodes.map((c) => <li key={c}><strong>{c.replace(/_/g, ' ').toLowerCase()}</strong></li>)}
              {a.sizingConstraints.map((s) => <li key={s}>sizing: {s}</li>)}
              <li>size = (equity × risk per trade) ÷ loss per share incl. costs, slippage and gap buffer — never capital ÷ price</li>
            </ul>
          )}
          {panel === 'risks' && <ul>{a.riskReasons.map((r) => <li key={r}>{r}</li>)}{a.invalidationReasons.map((r) => <li key={r}>{r}</li>)}</ul>}
          {panel === 'changes' && <ul>{a.changesIf.map((r) => <li key={r}>{r}</li>)}</ul>}
        </div>
      )}
    </article>
  );
}

/* ── Section B row ──────────────────────────────────────────────────────── */
function HoldingRow({ w, onOpenStock }: { w: WithdrawalDecision; onOpenStock: (t: string) => void }) {
  const [open, setOpen] = useState(false);
  const tone: 'buy' | 'amber' | 'sell' | 'zinc' | 'sky' = w.action === 'EXIT' ? 'sell' : w.action === 'REDUCE' ? 'amber' : w.action === 'TRAIL' ? 'sky' : 'zinc';
  return (
    <article className={clsx('desk-holding glass-inset', `desk-holding-${w.action.toLowerCase()}`)}>
      <header className="desk-card-head">
        <div>
          <button type="button" className="desk-ticker" onClick={() => onOpenStock(w.ticker)}>{w.ticker} <ArrowUpRight aria-hidden className="h-3.5 w-3.5" /></button>
          <p className="desk-card-sub">{w.name} · {w.qty} shares{w.evidenceAsOf ? ` · evaluated ${fmtDateTime(w.evidenceAsOf)}` : ' · no evaluation on file'}</p>
        </div>
        <Chip tone={tone}>{w.action}{w.action === 'REDUCE' || w.action === 'EXIT' ? ` · withdraw ${money0(w.amountToWithdrawInr)}` : ''}</Chip>
      </header>
      <dl className="desk-levels desk-levels-compact">
        <div><dt>Current</dt><dd>{money0(w.currentValueInr)}</dd></div>
        <div><dt>Invested</dt><dd>{money0(w.investedInr)}</dd></div>
        <div><dt>P&amp;L</dt><dd className={w.pnlInr == null ? '' : w.pnlInr >= 0 ? 'text-buy' : 'text-sell'}>{w.pnlInr == null ? '—' : `${w.pnlInr >= 0 ? '+' : ''}${inr(w.pnlInr, 0)}${w.pnlPct != null ? ` (${w.pnlPct.toFixed(1)}%)` : ''}`}</dd></div>
        <div><dt>Recommended remaining</dt><dd>{money0(w.recommendedRemainingInr)}</dd></div>
        <div><dt>Withdraw</dt><dd className={w.amountToWithdrawInr ? 'text-sell' : ''}>{w.amountToWithdrawInr ? `${money0(w.amountToWithdrawInr)} · ${w.qtyToSell} sh` : '—'}</dd></div>
        <div><dt>Trail stop</dt><dd>{w.trailStopPrice ?? '—'}</dd></div>
      </dl>
      <p className="desk-reason"><strong>Reason:</strong> {w.reasons[0]}</p>
      <button type="button" className="desk-expand" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        Invalidation &amp; detail <ChevronDown className={clsx('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open && <div className="desk-card-panel"><ul>{w.reasons.slice(1).map((r) => <li key={r}>{r}</li>)}{w.invalidation.map((r) => <li key={r}><strong>changes if:</strong> {r}</li>)}</ul></div>}
    </article>
  );
}

/* ── Why not ────────────────────────────────────────────────────────────── */
function WhyNot({ rejected }: { rejected: RejectedCandidate[] }) {
  const [filter, setFilter] = useState<string>('ALL');
  const [limit, setLimit] = useState(12);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rejected) for (const c of r.reasonCodes) m.set(c, (m.get(c) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [rejected]);
  const rows = rejected.filter((r) => filter === 'ALL' || r.reasonCodes.includes(filter));
  return (
    <Collapsible id="money-desk-why-not" title={`Why not? ${rejected.length} candidates did not qualify`} subtitle="Every rejection names the gate it failed. This is the engine's own verdict, not a black box." defaultOpen={false}>
      <div className="desk-chip-row">
        <button type="button" className={clsx('desk-filter', filter === 'ALL' && 'desk-filter-active')} onClick={() => setFilter('ALL')}>All <span>{rejected.length}</span></button>
        {counts.map(([code, n]) => (
          <button key={code} type="button" className={clsx('desk-filter', filter === code && 'desk-filter-active')} onClick={() => { setFilter(code); setLimit(12); }}>
            {code.replace(/_/g, ' ').toLowerCase()} <span>{n}</span>
          </button>
        ))}
      </div>
      <ul className="desk-whynot-list">
        {rows.slice(0, limit).map((r) => (
          <li key={r.ticker}>
            <div className="desk-whynot-head"><strong>{r.ticker.replace(/\.NS$/, '')}</strong><span>{r.name} · tier {r.tier} · {r.action.replace(/_/g, ' ').toLowerCase()}</span></div>
            <ul>{r.whyNot.slice(0, 4).map((w) => <li key={w}>{w}</li>)}{r.gateFailures.slice(0, 3).map((g) => <li key={g.gate}>gate {g.gate}: {g.current} (needs {g.required})</li>)}</ul>
          </li>
        ))}
      </ul>
      {rows.length > limit && <Button variant="secondary" size="sm" onClick={() => setLimit((n) => n + 12)}>Show 12 more</Button>}
    </Collapsible>
  );
}

/* ── Simulator ──────────────────────────────────────────────────────────── */
function Simulator({ base, id }: { base: Controls; id: string }) {
  const [c, setC] = useState<Controls>(base);
  const sim = useMutation({ mutationFn: () => simulateCapital({ capital: c.capital, profile: c.profile, horizon: c.horizon, maxPositions: c.maxPositions || undefined }) });
  const r = sim.data;
  return (
    <section id={id} className="glass desk-section" aria-labelledby={`${id}-title`}>
      <div className="desk-section-head">
        <div><h2 id={`${id}-title`}>Allocation simulator</h2><p>Recomputes the same evidence with different capital, profile or position count. <strong>Scenarios, not predictions.</strong> Nothing is saved.</p></div>
      </div>
      <form className="desk-controls" onSubmit={(e) => { e.preventDefault(); sim.mutate(); }}>
        <Input label="Capital (₹)" type="number" inputMode="numeric" min={0} value={c.capital} onChange={(e) => setC({ ...c, capital: Number(e.target.value) })} />
        <Select label="Risk" options={PROFILE_OPTIONS} value={c.profile} onChange={(v) => setC({ ...c, profile: v })} />
        <Select label="Max positions" options={MAXPOS_OPTIONS} value={String(c.maxPositions)} onChange={(v) => setC({ ...c, maxPositions: Number(v) })} />
        <Select label="Horizon" options={HORIZON_OPTIONS} value={c.horizon} onChange={(v) => setC({ ...c, horizon: v })} />
        <Button type="submit" loading={sim.isPending}><FlaskConical className="h-4 w-4" aria-hidden /> Run scenario</Button>
      </form>
      {sim.isError && <ErrorState compact message={sim.error instanceof Error ? sim.error.message : 'Scenario failed'} onRetry={() => sim.mutate()} />}
      {r && (
        <>
          <p className="desk-scenario-label"><AlertTriangle className="h-3.5 w-3.5" aria-hidden /> {r.scenario.label}: {r.summary}</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            <StatTile label="Capital deployed" value={money0(r.cash.recommendedDeploymentInr)} sub={`${r.allocations.length} position${r.allocations.length === 1 ? '' : 's'}`} />
            <StatTile label="Cash" value={money0(r.cash.recommendedCashInr)} sub={`reserve ${r.cash.cashReservePct}%`} />
            <StatTile label="Max portfolio loss" value={<span className="text-sell">{money0(r.scenario.maxPortfolioLossInr)}</span>} sub={`${r.scenario.maxPortfolioLossPct}% if every stop hits`} />
            <StatTile label="Upside at target 1" value={<span className="text-buy">{money0(r.scenario.maxUpsideAtTarget1Inr)}</span>} sub={`${r.scenario.maxUpsideAtTarget1Pct}% scenario, after costs`} />
            <StatTile label="Risk per position" value={r.scenario.riskPerPositionInr.length ? r.scenario.riskPerPositionInr.map((v) => inr(v, 0)).join(' · ') : '—'} sub="loss at stop" />
            <StatTile label="Concentration" value={`${r.scenario.concentrationLargestPct}%`} sub="largest single position" />
          </div>
        </>
      )}
    </section>
  );
}

/* ── View ───────────────────────────────────────────────────────────────── */
export function MoneyDeskView({ onOpenStock, onGoToShortTerm }: { onOpenStock: (t: string) => void; onGoToShortTerm: () => void }) {
  const { auth, loading: authLoading, error: authError } = useAuth();
  const authed = auth?.status === 'authenticated';
  const qc = useQueryClient();
  const [local] = useState<Controls | null>(() => {
    try {
      const raw = window.localStorage.getItem(PREFS_KEY);
      if (raw) return { ...DEFAULT_CONTROLS, ...(JSON.parse(raw) as Partial<Controls>) };
    } catch { /* storage unavailable */ }
    return null;
  });
  const settings = useQuery({ queryKey: ['desk-settings'], queryFn: getDeskSettings, enabled: authed, staleTime: 5 * 60_000, retry: false });
  // Precedence: what the user set this session > this browser's saved controls > server defaults > built-in defaults.
  const seed = useMemo<Controls>(() => {
    if (local) return local;
    const s = settings.data;
    return s ? { capital: s.capitalAvailableInr, profile: s.riskProfile, horizon: s.horizon, maxPositions: s.maxPositions ?? 0 } : DEFAULT_CONTROLS;
  }, [local, settings.data]);
  const [edited, setEdited] = useState<Controls | null>(null);
  const [userApplied, setUserApplied] = useState<Controls | null>(null);
  const controls = edited ?? seed;
  const applied = userApplied ?? seed;
  const setControls = (c: Controls) => setEdited(c);
  const setApplied = (c: Controls) => setUserApplied(c);
  const plan = useQuery({
    queryKey: ['capital-today', applied],
    queryFn: () => getCapitalToday({ capital: applied.capital, profile: applied.profile, horizon: applied.horizon, maxPositions: applied.maxPositions || undefined }),
    enabled: authed,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const record = useQuery({ queryKey: ['capital-track-record'], queryFn: getCapitalTrackRecord, staleTime: 5 * 60_000 });
  const history = useQuery({ queryKey: ['capital-history'], queryFn: () => getCapitalHistory(8), enabled: authed, staleTime: 60_000 });
  const save = useMutation({
    mutationFn: (c: Controls) => putDeskSettings({ capitalAvailableInr: c.capital, riskProfile: c.profile, horizon: c.horizon, maxPositions: c.maxPositions || null }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['desk-settings'] }),
  });
  const apply = () => {
    try { window.localStorage.setItem(PREFS_KEY, JSON.stringify(controls)); } catch { /* ignore */ }
    setApplied(controls);
    if (authed) save.mutate(controls);
    qc.invalidateQueries({ queryKey: ['capital-history'] });
  };
  const d = plan.data;

  if (authLoading) return <div className="desk-page space-y-5"><CardSkeleton lines={4} /></div>;
  if (authError) return <div className="desk-page space-y-5"><ErrorState message={authError} /></div>;
  if (!authed || (plan.isError && isUnauthorized(plan.error))) {
    return (
      <div className="desk-page space-y-5">
        <ViewHero eyebrow="Today's Money Desk" title="Where should your money go today?" subtitle="Sign in to size the engine's qualified setups for your capital, review your holdings, and keep an immutable record of every recommendation." visual={false} />
        <LoginPanel context="the Money Desk reads your private holdings and records each plan against your account" />
        {record.data && <p className="desk-caveat">{record.data.headline}</p>}
      </div>
    );
  }

  return (
    <div className="desk-page space-y-5">
      <ViewHero
        eyebrow="Today's Money Desk"
        title={d ? (d.noNewAllocation ? 'No new capital allocation today' : `Deploy ${money0(d.cash.recommendedDeploymentInr)} · keep ${money0(d.cash.recommendedCashInr)} in cash`) : 'Computing the plan for today…'}
        subtitle={d ? d.summary : 'Sizing the last persisted scan for your capital and profile.'}
        visual={false}
        right={d && (
          <div className="desk-hero-meta">
            <Chip tone={regimeTone(d.regime.regime)} title={d.regime.reasons.join(' · ')}>regime {d.regime.regime.replace(/_/g, ' ').toLowerCase()}{d.regime.sizeMultiplier < 1 ? ` · size ×${d.regime.sizeMultiplier}` : ''}</Chip>
            <Chip tone={freshnessTone(d.freshness.quoteType)} title={`${d.freshness.providerDelay}${d.freshness.featureCutoffAt ? ` · features cut off ${fmtDateTime(d.freshness.featureCutoffAt)}` : ''}`}>data {freshnessLabel(d.freshness)}</Chip>
            {!d.circuitBreaker.canEnter && <Chip tone="sell">circuit breaker: {d.circuitBreaker.reason ?? 'tripped'}</Chip>}
          </div>
        )}
      />

      <form className="desk-controls glass" onSubmit={(e) => { e.preventDefault(); apply(); }} aria-label="Capital controls">
        <Input label="Available capital (₹)" type="number" inputMode="numeric" min={0} value={controls.capital} onChange={(e) => setControls({ ...controls, capital: Number(e.target.value) })} />
        <Select label="Risk profile" options={PROFILE_OPTIONS} value={controls.profile} onChange={(v) => setControls({ ...controls, profile: v })} />
        <Select label="Horizon" options={HORIZON_OPTIONS} value={controls.horizon} onChange={(v) => setControls({ ...controls, horizon: v })} />
        <Select label="Max positions" options={MAXPOS_OPTIONS} value={String(controls.maxPositions)} onChange={(v) => setControls({ ...controls, maxPositions: Number(v) })} />
        <Button type="submit" loading={plan.isFetching}><RefreshCw className="h-4 w-4" aria-hidden /> Recompute plan</Button>
        <p className="desk-controls-note">Each recompute records a new immutable plan; earlier plans are never edited.</p>
      </form>

      {plan.isLoading && <CardSkeleton lines={6} />}
      {plan.isError && !isUnauthorized(plan.error) && <ErrorState message={`The Money Desk could not build a plan: ${plan.error instanceof Error ? plan.error.message : 'unknown error'}`} onRetry={() => plan.refetch()} />}

      {d && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <StatTile label="Available" value={money0(d.cash.capitalAvailableInr)} sub={d.cash.capitalInvestedInr > 0 ? `+ ${money0(d.cash.capitalInvestedInr)} invested` : 'no open holdings priced'} />
            <StatTile label="Recommended deployment" value={<span className={d.cash.recommendedDeploymentInr > 0 ? 'text-buy' : ''}>{money0(d.cash.recommendedDeploymentInr)}</span>} sub={`${d.allocations.length} qualified · ${d.conditional.length} conditional`} />
            <StatTile label="Keep in cash" value={money0(d.cash.recommendedCashInr)} sub={`reserve ${d.cash.cashReservePct}% = ${money0(d.cash.cashReserveInr)}`} />
            <StatTile label="Market regime" value={d.regime.regime.replace(/_/g, ' ').toLowerCase()} sub={d.regime.reasons[0] ?? ''} />
            <StatTile label="Data" value={d.freshness.quoteType === 'EOD_FINAL' ? 'EOD' : d.freshness.quoteType === 'DELAYED_INTRADAY' ? 'DELAYED' : d.freshness.quoteType} sub={`bar ${d.freshness.latestCompletedBarDate ?? '—'} · ${d.freshness.marketState.toLowerCase()}`} />
          </div>

          {d.coverage?.global && (
            <section className="glass desk-section" aria-labelledby="desk-global">
              <div className="desk-section-head"><div><h2 id="desk-global">Global risk context</h2><p>{d.coverage.global.note}</p></div><span className="desk-section-meta">GLOBAL DATA AS OF {d.coverage.global.globalDataAsOf ? fmtDateTime(d.coverage.global.globalDataAsOf) : '—'} · INDIA DATA AS OF {d.coverage.global.indiaDataAsOf ? fmtDateTime(d.coverage.global.indiaDataAsOf) : '—'}</span></div>
              <ol className="scanner-funnel" aria-label="Global diagnostics">
                <li><div className="scanner-funnel-static"><span>Global markets scanned</span><strong>{d.coverage.global.scanned}</strong></div></li>
                <li className={clsx(d.coverage.global.valid < d.coverage.global.scanned && 'scanner-funnel-zero')}><div className="scanner-funnel-static"><span>Valid observations</span><strong>{d.coverage.global.valid}</strong></div></li>
                {Object.entries(d.coverage.global.byRegion).map(([r, v]) => <li key={r}><div className="scanner-funnel-static"><span>{r.toLowerCase()}</span><strong>{v.valid}/{v.total}</strong></div></li>)}
                {Object.entries(d.coverage.global.byAssetClass).filter(([k]) => ['RATES', 'FX', 'COMMODITY', 'CREDIT'].includes(k)).map(([r, v]) => <li key={r}><div className="scanner-funnel-static"><span>{r.toLowerCase()}</span><strong>{v.valid}/{v.total}</strong></div></li>)}
              </ol>
              <div className="desk-chip-row">
                <Chip tone={d.coverage.global.regime === 'RISK_ON' ? 'buy' : d.coverage.global.regime === 'NEUTRAL' ? 'zinc' : d.coverage.global.regime === 'CAUTIOUS' ? 'amber' : 'sell'}>global regime {(d.coverage.global.regime ?? 'unknown').replace(/_/g, ' ').toLowerCase()}</Chip>
                <Chip tone={d.coverage.global.transmission === 'TAILWIND' ? 'buy' : d.coverage.global.transmission === 'NEUTRAL' ? 'zinc' : d.coverage.global.transmission === 'HEADWIND' ? 'amber' : 'sell'}>India transmission {(d.coverage.global.transmission ?? 'unknown').toLowerCase()}</Chip>
                <Chip tone="zinc">India regime {(d.coverage.global.indiaRegime ?? d.regime.regime).replace(/_/g, ' ').toLowerCase()}</Chip>
                <Chip tone={d.global.macroRiskMultiplier < 1 ? 'amber' : 'zinc'}>macro risk ×{d.global.macroRiskMultiplier} · positions ≤ {d.global.maxPositionsAfterMacro}</Chip>
              </div>
              <ul className="desk-why-cash">{d.global.reasons.slice(0, 3).map((r) => <li key={r}><Ban className="h-3.5 w-3.5" aria-hidden /> {r}</li>)}</ul>
              {d.coverage.global.sectorImpacts.length > 0 && <div className="desk-chip-row">{d.coverage.global.sectorImpacts.filter((s) => s.label !== 'NEUTRAL').map((s) => <Chip key={s.sector} tone={s.label === 'TAILWIND' ? 'buy' : s.label === 'HEADWIND' ? 'amber' : 'sell'} title={s.reason}>{s.name}: {s.label.toLowerCase()}</Chip>)}{d.coverage.global.sectorImpacts.every((s) => s.label === 'NEUTRAL') && <Chip tone="zinc">no sector has a displayable active-shock impact</Chip>}</div>}
            </section>
          )}

          {d.coverage && (
            <section className="glass desk-section" aria-labelledby="desk-coverage">
              <div className="desk-section-head"><div><h2 id="desk-coverage">Market scan coverage</h2><p>{d.coverage.note}</p></div><span className="desk-section-meta">broad scan {d.coverage.asOf ?? '—'}</span></div>
              <ol className="scanner-funnel" aria-label="Market scan coverage">
                {[['Scanned', d.coverage.scanned], ['Data valid', d.coverage.dataValid], ['Liquid', d.coverage.liquid], ['Technical screen', d.coverage.technicalScreen], ['Research-qualified', d.coverage.researchQualified], ['Short-term setups', d.coverage.shortTermSetups], ['Passed gates', d.coverage.passedGates], ['Risk-qualified', d.coverage.riskQualified], ['Model-health qualified', d.coverage.modelHealthQualified], ['Capital allocations', d.coverage.capitalAllocations]].map(([label, n]) => (
                  <li key={String(label)} className={clsx(Number(n) === 0 && 'scanner-funnel-zero')}><div className="scanner-funnel-static"><span>{label}</span><strong>{Number(n).toLocaleString('en-IN')}</strong></div></li>
                ))}
              </ol>
              {d.coverage.zeroBecause.length > 0 && <ul className="desk-why-cash">{d.coverage.zeroBecause.slice(0, 4).map((z) => <li key={z}><Ban className="h-3.5 w-3.5" aria-hidden /> {z}</li>)}</ul>}
            </section>
          )}

          {/* SECTION A */}
          <section className="glass desk-section" aria-labelledby="desk-put">
            <div className="desk-section-head">
              <div><h2 id="desk-put"><Wallet className="h-4 w-4" aria-hidden /> Put money</h2><p>Qualified setups sized by risk, not by price. Conditional lines get capital only if their entry trigger is reached and the gates still pass.</p></div>
              <span className="desk-section-meta">{d.candidatesEvaluated} candidates evaluated · source {d.evidence.candidatesSource}{d.evidence.scanRunAt ? ` · scan ${fmtDateTime(d.evidence.scanRunAt)}` : ''}</span>
            </div>
            {d.allocations.length === 0 && d.conditional.length === 0 ? (
              <EmptyState glyph="radar" title="NO NEW CAPITAL ALLOCATION TODAY" message="No candidate cleared every gate at this profile. Holding cash is the correct result — a tier or a chart alone never authorises an entry.">
                <div className="desk-chip-row"><Button variant="secondary" size="sm" onClick={onGoToShortTerm}>Open the Short-Term radar</Button></div>
              </EmptyState>
            ) : (
              <>
                {d.allocations.length > 0 && <div className="desk-card-grid">{d.allocations.map((a) => <AllocationCard key={a.ticker} a={a} onOpenStock={onOpenStock} onSimulate={() => document.getElementById('desk-simulator')?.scrollIntoView({ behavior: 'smooth' })} />)}</div>}
                {d.conditional.length > 0 && (
                  <>
                    <h3 className="desk-subhead">Watch / conditional</h3>
                    <div className="desk-card-grid">{d.conditional.map((a) => <AllocationCard key={a.ticker} a={a} onOpenStock={onOpenStock} onSimulate={() => document.getElementById('desk-simulator')?.scrollIntoView({ behavior: 'smooth' })} />)}</div>
                  </>
                )}
              </>
            )}
            <p className="desk-caveat"><ShieldAlert className="h-3.5 w-3.5" aria-hidden /> System recommendation on measured evidence. Model health: {d.modelHealth.shortTermModel}. {d.modelHealth.note}</p>
          </section>

          {/* SECTION B */}
          <section className="glass desk-section" aria-labelledby="desk-take">
            <div className="desk-section-head">
              <div><h2 id="desk-take"><ArrowDownToLine className="h-4 w-4" aria-hidden /> Take money out</h2><p>Every holding against its own plan levels: invalidation, stop, targets, trailing rule, regime and concentration.</p></div>
              <span className="desk-section-meta">{d.withdrawals.length} to reduce/exit · {d.holds.length} hold/trail</span>
            </div>
            {d.withdrawals.length === 0 && d.holds.length === 0 ? (
              <EmptyState title="No open holdings on the ledger" message="Record purchases on the Watchlist to have them evaluated here." />
            ) : (
              <div className="desk-holding-list">
                {d.withdrawals.map((w) => <HoldingRow key={w.ticker} w={w} onOpenStock={onOpenStock} />)}
                {d.holds.map((w) => <HoldingRow key={w.ticker} w={w} onOpenStock={onOpenStock} />)}
              </div>
            )}
          </section>

          {/* SECTION C */}
          <section className="glass desk-section" aria-labelledby="desk-cash">
            <div className="desk-section-head"><div><h2 id="desk-cash"><PiggyBank className="h-4 w-4" aria-hidden /> Cash</h2><p>Why the desk is holding what it is holding.</p></div></div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile label="Cash reserve" value={money0(d.cash.cashReserveInr)} sub={`${d.cash.cashReservePct}% of ${money0(d.cash.totalEquityInr)} equity`} />
              <StatTile label="Capital deployed" value={money0(d.cash.recommendedDeploymentInr + d.cash.capitalInvestedInr)} sub={`${money0(d.cash.capitalInvestedInr)} already invested`} />
              <StatTile label="Max deployable" value={money0(d.cash.maxDeployableInr)} sub="available minus reserve" />
              <StatTile label="Unused risk budget" value={money0(d.cash.unusedRiskBudgetInr)} sub={`of ${money0(d.cash.riskBudgetInr)} (${money0(d.cash.riskUsedInr)} open)`} />
            </div>
            <ul className="desk-why-cash">{d.cash.whyCash.map((w) => <li key={w}><Ban className="h-3.5 w-3.5" aria-hidden /> {w}</li>)}</ul>
          </section>

          <WhyNot rejected={d.rejected} />
          <Simulator key={`${applied.capital}-${applied.profile}-${applied.horizon}-${applied.maxPositions}`} base={applied} id="desk-simulator" />

          {/* Track record + history */}
          <section className="glass desk-section" aria-labelledby="desk-record">
            <div className="desk-section-head"><div><h2 id="desk-record"><ShieldCheck className="h-4 w-4" aria-hidden /> How have these decisions performed?</h2><p>The graded record of the desk itself versus NIFTY. Withheld below 10 observed outcomes.</p></div></div>
            {record.data ? (
              <>
                <p className="desk-headline">{record.data.headline}</p>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <StatTile label="Recommendations" value={record.data.overall.totalRecommendations} sub={`${record.data.overall.observed} observed outcomes`} />
                  <StatTile label="Win rate" value={record.data.overall.winRate.pct != null ? `${record.data.overall.winRate.pct}%` : 'withheld'} sub={record.data.overall.winRate.wilsonLb95Pct != null ? `Wilson LB ${record.data.overall.winRate.wilsonLb95Pct}%` : (record.data.overall.withheldReason ?? '')} />
                  <StatTile label="Excess vs NIFTY" value={record.data.overall.benchmarkExcessPct.mean != null ? `${record.data.overall.benchmarkExcessPct.mean}%` : 'withheld'} sub={record.data.overall.benchmarkExcessPct.ci95 ? `95% CI ${record.data.overall.benchmarkExcessPct.ci95[0]}…${record.data.overall.benchmarkExcessPct.ci95[1]}` : 'needs ≥10 outcomes'} />
                  <StatTile label="Expectancy" value={record.data.overall.expectancyR != null ? `${record.data.overall.expectancyR}R` : 'withheld'} sub={record.data.overall.maxDrawdownPct != null ? `max DD ${record.data.overall.maxDrawdownPct}%` : ''} />
                </div>
              </>
            ) : <CardSkeleton lines={2} />}
            {history.data && history.data.plans.length > 0 && (
              <Collapsible id="money-desk-history" title={`Plan history · ${history.data.plans.length} recent`} subtitle="Immutable. Each row is exactly what the desk said at that moment." defaultOpen={false}>
                <ul className="desk-history">{history.data.plans.map((p) => <li key={p.id}><span>{fmtDateTime(p.asOf)}</span><Chip tone="zinc">{p.kind}</Chip><span>{p.riskProfile.toLowerCase()} · {p.horizon} · {p.regime.toLowerCase()}</span><span>{p.summary}</span></li>)}</ul>
              </Collapsible>
            )}
          </section>
        </>
      )}
    </div>
  );
}
