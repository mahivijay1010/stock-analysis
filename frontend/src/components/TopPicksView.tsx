'use client';

import { useId, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowRight, IndianRupee, RefreshCw, Wallet } from 'lucide-react';
import { getTopPicks } from '@/lib/api';
import { DecisionGateChips, useDecisionBatch } from '@/components/DecisionGateChips';
import type { DecisionBatchEntry } from '@/lib/api';
import type { Horizon, TopPick } from '@/lib/types';
import { fmtDateTime, inr, inrSmart, plain, signedPct } from '@/lib/format';
import { COLOR } from '@/lib/design-tokens';
import {
  Button,
  Card,
  CardSkeleton,
  Chip,
  EntryChip,
  ErrorState,
  GlassCard,
  Input,
  RecBadge,
  RiskChip,
  ScoreDonut,
  ViewHero,
} from '@/components/ui';
import { Stagger, StaggerItem } from '@/components/motion';
import { RankMedallion } from '@/components/leaders/RankMedallion';

/* ------------------------------------------------------------------ */
/* Budget-per-share filter (persisted)                                 */
/* ------------------------------------------------------------------ */

const BUDGET_KEY = 'stocksense.topPicksBudget';
const BUDGET_CHIPS = [250, 500, 1000, 2500] as const;

function loadBudget(): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(BUDGET_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  } catch {
    return null;
  }
}

function persistBudget(v: number | null) {
  try {
    if (v == null) window.localStorage.removeItem(BUDGET_KEY);
    else window.localStorage.setItem(BUDGET_KEY, String(v));
  } catch {
    /* non-fatal */
  }
}

function parseBudget(raw: string): number | null {
  const cleaned = raw.replace(/[₹,\s]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 1 && n <= 10_00_000 ? Math.round(n) : null;
}

/** Budget preset pill — a radio in the "budget per share" group. */
function BudgetPill({
  selected,
  onSelect,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={clsx(
        'touch-target relative rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-all',
        selected
          ? 'border-cyan-400/60 bg-cyan-400/15 text-cyan-300 shadow-[0_0_14px_rgba(34,211,238,0.25)]'
          : 'border-white/10 bg-white/4 text-slate-400 hover:border-cyan-400/30 hover:text-slate-200',
      )}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Sign → status-token text class (buy/sell accents, slate when flat)  */
/* ------------------------------------------------------------------ */

function signToneClass(v: number): string {
  if (v > 0) return 'text-buy';
  if (v < 0) return 'text-sell';
  return 'text-slate-400';
}

/* ------------------------------------------------------------------ */
/* Expected-return mini vertical bars with 80%-range whiskers (SVG)    */
/* ------------------------------------------------------------------ */

const BAR_HORIZONS: Horizon[] = [1, 7, 30];

function ReturnBars({ pick }: { pick: TopPick }) {
  const uid = useId();
  const cols = BAR_HORIZONS.map((h) => pick.predictions.find((p) => p.horizonDays === h) ?? null);
  const vals = cols.flatMap((p) => (p ? [p.low80Pct, p.high80Pct, p.expectedReturnPct] : []));
  if (!vals.length) return null;
  const maxAbs = Math.max(1, ...vals.map(Math.abs));

  const W = 180;
  const H = 118;
  const plotTop = 20;
  const plotBot = H - 20;
  const zero = (plotTop + plotBot) / 2;
  const y = (v: number) => zero - (v / maxAbs) * ((plotBot - plotTop) / 2);
  const colW = W / BAR_HORIZONS.length;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full max-w-[220px]"
      role="img"
      aria-label={`Expected return for ${pick.ticker} at 1, 7 and 30 days with 80% ranges`}
    >
      <defs>
        <linearGradient id={`tpup-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={COLOR.accent.buy} stopOpacity="0.95" />
          <stop offset="100%" stopColor="#009B7D" stopOpacity="0.6" />
        </linearGradient>
        <linearGradient id={`tpdn-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#E11D48" stopOpacity="0.55" />
          <stop offset="100%" stopColor={COLOR.accent.sell} stopOpacity="0.95" />
        </linearGradient>
      </defs>
      {/* zero line */}
      <line x1={4} x2={W - 4} y1={zero} y2={zero} stroke="rgba(148,163,184,0.3)" strokeWidth={1} strokeDasharray="3 3" />
      {cols.map((p, i) => {
        if (!p) return null;
        const cx = colW * i + colW / 2;
        const barY = y(p.expectedReturnPct);
        const top = Math.min(zero, barY);
        const h = Math.max(1.5, Math.abs(zero - barY));
        const hiY = y(p.high80Pct);
        const loY = y(p.low80Pct);
        const up = p.expectedReturnPct >= 0;
        return (
          <g key={p.horizonDays}>
            {/* 80%-range whisker (slate) */}
            <line x1={cx} x2={cx} y1={hiY} y2={loY} stroke="rgba(148,163,184,0.55)" strokeWidth={1.2} />
            <line x1={cx - 4.5} x2={cx + 4.5} y1={hiY} y2={hiY} stroke="rgba(148,163,184,0.55)" strokeWidth={1.2} />
            <line x1={cx - 4.5} x2={cx + 4.5} y1={loY} y2={loY} stroke="rgba(148,163,184,0.55)" strokeWidth={1.2} />
            {/* expected bar (buy/sell status tint, value always printed) */}
            <rect x={cx - 7} width={14} y={top} height={h} rx={3} fill={up ? `url(#tpup-${uid})` : `url(#tpdn-${uid})`} />
            {/* signed value above the whisker */}
            <text
              x={cx}
              y={Math.max(9, Math.min(hiY, loY) - 5)}
              textAnchor="middle"
              fontSize={9.5}
              fontWeight={600}
              fill={up ? COLOR.accent.buy : COLOR.accent.sell}
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {signedPct(p.expectedReturnPct, 1)}
            </text>
            <text x={cx} y={H - 6} textAnchor="middle" fontSize={9.5} fill="#64748b">
              {p.horizonDays}d
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Budget-aware 30-day projection line                                 */
/* ------------------------------------------------------------------ */

function BudgetProjection({ pick, budget }: { pick: TopPick; budget: number | null }) {
  const p30 = pick.predictions.find((p) => p.horizonDays === 30);

  if (budget != null) {
    const shares = Math.floor(budget / pick.price);
    if (shares <= 0) {
      return (
        <p className="text-xs leading-relaxed text-amber-400">
          ₹{plain(budget, 0)} can&apos;t buy one share at {inr(pick.price)}.
        </p>
      );
    }
    if (!p30) return null;
    const invested = shares * pick.price;
    const exp = invested * (1 + p30.expectedReturnPct / 100);
    const lo = invested * (1 + p30.low80Pct / 100);
    const hi = invested * (1 + p30.high80Pct / 100);
    return (
      <p className="text-sm leading-relaxed text-slate-300">
        Your budget buys{' '}
        <span className="font-semibold text-slate-100">
          {plain(shares, 0)} share{shares === 1 ? '' : 's'}
        </span>{' '}
        ({inrSmart(invested)}) → <span className="font-display font-semibold text-slate-100">{inrSmart(exp)}</span>{' '}
        expected by 30d <span className="text-xs text-slate-500">(range {inrSmart(lo)} – {inrSmart(hi)})</span>
      </p>
    );
  }

  const row = pick.projections.find((r) => r.amount === 10_000);
  const cell = row?.byHorizon.find((c) => c.horizonDays === 30);
  if (!cell) return null;
  return (
    <p className="text-sm leading-relaxed text-slate-300">
      {inr(10_000, 0)} → <span className="font-display font-semibold text-slate-100">{inrSmart(cell.expectedValue)}</span>{' '}
      by 30d{' '}
      <span className="text-xs text-slate-500">
        (range {inrSmart(cell.lowValue)} – {inrSmart(cell.highValue)})
      </span>
    </p>
  );
}

/* ------------------------------------------------------------------ */
/* Pick card — large interactive-tilt glass card (hero = rank #1)      */
/* Published-gate lookup key: scan rows use bare symbols, snapshots .NS. */
/* ------------------------------------------------------------------ */

function gateKey(ticker: string): string {
  const t = ticker.trim().toUpperCase();
  return /\.(NS|BO)$/.test(t) ? t : `${t}.NS`;
}

function PickCard({
  gate,
  pick,
  budget,
  hero,
  onAnalyze,
}: {
  pick: TopPick;
  budget: number | null;
  /** Rank-1 treatment: full-row card with a horizontal split on xl. */
  hero: boolean;
  onAnalyze: (ticker: string) => void;
  gate?: DecisionBatchEntry;
}) {
  const entryTitle =
    pick.entryScore != null
      ? `entry timing score ${Math.round(pick.entryScore)}/100 (technicals only, not a guarantee)`
      : undefined;

  const identity = (
    <div className="flex min-w-0 items-start gap-3.5">
      <RankMedallion rank={pick.rank} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-display truncate text-xl font-semibold tracking-tight text-slate-100">{pick.name}</h3>
          <Chip tone="zinc">{pick.ticker}</Chip>
          <Chip tone="zinc">{pick.sector}</Chip>
        </div>
        <div className="mt-2 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <span className="font-display text-2xl font-semibold tracking-tight text-slate-100 tabular-nums">
            {inr(pick.price)}
          </span>
          <span className={clsx('text-sm font-medium tabular-nums', signToneClass(pick.changePercent))}>
            {signedPct(pick.changePercent)} today
          </span>
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <RecBadge rec={pick.recommendation} />
          {pick.entryAction && <EntryChip action={pick.entryAction} title={entryTitle} />}
          <RiskChip risk={pick.riskLevel} />
        </div>
        <div className="mt-2">
          <DecisionGateChips entry={gate} />
        </div>
      </div>
      <ScoreDonut
        score={pick.score}
        tone={pick.recommendation}
        size={hero ? 84 : 60}
        label={hero ? 'quant score' : undefined}
      />
    </div>
  );

  const reasons = pick.topReasons.length > 0 && (
    <div>
      <p className="font-display text-[11px] font-semibold tracking-[0.14em] text-cyan-300/90 uppercase">
        Why this pick
      </p>
      <ul className="mt-1.5 space-y-1.5">
        {pick.topReasons.slice(0, 3).map((r, i) => (
          <li key={i} className="flex gap-2 text-sm leading-snug text-slate-400">
            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-buy" aria-hidden />
            {r}
          </li>
        ))}
      </ul>
    </div>
  );

  const forecast = (
    <div className={clsx('flex flex-col gap-3', hero ? 'xl:w-72 xl:shrink-0 xl:border-l xl:border-white/8 xl:pl-6' : 'flex-1')}>
      <p className="font-display text-[11px] font-semibold tracking-[0.14em] text-slate-500 uppercase">
        Expected return · 80% range
      </p>
      <ReturnBars pick={pick} />
      <BudgetProjection pick={pick} budget={budget} />
      <Button
        variant={hero ? 'primary' : 'secondary'}
        size="sm"
        className="mt-auto w-fit"
        onClick={() => onAnalyze(pick.ticker)}
      >
        Full analysis
        <ArrowRight className="h-3.5 w-3.5" aria-hidden />
      </Button>
    </div>
  );

  if (hero) {
    return (
      <GlassCard variant="interactive" maxTiltDeg={2.5} className="h-full p-5 sm:p-6">
        <div className="flex h-full flex-col gap-5 xl:flex-row">
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            {identity}
            {reasons}
          </div>
          {forecast}
        </div>
      </GlassCard>
    );
  }

  return (
    <GlassCard variant="interactive" className="flex h-full flex-col gap-4 p-5 sm:p-6">
      {identity}
      {reasons}
      {forecast}
    </GlassCard>
  );
}

/* ------------------------------------------------------------------ */
/* View                                                                */
/* ------------------------------------------------------------------ */

export function TopPicksView({ onAnalyze }: { onAnalyze: (ticker: string) => void }) {
  // Persisted budget; this component only ever mounts client-side (tab switch),
  // so the lazy initializer can read localStorage without hydration risk.
  const [budget, setBudgetState] = useState<number | null>(() => loadBudget());
  const [customRaw, setCustomRaw] = useState<string>(() => {
    const b = loadBudget();
    return b != null && !BUDGET_CHIPS.includes(b as (typeof BUDGET_CHIPS)[number]) ? String(b) : '';
  });

  const setBudget = (v: number | null, fromCustom = false) => {
    setBudgetState(v);
    persistBudget(v);
    if (!fromCustom) setCustomRaw('');
  };

  const applyCustom = () => {
    const parsed = parseBudget(customRaw);
    if (parsed != null) setBudget(parsed, true);
    else if (!customRaw.trim()) setBudget(null);
  };

  const customInvalid = customRaw.trim().length > 0 && parseBudget(customRaw) == null;

  const { data, isPending, isFetching, isError, error, refetch } = useQuery({
    queryKey: ['top-picks', budget],
    queryFn: () => getTopPicks(5, budget),
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  });

  // Phase 14: published-gate summaries for every pick shown (one batched read).
  const allPickTickers = useMemo(() => {
    const b = data?.buckets;
    const all = [
      ...(b?.bestNewEntries ?? []),
      ...(b?.strongButExtended ?? []),
      ...(b?.watchForPullback ?? []),
      ...(b?.highRiskMomentum ?? []),
    ];
    return Array.from(new Set(all.map((p) => gateKey(p.ticker))));
  }, [data]);
  const gateBatch = useDecisionBatch(allPickTickers);
  const decisions = gateBatch.data?.decisions ?? {};

  const filtered = data?.maxPrice != null;

  return (
    <div className="space-y-5">
      <ViewHero
        className="view-hero-subsection"
        eyebrow="Daily full-universe scan"
        title="Today's Scan"
        subtitle="Setups from today's full-universe scan, grouped honestly: only stocks that pass the evidence gate can appear under Best new entries — strong charts without that evidence are labeled as setups, never recommendations."
        right={
          data ? (
            <>
              <Chip tone="cyan">
                scanned {plain(data.scannedCount, 0)} / {plain(data.universeSize, 0)}
              </Chip>
              <Chip tone="zinc">as of {fmtDateTime(data.asOf)}</Chip>
            </>
          ) : undefined
        }
      />

      {/* Budget-per-share control */}
      <Card className="p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <div className="flex items-center gap-2">
            <Wallet className="h-4 w-4 text-cyan-400" aria-hidden />
            <p className="font-display text-sm font-semibold tracking-wide text-slate-200">Your budget per share</p>
          </div>

          <div role="radiogroup" aria-label="Budget per share" className="flex flex-wrap items-center gap-1.5">
            {BUDGET_CHIPS.map((b) => (
              <BudgetPill key={b} selected={budget === b} onSelect={() => setBudget(budget === b ? null : b)}>
                ₹{plain(b, 0)}
              </BudgetPill>
            ))}
            <BudgetPill selected={budget == null} onSelect={() => setBudget(null)}>
              Any
            </BudgetPill>
          </div>

          <Input
            aria-label="Custom budget per share"
            inputMode="numeric"
            icon={<IndianRupee />}
            value={customRaw}
            onChange={(e) => setCustomRaw(e.target.value)}
            onBlur={applyCustom}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                applyCustom();
              }
            }}
            placeholder="custom"
            wrapClassName="w-40"
            error={customInvalid ? 'Enter ₹1 – ₹10,00,000 per share.' : undefined}
          />

          {filtered && data?.affordableCount != null && (
            <Chip tone="cyan" glow>
              {plain(data.affordableCount, 0)} of {plain(data.scannedCount, 0)} affordable
            </Chip>
          )}

          <Button variant="secondary" size="sm" onClick={() => refetch()} disabled={isFetching} className="ml-auto">
            <RefreshCw className={clsx('h-3.5 w-3.5', isFetching && 'animate-spin')} aria-hidden />
            Refresh
          </Button>
        </div>
        {data?.note && <p className="mt-2.5 max-w-4xl text-xs leading-relaxed text-slate-500">{data.note}</p>}
      </Card>

      {isPending && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <CardSkeleton lines={5} className="xl:col-span-2" />
          {Array.from({ length: 4 }).map((_, i) => (
            <CardSkeleton key={i} lines={5} />
          ))}
        </div>
      )}

      {isError && (
        <ErrorState message={error instanceof Error ? error.message : 'Failed to load top picks'} onRetry={() => refetch()} />
      )}

      {data && (
        <>
          {/* Rule 15: BEST NEW ENTRIES — gate-passed only; honest emptiness beats forced picks. */}
          <BucketSection
            title="Best new entries"
            explain="Passed the evidence gate: validated directional edge on independent samples, calibration, data quality, entry quality and positive expected value after costs."
            picks={data.buckets?.bestNewEntries ?? []}
            emptyBanner={data.bestNewEntriesNote ?? 'No statistically attractive entries today.'}
            budget={data.maxPrice ?? budget}
            onAnalyze={onAnalyze}
            isFetching={isFetching}
            tone="buy"
            decisions={decisions}
          />
          <BucketSection
            title="Strong but extended"
            explain="High setup scores near 52-week highs after rapid runs — chasing strength is the classic way a good chart becomes a bad entry."
            picks={data.buckets?.strongButExtended ?? []}
            budget={data.maxPrice ?? budget}
            onAnalyze={onAnalyze}
            isFetching={isFetching}
            decisions={decisions}
          />
          <BucketSection
            title="Watch for pullback"
            explain="Strong setups where the evidence gate still says WAIT — worth following, not chasing."
            picks={data.buckets?.watchForPullback ?? []}
            budget={data.maxPrice ?? budget}
            onAnalyze={onAnalyze}
            isFetching={isFetching}
            decisions={decisions}
          />
          <BucketSection
            title="High-risk momentum"
            explain="Strong setup scores with HIGH risk character — volatility this hostile makes sizing and stops unreliable."
            picks={data.buckets?.highRiskMomentum ?? []}
            budget={data.maxPrice ?? budget}
            onAnalyze={onAnalyze}
            isFetching={isFetching}
            decisions={decisions}
          />
          {data.buckets && (
            <p className="px-1 text-[11px] leading-relaxed text-slate-500">
              {plain(data.buckets.insufficientEdgeCount, 0)} scanned stocks fall under{' '}
              <span className="font-medium text-slate-400">insufficient edge</span> (setup score &lt; 62) and are not
              listed — see the full universe in Discover.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function BucketSection({
  title,
  explain,
  picks,
  emptyBanner,
  budget,
  onAnalyze,
  isFetching,
  tone = 'zinc',
  decisions = {},
}: {
  title: string;
  explain: string;
  picks: TopPick[];
  /** When set, an empty bucket renders this banner instead of disappearing. */
  emptyBanner?: string;
  budget: number | null;
  onAnalyze: (ticker: string) => void;
  isFetching: boolean;
  tone?: 'buy' | 'zinc';
  decisions?: Record<string, DecisionBatchEntry>;
}) {
  if (picks.length === 0 && !emptyBanner) return null;
  return (
    <section className="space-y-3">
      <div>
        <h3
          className={clsx(
            'font-display text-sm font-semibold tracking-wide',
            tone === 'buy' ? 'text-buy' : 'text-slate-200',
          )}
        >
          {title}
          {picks.length > 0 && <span className="ml-2 text-xs font-normal text-slate-500">{picks.length}</span>}
        </h3>
        <p className="mt-0.5 max-w-3xl text-xs leading-relaxed text-slate-500">{explain}</p>
      </div>
      {picks.length === 0 ? (
        <Card className="p-5">
          <p className="text-sm leading-relaxed text-slate-400">{emptyBanner}</p>
        </Card>
      ) : (
        <Stagger className={clsx('grid grid-cols-1 gap-4 transition-opacity xl:grid-cols-2', isFetching && 'opacity-60')}>
          {picks.map((pick) => (
            <StaggerItem key={pick.ticker} className="h-full">
              <PickCard pick={pick} hero={false} budget={budget} onAnalyze={onAnalyze} gate={decisions[gateKey(pick.ticker)]} />
            </StaggerItem>
          ))}
        </Stagger>
      )}
    </section>
  );
}
