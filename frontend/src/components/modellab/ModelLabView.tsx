'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Beaker, CheckCircle2, CircleHelp, Microscope, Sparkles, XCircle } from 'lucide-react';
import { CapitalMetrics, getLearningReport, getModelLab, getUniverseLearning, LearningReport } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { Button, CardSkeleton, Chip, Collapsible, DataTable, EmptyState, ErrorState, StatTile, Tabs, ViewHero } from '@/components/ui';

/*
 * MODEL LAB — "is the system actually learning?" Read-only over the experiment
 * registry, governance ledger, calibrators, setup evidence, shadow trackers,
 * lessons and the Money Desk's own record. The most important job of this
 * screen is to say, plainly, when there is NOT enough evidence.
 */

type LabTab = 'performance' | 'experiments' | 'failures' | 'learning' | 'challengers';
const TABS: Array<{ value: LabTab; label: string }> = [
  { value: 'performance', label: 'Performance' },
  { value: 'experiments', label: 'Experiments' },
  { value: 'failures', label: 'Failures' },
  { value: 'learning', label: 'Learning' },
  { value: 'challengers', label: 'Challengers' },
];

function GateIcon({ passed }: { passed: boolean | null }) {
  if (passed === true) return <CheckCircle2 className="h-4 w-4 text-buy" aria-label="passes" />;
  if (passed === false) return <XCircle className="h-4 w-4 text-sell" aria-label="fails" />;
  return <CircleHelp className="h-4 w-4 text-slate-400" aria-label="cannot be evaluated yet" />;
}

function MetricsRow({ label, m }: { label: string; m: CapitalMetrics }) {
  return (
    <tr>
      <td className="px-2 py-1.5 font-medium text-slate-200">{label}</td>
      <td className="px-2 py-1.5 tabular-nums text-slate-400">{m.observed}/{m.totalRecommendations}</td>
      <td className="px-2 py-1.5 tabular-nums">{m.withheld ? <span className="text-slate-500">withheld</span> : `${m.winRate.pct}% (LB ${m.winRate.wilsonLb95Pct}%)`}</td>
      <td className={clsx('px-2 py-1.5 tabular-nums', !m.withheld && m.expectancyR != null && (m.expectancyR > 0 ? 'text-buy' : 'text-sell'))}>{m.withheld || m.expectancyR == null ? '—' : `${m.expectancyR}R`}</td>
      <td className={clsx('px-2 py-1.5 tabular-nums', !m.withheld && m.benchmarkExcessPct.mean != null && (m.benchmarkExcessPct.mean > 0 ? 'text-buy' : 'text-sell'))}>{m.withheld || m.benchmarkExcessPct.mean == null ? '—' : `${m.benchmarkExcessPct.mean}%${m.benchmarkExcessPct.ci95 ? ` [${m.benchmarkExcessPct.ci95[0]}, ${m.benchmarkExcessPct.ci95[1]}]` : ''}`}</td>
      <td className="px-2 py-1.5 tabular-nums text-slate-400">{m.withheld || m.profitFactor == null ? '—' : m.profitFactor === Infinity ? '∞' : m.profitFactor}</td>
      <td className="px-2 py-1.5 tabular-nums text-slate-400">{m.withheld ? '—' : `${m.mfeR ?? '—'} / ${m.maeR ?? '—'}`}</td>
    </tr>
  );
}

function SegmentTable({ title, rows }: { title: string; rows: Array<{ key: string; metrics: CapitalMetrics }> }) {
  if (!rows.length) return null;
  return (
    <Collapsible id={`model-lab-seg-${title}`} title={`By ${title}`} subtitle={`${rows.filter((r) => !r.metrics.withheld).length} of ${rows.length} segments above the 10-outcome floor`} defaultOpen={false}>
      <div className="overflow-x-auto thin-scroll">
        <table className="w-full min-w-[720px] text-left text-xs">
          <thead><tr className="text-[10px] uppercase tracking-wide text-slate-500"><th className="px-2 py-1">Segment</th><th className="px-2 py-1">Observed / logged</th><th className="px-2 py-1">Win rate</th><th className="px-2 py-1">Expectancy</th><th className="px-2 py-1">Excess vs NIFTY</th><th className="px-2 py-1">Profit factor</th><th className="px-2 py-1">MFE / MAE</th></tr></thead>
          <tbody>{rows.map((r) => <MetricsRow key={r.key} label={r.key} m={r.metrics} />)}</tbody>
        </table>
      </div>
    </Collapsible>
  );
}

function LearningPanel({ initial }: { initial: LearningReport | null }) {
  const [report, setReport] = useState<LearningReport | null>(initial);
  const ai = useMutation({ mutationFn: () => getLearningReport(true), onSuccess: setReport });
  const r = report;
  if (!r) return <CardSkeleton lines={4} />;
  return (
    <div className="space-y-4">
      <div className="desk-section-head">
        <div><h3 className="lab-h3">What is the system learning?</h3><p>{r.evidenceStatus}</p></div>
        <Button variant="secondary" size="sm" loading={ai.isPending} onClick={() => ai.mutate()} title="Cost-governed; every sentence must cite a measured fact id"><Sparkles className="h-3.5 w-3.5" aria-hidden /> Ask the Learning Analyst (AI)</Button>
      </div>
      {ai.isError && <ErrorState compact message="The AI narrative is unavailable (budget or provider). The deterministic facts below stand on their own." />}
      <ol className="lab-narrative" aria-label="Learning narrative">
        {r.narrative.map((s, i) => (
          <li key={i}><span>{s.text}</span><small>cites {s.cites.join(', ')}</small></li>
        ))}
      </ol>
      <p className="desk-caveat">Narrative source: {r.narrativeSource}. {r.caveat}</p>
      <Collapsible id="model-lab-facts" title={`Measured facts · ${r.facts.length}`} subtitle="Each fact names its metric, sample size and source record." defaultOpen>
        <ul className="lab-facts">
          {r.facts.map((f) => (
            <li key={f.id} className={clsx('lab-fact', `lab-fact-${f.kind.toLowerCase()}`)}>
              <Chip tone={f.kind === 'FINDING' ? 'buy' : f.kind === 'INSUFFICIENT' ? 'amber' : 'zinc'}>{f.kind}</Chip>
              <div><p>{f.statement}</p><small>{f.metric} = {f.value ?? '—'} · n={f.n} · {f.source} · id {f.id}</small></div>
            </li>
          ))}
        </ul>
      </Collapsible>
    </div>
  );
}

export function ModelLabView() {
  const [tab, setTab] = useState<LabTab>('performance');
  const lab = useQuery({ queryKey: ['model-lab'], queryFn: getModelLab, staleTime: 5 * 60_000 });
  const learning = useQuery({ queryKey: ['model-lab-learning'], queryFn: () => getLearningReport(false), staleTime: 5 * 60_000 });
  const universe = useQuery({ queryKey: ['universe-learning'], queryFn: getUniverseLearning, staleTime: 5 * 60_000 });
  const d = lab.data;
  const rec = d?.capitalTrackRecord;
  const failures = useMemo(() => (d ? d.lessons.filter((l) => l.category === 'MISS' || l.category === 'CALIBRATION' || l.category === 'REGIME' || l.category === 'COST') : []), [d]);

  return (
    <div className="record-page lab-page space-y-5">
      <ViewHero
        eyebrow="Model Lab"
        title={d ? d.evidenceVerdict : 'Reading the experiment registry…'}
        subtitle="Current model → challenger → backtest → purged walk-forward → out-of-sample → shadow trading → promotion review. No automatic promotion; the LLM cannot promote, change thresholds, or write labels."
        visual={false}
        right={d && <div className="desk-hero-meta"><Chip tone="violet"><Microscope className="h-3 w-3" aria-hidden /> {d.experiments.length} experiments</Chip><Chip tone="zinc">{d.currentModels.length} governed models</Chip></div>}
      />
      {lab.isLoading && <CardSkeleton lines={6} />}
      {lab.isError && <ErrorState message={`Model Lab unavailable: ${lab.error instanceof Error ? lab.error.message : 'unknown error'}`} onRetry={() => lab.refetch()} />}
      {d && rec && (
        <>
          <section className="glass desk-section">
            <ol className="lab-pipeline" aria-label="Model pipeline">
              {d.pipeline.map((p, i) => <li key={p.stage}><span className="lab-step">{String(i + 1).padStart(2, '0')}</span><div><strong>{p.stage}</strong><em>{p.status}</em><small>{p.note}</small></div></li>)}
            </ol>
          </section>
          <Tabs items={TABS} value={tab} onChange={setTab} ariaLabel="Model Lab sections" />

          {tab === 'performance' && (
            <section className="glass desk-section space-y-4">
              <div className="desk-section-head"><div><h2>Current evidence</h2><p>{rec.headline}</p></div></div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <StatTile label="Desk recommendations" value={rec.overall.totalRecommendations} sub={`${rec.overall.observed} observed · ${rec.overall.notFilled} not filled · ${rec.overall.ambiguous} ambiguous`} />
                <StatTile label="Win rate" value={rec.overall.winRate.pct != null ? `${rec.overall.winRate.pct}%` : 'withheld'} sub={rec.overall.withheldReason ?? `Wilson LB ${rec.overall.winRate.wilsonLb95Pct}%`} />
                <StatTile label="Excess vs NIFTY" value={rec.overall.benchmarkExcessPct.mean != null ? `${rec.overall.benchmarkExcessPct.mean}%` : 'withheld'} sub={rec.overall.benchmarkExcessPct.ci95 ? `95% CI ${rec.overall.benchmarkExcessPct.ci95[0]}…${rec.overall.benchmarkExcessPct.ci95[1]}` : 'needs ≥10 observed'} />
                <StatTile label="Precision@1 / @3 / @5" value={rec.precision.map((p) => (p.precision == null ? '—' : p.precision.toFixed(2))).join(' / ') || '—'} sub={rec.precision[0]?.withheldReason ?? 'share of top-k with positive excess, per plan-day'} />
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <StatTile label="Expectancy" value={rec.overall.expectancyR != null ? `${rec.overall.expectancyR}R` : '—'} sub="mean realized net R" />
                <StatTile label="Profit factor" value={rec.overall.profitFactor == null ? '—' : rec.overall.profitFactor === Infinity ? '∞' : rec.overall.profitFactor} sub="gross wins ÷ gross losses" />
                <StatTile label="Max drawdown" value={rec.overall.maxDrawdownPct != null ? `${rec.overall.maxDrawdownPct}%` : '—'} sub="cumulative return path" />
                <StatTile label="MFE / MAE" value={rec.overall.mfeR != null ? `${rec.overall.mfeR}R / ${rec.overall.maeR}R` : '—'} sub="mean favourable / adverse excursion" />
              </div>
              <SegmentTable title="setup type" rows={rec.bySetupType} />
              <SegmentTable title="holding horizon" rows={rec.byHorizon} />
              <SegmentTable title="market regime" rows={rec.byRegime} />
              <SegmentTable title="risk profile" rows={rec.byRiskProfile} />
              <SegmentTable title="sector" rows={rec.bySector} />
              <SegmentTable title="liquidity bucket" rows={rec.byLiquidityBucket} />
              <SegmentTable title="model version" rows={rec.byModelVersion} />
              <h3 className="lab-h3">Current model health</h3>
              <ul className="lab-list">
                {d.shadowModels.length === 0 && <li>No shadow-tracker rows yet.</li>}
                {d.shadowModels.map((s) => <li key={s.modelName}><Chip tone={s.state === 'HEALTHY' ? 'buy' : s.state === 'SUSPENDED' ? 'sell' : 'amber'}>{s.state}</Chip> <strong>{s.modelName}</strong> {s.verdict ? `— ${s.verdict}` : ''}</li>)}
                {d.calibrators.slice(0, 6).map((c) => <li key={`${c.modelName}-${c.horizonDays}`}><Chip tone={c.promoted ? 'buy' : 'zinc'}>{c.promoted ? 'calibrator promoted' : 'calibrator not promoted'}</Chip> <strong>{c.modelName} · {c.horizonDays}d</strong> {c.brierBefore != null ? `Brier ${c.brierBefore} → ${c.brierAfter ?? '—'}` : ''} {c.effectiveSamples != null ? `· n=${c.effectiveSamples}` : ''}</li>)}
              </ul>
              <p className="desk-caveat">{rec.caveat}</p>
            </section>
          )}

          {tab === 'experiments' && (
            <section className="glass desk-section space-y-4">
              <div className="desk-section-head"><div><h2>Experiment registry</h2><p>Immutable (append-only trigger). Every promotion decision must reference a run id here.</p></div></div>
              <DataTable
                ariaLabel="Experiments"
                rowKey={(r) => r.id}
                rows={d.experiments}
                columns={[
                  { id: 'name', header: 'Run', cell: (r) => <span><strong>{r.name}</strong><br /><small className="text-slate-500">{r.id.slice(0, 8)}</small></span> },
                  { id: 'kind', header: 'Kind', cell: (r) => <Chip tone={r.kind === 'challenger' ? 'violet' : 'zinc'}>{r.kind}</Chip> },
                  { id: 'model', header: 'Model', cell: (r) => r.modelVersion ?? '—' },
                  { id: 'status', header: 'Status', cell: (r) => <Chip tone={r.status === 'completed' ? 'buy' : 'sell'}>{r.status}</Chip> },
                  { id: 'started', header: 'Started', cell: (r) => (r.startedAt ? fmtDateTime(r.startedAt) : '—'), sortValue: (r) => r.startedAt ?? '' },
                  { id: 'notes', header: 'Notes', cell: (r) => <span className="text-slate-400">{r.notes ?? '—'}</span> },
                ]}
                renderExpanded={(r) => <pre className="lab-json">{JSON.stringify(r.metrics, null, 2)}</pre>}
                expandLabel="metrics"
                empty={<EmptyState title="No experiment runs" message="Runs appear after the nightly challenger / weekly calibration jobs." />}
              />
              <h3 className="lab-h3">Setup evidence cells{d.setupEvidence.asOf ? ` · ${fmtDateTime(d.setupEvidence.asOf)}` : ''}</h3>
              {d.setupEvidence.verdict && <p className="desk-caveat">{d.setupEvidence.verdict}</p>}
              <div className="overflow-x-auto thin-scroll">
                <table className="w-full min-w-[640px] text-left text-xs">
                  <thead><tr className="text-[10px] uppercase tracking-wide text-slate-500"><th className="px-2 py-1">Setup</th><th className="px-2 py-1">Horizon</th><th className="px-2 py-1">Dates</th><th className="px-2 py-1">Expectancy after costs</th><th className="px-2 py-1">P(&gt;0)</th><th className="px-2 py-1">Tier</th><th className="px-2 py-1">Usable</th></tr></thead>
                  <tbody>
                    {d.setupEvidence.cells.map((c, i) => (
                      <tr key={i}>
                        <td className="px-2 py-1.5">{String(c.setupType ?? '—')}</td>
                        <td className="px-2 py-1.5">{String(c.horizon ?? '—')}</td>
                        <td className="px-2 py-1.5 tabular-nums">{String(c.independentEntryDates ?? '—')}</td>
                        <td className={clsx('px-2 py-1.5 tabular-nums', Number(c.expectancyAfterCosts) > 0 ? 'text-buy' : 'text-sell')}>{typeof c.expectancyAfterCosts === 'number' ? `${c.expectancyAfterCosts.toFixed(3)}R` : '—'}</td>
                        <td className="px-2 py-1.5 tabular-nums">{typeof c.probabilityExpectancyPositive === 'number' ? c.probabilityExpectancyPositive.toFixed(2) : '—'}</td>
                        <td className="px-2 py-1.5"><Chip tone={c.evidenceStrength === 'A' ? 'buy' : c.evidenceStrength === 'B' ? 'cyan' : c.evidenceStrength === 'C' ? 'amber' : 'zinc'}>{String(c.evidenceStrength ?? '—')}</Chip></td>
                        <td className="px-2 py-1.5">{c.usableForEntry ? <span className="text-buy">YES</span> : 'no'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {tab === 'failures' && (
            <section className="glass desk-section space-y-4">
              <div className="desk-section-head"><div><h2>What failed</h2><p>Lessons recorded by the studies and the nightly jobs. NONE is an honest action.</p></div></div>
              {failures.length === 0 && <EmptyState title="No failure lessons recorded" message="Lessons are written by the challenger, calibration and selection studies when a pre-registered claim resolves WRONG." />}
              <ul className="lab-lessons">
                {failures.map((l, i) => <li key={i}><Chip tone="sell">{l.category}</Chip><div><p><strong>Observed:</strong> {l.observation}</p><p><strong>Lesson:</strong> {l.lesson}</p><small>action {l.actionTaken} · {fmtDateTime(l.createdAt)}</small></div></li>)}
              </ul>
              <h3 className="lab-h3">All lessons</h3>
              <ul className="lab-lessons">
                {d.lessons.filter((l) => !failures.includes(l)).map((l, i) => <li key={i}><Chip tone="zinc">{l.category}</Chip><div><p>{l.observation}</p><p className="text-slate-400">{l.lesson}</p><small>action {l.actionTaken} · {fmtDateTime(l.createdAt)}</small></div></li>)}
              </ul>
            </section>
          )}

          {tab === 'learning' && (
            <>
              <section className="glass desk-section"><LearningPanel initial={learning.data ?? null} /></section>
              <section className="glass desk-section space-y-4">
                <div className="desk-section-head"><div><h2>Which stocks and setups work — broad-scan outcomes</h2><p>{universe.data ? universe.data.headline : 'Loading…'}</p></div></div>
                {universe.data && (
                  <>
                    <ul className="lab-narrative">{universe.data.statements.map((s, i) => <li key={i}><span>{s.text}</span><small>{s.metric} · n={s.n}</small></li>)}</ul>
                    <SegmentTable title="setup type (broad scan)" rows={universe.data.bySetupType} />
                    <SegmentTable title="market-cap bucket" rows={universe.data.byCapBucket} />
                    <SegmentTable title="liquidity tier" rows={universe.data.byLiquidityTier} />
                    <SegmentTable title="market regime (broad scan)" rows={universe.data.byRegime} />
                    <SegmentTable title="volatility regime" rows={universe.data.byVolRegime} />
                    <SegmentTable title="funnel stage reached" rows={universe.data.byStage} />
                    <SegmentTable title="sector (broad scan)" rows={universe.data.bySector} />
                    <p className="desk-caveat">{universe.data.caveat}</p>
                  </>
                )}
              </section>
            </>
          )}

          {tab === 'challengers' && (
            <section className="glass desk-section space-y-4">
              <div className="desk-section-head"><div><h2>Promotion gates</h2><p>{d.evidenceVerdict}</p></div></div>
              <ul className="lab-gates">
                {d.promotionGates.map((g) => <li key={g.id}><GateIcon passed={g.passed} /><div><strong>{g.rule}</strong><small>required: {g.required}</small><small>measured: {g.measured}</small></div></li>)}
              </ul>
              <h3 className="lab-h3">Governed models</h3>
              <ul className="lab-list">
                {d.currentModels.map((m) => <li key={m.key}><Chip tone={m.state === 'CHAMPION' ? 'buy' : m.state === 'SUSPENDED' || m.state === 'RETIRED' ? 'sell' : m.state === 'CANDIDATE' ? 'cyan' : 'zinc'}>{m.state}</Chip> <strong>{m.key}</strong> <span className="text-slate-500">· {m.scope}{m.updatedAt ? ` · ${fmtDateTime(m.updatedAt)}` : ''}</span>{m.reasons.length > 0 && <small className="block text-slate-500">{m.reasons[0]}</small>}</li>)}
              </ul>
              <h3 className="lab-h3">Promotion status · transitions</h3>
              {d.promotions.length === 0 && <p className="desk-caveat">No governance transitions recorded.</p>}
              <ul className="lab-list">
                {d.promotions.map((p, i) => <li key={i}><Chip tone={p.to === 'CHAMPION' ? 'buy' : p.to === 'RETIRED' || p.to === 'SUSPENDED' ? 'sell' : 'zinc'}>{p.from} → {p.to}</Chip> <strong>{p.modelKey}</strong> <span className="text-slate-400">— {p.reason}</span> <small className="text-slate-500">{fmtDateTime(p.at)}{p.evidenceRunId ? ` · run ${p.evidenceRunId.slice(0, 8)}` : ' · no evidence run'}</small></li>)}
              </ul>
              <h3 className="lab-h3"><Beaker className="inline h-4 w-4" aria-hidden /> Policy</h3>
              <ul className="lab-list">{d.policy.map((p) => <li key={p}>{p}</li>)}</ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
