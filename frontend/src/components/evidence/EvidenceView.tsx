'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BookOpen, CheckCircle2, ChevronDown, FlaskConical, RefreshCw, ShieldAlert, XCircle } from 'lucide-react';
import { getEvidence } from '@/lib/api';
import type {
  EvidenceBundle,
  EvidenceCalibrator,
  EvidenceExperiment,
  EvidenceGovernance,
  PredictionLedgerRow,
} from '@/lib/types';

/**
 * Evidence — the audit trail, in public.
 *
 * Every other tab shows what the system currently believes. This one exists to
 * show whether that belief has earned anything, by answering three questions
 * in order:
 *
 *   1. What did it predict, and what actually happened?
 *   2. What did it get WRONG?
 *   3. What changed as a result?
 *
 * Honesty rules, which are the reason the tab exists at all:
 *
 *  - Wrong predictions render FIRST and are never collapsed by default. The
 *    backend orders them that way so no client-side choice can bury them.
 *  - Pending predictions are shown as pending, with their target date. They are
 *    never dropped, and never counted as successes — the denominator is always
 *    on screen.
 *  - No aggregate is displayed that the sample cannot support. If the backend
 *    withholds a hit rate for want of matured outcomes, this renders the
 *    explanation instead of a number.
 *  - Rejected calibrators and demoted models are given the SAME prominence as
 *    promotions, because the refusals are what make the promotions credible.
 */

type Tab = 'predictions' | 'learning' | 'governance' | 'experiments';

export function EvidenceView() {
  const [bundle, setBundle] = useState<EvidenceBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('predictions');

  const refresh = useCallback(async () => {
    try {
      setBundle(await getEvidence());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach the analysis server');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const s = bundle?.summary;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-100">Evidence</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            The full audit trail: every prediction this system logged, what actually happened, and what it changed as a
            result. <strong className="text-slate-300">Failures are shown first.</strong> Nothing here is filtered to
            flatter the model.
          </p>
        </div>
        <button
          onClick={() => void refresh()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs text-slate-300 hover:bg-white/5"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
      </header>

      {error && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-4 text-sm text-rose-200">{error}</div>
      )}
      {loading && !bundle && <div className="text-sm text-slate-400">Loading the ledger…</div>}

      {s && (
        <>
          {/* The headline is written by the backend to be the LEAST flattering
              true statement available, so it is rendered verbatim. */}
          <section className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-4">
            <div className="flex gap-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
              <div className="space-y-1">
                <p className="font-medium text-amber-200">Where the evidence actually stands</p>
                <p className="text-sm text-slate-300">{s.headline}</p>
              </div>
            </div>
          </section>

          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Predictions logged"
              value={String(s.predictionsTotal)}
              tone="muted"
              sub={`${s.predictionsGraded} matured · ${s.predictionsPending} still pending`}
            />
            <Stat
              label="Wrong so far"
              value={`${s.predictionsWrong}/${s.predictionsGraded || 0}`}
              tone={s.predictionsWrong > 0 ? 'bad' : 'muted'}
              sub={s.predictionsGraded === 0 ? 'nothing has matured yet' : 'of everything that has matured'}
            />
            <Stat
              label="Calibrator fits rejected"
              value={`${s.calibratorsRejected}/${s.calibratorsTrained}`}
              tone="good"
              sub={`${s.calibratorsPromoted} promoted — refusals are the point`}
            />
            <Stat
              label="Models held below LIVE"
              value={`${s.modelsNotLive}/${s.governedModels}`}
              tone={s.modelsNotLive > 0 ? 'warn' : 'muted'}
              sub="governance states, with reasons below"
            />
          </section>

          <nav className="flex flex-wrap gap-1.5 border-b border-white/10 pb-2">
            <TabButton id="predictions" tab={tab} setTab={setTab} icon={<BookOpen className="h-3.5 w-3.5" />}>
              Prediction ledger ({s.predictionsTotal})
            </TabButton>
            <TabButton id="learning" tab={tab} setTab={setTab} icon={<CheckCircle2 className="h-3.5 w-3.5" />}>
              What it learned ({s.calibratorsTrained})
            </TabButton>
            <TabButton id="governance" tab={tab} setTab={setTab} icon={<ShieldAlert className="h-3.5 w-3.5" />}>
              Model governance ({s.governedModels})
            </TabButton>
            <TabButton id="experiments" tab={tab} setTab={setTab} icon={<FlaskConical className="h-3.5 w-3.5" />}>
              Experiments ({s.experimentsRun})
            </TabButton>
          </nav>

          {tab === 'predictions' && <PredictionsPanel bundle={bundle!} />}
          {tab === 'learning' && <LearningPanel calibrators={bundle!.calibrators} />}
          {tab === 'governance' && <GovernancePanel rows={bundle!.governance} />}
          {tab === 'experiments' && <ExperimentsPanel rows={bundle!.experiments} />}
        </>
      )}
    </div>
  );
}

// ── 1. The prediction ledger ─────────────────────────────────────────────────

function PredictionsPanel({ bundle }: { bundle: EvidenceBundle }) {
  const { predictions: p } = bundle;
  const [showPending, setShowPending] = useState(true);

  const graded = p.rows.filter((r) => r.grade !== 'PENDING');
  const pending = p.rows.filter((r) => r.grade === 'PENDING');

  return (
    <div className="space-y-4">
      {/* A withheld statistic is explained, not silently omitted. */}
      {p.sampleWarning ? (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 text-sm text-slate-300">
          <p className="font-medium text-slate-200">No hit rate is shown, on purpose</p>
          <p className="mt-1 text-slate-400">{p.sampleWarning}</p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <Stat label="Hit rate" value={`${p.hitRatePct}%`} tone={(p.hitRatePct ?? 0) < 55 ? 'warn' : 'good'} sub={`over ${p.graded} matured predictions`} />
          <Stat
            label="Mean absolute error"
            value={p.meanAbsErrorPct != null ? `${p.meanAbsErrorPct}pp` : '—'}
            tone="muted"
            sub="how far the expected return sat from the actual"
          />
        </div>
      )}

      {graded.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-medium text-slate-200">
            Matured predictions — graded against what actually happened
          </h2>
          <PredictionTable rows={graded} />
        </section>
      )}

      {pending.length > 0 && (
        <section>
          <button
            onClick={() => setShowPending((v) => !v)}
            className="mb-2 flex w-full items-center justify-between text-left text-sm font-medium text-slate-200"
          >
            <span>
              Still pending ({pending.length}) — logged, not yet judged
            </span>
            <ChevronDown className={`h-4 w-4 text-slate-500 transition ${showPending ? 'rotate-180' : ''}`} />
          </button>
          <p className="mb-2 text-xs text-slate-500">
            These count in the denominator above. They are shown so the record cannot be read as {graded.length}{' '}
            prediction{graded.length === 1 ? '' : 's'} when {p.total} were made.
          </p>
          {showPending && <PredictionTable rows={pending} />}
        </section>
      )}
    </div>
  );
}

function PredictionTable({ rows }: { rows: PredictionLedgerRow[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-white/10">
      <table className="w-full text-sm">
        <thead className="bg-white/[0.03] text-[11px] uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-3 py-2 text-left">Result</th>
            <th className="px-3 py-2 text-left">Ticker</th>
            <th className="px-3 py-2 text-left">Made on</th>
            <th className="px-3 py-2 text-left">Called</th>
            <th className="px-3 py-2 text-right">Prob.</th>
            <th className="px-3 py-2 text-right">Expected</th>
            <th className="px-3 py-2 text-right">Actual</th>
            <th className="px-3 py-2 text-right">Miss</th>
            <th className="px-3 py-2 text-left">Model</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {rows.map((r) => (
            <tr key={r.id} className={r.grade === 'WRONG' ? 'bg-rose-500/[0.04]' : undefined}>
              <td className="px-3 py-2.5">
                <GradeChip grade={r.grade} />
              </td>
              <td className="px-3 py-2.5 font-medium text-slate-200">{r.ticker.replace(/\.NS$/, '')}</td>
              <td className="px-3 py-2.5 text-xs text-slate-400">
                {r.predictionDate}
                {r.horizonDays != null && <span className="text-slate-600"> · {r.horizonDays}d</span>}
              </td>
              <td className="px-3 py-2.5 text-xs text-slate-300">
                {r.predictedDirection}
                {r.actualDirection && r.actualDirection !== r.predictedDirection && (
                  <span className="text-rose-300"> → was {r.actualDirection}</span>
                )}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums text-xs text-slate-400">
                {(r.predictedProbability * 100).toFixed(1)}%
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums text-xs text-slate-400">
                {r.expectedReturnPct != null ? `${r.expectedReturnPct > 0 ? '+' : ''}${r.expectedReturnPct.toFixed(2)}%` : '—'}
              </td>
              <td
                className={`px-3 py-2.5 text-right tabular-nums text-xs ${
                  r.actualReturnPct == null ? 'text-slate-600' : r.actualReturnPct < 0 ? 'text-rose-300' : 'text-emerald-300'
                }`}
              >
                {r.actualReturnPct != null ? `${r.actualReturnPct > 0 ? '+' : ''}${r.actualReturnPct.toFixed(2)}%` : 'pending'}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums text-xs text-slate-400">
                {r.errorPct != null ? `${r.errorPct > 0 ? '+' : ''}${r.errorPct.toFixed(2)}pp` : '—'}
              </td>
              <td className="px-3 py-2.5 text-[11px] text-slate-500">{r.modelVersion}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GradeChip({ grade }: { grade: PredictionLedgerRow['grade'] }) {
  if (grade === 'WRONG') {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-rose-500/15 px-1.5 py-0.5 text-[11px] font-medium text-rose-300">
        <XCircle className="h-3 w-3" /> WRONG
      </span>
    );
  }
  if (grade === 'CORRECT') {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] font-medium text-emerald-300">
        <CheckCircle2 className="h-3 w-3" /> correct
      </span>
    );
  }
  return (
    <span className="inline-flex rounded bg-slate-500/15 px-1.5 py-0.5 text-[11px] font-medium text-slate-400">
      pending
    </span>
  );
}

// ── 2. What it learned ───────────────────────────────────────────────────────

function LearningPanel({ calibrators }: { calibrators: EvidenceCalibrator[] }) {
  const promoted = useMemo(() => calibrators.filter((c) => c.promoted), [calibrators]);
  const rejected = useMemo(() => calibrators.filter((c) => !c.promoted), [calibrators]);
  const [showRejected, setShowRejected] = useState(true);

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-400">
        After each grading cycle the system refits its probability calibrators on held-out outcomes and only ships a fit
        that measurably beat the uncalibrated model on data it did not train on.{' '}
        <strong className="text-slate-300">
          {rejected.length} of {calibrators.length} fits were refused.
        </strong>{' '}
        Brier score is the mean squared probability error — lower is better, and always predicting 50% scores 0.25.
      </p>

      <section>
        <h2 className="mb-2 text-sm font-medium text-slate-200">Promoted — these changed live behaviour</h2>
        {promoted.length === 0 ? (
          <Empty>No calibrator has earned promotion yet.</Empty>
        ) : (
          <CalibratorTable rows={promoted} />
        )}
      </section>

      <section>
        <button
          onClick={() => setShowRejected((v) => !v)}
          className="mb-2 flex w-full items-center justify-between text-left text-sm font-medium text-slate-200"
        >
          <span>Refused ({rejected.length}) — fits the system declined to ship</span>
          <ChevronDown className={`h-4 w-4 text-slate-500 transition ${showRejected ? 'rotate-180' : ''}`} />
        </button>
        {showRejected && (rejected.length === 0 ? <Empty>Nothing refused.</Empty> : <CalibratorTable rows={rejected} />)}
      </section>
    </div>
  );
}

function CalibratorTable({ rows }: { rows: EvidenceCalibrator[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-white/10">
      <table className="w-full text-sm">
        <thead className="bg-white/[0.03] text-[11px] uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-3 py-2 text-left">Model</th>
            <th className="px-3 py-2 text-left">Horizon</th>
            <th className="px-3 py-2 text-left">Method</th>
            <th className="px-3 py-2 text-right">Samples</th>
            <th className="px-3 py-2 text-right">Brier before → after</th>
            <th className="px-3 py-2 text-left">Verdict</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {rows.map((c) => (
            <tr key={c.id}>
              <td className="px-3 py-2.5 font-medium text-slate-200">{c.modelName}</td>
              <td className="px-3 py-2.5 text-xs text-slate-400">{c.horizonDays}d</td>
              <td className="px-3 py-2.5 text-xs text-slate-400">{c.calibratorType ?? '—'}</td>
              <td className="px-3 py-2.5 text-right tabular-nums text-xs text-slate-400">{c.effectiveSamples}</td>
              <td className="px-3 py-2.5 text-right tabular-nums text-xs">
                <span className="text-slate-400">{c.brierBefore.toFixed(4)}</span>
                <span className="text-slate-600"> → </span>
                {c.brierAfter != null ? (
                  <span className={c.brierImprovement != null && c.brierImprovement > 0 ? 'text-emerald-300' : 'text-rose-300'}>
                    {c.brierAfter.toFixed(4)}
                  </span>
                ) : (
                  <span className="text-slate-600">not scored</span>
                )}
              </td>
              <td className="px-3 py-2.5 text-xs text-slate-400">{c.verdict}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── 3. Governance ────────────────────────────────────────────────────────────

function GovernancePanel({ rows }: { rows: EvidenceGovernance[] }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-400">
        What each model is currently allowed to do, and the written reason it sits there. A model in{' '}
        <strong className="text-slate-300">SHADOW</strong> produces predictions that are logged and graded but cannot
        influence a recommendation; <strong className="text-slate-300">RETIRED</strong> means it failed badly enough to
        be switched off.
      </p>
      {rows.length === 0 ? (
        <Empty>No governance records.</Empty>
      ) : (
        <div className="space-y-2">
          {rows.map((g) => (
            <article key={g.modelKey} className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-slate-200">{g.modelKey}</span>
                  <StateChip state={g.state} />
                  <span className="text-[11px] text-slate-600">{g.scope}</span>
                </div>
                <span className="text-[11px] text-slate-500">{g.updatedAt.slice(0, 10)}</span>
              </div>
              {g.reasons.length > 0 ? (
                <ul className="mt-2 space-y-1">
                  {g.reasons.map((r, i) => (
                    <li key={i} className="text-xs text-slate-400">
                      — {r}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-xs text-slate-600">No reason recorded.</p>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function StateChip({ state }: { state: string }) {
  const tone =
    state === 'RETIRED'
      ? 'bg-rose-500/15 text-rose-300'
      : state === 'SHADOW'
        ? 'bg-amber-500/15 text-amber-300'
        : state === 'CANDIDATE'
          ? 'bg-sky-500/15 text-sky-300'
          : 'bg-emerald-500/15 text-emerald-300';
  return <span className={`inline-flex rounded px-1.5 py-0.5 text-[11px] font-medium ${tone}`}>{state}</span>;
}

// ── 4. Experiments ───────────────────────────────────────────────────────────

function ExperimentsPanel({ rows }: { rows: EvidenceExperiment[] }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-400">
        Append-only record of every validation run, including the ones that failed. A run flagged{' '}
        <strong className="text-slate-300">final test</strong> touched the held-out set, which may only happen once per
        question — that flag is how the record shows the budget was spent.
      </p>
      {rows.length === 0 ? (
        <Empty>No experiment runs recorded.</Empty>
      ) : (
        <div className="space-y-2">
          {rows.map((e) => (
            <article key={e.id} className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-slate-200">{e.name}</span>
                  <span className="text-[11px] text-slate-500">{e.kind}</span>
                  <span className="text-[11px] text-slate-600">{e.modelVersion}</span>
                  {e.usedFinalTest && (
                    <span className="inline-flex rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-300">
                      final test used
                    </span>
                  )}
                  <span
                    className={`inline-flex rounded px-1.5 py-0.5 text-[11px] font-medium ${
                      e.status === 'completed' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300'
                    }`}
                  >
                    {e.status}
                  </span>
                </div>
                <span className="text-[11px] text-slate-500">{e.startedAt.slice(0, 10)}</span>
              </div>
              {e.error && <p className="mt-2 text-xs text-rose-300">{e.error}</p>}
              {e.notes && <p className="mt-2 text-xs text-slate-400">{e.notes}</p>}
              {e.metrics && Object.keys(e.metrics).length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-300">metrics</summary>
                  <pre className="mt-1.5 overflow-x-auto rounded-lg bg-black/30 p-2.5 text-[11px] text-slate-400">
                    {JSON.stringify(e.metrics, null, 2)}
                  </pre>
                </details>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

// ── shared bits ──────────────────────────────────────────────────────────────

function TabButton({
  id,
  tab,
  setTab,
  icon,
  children,
}: {
  id: Tab;
  tab: Tab;
  setTab: (t: Tab) => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const active = tab === id;
  return (
    <button
      onClick={() => setTab(id)}
      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
        active ? 'bg-white/10 text-slate-100' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string | null;
  tone: 'good' | 'warn' | 'bad' | 'muted';
}) {
  const toneClass =
    tone === 'good'
      ? 'text-emerald-300'
      : tone === 'warn'
        ? 'text-amber-300'
        : tone === 'bad'
          ? 'text-rose-300'
          : 'text-slate-300';
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3.5">
      <p className="text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 font-display text-lg font-semibold tabular-nums ${toneClass}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-slate-500">{sub}</p>}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 text-sm text-slate-500">{children}</div>;
}
