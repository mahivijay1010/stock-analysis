'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import clsx from 'clsx';
import { Download, IndianRupee, Scale, Sprout, Zap, type LucideIcon } from 'lucide-react';
import { suggestPortfolio } from '@/lib/api';
import type { PortfolioStrategy } from '@/lib/types';
import { parseAmount } from '@/components/analyze/AmountInput';
import { fmtDateTime, inr, inrSmart, pct, plain } from '@/lib/format';
import {
  AnimatedNumber,
  Button,
  Card,
  Chip,
  Collapsible,
  EmptyState,
  SectionTitle,
  StatTile,
  ViewHero,
} from '@/components/ui';
import { Stagger, StaggerItem } from '@/components/motion';
import {
  AllocationLegs,
  AllocationWarnings,
  CashReserveNote,
  CombinedOutcomes,
  STRATEGY_LABEL,
  SplitRationale,
  TranchePlan,
  downloadAllocationCsv,
} from '@/components/AllocationCard';
import { StressTestCard } from '@/components/StressTestCard';

const STRATEGIES: Array<{ id: PortfolioStrategy; label: string; icon: LucideIcon; blurb: string }> = [
  {
    id: 'short-term',
    label: 'Short-term',
    icon: Zap,
    blurb: 'Momentum setups for days–weeks, tight stops, full deploy now.',
  },
  {
    id: 'balanced',
    label: 'Balanced',
    icon: Scale,
    blurb: 'Half momentum, half quality compounders — a middle path.',
  },
  {
    id: 'long-term',
    label: 'Long-term',
    icon: Sprout,
    blurb: 'Quality compounders for months+, judged on fundamentals, staggered entry in tranches.',
  },
];

/**
 * Public portfolio builder, laid out as a dashboard of collapsible sections:
 * Strategy & Amount → totals → Suggested Allocation (legs as cards, CSV
 * export) → Combined Outcomes → Stress Test. Read-only (recording trades
 * lives in Admin); honesty elements (cash reserve, warnings, disclaimer)
 * stay outside the collapsibles so they can never be hidden.
 */
export function PortfolioView({ onAnalyze }: { onAnalyze: (ticker: string) => void }) {
  const [raw, setRaw] = useState('');
  const [strategy, setStrategy] = useState<PortfolioStrategy>('balanced');
  const suggest = useMutation({
    mutationFn: ({ amount, strategy: s }: { amount: number; strategy: PortfolioStrategy }) =>
      suggestPortfolio(amount, s),
  });

  const parsed = parseAmount(raw);
  const invalid = raw.trim().length > 0 && parsed == null;
  const active = STRATEGIES.find((s) => s.id === strategy) ?? STRATEGIES[1];

  const data = suggest.data;
  const alloc = data?.allocation ?? null;
  const sectorCount = alloc ? new Set(alloc.stocks.map((s) => s.sector)).size : 0;

  return (
    <div className="space-y-5">
      <ViewHero
        eyebrow="allocation engine"
        title="Portfolio"
        subtitle="Pick a strategy and an amount — the engine splits it across today's qualified setups (diversified by sector, 3:1 stop/target on every short-term leg) and shows the combined expected outcome with honest ranges."
        right={
          <Chip tone="violet" glow>
            strategy: {active.label}
          </Chip>
        }
      />

      {/* Section — Strategy & Amount */}
      <section>
        <Collapsible
          id="portfolio.strategy"
          defaultOpen
          title="Strategy & amount"
          subtitle="How the engine should think, and how much it gets to split"
          right={<Chip tone="violet">{active.label}</Chip>}
        >
          <Card className="p-5">
            <div>
              <p className="font-display text-[11px] font-semibold tracking-[0.14em] text-slate-500 uppercase">
                Strategy
              </p>
              <div
                role="radiogroup"
                aria-label="Portfolio strategy"
                className="mt-2 grid grid-cols-3 gap-1 rounded-xl border border-white/8 bg-white/4 p-1"
              >
                {STRATEGIES.map((s) => {
                  const selected = strategy === s.id;
                  const Icon = s.icon;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setStrategy(s.id)}
                      className={clsx(
                        'flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-semibold transition-all sm:text-sm',
                        selected
                          ? 'bg-gradient-to-r from-cyan-400/20 to-violet-400/20 text-cyan-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]'
                          : 'text-slate-400 hover:text-slate-200',
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" aria-hidden />
                      {s.label}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1.5 px-1 text-xs leading-relaxed text-slate-500">{active.blurb}</p>
            </div>

            <form
              className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-start"
              onSubmit={(e) => {
                e.preventDefault();
                if (parsed != null) suggest.mutate({ amount: parsed, strategy });
              }}
            >
              <div className="w-full sm:max-w-72">
                <div className="relative">
                  <IndianRupee
                    className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-slate-500"
                    aria-hidden
                  />
                  <input
                    type="text"
                    inputMode="numeric"
                    aria-label="Amount to allocate"
                    value={raw}
                    onChange={(e) => setRaw(e.target.value)}
                    onBlur={() => {
                      if (parsed != null) setRaw(plain(parsed, 0));
                    }}
                    placeholder="Amount, e.g. 10,000"
                    className="input-glass py-2.5 pr-3 pl-10"
                  />
                </div>
                {invalid && <p className="mt-1 px-1 text-xs text-amber-400">Enter between ₹100 and ₹10,00,00,000.</p>}
              </div>
              <Button type="submit" disabled={parsed == null} loading={suggest.isPending} className="sm:shrink-0">
                Build allocation
              </Button>
            </form>
            {suggest.isError && (
              <p className="mt-3 text-xs text-sell">
                {suggest.error instanceof Error ? suggest.error.message : 'Suggestion failed.'}
              </p>
            )}
          </Card>
        </Collapsible>
      </section>

      {data && !alloc && (
        <Card className="p-5">
          <SectionTitle>Suggested allocation</SectionTitle>
          <EmptyState
            glyph="radar"
            className="mt-3"
            title="No allocation today"
            message={data.reason || 'No qualified BUY setups pass the filters right now — holding cash is the right move.'}
          />
        </Card>
      )}

      {data && alloc && (
        <>
          {/* Totals — always visible, animated */}
          <Stagger className="grid grid-cols-2 gap-4 xl:grid-cols-4">
            <StaggerItem>
              <StatTile
                label="Invested now"
                value={<AnimatedNumber value={alloc.cashUsed} format={inrSmart} />}
                sub={`of ${inrSmart(alloc.amount)} · ${plain(alloc.stocks.length, 0)} leg${alloc.stocks.length > 1 ? 's' : ''}`}
              />
            </StaggerItem>
            <StaggerItem>
              <StatTile
                label="Cash reserve"
                value={<AnimatedNumber value={alloc.cashLeft} format={inrSmart} />}
                sub={`${pct(alloc.cashReservePct, 0)} held back — see note below`}
              />
            </StaggerItem>
            <StaggerItem>
              <StatTile
                label="Diversification"
                value={
                  <>
                    {plain(alloc.stocks.length, 0)}
                    <span className="text-slate-500"> × </span>
                    {plain(sectorCount, 0)}
                  </>
                }
                sub="stocks × sectors"
              />
            </StaggerItem>
            <StaggerItem>
              <StatTile
                label="Round-trip fees (est.)"
                value={<AnimatedNumber value={alloc.totalFeesRoundTrip} format={(v) => inr(v)} />}
                sub={`${pct(alloc.totalFeesPct, 2)} of invested — fees are certain, returns are not`}
              />
            </StaggerItem>
          </Stagger>

          {/* Honesty elements — never inside a collapsible */}
          <CashReserveNote allocation={alloc} />
          <AllocationWarnings warnings={alloc.warnings} />

          {/* Section — Suggested Allocation */}
          <section>
            <Collapsible
              id="portfolio.allocation"
              defaultOpen
              title="Suggested allocation"
              subtitle={`${STRATEGY_LABEL[alloc.strategy]} · as of ${fmtDateTime(alloc.asOf)}`}
              right={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => downloadAllocationCsv(alloc, data.disclaimer)}
                  aria-label="Export the allocation table as CSV"
                >
                  <Download className="h-3.5 w-3.5" aria-hidden />
                  Export CSV
                </Button>
              }
            >
              <Card className="p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <Chip tone="violet">{STRATEGY_LABEL[alloc.strategy]}</Chip>
                  <Chip tone="zinc">
                    {alloc.stocks.length} stock{alloc.stocks.length > 1 ? 's' : ''} · {sectorCount} sector
                    {sectorCount > 1 ? 's' : ''}
                  </Chip>
                  <Chip tone="zinc">
                    invested {inrSmart(alloc.cashUsed)} · cash left {inrSmart(alloc.cashLeft)}
                  </Chip>
                </div>

                <AllocationLegs allocation={alloc} onAnalyze={onAnalyze} className="mt-4" />

                <TranchePlan plan={alloc.tranchePlan} className="mt-5" />

                <SplitRationale rationale={alloc.rationale} className="mt-4" />
              </Card>
            </Collapsible>
          </section>

          {/* Section — Combined Outcomes */}
          <section>
            <Collapsible
              id="portfolio.outcomes"
              defaultOpen
              title="Combined outcomes"
              subtitle={`for ${inrSmart(alloc.amount)} — stocks + uninvested cash, with 80% ranges`}
              right={<Chip tone="cyan">{alloc.outcomes.length} horizons</Chip>}
            >
              <Card className="p-5">
                <CombinedOutcomes allocation={alloc} heading={false} />
              </Card>
            </Collapsible>
          </section>

          {/* Section — Stress Test (V7 — hides itself when the backend hasn't
              shipped /api/portfolio/stress) */}
          {alloc.stocks.length > 0 && (
            <section>
              <Collapsible
                id="portfolio.stress"
                defaultOpen
                title="Stress test"
                subtitle="Real history replayed against this allocation — no synthetic scenarios"
              >
                <StressTestCard
                  title="This allocation — how bad could 21 days get?"
                  tickers={alloc.stocks.map((s) => s.ticker)}
                  weights={alloc.stocks.map((s) =>
                    Number(((Number.isFinite(s.weightPct) ? s.weightPct : 0) / 100).toFixed(4)),
                  )}
                />
              </Collapsible>
            </section>
          )}
        </>
      )}

      {data && <p className="px-1 text-xs leading-relaxed text-slate-500">{data.disclaimer}</p>}
    </div>
  );
}
