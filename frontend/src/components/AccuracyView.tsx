'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, ReferenceLine, Tooltip, XAxis, YAxis } from 'recharts';
import clsx from 'clsx';
import { AlertTriangle, ArrowUpDown } from 'lucide-react';
import { getAccuracy } from '@/lib/api';
import type { AccuracyPerStock } from '@/lib/types';
import { CHART } from '@/lib/palette';
import { fmtDateTime, pct, plain } from '@/lib/format';
import {
  Card,
  CardSkeleton,
  ChartFrame,
  ChartSkeleton,
  ChartTip,
  Chip,
  ErrorState,
  GlassCard,
  InfoTip,
  SectionTitle,
  StatTile,
  StatTileSkeleton,
  ViewHero,
  useChartMotion,
} from '@/components/ui';
import { Stagger, StaggerItem } from '@/components/motion';
import { CalibrationPanel } from '@/components/CalibrationPanel';

type SortKey = 'ticker' | 'hitRate1d' | 'hitRate7d' | 'hitRate30d' | 'samples';

function hitClass(v: number | null): string {
  if (v == null) return 'text-slate-600';
  if (v >= 55) return 'text-buy';
  if (v <= 45) return 'text-sell';
  return 'text-slate-200';
}

/** Extreme per-stock rates (≥95% or ≤5%) at long horizons are usually one trend counted many times.
 *  Checked on the ROUNDED value so the flag always matches the percentage shown in the cell. */
function isExtreme(v: number | null): boolean {
  if (v == null) return false;
  const r = Math.round(v);
  return r >= 95 || r <= 5;
}

/** One plain sentence per metric — shown in the ⓘ popovers. */
const TILE_INFO = {
  samples:
    'Total prediction-vs-outcome pairs replayed across all stocks and horizons — more samples make these stats harder to fluke.',
  bestHorizon:
    'The horizon whose direction call matched what actually happened most often in the backtest — measured, not promised.',
  avgError:
    'On average, how many percentage points the predicted return missed the actual return by, ignoring direction.',
  withinBand:
    'How often the actual return landed inside the stated 80% confidence range — honest bands should land near 80%.',
} as const;

const COLUMN_INFO: Partial<Record<SortKey, string>> = {
  hitRate1d:
    '% of backtest predictions where the 1-day direction call matched reality — short windows barely overlap, so this is the most trustworthy per-stock number.',
  hitRate7d:
    '% of backtest predictions where the 7-day direction call matched reality — windows overlap, so treat extremes with suspicion.',
  hitRate30d:
    '% of backtest predictions where the 30-day direction call matched reality — windows overlap heavily, so treat extremes (marked *) with suspicion.',
  samples:
    'How many backtest windows were scored for this stock — overlapping windows mean far fewer independent observations than this count suggests.',
};

function AccuracyTip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ value?: number | null; color?: string; name?: string | number }>;
  label?: string | number;
}) {
  if (!active || !payload?.length) return null;
  return (
    <ChartTip>
      <p className="font-medium text-slate-300">{label} horizon</p>
      <div className="mt-1 space-y-0.5">
        {payload.map((e, i) =>
          e.value == null ? null : (
            <p key={i} className="flex items-center gap-1.5">
              <span className="h-2 w-2.5 rounded-sm" style={{ backgroundColor: e.color }} aria-hidden />
              <span className="font-semibold text-slate-100">{pct(e.value, 1)}</span>
              <span className="text-slate-500">{String(e.name)}</span>
            </p>
          ),
        )}
      </div>
    </ChartTip>
  );
}

/**
 * The honesty page: every number here is measured out-of-sample, never
 * promised. Aggregate stats sit left, the per-horizon breakdown right;
 * below them the Brier calibration panel (gauges vs the 0.25 coin flip),
 * the per-stock table with its overlapping-window caveat, and the model
 * pool comparison.
 */
export function AccuracyView({ diagnosticsOpen = false }: { diagnosticsOpen?: boolean } = {}) {
  void diagnosticsOpen;
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ['accuracy'],
    queryFn: getAccuracy,
    staleTime: 5 * 60_000,
  });

  const chartMotion = useChartMotion();

  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'hitRate7d', dir: -1 });

  const overall = useMemo(
    () => (data?.overall ?? []).slice().sort((a, b) => a.horizonDays - b.horizonDays),
    [data],
  );

  const chartData = useMemo(
    () =>
      overall.map((h) => ({
        horizon: `${h.horizonDays}d`,
        hitRate: h.directionHitRatePct,
        withinBand: h.withinBandPct,
      })),
    [overall],
  );

  const tiles = useMemo(() => {
    if (!overall.length) return null;
    const totalSamples = overall.reduce((s, h) => s + h.samples, 0);
    const best = overall.reduce((a, b) => (b.directionHitRatePct > a.directionHitRatePct ? b : a));
    const avgErr = overall.reduce((s, h) => s + h.avgAbsErrorPct, 0) / overall.length;
    const withinBand = overall.reduce((s, h) => s + h.withinBandPct, 0) / overall.length;
    return { totalSamples, best, avgErr, withinBand };
  }, [overall]);

  const sortedStocks = useMemo(() => {
    const rows = (data?.perStock ?? []).slice();
    const { key, dir } = sort;
    rows.sort((a, b) => {
      if (key === 'ticker') return dir * a.ticker.localeCompare(b.ticker);
      const av = a[key];
      const bv = b[key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return dir * (av - bv);
    });
    return rows;
  }, [data, sort]);

  function toggleSort(key: SortKey) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === 'ticker' ? 1 : -1 }));
  }

  function renderSortHeader(label: string, k: SortKey, className?: string) {
    const info = COLUMN_INFO[k];
    return (
      <th className={className} aria-sort={sort.key === k ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}>
        <span className="inline-flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => toggleSort(k)}
            className={clsx(
              'inline-flex items-center gap-1 tracking-[inherit] uppercase transition-colors hover:text-slate-200',
              sort.key === k ? 'text-slate-200' : 'text-inherit',
            )}
          >
            {label}
            <ArrowUpDown className="h-3 w-3" aria-hidden />
          </button>
          {info && <InfoTip label={`What does ${label} mean?`} text={info} align={className === 'num' ? 'right' : 'left'} />}
        </span>
      </th>
    );
  }

  if (isPending) {
    return (
      <div className="space-y-5">
        <CardSkeleton lines={2} />
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-5">
          <div className="grid grid-cols-2 gap-4 lg:col-span-2">
            <StatTileSkeleton />
            <StatTileSkeleton />
            <StatTileSkeleton />
            <StatTileSkeleton />
          </div>
          <GlassCard className="p-5 lg:col-span-3">
            <ChartSkeleton height={260} />
          </GlassCard>
        </div>
        <CardSkeleton lines={6} />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <ErrorState
        message={error instanceof Error ? error.message : 'Failed to load accuracy data'}
        onRetry={() => refetch()}
      />
    );
  }

  return (
    <div className="space-y-5">
      <ViewHero
        className="view-hero-subsection"
        eyebrow="measured, not promised"
        title="Accuracy"
        subtitle="Everything here is measured, not promised — walk-forward backtests replay past days and compare each prediction with what actually happened."
        right={
          tiles ? (
            <>
              <Chip tone="cyan" glow>
                {plain(tiles.totalSamples, 0)} samples
              </Chip>
              <Chip tone="zinc">updated {fmtDateTime(data.updatedAt)}</Chip>
            </>
          ) : undefined
        }
      />

      {/* Two columns: aggregate stats left · per-horizon breakdown right */}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-5">
        <div className="space-y-4 lg:col-span-2">
          <Card className="p-5">
            <p className="text-sm leading-relaxed text-slate-400">
              No model can be 100% accurate — markets are moved by news, flows and sentiment that no indicator can
              foresee. A direction hit rate consistently above the 50% coin-flip line is the honest signal of edge, and
              even then past accuracy does not guarantee future results.
            </p>
          </Card>

          {tiles && (
            <Stagger className="grid grid-cols-2 gap-4">
              <StaggerItem>
                <StatTile
                  tilt
                  label="Backtest samples"
                  value={plain(tiles.totalSamples, 0)}
                  sub="across all horizons"
                  info={<InfoTip label="What does backtest samples mean?" text={TILE_INFO.samples} />}
                />
              </StaggerItem>
              <StaggerItem>
                <StatTile
                  tilt
                  label="Best horizon"
                  value={`${tiles.best.horizonDays}d`}
                  sub={`${pct(tiles.best.directionHitRatePct, 1)} direction hit rate`}
                  info={<InfoTip label="What does best horizon mean?" text={TILE_INFO.bestHorizon} align="right" />}
                />
              </StaggerItem>
              <StaggerItem>
                <StatTile
                  tilt
                  label="Avg absolute error"
                  value={`±${plain(tiles.avgErr, 1)}%`}
                  sub="predicted vs actual return"
                  info={<InfoTip label="What does avg absolute error mean?" text={TILE_INFO.avgError} />}
                />
              </StaggerItem>
              <StaggerItem>
                <StatTile
                  tilt
                  label="Within 80% band"
                  value={pct(tiles.withinBand, 1)}
                  sub="actuals inside the stated range"
                  info={<InfoTip label="What does within 80% band mean?" text={TILE_INFO.withinBand} align="right" />}
                />
              </StaggerItem>
            </Stagger>
          )}
        </div>

        <Card className="p-5 lg:col-span-3">
          {chartData.length === 0 ? (
            <>
              <SectionTitle>Per-horizon breakdown</SectionTitle>
              <p className="mt-4 text-sm text-slate-400">No backtest results yet — run the seed &amp; backtest script.</p>
            </>
          ) : (
            <>
              <ChartFrame
                height={260}
                title={<SectionTitle>Per-horizon breakdown</SectionTitle>}
                legend={
                  <div className="flex items-center gap-4 text-xs text-slate-400">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="h-2.5 w-3.5 rounded-sm" style={{ backgroundColor: CHART.sky }} aria-hidden />
                      Direction hit rate
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="h-2.5 w-3.5 rounded-sm" style={{ backgroundColor: CHART.violet }} aria-hidden />
                      Within 80% band
                    </span>
                  </div>
                }
                ariaLabel="Direction hit rate and 80%-band coverage per prediction horizon, against the 50% coin-flip line"
              >
                <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 4 }} barCategoryGap="28%" barGap={2}>
                  <CartesianGrid stroke={CHART.grid} strokeWidth={1} vertical={false} />
                  <XAxis
                    dataKey="horizon"
                    tick={{ fill: CHART.tick, fontSize: 12 }}
                    axisLine={{ stroke: CHART.axisLine }}
                    tickLine={false}
                    tickMargin={8}
                  />
                  <YAxis
                    domain={[0, 100]}
                    ticks={[0, 25, 50, 75, 100]}
                    tick={{ fill: CHART.tick, fontSize: 11 }}
                    tickFormatter={(v: number) => `${v}%`}
                    axisLine={false}
                    tickLine={false}
                    width={48}
                  />
                  <Tooltip content={<AccuracyTip />} cursor={{ fill: 'rgba(148,163,184,0.08)' }} />
                  <Bar
                    dataKey="hitRate"
                    name="Direction hit rate"
                    fill={CHART.sky}
                    radius={[4, 4, 0, 0]}
                    maxBarSize={24}
                    isAnimationActive={chartMotion.isAnimationActive}
                    animationDuration={chartMotion.animationDuration}
                  />
                  <Bar
                    dataKey="withinBand"
                    name="Within 80% band"
                    fill={CHART.violet}
                    radius={[4, 4, 0, 0]}
                    maxBarSize={24}
                    isAnimationActive={chartMotion.isAnimationActive}
                    animationDuration={chartMotion.animationDuration}
                  />
                  {/* rendered after the bars so the line + label paint on top */}
                  <ReferenceLine
                    y={50}
                    stroke={CHART.reference}
                    strokeWidth={1.5}
                    strokeDasharray="5 4"
                    label={{
                      value: 'Coin flip · 50%',
                      position: 'insideTopLeft',
                      fill: '#e2e8f0',
                      fontSize: 11,
                      fontWeight: 600,
                    }}
                  />
                </BarChart>
              </ChartFrame>

              <div className="thin-scroll mt-4 overflow-x-auto rounded-xl border border-white/6">
                <table className="table-premium min-w-[460px]">
                  <thead>
                    <tr>
                      <th>Horizon</th>
                      <th className="num">Hit rate</th>
                      <th className="num">Within band</th>
                      <th className="num">Avg |error|</th>
                      <th className="num">Samples</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overall.map((h) => (
                      <tr key={h.horizonDays}>
                        <td className="font-medium text-slate-100">{h.horizonDays}d</td>
                        <td className={clsx('num font-medium', hitClass(h.directionHitRatePct))}>
                          {pct(h.directionHitRatePct, 1)}
                        </td>
                        <td className="num text-slate-200">{pct(h.withinBandPct, 1)}</td>
                        <td className="num text-slate-300">±{plain(h.avgAbsErrorPct, 1)}%</td>
                        <td className="num text-slate-400">{plain(h.samples, 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
                50% = coin flip; honest 80% bands should land near 80%. Values within a point or two of 50% mean no
                measurable direction edge.
              </p>
            </>
          )}
        </Card>
      </div>

      {/* V6 — Brier calibration: gauges vs the 0.25 coin-flip line, reliability diagram,
          live-vs-backtest table (self-fetching; hides itself when /api/calibration 404s) */}
      <CalibrationPanel />

      <Card className="p-5">
        <SectionTitle>Per-stock accuracy</SectionTitle>
        {data.perStockCaveat && (
          <div
            id="per-stock-caveat"
            className="mt-3 flex items-start gap-2.5 rounded-xl border border-amber-400/25 bg-amber-400/8 px-4 py-3"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden />
            <p className="text-xs leading-relaxed text-amber-200">
              {data.perStockCaveat}
              <span className="mt-1 block text-amber-300/80">
                * Extreme rates (≥95% or ≤5%) at long horizons are dimmed below for exactly this reason.
              </span>
            </p>
          </div>
        )}
        {sortedStocks.length === 0 ? (
          <p className="mt-3 text-sm text-slate-400">No per-stock backtests stored yet.</p>
        ) : (
          <div className="thin-scroll mt-3 max-h-[520px] overflow-x-auto overflow-y-auto rounded-xl border border-white/6">
            <table className="table-premium min-w-[640px]">
              <thead>
                <tr>
                  {renderSortHeader('Stock', 'ticker')}
                  {renderSortHeader('1d hit rate', 'hitRate1d', 'num')}
                  {renderSortHeader('7d hit rate', 'hitRate7d', 'num')}
                  {renderSortHeader('30d hit rate', 'hitRate30d', 'num')}
                  {renderSortHeader('Samples', 'samples', 'num')}
                </tr>
              </thead>
              <tbody>
                {sortedStocks.map((s: AccuracyPerStock) => (
                  <tr key={s.ticker}>
                    <td>
                      <p className="font-medium text-slate-100">{s.name}</p>
                      <p className="text-xs text-slate-500">{s.ticker}</p>
                    </td>
                    <td className={clsx('num font-medium', hitClass(s.hitRate1d))}>
                      {s.hitRate1d != null ? pct(s.hitRate1d, 0) : '—'}
                    </td>
                    <td className={clsx('num font-medium', hitClass(s.hitRate7d))}>
                      {s.hitRate7d != null ? pct(s.hitRate7d, 0) : '—'}
                    </td>
                    <td
                      className={clsx(
                        'num font-medium',
                        isExtreme(s.hitRate30d) ? 'text-slate-500' : hitClass(s.hitRate30d),
                      )}
                    >
                      {s.hitRate30d != null ? (
                        <>
                          {pct(s.hitRate30d, 0)}
                          {isExtreme(s.hitRate30d) && (
                            <a
                              href="#per-stock-caveat"
                              aria-label="Extreme rate — likely one trend counted many times; see the overlapping-windows caveat above"
                              title={
                                data.perStockCaveat ??
                                'Overlapping backtest windows — an extreme rate here is usually one trend counted many times, not skill.'
                              }
                              className="ml-0.5 align-super text-[10px] text-amber-400/80 hover:text-amber-300"
                            >
                              *
                            </a>
                          )}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="num text-slate-300">{plain(s.samples, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="p-5">
        <SectionTitle>Methodology</SectionTitle>
        <p className="mt-2 text-sm leading-relaxed whitespace-pre-line text-slate-400">{data.methodology}</p>
      </Card>

      {/* V7 — per-model aggregate Brier table + model drift (shares the calibration query;
          hides itself when the backend hasn't shipped calibration.models yet) */}
    </div>
  );
}
