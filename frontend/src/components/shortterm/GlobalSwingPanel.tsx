'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  CalendarClock,
  ChevronDown,
  Clock3,
  Globe2,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { getGlobalSwing, GlobalSwingRow, GlobalSwingTier, GlobalMarket } from '@/lib/api';
import { Button, Card, Chip, ErrorState, SearchInput, Select, Skeleton } from '@/components/ui';

/*
 * GLOBAL SWING — a descriptive screen of international large caps for a
 * 10–15 trading-day window. It ranks how well PAST volatility, trend and
 * liquidity fit "moves a lot, has been growing steadily, not reckless".
 * It never predicts direction. UNPROVEN travels with every number.
 */

const TIER_META: Record<GlobalSwingTier, { label: string; tone: 'emerald' | 'amber' | 'zinc'; icon: typeof ShieldCheck }> = {
  SHORTLIST: { label: 'Shortlist', tone: 'emerald', icon: TrendingUp },
  WATCH: { label: 'Watch', tone: 'amber', icon: Clock3 },
  AVOID: { label: 'Avoid', tone: 'zinc', icon: TrendingDown },
};

const MARKET_LABEL: Record<GlobalMarket, string> = {
  US: 'US',
  ADR: 'US ADR',
  EU: 'Europe',
  JP: 'Japan',
  HK: 'Hong Kong',
  KR: 'Korea',
  TW: 'Taiwan',
  OTHER: 'Other',
};

const ACCESS_LABEL = {
  US_BROKER: 'Vested / INDmoney / IBKR',
  ADR_ON_US: 'ADR on a US broker',
  HOME_MARKET_ONLY: 'IBKR only (home market)',
} as const;

const CURRENCY_SYMBOL: Record<string, string> = { USD: '$', EUR: '€', JPY: '¥', HKD: 'HK$', KRW: '₩', TWD: 'NT$', GBp: 'p', GBP: '£', CHF: 'CHF ' };

function money(n: number, ccy: string): string {
  const sym = CURRENCY_SYMBOL[ccy] ?? `${ccy} `;
  const digits = ccy === 'JPY' || ccy === 'KRW' ? 0 : 2;
  return `${sym}${n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits })}`;
}
function signed(n: number, d = 1): string {
  return `${n > 0 ? '+' : ''}${n.toFixed(d)}%`;
}
function compactValue(n: number, ccy: string): string {
  const sym = CURRENCY_SYMBOL[ccy] ?? `${ccy} `;
  if (n >= 1e9) return `${sym}${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${sym}${(n / 1e6).toFixed(0)}M`;
  return `${sym}${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function SwingCard({ r }: { r: GlobalSwingRow }) {
  const [open, setOpen] = useState(false);
  const meta = TIER_META[r.tier];
  const Icon = meta.icon;
  return (
    <article className={clsx('conviction-stock-card', `swing-card-${r.tier.toLowerCase()}`)}>
      <div className="conviction-stock-topline">
        <span className="conviction-tier-label">
          <Icon aria-hidden />
          {meta.label}
        </span>
        <span className="swing-market-tag">{MARKET_LABEL[r.market]}</span>
      </div>
      <div className="conviction-stock-identity">
        <span className="conviction-stock-avatar" aria-hidden>
          {r.ticker.replace(/\..*$/, '').slice(0, 4)}
        </span>
        <div>
          <span className="conviction-stock-name">{r.ticker}</span>
          <p title={`${r.name} · ${r.sector}`}>
            {r.name} · {r.sector}
          </p>
        </div>
      </div>
      <div className="conviction-score-row">
        <span>Profile fit</span>
        <strong>
          {r.score.toFixed(0)}
          <small> / 100</small>
        </strong>
      </div>
      <div className="conviction-score-track" aria-hidden>
        <span style={{ width: `${Math.max(0, Math.min(100, r.score))}%` }} />
      </div>
      <dl className="conviction-stock-metrics">
        <div>
          <dt>Last close</dt>
          <dd>{money(r.price, r.currency)}</dd>
        </div>
        <div>
          <dt>Daily range</dt>
          <dd className={clsx(r.atrPct20 > 4.5 ? 'radar-value-warning' : 'radar-value-positive')}>{r.atrPct20.toFixed(1)}%</dd>
        </div>
        <div>
          <dt>Typical 12-day move</dt>
          <dd title="ATR × √12 — the size of a normal move either way, not a forecast">±{r.typicalMove12dPct.toFixed(0)}%</dd>
        </div>
      </dl>
      <div className="conviction-stock-status">
        {r.earningsInWindow === true ? (
          <Chip tone="rose" title={`Earnings ${r.earningsDate}${r.earningsSource === 'manual' ? ' (manual date, verify)' : ''}`}>
            <CalendarClock aria-hidden className="h-3 w-3" /> Earnings {r.earningsDate?.slice(5)}
          </Chip>
        ) : r.earningsInWindow === false ? (
          <Chip tone="zinc" title={`Next earnings ${r.earningsDate ?? 'beyond 60 days'}`}>
            No earnings in window
          </Chip>
        ) : (
          <Chip tone="amber">Earnings date unknown</Chip>
        )}
        <Chip tone={r.aboveSma50 && r.aboveSma200 ? 'emerald' : 'zinc'}>
          {r.aboveSma50 && r.aboveSma200 ? 'Above 50 & 200d' : r.aboveSma200 ? 'Above 200d' : 'Below 200d'}
        </Chip>
      </div>
      <button type="button" className="conviction-evidence-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide' : 'Why, and the geometry'}
        <ChevronDown aria-hidden className={clsx('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="conviction-evidence-details">
          <ul className="swing-reasons">
            {r.blocks.map((b) => (
              <li key={b} className="swing-reason-block">
                <ShieldAlert aria-hidden /> {b}
              </li>
            ))}
            {r.reasons.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
          <dl className="swing-geometry">
            <div>
              <dt>Entry (last close)</dt>
              <dd>{money(r.plan.entry, r.currency)}</dd>
            </div>
            <div>
              <dt>Stop · 2×ATR</dt>
              <dd className="radar-value-negative">
                {money(r.plan.stop, r.currency)} ({r.plan.stopPct.toFixed(1)}%)
              </dd>
            </div>
            <div>
              <dt>Target · 3×ATR</dt>
              <dd className="radar-value-positive">
                {money(r.plan.target, r.currency)} (+{r.plan.targetPct.toFixed(1)}%)
              </dd>
            </div>
            <div>
              <dt>60d / 120d</dt>
              <dd>
                {signed(r.ret60Pct)} / {signed(r.ret120Pct)}
              </dd>
            </div>
            <div>
              <dt>Worst 120d drawdown</dt>
              <dd className="radar-value-negative">{r.maxDrawdown120Pct.toFixed(0)}%</dd>
            </div>
            <div>
              <dt>Traded / day</dt>
              <dd>{compactValue(r.avgValue20, r.currency)}</dd>
            </div>
            <div>
              <dt>Round-trip cost (India, LRS)</dt>
              <dd>≈{r.roundTripCostPct.toFixed(1)}% before slab-rate tax</dd>
            </div>
            <div>
              <dt>How to buy</dt>
              <dd>{ACCESS_LABEL[r.access]}</dd>
            </div>
          </dl>
          <p className="swing-card-note">
            Stop and target are ATR geometry so the loss is defined first. They are not a prediction; the screen has no
            graded outcomes yet.
          </p>
        </div>
      )}
    </article>
  );
}

export function GlobalSwingPanel() {
  const [tier, setTier] = useState<'ALL' | GlobalSwingTier>('SHORTLIST');
  const [market, setMarket] = useState<'ALL' | 'US' | 'ADR' | 'HOME'>('ALL');
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(9);
  const [sort, setSort] = useState<'score' | 'atr' | 'ret60'>('score');
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['global-swing'],
    queryFn: () => getGlobalSwing(false),
    staleTime: 10 * 60_000,
  });

  const rows = useMemo(() => {
    const all = [...(data?.shortlist ?? []), ...(data?.watch ?? []), ...(data?.avoid ?? [])];
    const needle = search.trim().toLowerCase();
    return all
      .filter((r) => tier === 'ALL' || r.tier === tier)
      .filter((r) =>
        market === 'ALL'
          ? true
          : market === 'HOME'
            ? r.access === 'HOME_MARKET_ONLY'
            : r.market === market,
      )
      .filter((r) => !needle || `${r.ticker} ${r.name} ${r.sector}`.toLowerCase().includes(needle))
      .sort((a, b) =>
        sort === 'atr' ? b.atrPct20 - a.atrPct20 : sort === 'ret60' ? b.ret60Pct - a.ret60Pct : b.score - a.score,
      );
  }, [data, tier, market, search, sort]);

  const counts = {
    ALL: (data?.shortlist.length ?? 0) + (data?.watch.length ?? 0) + (data?.avoid.length ?? 0),
    SHORTLIST: data?.shortlist.length ?? 0,
    WATCH: data?.watch.length ?? 0,
    AVOID: data?.avoid.length ?? 0,
  };
  const generated = data
    ? new Date(data.generatedAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })
    : null;
  const inWindow = rows.filter((r) => r.earningsInWindow === true).length;

  return (
    <Card className="radar-research-panel conviction-board-panel">
      <div className="radar-panel-heading">
        <div>
          <h2>
            Global swing <span className="radar-heading-tag">10–15 trading days</span>
          </h2>
          <p>
            International large caps that move a lot day to day but have been growing steadily. A higher fit is a
            closer match to that profile, not a higher chance of profit.
          </p>
        </div>
        {data && (
          <div className="radar-panel-meta">
            <span>
              <strong>{counts.ALL}</strong> screened
            </span>
            {generated && (
              <small>
                <Clock3 aria-hidden />
                {generated} IST
              </small>
            )}
            <Button variant="secondary" size="sm" loading={isFetching} onClick={() => refetch()} aria-label="Refresh global swing screen">
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              Refresh
            </Button>
          </div>
        )}
      </div>
      {data && (
        <div className={clsx('radar-board-verdict', data.shortlist.length > 0 && 'radar-board-verdict-positive')}>
          <span className="radar-verdict-icon">
            <Globe2 aria-hidden />
          </span>
          <div>
            <strong>
              {data.shortlist.length} on the shortlist · {inWindow} of the shown names report earnings inside the window
            </strong>
            <p>
              Window ends {data.earningsWindowEnd}.{' '}
              {data.context.spy && (
                <>
                  S&amp;P 500 ETF {signed(data.context.spy.ret20Pct)} over 20 days
                  {data.context.vix && <> · VIX {data.context.vix.last.toFixed(1)}</>}.
                </>
              )}{' '}
              <span className="swing-unproven">UNPROVEN — 0 graded outcomes.</span>
            </p>
          </div>
        </div>
      )}
      <div className="conviction-toolbar">
        <SearchInput
          aria-label="Search global swing screen"
          placeholder="Search tickers, companies, sectors…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setLimit(9);
          }}
          onClear={() => {
            setSearch('');
            setLimit(9);
          }}
          wrapClassName="conviction-search"
        />
        <Select
          ariaLabel="Filter by market"
          value={market}
          onChange={(v) => {
            setMarket(v as typeof market);
            setLimit(9);
          }}
          options={[
            { value: 'ALL', label: 'All markets' },
            { value: 'US', label: 'US listed' },
            { value: 'ADR', label: 'ADRs' },
            { value: 'HOME', label: 'Home markets (IBKR only)' },
          ]}
          className="conviction-sort"
        />
        <Select
          ariaLabel="Sort global swing screen"
          value={sort}
          onChange={(v) => setSort(v as typeof sort)}
          options={[
            { value: 'score', label: 'Best profile fit' },
            { value: 'atr', label: 'Widest daily range' },
            { value: 'ret60', label: 'Strongest 60-day' },
          ]}
          className="conviction-sort"
        />
      </div>
      <div className="conviction-filter-row">
        <div className="radar-segmented-control" role="group" aria-label="Filter by tier">
          {(['SHORTLIST', 'WATCH', 'AVOID', 'ALL'] as const).map((id) => (
            <button
              type="button"
              key={id}
              aria-pressed={tier === id}
              onClick={() => {
                setTier(id);
                setLimit(9);
              }}
            >
              {id === 'ALL' ? 'All' : TIER_META[id].label}
              <span>{counts[id]}</span>
            </button>
          ))}
        </div>
        <span className="conviction-score-note">Profile fit, not probability</span>
      </div>
      {isLoading && (
        <div className="conviction-card-grid" role="status" aria-label="Loading global swing screen">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-64 rounded-xl" />
          ))}
          <span className="sr-only">Fetching a year of daily bars for every name — about 15 seconds the first time.</span>
        </div>
      )}
      {isError && (
        <ErrorState
          message={`The global swing screen failed to load: ${error instanceof Error ? error.message : 'unknown error'}`}
          onRetry={() => refetch()}
        />
      )}
      {data &&
        (rows.length ? (
          <div className="conviction-card-grid">
            {rows.slice(0, limit).map((r) => (
              <SwingCard key={r.ticker} r={r} />
            ))}
          </div>
        ) : (
          <div className="radar-filter-empty">
            <Search aria-hidden />
            <h3>No names match these filters.</h3>
            <p>Try another tier, market or search.</p>
          </div>
        ))}
      {data && (
        <>
          <div className="radar-panel-footer">
            <span>
              Showing {Math.min(limit, rows.length)} of {rows.length}
              {data.failed.length > 0 && ` · ${data.failed.length} failed to load (${data.failed.map((f) => f.ticker).join(', ')})`}
            </span>
            {rows.length > limit && (
              <Button variant="secondary" size="sm" onClick={() => setLimit((n) => n + 9)}>
                Show 9 more
                <ChevronDown className="h-3.5 w-3.5" aria-hidden />
              </Button>
            )}
          </div>
          <p className="radar-evidence-caveat">
            <ShieldAlert aria-hidden />
            <span>{data.caveat}</span>
          </p>
          <details className="swing-method">
            <summary>How this screen is built</summary>
            <ul>
              {data.method.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </details>
        </>
      )}
    </Card>
  );
}
