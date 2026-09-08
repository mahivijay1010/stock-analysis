'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Zap, RefreshCw, ArrowLeft, ArrowUpRight } from 'lucide-react';
import {
  getShortTermAiUsage,
  getShortTermDetail,
  runShortTermReview,
  runShortTermScan,
  StCandidate,
  StScanParams,
  StScanResult,
} from '@/lib/api';
import { fmtDateTime, inr, signedPct } from '@/lib/format';
import { Button, Card, Chip, ErrorState, Input, Select, ViewHero } from '@/components/ui';

/*
 * SHORT-TERM TRADE RADAR (S1/S14) — risk-adjusted EV over completed daily
 * bars. UP TO five cards; zero qualified is a first-class outcome; freshness
 * is labeled honestly (the free provider is DELAYED, never "real-time");
 * probabilities appear only when calibrated (none are yet — the mandated text
 * shows instead). Clicking a candidate stays inside this section.
 */

const HORIZONS = ['1-3d', '3-5d', '5-10d', '10-21d'] as const;
const RISKS = [0.25, 0.5, 1.0] as const;
const STRATEGIES = ['ALL', 'PULLBACK', 'BREAKOUT', 'MOMENTUM', 'MEAN_REVERSION'] as const;

const ACTION_TONE: Record<string, 'buy' | 'amber' | 'sell' | 'zinc' | 'cyan'> = {
  ENTRY_ZONE: 'buy',
  BREAKOUT_CONFIRMATION: 'cyan',
  WAIT_FOR_ENTRY: 'amber',
  WATCH: 'zinc',
  NO_TRADE: 'zinc',
  EXIT: 'sell',
  INVALIDATED: 'sell',
};

const FRESH_TONE: Record<string, 'buy' | 'amber' | 'sell'> = { LIVE: 'buy', DELAYED: 'amber', STALE: 'sell' };

function FreshnessChip({ f }: { f: StCandidate['freshness'] }) {
  return (
    <Chip tone={FRESH_TONE[f.state] ?? 'zinc'}>
      {f.state}
      {f.lastUpdate ? ` · ${fmtDateTime(f.lastUpdate)}` : ''}
    </Chip>
  );
}

function CandidateCard({ c, onOpen }: { c: StCandidate; onOpen: (t: string) => void }) {
  const p = c.plan;
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {c.rank != null && <span className="font-display text-lg font-bold text-cyan-300">#{c.rank}</span>}
            <h3 className="font-display truncate text-lg font-semibold text-slate-100">{c.name}</h3>
            <Chip tone="zinc">{c.ticker}</Chip>
            <FreshnessChip f={c.freshness} />
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="font-display text-xl font-semibold tabular-nums text-slate-100">{c.currentPrice != null ? inr(c.currentPrice) : '—'}</span>
            <Chip tone={ACTION_TONE[c.action] ?? 'zinc'} glow={c.action === 'ENTRY_ZONE'}>{c.action.replace(/_/g, ' ')}</Chip>
            <Chip tone="zinc">{c.setupType.replace(/_/g, ' ').toLowerCase()}</Chip>
            <Chip tone={c.riskLevel === 'HIGH' ? 'sell' : c.riskLevel === 'MEDIUM' ? 'amber' : 'buy'}>risk {c.riskLevel.toLowerCase()}</Chip>
          </div>
        </div>
        <Button variant="secondary" size="sm" onClick={() => onOpen(c.ticker)}>
          Detail <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
        <p className="text-slate-500">Setup <span className="float-right font-semibold text-slate-200 tabular-nums">{c.setupScore}/100</span></p>
        <p className="text-slate-500">Entry quality <span className="float-right font-semibold text-slate-200 tabular-nums">{c.entryQuality ?? '—'}</span></p>
        <p className="text-slate-500">Model conf. <span className="float-right font-semibold text-slate-200">{c.forecast.modelConfidence}</span></p>
        <p className="text-slate-500">Model health <span className="float-right font-semibold text-slate-200">{c.modelHealth.replace(/_/g, ' ').toLowerCase()}</span></p>
      </div>

      <div className="glass-inset mt-3 px-3.5 py-2.5 text-xs leading-relaxed">
        <p className="text-slate-300">
          <span className="text-slate-500">{p.entryType === 'BREAKOUT_TRIGGER' ? 'Breakout confirmation:' : 'Entry zone:'}</span>{' '}
          {p.entryType === 'BREAKOUT_TRIGGER'
            ? p.entryTrigger
            : p.entryZoneLow != null
              ? `₹${p.entryZoneLow} – ₹${p.entryZoneHigh}`
              : '—'}
        </p>
        <p className="mt-1 text-slate-400">
          Stop <span className="text-slate-200 tabular-nums">₹{p.initialStop ?? '—'}</span>
          <span className="text-slate-600"> ({p.stopBasis})</span> · T1 <span className="text-slate-200 tabular-nums">₹{p.target1 ?? '—'}</span> · T2{' '}
          <span className="text-slate-200 tabular-nums">₹{p.target2 ?? '—'}</span> · R:R{' '}
          <span className="text-slate-200 tabular-nums">{p.rewardRiskToTarget1 ?? '—'}</span> · EV after costs{' '}
          <span className={clsx('font-semibold tabular-nums', (p.expectedValueAfterCostsPct ?? 0) > 0 ? 'text-buy' : 'text-sell')}>
            {p.expectedValueAfterCostsPct != null ? signedPct(p.expectedValueAfterCostsPct) : '—'}
          </span>{' '}
          · ~{p.expectedHoldingDays} sessions
        </p>
        {c.sizing && (
          <p className="mt-1 text-slate-400">
            Size for your budget: <span className="font-semibold text-slate-200 tabular-nums">{c.sizing.positionSizeShares} shares</span> = ₹
            <span className="tabular-nums">{c.sizing.capitalRequired.toLocaleString('en-IN')}</span> · risk if stopped ₹
            <span className="tabular-nums">{c.sizing.lossAtStop?.toLocaleString('en-IN') ?? '—'}</span> · remaining ₹
            <span className="tabular-nums">{c.sizing.capitalRemaining.toLocaleString('en-IN')}</span>
            <span className="text-slate-600"> ({c.sizing.constraintsApplied[0]})</span>
          </p>
        )}
        <p className="mt-1 text-[11px] text-slate-600">{c.forecast.probabilityStatement}</p>
      </div>

      {c.whyCandidate.length > 0 && <p className="mt-2 text-[11px] leading-relaxed text-slate-500">{c.whyCandidate[0]}</p>}
      {c.changedSincePrevious && (
        <p className="mt-1 text-[11px] text-amber-300/90">Changed since previous evaluation: {c.changedSincePrevious.join(' · ')}</p>
      )}
    </Card>
  );
}

function DetailPanel({ ticker, onBack, budget, riskPct }: { ticker: string; onBack: () => void; budget: number | null; riskPct: number }) {
  const [tab, setTab] = useState<'overview' | 'entry' | 'exit' | 'events' | 'ai' | 'track'>('overview');
  const [question, setQuestion] = useState('');
  const q = useQuery({ queryKey: ['st-detail', ticker], queryFn: () => getShortTermDetail(ticker), staleTime: 60_000, retry: 1 });
  const review = useMutation({
    mutationFn: (body: { depth?: string; question?: string }) =>
      runShortTermReview(ticker, { ...body, budgetInr: budget ?? undefined, riskPerTradePct: riskPct }),
  });

  if (q.isPending) return <Card className="p-5"><p className="text-xs text-slate-500">Loading…</p></Card>;
  if (q.isError) return <ErrorState message={q.error instanceof Error ? q.error.message : 'failed'} onRetry={() => q.refetch()} />;
  const c = q.data!.candidate;
  const p = c.plan;

  const TabBtn = ({ id, label }: { id: typeof tab; label: string }) => (
    <button
      type="button"
      onClick={() => setTab(id)}
      className={clsx('rounded-lg px-3 py-1.5 text-xs font-semibold', tab === id ? 'bg-white/10 text-cyan-300' : 'text-slate-400 hover:text-slate-200')}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="secondary" size="sm" onClick={onBack}>
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to radar
        </Button>
        <div className="inline-flex flex-wrap gap-1 rounded-xl border border-white/8 bg-white/4 p-1">
          <TabBtn id="overview" label="Overview" />
          <TabBtn id="entry" label="Entry" />
          <TabBtn id="exit" label="Exit" />
          <TabBtn id="events" label="Events" />
          <TabBtn id="ai" label="AI Review" />
          <TabBtn id="track" label="Track Record" />
        </div>
      </div>

      <CandidateCard c={c} onOpen={() => undefined} />

      {tab === 'overview' && (
        <Card className="p-4 text-xs leading-relaxed text-slate-400">
          <p>Evaluated {fmtDateTime(q.data!.evaluatedAt)} · state <span className="font-semibold text-slate-200">{q.data!.state}</span> · expected hold ~{p.expectedHoldingDays} sessions.</p>
          <p className="mt-1.5">Distribution (own history, uncalibrated): p10 {c.forecast.p10Pct}% · median {c.forecast.p50Pct}% · p90 {c.forecast.p90Pct}% · excess vs NIFTY {c.forecast.expectedExcessReturnPct ?? '—'}%.</p>
          <p className="mt-1.5">Costs: {p.transactionCostPct}% round trip + ~{p.estimatedSlippagePct}% slippage. Invalidation: {p.invalidationReason}</p>
          {!c.gates.passed && (
            <div className="mt-2">
              <p className="font-semibold text-amber-300">Why this is not a qualified candidate:</p>
              <ul className="mt-1 space-y-0.5">{c.gates.failures.map((f, i) => <li key={i}>• {f.gate}: {f.current} (needs {f.required})</li>)}</ul>
            </div>
          )}
        </Card>
      )}

      {tab === 'entry' && (
        <Card className="p-4 text-xs leading-relaxed text-slate-400">
          <p className="text-sm font-semibold text-slate-200">
            Entry status: {c.action === 'ENTRY_ZONE' ? 'READY (price inside the zone)' : c.action === 'WAIT_FOR_ENTRY' ? 'WAIT' : c.action.replace(/_/g, ' ')}
          </p>
          <p className="mt-2">Zone / trigger: {p.entryType === 'BREAKOUT_TRIGGER' ? p.entryTrigger : `₹${p.entryZoneLow} – ₹${p.entryZoneHigh}`}</p>
          <p className="mt-1.5">Why now: {c.whyCandidate.join(' ')}</p>
          <p className="mt-1.5">Confirmation requirements: {p.entryType === 'BREAKOUT_TRIGGER' ? `close above trigger with relative volume ≥ ${p.entryTriggerRelVolume ?? 1.3}×` : 'hold above SMA20 on the close; avoid entries into event risk'}.</p>
          <p className="mt-1.5 text-slate-600">Signals confirm on COMPLETED daily bars only — partial intraday bars never trigger entries.</p>
        </Card>
      )}

      {tab === 'exit' && (
        <Card className="p-4 text-xs leading-relaxed text-slate-400">
          <p>Initial stop ₹{p.initialStop} ({p.stopBasis}). Targets: T1 ₹{p.target1} → optional partial + stop to breakeven; T2 ₹{p.target2} → trailing stop (close − 1.5 ATR, only ever raised).</p>
          <p className="mt-1.5">Time stop: exit if neither target nor stop within ~{p.expectedHoldingDays * 2} sessions. Thesis exits: deep SMA20 break, relative-strength collapse, hostile market regime, adverse tier-≤2 event.</p>
          <p className="mt-1.5">{p.invalidationReason}</p>
        </Card>
      )}

      {tab === 'events' && (
        <Card className="p-4 text-xs leading-relaxed text-slate-400">
          <p>Point-in-time structured events for this instrument are on the Research tab of the long-term page; the radar consumes them as the HIGH_EVENT_RISK gate (an imminent material event blocks short-term entries outright).</p>
        </Card>
      )}

      {tab === 'ai' && (
        <Card className="p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder='e.g. "Why should I wait?" · "What if my budget is ₹20,000?"' className="min-w-64 flex-1" />
            <Button size="sm" onClick={() => review.mutate({ depth: 'AUTO', question: question || undefined })} disabled={review.isPending}>
              {review.isPending ? 'Reviewing…' : 'Ask (free-first)'}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => review.mutate({ depth: 'DEEP_REVIEW', question: question || undefined })} disabled={review.isPending}>
              Deep review
            </Button>
          </div>
          {review.data && (
            <div className="mt-3 space-y-2 text-xs leading-relaxed text-slate-400">
              <div className="flex flex-wrap gap-1.5">
                <Chip tone="zinc">{review.data.review.provider} · {review.data.review.model}</Chip>
                <Chip tone={ACTION_TONE[review.data.review.state] ?? 'zinc'}>{review.data.review.state.replace(/_/g, ' ')}</Chip>
                <Chip tone="zinc">confidence {review.data.review.confidence}</Chip>
                {review.data.review.clamped && <Chip tone="sell">clamped: AI tried to exceed the deterministic ceiling</Chip>}
              </div>
              <p><span className="text-slate-600">Entry:</span> {review.data.review.entrySummary}</p>
              <p><span className="text-slate-600">Exit:</span> {review.data.review.exitSummary}</p>
              <p><span className="text-slate-600">Risk:</span> {review.data.review.riskSummary}</p>
              {review.data.review.whyNotCandidate.length > 0 && (
                <p><span className="text-slate-600">Why not:</span> {review.data.review.whyNotCandidate.join(' · ')}</p>
              )}
              {review.data.review.whatWouldInvalidateSetup.length > 0 && (
                <p><span className="text-slate-600">Invalidation:</span> {review.data.review.whatWouldInvalidateSetup.join(' · ')}</p>
              )}
            </div>
          )}
          {review.isError && <p className="mt-2 text-xs text-amber-300">AI review unavailable — the deterministic evidence above remains active.</p>}
        </Card>
      )}

      {tab === 'track' && (
        <Card className="p-4 text-xs leading-relaxed text-slate-400">
          <p className="font-semibold text-slate-300">State transitions (full accountability)</p>
          {q.data!.transitions.length === 0 ? (
            <p className="mt-1 text-slate-500">No transitions recorded yet.</p>
          ) : (
            <ul className="mt-2 space-y-1">
              {q.data!.transitions.map((t, i) => (
                <li key={i}>
                  <span className="tabular-nums text-slate-600">{fmtDateTime(t.createdAt)}</span> — {t.fromState} → <span className="font-semibold text-slate-200">{t.toState}</span>
                  <span className="text-slate-600"> ({t.reason.slice(0, 90)})</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}

export function ShortTermView() {
  const [budget, setBudget] = useState<string>('50000');
  const [priceMin, setPriceMin] = useState<string>('');
  const [priceMax, setPriceMax] = useState<string>('');
  const [horizon, setHorizon] = useState<(typeof HORIZONS)[number]>('5-10d');
  const [risk, setRisk] = useState<number>(0.5);
  const [strategy, setStrategy] = useState<(typeof STRATEGIES)[number]>('ALL');
  const [limit, setLimit] = useState<number>(5);
  const [openTicker, setOpenTicker] = useState<string | null>(null);
  const [result, setResult] = useState<StScanResult | null>(null);

  const usage = useQuery({ queryKey: ['st-ai-usage'], queryFn: getShortTermAiUsage, staleTime: 60_000, retry: 1 });

  const scan = useMutation({
    mutationFn: (p: StScanParams) => runShortTermScan(p),
    onSuccess: (data) => setResult(data),
  });

  const params = useMemo<StScanParams>(
    () => ({
      budgetInr: budget ? Number(budget) : null,
      priceMin: priceMin ? Number(priceMin) : null,
      priceMax: priceMax ? Number(priceMax) : null,
      horizon,
      riskPerTradePct: risk,
      strategy,
      limit,
    }),
    [budget, priceMin, priceMax, horizon, risk, strategy, limit],
  );

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
        eyebrow="Risk-adjusted expected value — never five forced picks"
        title="Short-Term"
        subtitle={
          <>
            Positional setups over <span className="font-medium text-slate-300">completed daily bars</span> (1–21 sessions). Zero
            qualified candidates is a valid answer; probabilities appear only when calibrated.
          </>
        }
        right={
          usage.data ? (
            <Chip tone="zinc">
              <Zap className="h-3.5 w-3.5" aria-hidden /> AI {usage.data.mode} · today ${usage.data.usage.todayUsd.toFixed(2)} / ${usage.data.usage.dailyBudgetUsd}
            </Chip>
          ) : undefined
        }
      />

      <Card className="p-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <label className="text-xs text-slate-500">
            Budget ₹
            <Input value={budget} onChange={(e) => setBudget(e.target.value.replace(/[^\d]/g, ''))} placeholder="50000" className="mt-1" />
          </label>
          <label className="text-xs text-slate-500">
            Min price ₹
            <Input value={priceMin} onChange={(e) => setPriceMin(e.target.value.replace(/[^\d]/g, ''))} placeholder="—" className="mt-1" />
          </label>
          <label className="text-xs text-slate-500">
            Max price ₹
            <Input value={priceMax} onChange={(e) => setPriceMax(e.target.value.replace(/[^\d]/g, ''))} placeholder="—" className="mt-1" />
          </label>
          <label className="text-xs text-slate-500">
            Horizon
            <Select value={horizon} onChange={(v) => setHorizon(v as never)} options={HORIZONS.map((h) => ({ value: h, label: h }))} className="mt-1" />
          </label>
          <label className="text-xs text-slate-500">
            Risk per trade
            <Select value={String(risk)} onChange={(v) => setRisk(Number(v))} options={RISKS.map((r) => ({ value: String(r), label: `${r}%` }))} className="mt-1" />
          </label>
          <label className="text-xs text-slate-500">
            Strategy
            <Select value={strategy} onChange={(v) => setStrategy(v as never)} options={STRATEGIES.map((s) => ({ value: s, label: s.replace(/_/g, ' ') }))} className="mt-1" />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button onClick={() => scan.mutate(params)} disabled={scan.isPending}>
            <RefreshCw className={clsx('h-3.5 w-3.5', scan.isPending && 'animate-spin')} aria-hidden />
            {scan.isPending ? 'Scanning 151 stocks…' : 'Refresh'}
          </Button>
          {result && result.passedGates > result.candidates.length && (
            <Button variant="secondary" onClick={() => { setLimit(limit === 5 ? 10 : limit === 10 ? 20 : 0); scan.mutate({ ...params, limit: limit === 5 ? 10 : limit === 10 ? 20 : 0 }); }}>
              Show more ({result.passedGates} passing)
            </Button>
          )}
          {result && (
            <span className="text-[11px] text-slate-500">
              {result.marketStatus.session === 'OPEN' ? 'Market open' : 'Market closed'} · scan {result.universeSize} stocks → {result.passedGates} passed gates · risk manager:{' '}
              {result.riskManager.newEntriesAllowed ? 'entries allowed' : 'NEW ENTRIES DISABLED'}
            </span>
          )}
        </div>
        {result && !result.riskManager.newEntriesAllowed && (
          <p className="mt-2 text-xs text-amber-300">{result.riskManager.reasons.join(' · ')} — the radar stays visible, entries are disabled.</p>
        )}
      </Card>

      {scan.isError && <ErrorState message={scan.error instanceof Error ? scan.error.message : 'Scan failed'} onRetry={() => scan.mutate(params)} />}

      {result == null && !scan.isPending && (
        <Card className="p-5">
          <p className="text-sm leading-relaxed text-slate-400">
            Set your budget and constraints, then <span className="font-medium text-slate-200">Refresh</span> to scan the 151-stock universe. The scan is
            deterministic and free — AI reviews are an optional, budget-governed escalation on the candidates you open.
          </p>
        </Card>
      )}

      {result?.emptyMessage && (
        <Card className="p-5">
          <p className="text-sm font-medium leading-relaxed text-slate-300">{result.emptyMessage}</p>
          <p className="mt-1 text-xs text-slate-500">The gates that filtered the universe are visible on each stock's detail — nothing is hidden, and nothing is forced.</p>
        </Card>
      )}

      <div className="space-y-4">
        <p className="text-xs font-semibold tracking-wide text-slate-400 uppercase">Top short-term opportunities — up to {limit === 0 ? 'all passing' : limit}</p>
        {result?.candidates.map((c) => <CandidateCard key={c.ticker} c={c} onOpen={setOpenTicker} />)}
      </div>
    </div>
  );
}
