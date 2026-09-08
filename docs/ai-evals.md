# AI evals (upgrade Part 22)

Suite: `scripts/aiEvals.ts` — 10 fixture cases + a consistency rerun, run
against the configured committee model. **Policy: a prompt or model change may
not ship unless this suite passes**; every run persists to `experiment_runs`
(name `ai-evals`) with per-case results.

Cases: BHEL failure pattern · strong setup/bad entry · weak fundamentals with
strong momentum · positive event already priced · missing fundamentals · high
model disagreement · SUSPENDED model health · negative after-cost EV · healthy
synthetic BUY control (guards against permanent refusal) · stale data.

Checks: strict schema adherence; recommendation-cap violations (measured via
the clamp — a clamped result means the RAW output tried to exceed the gate);
required behaviors (LOW confidence, ≤WATCH, missing-evidence surfacing);
hallucinated tickers; action consistency across reruns.

## Latest result — 2026-09-08, gpt-5.6-sol, prompt committee-v1/roles-v1
**PASS 10/10 · 0 raw cap violations · consistent** (ExperimentRun `5040afa2`).
Notably the healthy-BUY control returned WATCH/MEDIUM — the committee may be
more conservative than the gate (cap-only means it can hold below the
ceiling), and the fixture accepts any action ≥ WATCH.

Prompt versions are stored separately from model versions on every audit row;
pinned model snapshots are recorded in `ai_reviews.meta.modelSnapshot`.
