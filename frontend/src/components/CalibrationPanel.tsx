'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CartesianGrid, ReferenceLine, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from 'recharts';
import { ApiError, getCalibration } from '@/lib/api';
import type { CalibrationHorizon } from '@/lib/types';
import { CHART } from '@/lib/palette';
import { fmtDateTime, plain, signedPct } from '@/lib/format';
import {
  Card,
  CardSkeleton,
  ChartFrame,
  ChartTip,
  Chip,
  ErrorState,
  GaugeH,
  InfoTip,
  SectionTitle,
  Tabs,
  chartCursor,
  useChartMotion,
  type Tone,
} from '@/components/ui';
import { Stagger, StaggerItem } from '@/components/motion';

/** One-sentence Brier explainer (spec C4 verbatim). */
const BRIER_TIP =
  'Average squared gap between stated probability and what happened — 0 perfect, 0.25 = coin-flip honesty line.';

const RELIABILITY_TIP =
  'Each dot is a probability bucket: how often the stock actually went up (y) when we said P(up) was x. Dots on the dashed diagonal = perfectly calibrated.';

/** Horizons offered in the reliability-diagram toggle (spec C4.1). */
const DIAGRAM_HORIZONS = [1, 7, 30];

function skillTone(skillPct: number): Tone {
  if (skillPct > 1) return 'buy';
  if (skillPct < -1) return 'sell';
  return 'zinc';
}

function fmtBrier(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? '—' : v.toFixed(4);
}

interface BucketPoint {
  x: number; // meanPredicted
  y: number; // observedUpFreq
  n: number;
  pLow: number;
  pHigh: number;
}

/** Hover = full bucket details: range, stated vs observed, gap and sample count. */
function ReliabilityTip({ active, payload }: { active?: boolean; payload?: Array<{ payload?: BucketPoint }> }) {
  if (!active || !payload?.length) return null;
  const p = payload[0]?.payload;
  if (!p) return null;
  const gapPp = (p.y - p.x) * 100;
  return (
    <ChartTip>
      <p className="font-medium text-slate-300">
        Bucket {p.pLow.toFixed(3)}–{p.pHigh.toFixed(3)}
      </p>
      <div className="mt-1 space-y-0.5 tabular-nums">
        <p className="text-slate-400">
          stated P(up) <span className="font-semibold text-slate-100">{p.x.toFixed(3)}</span>
        </p>
        <p className="text-slate-400">
          actually went up <span className="font-semibold text-slate-100">{(p.y * 100).toFixed(1)}%</span> of the time
        </p>
        <p className="text-slate-400">
          gap (observed − stated){' '}
          <span className="font-semibold text-slate-100">
            {gapPp >= 0 ? '+' : '−'}
            {plain(Math.abs(gapPp), 1)} pp
          </span>
        </p>
        <p className="text-slate-500">{plain(p.n, 0)} samples</p>
      </div>
    </ChartTip>
  );
}

/**
 * V6 — "Calibration — how honest are our probabilities?" (SPEC_CALIBRATION.md
 * C4.1), redesigned on the component library: per-horizon Brier scores as
 * horizontal GaugeH gauges against the 0.25 coin-flip line, the interactive
 * reliability diagram (hover = bucket details) with a 1d/7d/30d toggle, the
 * live-vs-backtest Brier table and the backend's verbatim interpretation +
 * methodology. Hidden entirely when the endpoint 404s (old backend).
 */
export function CalibrationPanel() {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ['calibration'],
    queryFn: getCalibration,
    staleTime: 5 * 60_000,
    // An old backend 404s forever — don't burn retries on it.
    retry: (failureCount, err) => !(err instanceof ApiError && err.status === 404) && failureCount < 2,
  });

  const chartMotion = useChartMotion();

  const backtest = useMemo(
    () => (data?.backtest ?? []).slice().sort((a, b) => a.horizonDays - b.horizonDays),
    [data],
  );

  // Toggle over 1d/7d/30d (only those actually present); fall back to whatever exists.
  const diagramChoices = useMemo(() => {
    const preferred = backtest.filter((h) => DIAGRAM_HORIZONS.includes(h.horizonDays));
    return preferred.length > 0 ? preferred : backtest;
  }, [backtest]);

  const [selectedHorizon, setSelectedHorizon] = useState<number | null>(null);
  const selected: CalibrationHorizon | null =
    diagramChoices.find((h) => h.horizonDays === selectedHorizon) ??
    diagramChoices.find((h) => h.horizonDays === 7) ??
    diagramChoices[0] ??
    null;

  const points = useMemo<BucketPoint[]>(
    () =>
      (selected?.buckets ?? [])
        .filter((b) => b.n > 0)
        .map((b) => ({ x: b.meanPredicted, y: b.observedUpFreq, n: b.n, pLow: b.pLow, pHigh: b.pHigh })),
    [selected],
  );

  // Live vs backtest rows, unioned by horizon so neither side is silently dropped.
  const compareRows = useMemo(() => {
    const live = data?.live ?? [];
    const days = Array.from(new Set([...backtest.map((h) => h.horizonDays), ...live.map((l) => l.horizonDays)])).sort(
      (a, b) => a - b,
    );
    return days.map((d) => ({
      horizonDays: d,
      bt: backtest.find((h) => h.horizonDays === d) ?? null,
      lv: live.find((l) => l.horizonDays === d) ?? null,
    }));
  }, [data, backtest]);

  // Old backend without /api/calibration → hide the whole section (spec C4).
  if (isError && error instanceof ApiError && error.status === 404) return null;

  if (isPending) {
    return (
      <div className="space-y-4">
        <CardSkeleton lines={2} />
        <CardSkeleton lines={5} />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <ErrorState
        compact
        message={error instanceof Error ? error.message : 'Failed to load calibration data'}
        onRetry={() => refetch()}
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* (a) Intro + per-horizon Brier gauges vs the 0.25 coin-flip line */}
      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SectionTitle>
            <span className="inline-flex flex-wrap items-center gap-1">
              <span>Calibration — how honest are our probabilities?</span>
              <InfoTip label="What is a Brier score?" text={BRIER_TIP} />
            </span>
          </SectionTitle>
          <Chip tone="zinc">updated {fmtDateTime(data.updatedAt)}</Chip>
        </div>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-400">
          A prediction can be honest without being clairvoyant: saying &ldquo;52% up&rdquo; is calibrated if such calls
          come true about 52% of the time. The Brier score measures exactly that — always answering 50% scores 0.25,
          so anything below 0.25 is real (if small) probability skill.
        </p>

        {backtest.length > 0 && (
          <Stagger className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {backtest.map((h) => (
              <StaggerItem key={h.horizonDays} className="h-full">
                <div className="glass-inset h-full p-4">
                  <GaugeH
                    label={
                      <span className="inline-flex items-center gap-1">
                        {h.horizonDays}d Brier
                        <InfoTip label={`What does the ${h.horizonDays}-day Brier score mean?`} text={BRIER_TIP} />
                      </span>
                    }
                    value={h.brierScore}
                    min={0.2}
                    max={0.3}
                    benchmark={0.25}
                    benchmarkLabel="coin flip 0.25"
                    lowerIsBetter
                    format={(v) => plain(v, 4)}
                  />
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                    <Chip tone={skillTone(h.skillPct)} title="Skill vs always answering 50% — (0.25 − Brier) / 0.25">
                      {signedPct(h.skillPct, 1)} skill
                    </Chip>
                    <span className="text-[11px] text-slate-500 tabular-nums">{plain(h.samples, 0)} samples</span>
                  </div>
                </div>
              </StaggerItem>
            ))}
          </Stagger>
        )}
        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
          Lower is better: fills left of the white tick beat the coin flip, fills right of it don&apos;t. Scale shown
          0.2–0.3 to make the gap around 0.25 readable.
        </p>
      </Card>

      {/* (b) Reliability diagram — hover a dot for the bucket's details */}
      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SectionTitle>
            <span className="inline-flex items-center gap-1">
              <span>Reliability diagram</span>
              <InfoTip label="How do I read the reliability diagram?" text={RELIABILITY_TIP} />
            </span>
          </SectionTitle>
          {diagramChoices.length > 1 && selected && (
            <Tabs
              variant="pill"
              ariaLabel="Reliability diagram horizon"
              items={diagramChoices.map((h) => ({ value: String(h.horizonDays), label: `${h.horizonDays}d` }))}
              value={String(selected.horizonDays)}
              onChange={(v) => setSelectedHorizon(Number(v))}
            />
          )}
        </div>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">
          When we said P(up) was x, how often did the stock actually go up? Dot size ∝ samples in the bucket; the
          dashed diagonal is perfect calibration. Hover a dot for the bucket&apos;s details.
        </p>

        {!selected || points.length === 0 ? (
          <p className="mt-4 text-sm text-slate-400">
            No probability buckets yet — refresh the backtests to populate calibration data.
          </p>
        ) : (
          <ChartFrame
            className="mt-4"
            height={300}
            ariaLabel={`Reliability diagram, ${selected.horizonDays}-day horizon: stated probability of an up move versus the observed up frequency per bucket`}
          >
            <ScatterChart margin={{ top: 8, right: 16, bottom: 8, left: 4 }}>
              <CartesianGrid stroke={CHART.grid} strokeWidth={1} />
              <XAxis
                type="number"
                dataKey="x"
                name="stated P(up)"
                domain={[0, 1]}
                ticks={[0, 0.25, 0.5, 0.75, 1]}
                tickFormatter={(v: number) => v.toFixed(2)}
                tick={{ fill: CHART.tick, fontSize: 11 }}
                axisLine={{ stroke: CHART.axisLine }}
                tickLine={false}
                tickMargin={8}
                label={{ value: 'stated P(up)', position: 'insideBottom', offset: -4, fill: CHART.tick, fontSize: 11 }}
              />
              <YAxis
                type="number"
                dataKey="y"
                name="observed up frequency"
                domain={[0, 1]}
                ticks={[0, 0.25, 0.5, 0.75, 1]}
                tickFormatter={(v: number) => v.toFixed(2)}
                tick={{ fill: CHART.tick, fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={44}
                label={{
                  value: 'observed up frequency',
                  angle: -90,
                  position: 'insideLeft',
                  offset: 12,
                  fill: CHART.tick,
                  fontSize: 11,
                  style: { textAnchor: 'middle' },
                }}
              />
              {/* Dot area ∝ bucket sample count; floor keeps the smallest bucket hoverable. */}
              <ZAxis type="number" dataKey="n" range={[90, 480]} name="samples" />
              <Tooltip content={<ReliabilityTip />} cursor={chartCursor} />
              {/* Perfect calibration: y = x */}
              <ReferenceLine
                segment={[
                  { x: 0, y: 0 },
                  { x: 1, y: 1 },
                ]}
                stroke={CHART.reference}
                strokeWidth={1.5}
                strokeDasharray="5 4"
                ifOverflow="hidden"
              />
              <Scatter
                data={points}
                name={`${selected.horizonDays}d buckets`}
                fill={CHART.sky}
                fillOpacity={0.85}
                stroke={CHART.surface}
                strokeWidth={1.5}
                isAnimationActive={chartMotion.isAnimationActive}
                animationDuration={chartMotion.animationDuration}
              />
            </ScatterChart>
          </ChartFrame>
        )}
        {selected && (
          <p className="mt-2 text-[11px] text-slate-500">
            {selected.horizonDays}-day horizon · {plain(selected.samples, 0)} backtest samples · dashed line = stated
            probability matches reality
          </p>
        )}
      </Card>

      {/* (c) Live vs backtest Brier */}
      <Card className="p-5">
        <SectionTitle>
          <span className="inline-flex items-center gap-1">
            <span>Live vs backtest Brier</span>
            <InfoTip
              label="What is the difference between live and backtest Brier?"
              text="Backtest = replayed history (can look better than reality). Live = predictions logged before the outcome was known — the honest number once enough verify."
            />
          </span>
        </SectionTitle>
        {compareRows.length === 0 ? (
          <p className="mt-3 text-sm text-slate-400">No calibration rows yet.</p>
        ) : (
          <div className="thin-scroll mt-3 overflow-x-auto rounded-xl border border-white/6">
            <table className="table-premium min-w-[480px]">
              <thead>
                <tr>
                  <th>Horizon</th>
                  <th className="num">Backtest Brier</th>
                  <th className="num">Backtest samples</th>
                  <th className="num">Live Brier</th>
                  <th className="num">Live samples</th>
                </tr>
              </thead>
              <tbody>
                {compareRows.map((r) => (
                  <tr key={r.horizonDays}>
                    <td className="font-medium text-slate-100">{r.horizonDays}d</td>
                    <td className="num text-slate-200 tabular-nums">{fmtBrier(r.bt?.brierScore)}</td>
                    <td className="num text-slate-400 tabular-nums">{r.bt ? plain(r.bt.samples, 0) : '—'}</td>
                    <td className="num tabular-nums">
                      {r.lv == null ? (
                        <span className="text-slate-600">—</span>
                      ) : r.lv.brierScore == null ? (
                        <span className="text-slate-500" title="Fewer than 10 verified live predictions at this horizon">
                          — (&lt;10 verified)
                        </span>
                      ) : (
                        <span className="text-slate-200">{fmtBrier(r.lv.brierScore)}</span>
                      )}
                    </td>
                    <td className="num text-slate-400 tabular-nums">{r.lv ? plain(r.lv.samples, 0) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
          0 = perfect, 0.25 = coin-flip honesty line, lower is better. Live scores appear only after ≥10 predictions
          verify against real closes.
        </p>
      </Card>

      {/* (d) Interpretation + methodology — backend text verbatim */}
      <Card className="p-5">
        <SectionTitle>What this means</SectionTitle>
        <div className="glass-inset mt-3 p-4">
          <p className="text-sm leading-relaxed text-slate-200">{data.interpretation}</p>
        </div>
        <p className="mt-3 text-xs leading-relaxed whitespace-pre-line text-slate-500">{data.methodology}</p>
      </Card>
    </div>
  );
}
