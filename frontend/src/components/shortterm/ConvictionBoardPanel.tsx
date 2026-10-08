'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  ArrowUpRight,
  ChevronDown,
  Clock3,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  TrendingUp,
} from 'lucide-react';
import {
  getConvictionBoard,
  runWideScan,
  ConvictionBoard,
  ScoredConviction,
  ConvictionTier,
} from '@/lib/api';
import {
  Button,
  Card,
  Chip,
  ErrorState,
  Input,
  SearchInput,
  Select,
  Skeleton,
} from '@/components/ui';
import { useAuth } from '@/components/auth/useAuth';

// Conviction measures evidence and setup completeness, never probability of profit.
// Empty high tiers and deterministic/AI vetoes must remain visible.
const TIER_META = {
  HIGH: { label: 'High conviction', tone: 'emerald', icon: Sparkles },
  MEDIUM: { label: 'Medium conviction', tone: 'amber', icon: TrendingUp },
  LOW: { label: 'Low / avoid', tone: 'zinc', icon: ShieldAlert },
} as const;

function money(n: number | null): string {
  return n == null ? '—' : `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

function ConvictionCard({ s, onOpen }: { s: ScoredConviction; onOpen: (t: string) => void }) {
  const [open, setOpen] = useState(false);
  const meta = TIER_META[s.tier];
  const Icon = meta.icon;
  const capLabel =
    s.aiCapAction === 'CAP_TO_NO_TRADE'
      ? 'AI: avoid'
      : s.aiCapAction === 'CAP_TO_WATCH'
        ? 'AI: watch only'
        : s.aiCapAction === 'AFFIRM'
          ? 'AI: no veto'
          : 'AI: not reviewed';
  return (
    <article className={clsx('conviction-stock-card', `conviction-stock-${s.tier.toLowerCase()}`)}>
      <div className="conviction-stock-topline">
        <span className="conviction-tier-label">
          <Icon aria-hidden />
          {meta.label}
        </span>
        {s.buyGrade ? (
          <Chip tone="emerald">BUY-grade</Chip>
        ) : s.tradeabilityBlocked ? (
          <Chip tone="rose" title={s.tradeabilityReasons.join(' · ')}>
            Not tradeable
          </Chip>
        ) : (
          <span className="conviction-stock-setup">
            {s.setupType.replace(/_/g, ' ').toLowerCase()}
          </span>
        )}
      </div>
      <div className="conviction-stock-identity">
        <span className="conviction-stock-avatar" aria-hidden>
          {s.symbol.slice(0, 2)}
        </span>
        <div>
          <button type="button" onClick={() => onOpen(s.ticker)} className="conviction-stock-name">
            {s.symbol}
            <ArrowUpRight aria-hidden />
          </button>
          <p title={s.companyName ?? s.industry ?? ''}>
            {s.companyName ?? s.industry ?? 'Company details unavailable'}
          </p>
        </div>
      </div>
      <div className="conviction-score-row">
        <span>Evidence score</span>
        <strong>
          {s.score.toFixed(1)}
          <small> / 100</small>
        </strong>
      </div>
      <div className="conviction-score-track" aria-hidden>
        <span style={{ width: `${Math.max(0, Math.min(100, s.score))}%` }} />
      </div>
      <dl className="conviction-stock-metrics">
        <div>
          <dt>Market price</dt>
          <dd>{money(s.price)}</dd>
        </div>
        <div>
          <dt>Reward / risk</dt>
          <dd
            className={clsx(
              s.rewardRiskToT1 != null &&
                (s.rewardRiskToT1 >= 1.5
                  ? 'radar-value-positive'
                  : s.rewardRiskToT1 >= 1
                    ? 'radar-value-warning'
                    : 'radar-value-negative'),
            )}
          >
            {s.rewardRiskToT1 != null ? `${s.rewardRiskToT1.toFixed(2)}×` : '—'}
          </dd>
        </div>
        <div>
          <dt>EV after costs</dt>
          <dd
            className={clsx(
              s.evAfterCostsPct != null &&
                (s.evAfterCostsPct > 0 ? 'radar-value-positive' : 'radar-value-negative'),
            )}
          >
            {s.evAfterCostsPct != null
              ? `${s.evAfterCostsPct > 0 ? '+' : ''}${s.evAfterCostsPct.toFixed(2)}%`
              : '—'}
          </dd>
        </div>
      </dl>
      <div className="conviction-stock-status">
        <Chip
          tone={
            s.decision === 'BUY'
              ? 'emerald'
              : s.decision === 'WATCH' || s.decision === 'WAIT'
                ? 'amber'
                : 'zinc'
          }
        >
          {s.decision}
        </Chip>
        <span
          className={s.aiCapAction === 'CAP_TO_NO_TRADE' ? 'radar-value-negative' : undefined}
          title="AI risk scout can only cap a tier, never upgrade it"
        >
          {capLabel}
        </span>
        {s.aiRedFlags > 0 && (
          <Chip tone={s.aiRedFlags >= 7 ? 'rose' : 'zinc'}>{s.aiRedFlags} flags</Chip>
        )}
      </div>
      {s.valuation && (
        <div className="conviction-valuation-tag">
          <ShieldCheck aria-hidden />
          <span className={s.valuation.isValueTrap ? 'radar-value-negative' : undefined}>
            {s.valuation.isValueTrap
              ? 'Value trap flagged'
              : s.valuation.verdict === 'UNDERVALUED_QUALITY'
                ? 'Undervalued + quality'
                : s.valuation.verdict.replace(/_/g, ' ').toLowerCase()}
          </span>
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="conviction-evidence-toggle"
        aria-expanded={open}
        aria-controls={`conviction-evidence-${s.symbol}`}
      >
        <span>View evidence & risk</span>
        <ChevronDown className={clsx(open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <div id={`conviction-evidence-${s.symbol}`} className="conviction-evidence-details">
          {s.entry != null && (
            <dl className="conviction-stock-metrics">
              <div>
                <dt>Entry ≤</dt>
                <dd>{money(s.entry)}</dd>
              </div>
              <div>
                <dt>Stop</dt>
                <dd className="radar-value-negative">{money(s.stop)}</dd>
              </div>
              <div>
                <dt>Target 1</dt>
                <dd className="radar-value-positive">{money(s.target1)}</dd>
              </div>
            </dl>
          )}
          {s.liquidity && (
            <dl className="conviction-liquidity">
              <div>
                <dt>Daily traded value</dt>
                <dd>
                  {s.liquidity.medianDailyValueInr20d != null
                    ? `₹${(s.liquidity.medianDailyValueInr20d / 1e7).toFixed(2)} cr`
                    : '—'}
                </dd>
              </div>
              <div>
                <dt>Days to exit ₹1 cr</dt>
                <dd>{s.liquidity.daysToExitAt1crore ?? '—'}</dd>
              </div>
              <div>
                <dt>Delivery, 20 days</dt>
                <dd>{s.liquidity.delivPct20d != null ? `${s.liquidity.delivPct20d}%` : '—'}</dd>
              </div>
              <div>
                <dt>Circuit band</dt>
                <dd>
                  {s.liquidity.inferredCircuitBandPct != null
                    ? `~${s.liquidity.inferredCircuitBandPct}%`
                    : 'None'}
                </dd>
              </div>
            </dl>
          )}
          {s.tradeabilityBlocked && (
            <p className="radar-value-negative">{s.tradeabilityReasons.join(' · ')}</p>
          )}
          <ul>
            {s.reasons.map((reason, index) => (
              <li key={index}>{reason}</li>
            ))}
          </ul>
          <button type="button" className="radar-text-link" onClick={() => onOpen(s.ticker)}>
            Open full research
            <ArrowUpRight aria-hidden />
          </button>
        </div>
      )}
    </article>
  );
}

export function ConvictionBoardPanel({
  onOpen,
  scanParams,
}: {
  onOpen: (ticker: string) => void;
  scanParams?: {
    budgetInr?: number | null;
    horizon?: '1-3d' | '3-5d' | '5-10d' | '10-21d';
    riskPerTradePct?: number | null;
  };
}) {
  const { auth } = useAuth();
  const isAuthenticated = auth?.status === 'authenticated';
  const { data, isLoading, isError, error, refetch } = useQuery<ConvictionBoard>({
    queryKey: ['conviction-board'],
    queryFn: getConvictionBoard,
    staleTime: 60_000,
  });
  const [priceInput, setPriceInput] = useState('');
  const [tier, setTier] = useState<ConvictionTier | 'ALL'>('ALL');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'score' | 'rr'>('score');
  const [limit, setLimit] = useState(6);
  const reEval = useMutation({
    mutationFn: (maxPrice: number) =>
      runWideScan({
        priceMax: maxPrice,
        budgetInr: scanParams?.budgetInr ?? 50000,
        horizon: scanParams?.horizon ?? '5-10d',
        riskPerTradePct: scanParams?.riskPerTradePct ?? 0.5,
      }),
    onSuccess: () => refetch(),
  });
  const ceiling = data?.maxPrice ?? 100;
  const priceValue = priceInput || String(ceiling);
  const validPrice =
    Number.isFinite(Number(priceValue)) && Number(priceValue) >= 6 && Number(priceValue) <= 2000;
  const generated = useMemo(
    () =>
      data?.generatedAt
        ? new Date(data.generatedAt).toLocaleString('en-IN', {
            day: 'numeric',
            month: 'short',
            hour: 'numeric',
            minute: '2-digit',
            timeZone: 'Asia/Kolkata',
          })
        : null,
    [data],
  );
  const rows = useMemo(() => {
    const all = [...(data?.high ?? []), ...(data?.medium ?? []), ...(data?.low ?? [])];
    const needle = search.trim().toLowerCase();
    return all
      .filter(
        (s) =>
          (tier === 'ALL' || s.tier === tier) &&
          (!needle ||
            `${s.symbol} ${s.companyName ?? ''} ${s.industry ?? ''}`
              .toLowerCase()
              .includes(needle)),
      )
      .sort((a, b) =>
        sort === 'rr'
          ? (b.rewardRiskToT1 ?? -Infinity) - (a.rewardRiskToT1 ?? -Infinity)
          : b.score - a.score,
      );
  }, [data, tier, search, sort]);
  const total = (data?.high.length ?? 0) + (data?.medium.length ?? 0) + (data?.low.length ?? 0);

  return (
    <Card className="radar-research-panel conviction-board-panel">
      <div className="radar-panel-heading">
        <div>
          <h2>
            Conviction board{' '}
            <span className="radar-heading-tag">Under ₹{ceiling.toLocaleString('en-IN')}</span>
          </h2>
          <p>
            A shortlist ranked by evidence and reward-to-risk. A higher score is a more complete
            setup, not a higher chance of profit.
          </p>
        </div>
        {data && (
          <div className="radar-panel-meta">
            <span>
              <strong>{data.evaluated.toLocaleString('en-IN')}</strong> evaluated
            </span>
            {generated && (
              <small>
                <Clock3 aria-hidden />
                {generated} IST
              </small>
            )}
          </div>
        )}
      </div>
      {data && (
        <div
          className={clsx(
            'radar-board-verdict',
            data.buyGradeCount > 0 && 'radar-board-verdict-positive',
          )}
        >
          <span className="radar-verdict-icon">
            <ShieldCheck aria-hidden />
          </span>
          <div>
            <strong>
              {data.buyGradeCount > 0
                ? `${data.buyGradeCount} buy-grade ${data.buyGradeCount === 1 ? 'setup' : 'setups'}`
                : 'Patience is a position.'}
            </strong>
            <p>{data.headline}</p>
          </div>
          {data.regime && (
            <Chip
              tone={
                data.regime.regime === 'TREND_UP'
                  ? 'emerald'
                  : data.regime.regime === 'TREND_DOWN' || data.regime.regime === 'CRISIS'
                    ? 'rose'
                    : 'amber'
              }
              title={[data.regime.gateNote, ...data.regime.reasons].filter(Boolean).join(' · ')}
            >
              {data.regime.regime.replace(/_/g, ' ').toLowerCase()}
              {data.regime.sizeMultiplier != null &&
                data.regime.sizeMultiplier !== 1 &&
                ` · size ×${data.regime.sizeMultiplier}`}
            </Chip>
          )}
        </div>
      )}
      <div className="conviction-toolbar">
        <form
          className="conviction-price-control"
          onSubmit={(event) => {
            event.preventDefault();
            if (validPrice && isAuthenticated && !reEval.isPending)
              reEval.mutate(Math.round(Number(priceValue)));
          }}
        >
          <Input
            aria-label="Conviction board maximum price in rupees"
            type="number"
            inputMode="numeric"
            value={priceValue}
            onChange={(e) => setPriceInput(e.target.value)}
            min={6}
            max={2000}
            icon={<span>₹</span>}
          />
          <Button
            variant="secondary"
            type="submit"
            loading={reEval.isPending}
            disabled={!isAuthenticated || !validPrice}
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            {reEval.isPending ? 'Evaluating…' : 'Update ceiling'}
          </Button>
        </form>
        <SearchInput
          aria-label="Search conviction board"
          placeholder="Search stocks or companies…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setLimit(6);
          }}
          onClear={() => {
            setSearch('');
            setLimit(6);
          }}
          wrapClassName="conviction-search"
        />
        <Select
          ariaLabel="Sort conviction board"
          value={sort}
          onChange={setSort}
          options={[
            { value: 'score', label: 'Highest evidence score' },
            { value: 'rr', label: 'Highest reward / risk' },
          ]}
          className="conviction-sort"
        />
      </div>
      {!validPrice && (
        <p className="radar-inline-error" role="alert">
          Choose a price ceiling between ₹6 and ₹2,000.
        </p>
      )}
      {!isAuthenticated && (
        <p className="radar-control-hint">
          Sign in to update the price ceiling. You can browse the latest evaluation below.
        </p>
      )}
      {reEval.isPending && (
        <p className="radar-control-hint" role="status">
          Scanning the universe and measuring setups at your new price ceiling…
        </p>
      )}
      {reEval.isError && (
        <p className="radar-inline-error" role="alert">
          Could not update the ceiling. Try again.
        </p>
      )}
      <div className="conviction-filter-row">
        <div
          className="radar-segmented-control"
          role="group"
          aria-label="Filter by conviction tier"
        >
          {(['ALL', 'HIGH', 'MEDIUM', 'LOW'] as const).map((id) => (
            <button
              type="button"
              key={id}
              aria-pressed={tier === id}
              onClick={() => {
                setTier(id);
                setLimit(6);
              }}
            >
              {id === 'ALL'
                ? 'All setups'
                : id === 'LOW'
                  ? 'Low / avoid'
                  : id === 'HIGH'
                    ? 'High'
                    : 'Medium'}
              <span>
                {id === 'ALL'
                  ? total
                  : id === 'HIGH'
                    ? (data?.high.length ?? 0)
                    : id === 'MEDIUM'
                      ? (data?.medium.length ?? 0)
                      : (data?.low.length ?? 0)}
              </span>
            </button>
          ))}
        </div>
        <span className="conviction-score-note">Evidence strength, not probability</span>
      </div>
      {isLoading && (
        <div
          className="conviction-card-grid"
          role="status"
          aria-label="Loading latest stock evaluation"
        >
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-64 rounded-xl" />
          ))}
          <span className="sr-only">Loading the latest background evaluation…</span>
        </div>
      )}
      {isError && (
        <ErrorState
          message={`The conviction board could not be loaded: ${
            error instanceof Error ? error.message : 'unknown error'
          }. ${
            error instanceof Error && /Internal Server Error/i.test(error.message)
              ? 'The backend hit an exception — check its log for the stack (a missing table means pending migrations).'
              : 'Retry to reconnect to the research engine.'
          }`}
          onRetry={() => refetch()}
        />
      )}
      {data &&
        (rows.length ? (
          <div className="conviction-card-grid">
            {rows.slice(0, limit).map((s) => (
              <ConvictionCard key={s.ticker} s={s} onOpen={onOpen} />
            ))}
          </div>
        ) : (
          <div className="radar-filter-empty">
            {tier === 'HIGH' && !search ? <ShieldCheck aria-hidden /> : <Search aria-hidden />}
            <h3>
              {tier === 'HIGH' && !search
                ? 'No high-conviction setups today.'
                : 'No setups match these filters.'}
            </h3>
            <p>
              {tier === 'HIGH' && !search
                ? 'No stock cleared the high-conviction bar. Waiting protects your capital; a tier alone never authorizes an entry.'
                : 'Try another stock name or conviction tier.'}
            </p>
            {search && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setSearch('');
                  setTier('ALL');
                }}
              >
                Clear filters
              </Button>
            )}
          </div>
        ))}
      {data && (
        <>
          <div className="radar-panel-footer">
            <span>
              Showing {Math.min(limit, rows.length)} of {rows.length} setups
            </span>
            {rows.length > limit && (
              <Button variant="secondary" size="sm" onClick={() => setLimit((n) => n + 6)}>
                Show 6 more
                <ChevronDown className="h-3.5 w-3.5" aria-hidden />
              </Button>
            )}
          </div>
          <p className="radar-evidence-caveat">
            <ShieldAlert aria-hidden />
            <span>{data.caveat} The AI scout can lower a tier, never raise it.</span>
          </p>
        </>
      )}
    </Card>
  );
}
