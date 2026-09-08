'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Zap, RefreshCw, ArrowLeft, ArrowUpRight, FlaskConical, ShieldCheck } from 'lucide-react';
import {
  getShortTermAiUsage,
  getShortTermDetail,
  getShortTermModelLab,
  runShortTermReview,
  runShortTermRevalidate,
  runShortTermScan,
  StCandidate,
  StScanParams,
  StScanResult,
} from '@/lib/api';
import { fmtDateTime, inr, signedPct } from '@/lib/format';
import { Button, Card, Chip, ErrorState, Input, Select, ViewHero } from '@/components/ui';

/*
 * SHORT-TERM TRADE RADAR V2 — qualification integrity. Two sections:
 * QUALIFIED SHORT-TERM TRADES (tier A, ENTRY_CONFIRMED, affordable — 0-5) and
 * RESEARCH WATCHLIST (interesting but unproven / awaiting confirmation /
 * budget-incompatible). A stock in an entry zone is NOT actionable unless the
 * evidence earns it. Freshness is labeled EOD_FINAL / DELAYED_INTRADAY / STALE.
 */

const HORIZONS = ['1-3d', '3-5d', '5-10d', '10-21d'] as const;
const RISKS = [0.25, 0.5, 1.0] as const;
const STRATEGIES = ['ALL', 'PULLBACK', 'BREAKOUT', 'MOMENTUM', 'MEAN_REVERSION'] as const;

const ACTION_LABEL: Record<string, string> = {
  ENTRY_CONFIRMED: 'ENTRY CONFIRMED',
  ZONE_REACHED: 'ZONE REACHED — WAIT FOR CONFIRMATION',
  WAIT_FOR_CONFIRMATION: 'WAIT FOR CONFIRMATION',
  RESEARCH_WATCH: 'RESEARCH WATCH',
  SETUP_DETECTED: 'SETUP DETECTED',
  NO_TRADE: 'NO TRADE',
  NO_SETUP: 'NO SETUP',
  INVALIDATED: 'INVALIDATED',
};
const ACTION_TONE: Record<string, 'buy' | 'amber' | 'sell' | 'zinc' | 'cyan'> = {
  ENTRY_CONFIRMED: 'buy',
  ZONE_REACHED: 'amber',
  WAIT_FOR_CONFIRMATION: 'amber',
  RESEARCH_WATCH: 'zinc',
  SETUP_DETECTED: 'zinc',
  NO_TRADE: 'sell',
  INVALIDATED: 'sell',
};
const TIER_TONE: Record<string, 'buy' | 'cyan' | 'amber' | 'zinc'> = { A: 'buy', B: 'cyan', C: 'amber', D: 'zinc' };
const TIER_LABEL: Record<string, string> = { A: 'A / VALIDATED', B: 'B / PROMISING', C: 'C / UNPROVEN', D: 'D / REJECTED' };
const FRESH_TONE: Record<string, 'buy' | 'amber' | 'sell'> = { LIVE: 'buy', EOD_FINAL: 'cyan' as never, DELAYED_INTRADAY: 'amber', STALE: 'sell' };

function CandidateCard({ c, onOpen }: { c: StCandidate; onOpen: (t: string) => void }) {
  const p = c.plan;
  const tier = c.tier ?? 'C';
  const se = c.setupEvidence;
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {c.rank != null && c.qualified && <span className="font-display text-lg font-bold text-cyan-300">#{c.rank}</span>}
            <h3 className="font-display truncate text-lg font-semibold text-slate-100">{c.name}</h3>
            <Chip tone="zinc">{c.ticker}</Chip>
            <Chip tone={(FRESH_TONE[c.freshnessV2 ?? ''] ?? 'amber') as 'buy' | 'amber' | 'sell'}>
              {(c.freshnessV2 ?? 'DELAYED_INTRADAY').replace(/_/g, ' ')}
              {c.freshness.lastUpdate ? ` · ${fmtDateTime(c.freshness.lastUpdate)}` : ''}
            </Chip>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="font-display text-xl font-semibold tabular-nums text-slate-100">{c.currentPrice != null ? inr(c.currentPrice) : '—'}</span>
            <Chip tone={ACTION_TONE[c.action] ?? 'zinc'} glow={c.action === 'ENTRY_CONFIRMED'}>{ACTION_LABEL[c.action] ?? c.action}</Chip>
            <Chip tone={TIER_TONE[tier] ?? 'zinc'}>Tier {TIER_LABEL[tier] ?? tier}</Chip>
            <Chip tone="zinc">{c.setupType.replace(/_/g, ' ').toLowerCase()}</Chip>
          </div>
        </div>
        <Button variant="secondary" size="sm" onClick={() => onOpen(c.ticker)}>
          Detail <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
        <p className="text-slate-500">Model confidence <span className="float-right font-semibold text-slate-200">{c.forecast.modelConfidence}</span></p>
        <p className="text-slate-500">Live authority <span className="float-right font-semibold text-slate-200">{c.modelHealth.replace(/_/g, ' ').toLowerCase()}</span></p>
        <p className="text-slate-500" title={se?.note}>Setup evidence <span className="float-right font-semibold text-slate-200">{se?.usableForEntry ? 'validated' : 'unvalidated'}</span></p>
        <p className="text-slate-500">Expectancy <span className="float-right font-semibold text-slate-200 tabular-nums">{se?.expectancyAfterCosts != null ? `${se.expectancyAfterCosts}R` : '—'}</span></p>
      </div>

      {c.whyNotEntry && c.whyNotEntry.length > 0 && (
        <div className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/5 px-3.5 py-2.5">
          <p className="text-[11px] font-semibold tracking-wide text-amber-300 uppercase">Why this is not entry-confirmed</p>
          <ul className="mt-1 space-y-0.5">
            {c.whyNotEntry.slice(0, 4).map((w, i) => (
              <li key={i} className="text-[11px] leading-relaxed text-slate-400">• {w}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="glass-inset mt-3 px-3.5 py-2.5 text-xs leading-relaxed">
        <p className="text-slate-400">
          <span className="text-slate-500">{p.entryType === 'BREAKOUT_TRIGGER' ? 'Trigger:' : 'Entry zone:'}</span>{' '}
          {p.entryType === 'BREAKOUT_TRIGGER' ? p.entryTrigger : p.entryZoneLow != null ? `₹${p.entryZoneLow} – ₹${p.entryZoneHigh}` : '—'}
          {' · '}stop <span className="tabular-nums text-slate-200">₹{p.initialStop ?? '—'}</span> · T1{' '}
          <span className="tabular-nums text-slate-200">₹{p.target1 ?? '—'}</span> · R:R{' '}
          <span className="tabular-nums text-slate-200">{p.rewardRiskToTarget1 ?? '—'}</span>
        </p>
        {c.ev && (
          <p className="mt-1 text-slate-400">
            EV after costs mean <span className="tabular-nums text-slate-200">{signedPct(c.ev.meanEvAfterCostsPct)}</span> · 80% lower{' '}
            <span className={clsx('font-semibold tabular-nums', c.ev.ev80LowerPct > 0 ? 'text-buy' : 'text-sell')}>{signedPct(c.ev.ev80LowerPct)}</span> · expected{' '}
            <span className="tabular-nums text-slate-200">{c.ev.expectedR}R</span> · CVaR{' '}
            <span className="tabular-nums text-slate-200">{c.ev.cvarR}R</span>
          </p>
        )}
        {c.sizing && c.sizing.positionSizeShares > 0 ? (
          <p className="mt-1 text-slate-400">
            Size: <span className="font-semibold text-slate-200 tabular-nums">{c.sizing.positionSizeShares} sh</span> = ₹
            <span className="tabular-nums">{c.sizing.capitalRequired.toLocaleString('en-IN')}</span> · risk if stopped ₹
            <span className="tabular-nums">{c.sizing.lossAtStop?.toLocaleString('en-IN') ?? '—'}</span>
          </p>
        ) : c.sizing ? (
          <p className="mt-1 text-amber-400">Not affordable under your current risk budget — {c.sizing.constraintsApplied[0]}.</p>
        ) : null}
        <p className="mt-1 text-[11px] text-slate-600">If confirmed: enter on a completed bar holding the zone; invalidation: {p.invalidationReason}</p>
      </div>
    </Card>
  );
}

function ModelLabPanel() {
  const q = useQuery({ queryKey: ['st-model-lab'], queryFn: getShortTermModelLab, staleTime: 5 * 60_000, retry: 1 });
  if (q.isPending || q.isError || !q.data?.available || !q.data.setupEvidence) return null;
  const cells = q.data.setupEvidence.cells as Array<Record<string, unknown>>;
  return (
    <Card className="p-4">
      <p className="flex items-center gap-2 text-xs font-medium text-slate-400">
        <FlaskConical className="h-4 w-4 text-cyan-300" aria-hidden /> Short-Term Model Lab — per-setup realized-R evidence
      </p>
      <p className="mt-1 text-[11px] text-slate-500">{q.data.setupEvidence.verdict}</p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-xs">
          <thead>
            <tr className="border-b border-white/8 text-[10px] uppercase tracking-wide text-slate-600">
              <th className="px-2 py-1.5 font-medium">Setup</th><th className="px-2 py-1.5">Horizon</th><th className="px-2 py-1.5">Ind. dates</th>
              <th className="px-2 py-1.5">E[R]</th><th className="px-2 py-1.5">CI low</th><th className="px-2 py-1.5">P(&gt;0)</th><th className="px-2 py-1.5">Tier</th><th className="px-2 py-1.5">Entry?</th>
            </tr>
          </thead>
          <tbody>
            {cells
              .slice()
              .sort((a, b) => Number(b.expectancyR) - Number(a.expectancyR))
              .map((c, i) => (
                <tr key={i} className="border-b border-white/4 last:border-0">
                  <td className="px-2 py-1.5 text-slate-300">{String(c.setupType).replace(/_/g, ' ').toLowerCase()}</td>
                  <td className="px-2 py-1.5 text-slate-400">{String(c.horizon)}</td>
                  <td className="px-2 py-1.5 tabular-nums text-slate-400">{String(c.independentEntryDates)}</td>
                  <td className={clsx('px-2 py-1.5 tabular-nums font-semibold', Number(c.expectancyR) > 0 ? 'text-buy' : 'text-sell')}>{String(c.expectancyR)}R</td>
                  <td className="px-2 py-1.5 tabular-nums text-slate-400">{String((c.bootstrapExpectancyCI as number[])?.[0] ?? '—')}</td>
                  <td className="px-2 py-1.5 tabular-nums text-slate-400">{String(c.probabilityExpectancyPositive)}</td>
                  <td className="px-2 py-1.5"><Chip tone={TIER_TONE[String(c.evidenceStrength)] ?? 'zinc'}>{String(c.evidenceStrength)}</Chip></td>
                  <td className="px-2 py-1.5">{c.usableForEntry ? <span className="font-semibold text-buy">YES</span> : <span className="text-slate-500">no</span>}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[10px] leading-relaxed text-slate-600">
        A setup earns TIER A (entry authority in backtest) only with positive after-cost expectancy, CI lower bound &gt; 0, ≥60 independent
        entry dates and Benjamini–Hochberg significance. Live authority additionally requires prospective shadow confirmation.
      </p>
    </Card>
  );
}

function DetailPanel({ ticker, onBack, budget, riskPct }: { ticker: string; onBack: () => void; budget: number | null; riskPct: number }) {
  const [tab, setTab] = useState<'overview' | 'entry' | 'exit' | 'ai' | 'track'>('overview');
  const [question, setQuestion] = useState('');
  const q = useQuery({ queryKey: ['st-detail', ticker], queryFn: () => getShortTermDetail(ticker), staleTime: 60_000, retry: 1 });
  const review = useMutation({ mutationFn: (body: { depth?: string; question?: string }) => runShortTermReview(ticker, { ...body, budgetInr: budget ?? undefined, riskPerTradePct: riskPct }) });
  const reval = useMutation({ mutationFn: () => runShortTermRevalidate(ticker) });

  if (q.isPending) return <Card className="p-5"><p className="text-xs text-slate-500">Loading…</p></Card>;
  if (q.isError) return <ErrorState message={q.error instanceof Error ? q.error.message : 'failed'} onRetry={() => q.refetch()} />;
  const c = q.data!.candidate;
  const p = c.plan;
  const TabBtn = ({ id, label }: { id: typeof tab; label: string }) => (
    <button type="button" onClick={() => setTab(id)} className={clsx('rounded-lg px-3 py-1.5 text-xs font-semibold', tab === id ? 'bg-white/10 text-cyan-300' : 'text-slate-400 hover:text-slate-200')}>{label}</button>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="secondary" size="sm" onClick={onBack}><ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to radar</Button>
        <div className="inline-flex flex-wrap gap-1 rounded-xl border border-white/8 bg-white/4 p-1">
          <TabBtn id="overview" label="Overview" /><TabBtn id="entry" label="Entry" /><TabBtn id="exit" label="Exit" /><TabBtn id="ai" label="AI Review" /><TabBtn id="track" label="Track Record" />
        </div>
      </div>
      <CandidateCard c={c} onOpen={() => undefined} />

      {tab === 'overview' && (
        <Card className="p-4 text-xs leading-relaxed text-slate-400">
          <p>Evaluated {fmtDateTime(q.data!.evaluatedAt)} · deterministic ceiling reasons: {c.ceilingReasons?.join(' · ')}</p>
          {c.contradictions && c.contradictions.length > 0 && (
            <div className="mt-2">
              <p className="font-semibold text-amber-300">Deterministic contradictions (each lowers the action):</p>
              <ul className="mt-1 space-y-0.5">{c.contradictions.map((x, i) => <li key={i}>• {x.message} → cap {x.cap.replace(/_/g, ' ')}</li>)}</ul>
            </div>
          )}
          {c.setupEvidence && <p className="mt-2">Setup evidence: {c.setupEvidence.note} ({c.setupEvidence.independentEntryDates} independent entry dates, after-cost expectancy {c.setupEvidence.expectancyAfterCosts}R).</p>}
        </Card>
      )}
      {tab === 'entry' && (
        <Card className="p-4 text-xs leading-relaxed text-slate-400">
          <p className="text-sm font-semibold text-slate-200">Entry status: {ACTION_LABEL[c.action] ?? c.action}</p>
          <p className="mt-2">Zone / trigger: {p.entryType === 'BREAKOUT_TRIGGER' ? p.entryTrigger : `₹${p.entryZoneLow} – ₹${p.entryZoneHigh}`}</p>
          {c.confirmation && (
            <>
              <p className="mt-1.5 font-semibold text-slate-300">Confirmation {c.confirmation.satisfied ? 'satisfied' : 'NOT satisfied'}:</p>
              <ul className="mt-0.5 space-y-0.5">
                {c.confirmation.met.map((m, i) => <li key={`m${i}`} className="text-buy">✓ {m}</li>)}
                {c.confirmation.unmet.map((m, i) => <li key={`u${i}`} className="text-amber-400">✗ {m}</li>)}
              </ul>
            </>
          )}
          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => reval.mutate()} disabled={reval.isPending}>Pre-entry revalidate (fresh quote)</Button>
          </div>
          {reval.data && (
            <p className={clsx('mt-2', reval.data.ok ? 'text-buy' : 'text-amber-400')}>
              {reval.data.recommendation} · gap {reval.data.gap.decision} ({reval.data.gap.reason}) · freshness {reval.data.freshness}
              {reval.data.vetoes.length > 0 && ` · vetoes: ${reval.data.vetoes.join('; ')}`}
            </p>
          )}
        </Card>
      )}
      {tab === 'exit' && (
        <Card className="p-4 text-xs leading-relaxed text-slate-400">
          <p>Initial stop ₹{p.initialStop} ({p.stopBasis}). T1 ₹{p.target1} → partial + stop to breakeven; T2 ₹{p.target2} → trailing (close − 1.5 ATR, only raised). Time stop ~{p.expectedHoldingDays * 2} sessions. {p.invalidationReason}</p>
          {c.plausibility && <p className="mt-1.5">Target ≈ {c.plausibility.target1DistanceAtr} ATR (reached in {c.plausibility.target1ReachRate != null ? `${Math.round(c.plausibility.target1ReachRate * 100)}%` : '—'} of horizon paths); stop ≈ {c.plausibility.stopDistanceAtr} ATR (noise-out {c.plausibility.stopNoiseRate != null ? `${Math.round(c.plausibility.stopNoiseRate * 100)}%` : '—'}). {c.plausibility.reasons.join(' ')}</p>}
        </Card>
      )}
      {tab === 'ai' && (
        <Card className="p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder='"Why is this not entry-confirmed?" · "What if my budget is ₹20,000?"' className="min-w-64 flex-1" />
            <Button size="sm" onClick={() => review.mutate({ depth: 'AUTO', question: question || undefined })} disabled={review.isPending}>{review.isPending ? 'Reviewing…' : 'Ask (free-first)'}</Button>
            <Button size="sm" variant="secondary" onClick={() => review.mutate({ depth: 'DEEP_REVIEW', question: question || undefined })} disabled={review.isPending}>Deep review</Button>
          </div>
          {review.data && (
            <div className="mt-3 space-y-2 text-xs leading-relaxed text-slate-400">
              <div className="flex flex-wrap gap-1.5">
                <Chip tone="zinc">{review.data.review.provider} · {review.data.review.model}</Chip>
                <Chip tone={ACTION_TONE[review.data.review.state] ?? 'zinc'}>{review.data.review.state.replace(/_/g, ' ')}</Chip>
                {review.data.review.clamped && <Chip tone="sell">clamped — AI tried to exceed the deterministic ceiling</Chip>}
              </div>
              <p><span className="text-slate-600">Entry:</span> {review.data.review.entrySummary}</p>
              <p><span className="text-slate-600">Risk:</span> {review.data.review.riskSummary}</p>
              {review.data.review.whyNotCandidate.length > 0 && <p><span className="text-slate-600">Why not:</span> {review.data.review.whyNotCandidate.join(' · ')}</p>}
            </div>
          )}
          {review.isError && <p className="mt-2 text-xs text-amber-300">AI unavailable — the deterministic evidence above remains active.</p>}
        </Card>
      )}
      {tab === 'track' && (
        <Card className="p-4 text-xs leading-relaxed text-slate-400">
          <p className="font-semibold text-slate-300">State transitions</p>
          {q.data!.transitions.length === 0 ? <p className="mt-1 text-slate-500">No transitions recorded yet.</p> : (
            <ul className="mt-2 space-y-1">{q.data!.transitions.map((t, i) => <li key={i}><span className="tabular-nums text-slate-600">{fmtDateTime(t.createdAt)}</span> — {t.fromState} → <span className="font-semibold text-slate-200">{t.toState}</span></li>)}</ul>
          )}
        </Card>
      )}
    </div>
  );
}

export function ShortTermView() {
  const [budget, setBudget] = useState('50000');
  const [priceMin, setPriceMin] = useState('');
  const [priceMax, setPriceMax] = useState('');
  const [horizon, setHorizon] = useState<(typeof HORIZONS)[number]>('5-10d');
  const [risk, setRisk] = useState(0.5);
  const [strategy, setStrategy] = useState<(typeof STRATEGIES)[number]>('ALL');
  const [openTicker, setOpenTicker] = useState<string | null>(null);
  const [result, setResult] = useState<StScanResult | null>(null);
  const usage = useQuery({ queryKey: ['st-ai-usage'], queryFn: getShortTermAiUsage, staleTime: 60_000, retry: 1 });
  const scan = useMutation({ mutationFn: (p: StScanParams) => runShortTermScan(p), onSuccess: setResult });
  const params = useMemo<StScanParams>(() => ({ budgetInr: budget ? Number(budget) : null, priceMin: priceMin ? Number(priceMin) : null, priceMax: priceMax ? Number(priceMax) : null, horizon, riskPerTradePct: risk, strategy, limit: 5 }), [budget, priceMin, priceMax, horizon, risk, strategy]);

  if (openTicker) {
    return (
      <div className="space-y-5">
        <ViewHero eyebrow="Short-term trade radar" title={openTicker.replace('.NS', '')} subtitle="Positional short-term detail — stays inside the Short-Term section." />
        <DetailPanel ticker={openTicker} onBack={() => setOpenTicker(null)} budget={budget ? Number(budget) : null} riskPct={risk} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <ViewHero
        eyebrow="Qualified trades vs research — a zone is not an entry"
        title="Short-Term"
        subtitle={<>An entry becomes actionable only when the data is usable, the setup is validated out-of-sample, the entry is confirmed, the downside is defined, and the edge survives costs and uncertainty. Otherwise: <span className="font-medium text-slate-300">wait</span>.</>}
        right={usage.data ? <Chip tone="zinc"><Zap className="h-3.5 w-3.5" aria-hidden /> AI {usage.data.mode} · today ${usage.data.usage.todayUsd.toFixed(2)}/{usage.data.usage.dailyBudgetUsd}</Chip> : undefined}
      />

      <Card className="p-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <label className="text-xs text-slate-500">Budget ₹<Input value={budget} onChange={(e) => setBudget(e.target.value.replace(/[^\d]/g, ''))} placeholder="50000" className="mt-1" /></label>
          <label className="text-xs text-slate-500">Min price ₹<Input value={priceMin} onChange={(e) => setPriceMin(e.target.value.replace(/[^\d]/g, ''))} placeholder="—" className="mt-1" /></label>
          <label className="text-xs text-slate-500">Max price ₹<Input value={priceMax} onChange={(e) => setPriceMax(e.target.value.replace(/[^\d]/g, ''))} placeholder="—" className="mt-1" /></label>
          <label className="text-xs text-slate-500">Horizon<Select value={horizon} onChange={(v) => setHorizon(v as never)} options={HORIZONS.map((h) => ({ value: h, label: h }))} className="mt-1" /></label>
          <label className="text-xs text-slate-500">Risk per trade<Select value={String(risk)} onChange={(v) => setRisk(Number(v))} options={RISKS.map((r) => ({ value: String(r), label: `${r}%` }))} className="mt-1" /></label>
          <label className="text-xs text-slate-500">Strategy<Select value={strategy} onChange={(v) => setStrategy(v as never)} options={STRATEGIES.map((s) => ({ value: s, label: s.replace(/_/g, ' ') }))} className="mt-1" /></label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button onClick={() => scan.mutate(params)} disabled={scan.isPending}><RefreshCw className={clsx('h-3.5 w-3.5', scan.isPending && 'animate-spin')} aria-hidden />{scan.isPending ? 'Scanning 151 stocks…' : 'Refresh'}</Button>
          {result && <span className="text-[11px] text-slate-500">{result.marketStatus.session === 'OPEN' ? 'Market open (delayed intraday)' : 'Market closed (EOD final)'} · {result.universeSize} scanned · {result.passedGates} passed base gates · qualified {result.qualifiedCount} · watchlist {result.watchlistCount} · risk mgr {result.riskManager.newEntriesAllowed ? 'entries allowed' : 'NEW ENTRIES DISABLED'}</span>}
        </div>
        {result && !result.riskManager.newEntriesAllowed && <p className="mt-2 text-xs text-amber-300">{result.riskManager.reasons.join(' · ')} — the radar stays visible, entries are disabled.</p>}
      </Card>

      {scan.isError && <ErrorState message={scan.error instanceof Error ? scan.error.message : 'Scan failed'} onRetry={() => scan.mutate(params)} />}

      {result == null && !scan.isPending && (
        <Card className="p-5"><p className="text-sm leading-relaxed text-slate-400">Set your budget and constraints, then <span className="font-medium text-slate-200">Refresh</span>. Qualified trades require validated setup evidence, a confirmed entry, and an EV edge that survives its own uncertainty — often that is zero stocks, and that is the correct answer.</p></Card>
      )}

      {result && (
        <>
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-buy" aria-hidden />
              <h2 className="font-display text-sm font-semibold tracking-wide text-slate-200">Qualified short-term trades <span className="text-slate-500">— up to 5</span></h2>
            </div>
            {result.candidates.length === 0 ? (
              <Card className="p-5"><p className="text-sm font-medium leading-relaxed text-slate-300">{result.emptyMessage}</p><p className="mt-1 text-xs text-slate-500">Tier A + confirmed entry + positive EV lower bound + affordable + live authority. None today — see the Research Watchlist.</p></Card>
            ) : (
              result.candidates.map((c) => <CandidateCard key={c.ticker} c={c} onOpen={setOpenTicker} />)
            )}
          </section>

          <section className="space-y-3">
            <h2 className="font-display text-sm font-semibold tracking-wide text-slate-400">Research watchlist <span className="text-slate-600">— interesting, not yet actionable</span></h2>
            {result.watchlist.length === 0 ? (
              <Card className="p-5"><p className="text-xs text-slate-500">No interesting setups today.</p></Card>
            ) : (
              result.watchlist.slice(0, 12).map((c) => <CandidateCard key={c.ticker} c={c} onOpen={setOpenTicker} />)
            )}
          </section>

          <ModelLabPanel />
        </>
      )}
    </div>
  );
}
