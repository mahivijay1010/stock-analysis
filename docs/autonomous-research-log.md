# Autonomous research log

Maintained per the autonomous backend directive. Every cycle appends:
hypothesis · why · data · models · dates · metrics · uncertainty · result
(PROMOTED / REJECTED / PROMISING_NOT_PROVEN) · learning · next experiment.

---

## Cycle 0 — Definition-of-Done audit (2026-09-08)

**Status matrix** (✓ done · ~ partial · ✗ gap · B blocked):

| Area | Item | Status | Evidence / gap |
| --- | --- | --- | --- |
| PIT data | universe membership | **B** | no point-in-time NSE membership source → survivorship exposure documented (short-term-survivorship-audit.md); classify BLOCKED_EXTERNAL |
| PIT data | corporate actions / adjusted prices | ✓ | events=div,split; analysisCloses; canonical tests |
| PIT data | fundamentals PIT | ~ | XBRL facts availableAt=ingestion; Yahoo snapshot excluded from all learning; no historical filing-timestamp feed → strongest tier BLOCKED_EXTERNAL |
| PIT data | events PIT | ✓ | announcedAt discipline, replay-tested |
| PIT data | holidays/sessions | ✓ | session calendar; completed-bar discipline |
| Forecasting | mandatory baselines | ~ | constant-50/zero/mean/momentum/AR1 ✓; **EWMA, HAR-RV, ARIMA missing from harness** |
| Forecasting | statistical + panel + ranking + excess-target | ✓ | ExperimentRuns 86b07227 / 0208bb27 + stride rerun |
| Forecasting | regime interactions | **✗** | never evaluated (Part I) |
| Forecasting | feature ablation | **✗** | never run (Part P) |
| Forecasting | model disagreement | ~ | AI-role disagreement ✓; cross-model forecast dispersion not emitted by harness |
| Forecasting | medium horizons 42/63d | **✗** | panel stops at 21td |
| Forecasting | direct vs residual target (Part D) | ~ | excess target used; formal same-panel head-to-head not run |
| Calibration | probabilities calibrated-or-withheld | ✓ | calibrators table; 30d withheld |
| Calibration | interval coverage OOS | ✓ | MC study 3a591851 |
| Calibration | conditional coverage + conformal | **✗** | Part M: conformal/adaptive-conformal never tested; coverage-by-vol-regime not measured |
| Trading | setup expectancy/costs/gaps/sizing/portfolio limits | ✓ | V2 modules + studies |
| Trading | survival / time-to-event (Part K) | **✗** | 72,236-bracket dataset exists; hazard model untested |
| Trading | portfolio context (Part O) | ~ | correlation/exposure utils exist; candidate marginal-risk not wired |
| Validation | walk-forward/purge/embargo/effN/multiple-testing/untouched-test | ✓ | harness + BH-FDR |
| Validation | DSR / PBO (Part T) | **✗** | only BH implemented |
| Validation | prospective shadow | ~ | machinery live; REQUIRES_PROSPECTIVE_TIME |
| Governance | unified registry with states (Part R) | ~ | states exist per-subsystem; ModelRegistry entity unused for governance |
| Governance | scheduled retraining (Part V) | **✗** | research runs are manual scripts; no cron wiring |
| Ops | provider failure / freshness / idempotent jobs / monitoring / tests | ✓ | verified across sessions |
| Features | versioned feature registry (Part B) | **✗** | version strings exist; no per-feature metadata registry |
| Features | breadth / advance-decline market features | **✗** | computable PIT from cached universe bars; absent |
| Features | derivatives / microstructure | **B** | no trustworthy PIT source (no fabrication) → BLOCKED_EXTERNAL |

**Top-5 bottlenecks** (ranked by expected predictive impact × testability):
1. **Feature ablation** — determines what actually carries the panel signal; directly steers all later work.
2. **Regime interactions** — the panel pools regimes; conditioning may explain the promising-not-proven ICs.
3. **Conformal intervals + conditional coverage** — direct risk-reduction; measurable now.
4. **Survival/competing-risks on the bracket set** — new timing capability; dataset already built.
5. **Governance + scheduled jobs + missing baselines + feature registry** — hardening; cheap.

---

## Cycle 1 — mandatory baseline completion (Part F)
**Hypothesis**: EWMA / HAR-RV / ARX add baseline coverage; HAR-RV's conditional σ may improve interval quality.
**Data**: 40 tickers, walk-forward harness, horizons 1/7/30d. Run `baseline-completion-study`.
**Result**: stat-arx ≈ stat-ar1 (BSS −0.006…−0.013, no edge). stat-ewma **REJECTED** at 30d (BSS −0.672, MAE 12.7%, coverage 41% — drift extrapolation compounds). **stat-har-rv: coverage 79.7% at 30d ≈ nominal vs zero-return fixed-σ 57.4%** → registered SHADOW as an interval-generation candidate (Cycle 6 tested it head-to-head).
**Learned**: conditional volatility ≠ direction; it earns its keep only in bands.

## Cycle 2 — feature ablation (Part P)
**Data**: panel-v2 (30,910+ rows incl. breadth features), lgbm-reg, excess-vs-NIFTY, val-select/test-report, run `eb77c878`.
**Result**: reference ALL h=10 valIC 0.0226 / testIC 0.0298 (stride-t ≈ 1.0). No minus-group collapses IC; minus-TECHNICAL hurts most (val 0.0052); minus-SECTOR / minus-RELATIVE slightly IMPROVE val IC (0.0319/0.0262) but all stride-t < 2. **PROMISING_NOT_PROVEN** — most useful group descriptively: TECHNICAL (vol); possibly redundant: SECTOR, RELATIVE; nothing significant.

## Cycle 3 — regime interactions (Part I)
**Result**: regime-flag feature adds nothing (Δ val IC within noise); regime-SPLIT models produce too few strided windows for inference (stride-t null on bear cells). **REJECTED for now** — keep the global model; revisit when history doubles.

## Cycle 4 — target formulation (Part D)
**Result**: raw-return target valIC 0.0357/testIC 0.0185 (10td) vs excess 0.0226/0.0298 — mixed, no formulation dominates at significance. Excess retained (a-priori preferable for ranking). **NO CHANGE**.

## Cycle 5 — survival / competing risks (Part K)
**Data**: 7,610 radar-geometry brackets with per-day timing, purged date split.
**Result**: LGBM beat both pre-registered baselines marginally (time-MAE 2.006 vs 2.109; day-3 Brier 0.2459 vs 0.2474) **but on 27 < 40 independent windows ⇒ NO_VALIDATED_EDGE, stays SHADOW**. Descriptive hazard tables SHIP: median resolution day 2–3 (pullback/momentum reach target by day 3 in ~40% with only 3–6% stops; VCP is stop-heavy early: 29.9% stops vs 19.5% targets by day 3). `expectedHoldingDaysFor()` now uses these medians (descriptive timing, not edge).

## Cycle 6 — interval head-to-head (Part M)
**Data**: 3,003 non-overlapping 21td anchors (test half; conformal strictly online). Run `88a41071`.
**Result**: bootstrap 81.72% cov80 / width 22.4%; split-conformal 82.64%/22.9%; **adaptive-conformal 78.97%/20.6% (closest to nominal, narrower, best pinball 0.0305)** — but the gain is 0.69pp < the pre-registered 2pp bar ⇒ **NONE PROMOTED, bootstrap keeps the interval crown**. Conditional coverage now measured: bootstrap stable across vol regimes (83.4 low / 81.6 high); har-sigma badly under-covers low-vol (63.7%) — SHADOW retained, not promotable as-is. Adaptive-conformal recorded PROMISING_NOT_PROVEN.

## Cycle 7 — governance + scheduled jobs (Parts R/V)
model_governance + transitions tables; ModelGovernanceService (legal-transition enforcement, evidence-required, no AI path); seeded 10 honest states (champion-quant-v1 CHAMPION; panel/lambdarank/meta-label/har-rv SHADOW; calibrator-1d + mean-reversion setups CANDIDATE; ewma + mc-block RETIRED). Cron gains `evening-resolve-shadow-outcomes` (18:45 IST weekdays, idempotent) and `monthly-governance-review` (demote-only; promotion always explicit).

## Cycle 8 — portfolio context (Part O)
`assessPortfolioContext` (pairwise correlation vs open positions, sector concentration after add, marginal σ contribution, deterministic ranking penalty ≤15) wired into the short-term scan whenever open paper positions exist; tested.

## Cycle 9 — multiple-testing controls + disagreement (Parts T/Q)
Deflated Sharpe + CSCV-lite PBO + forecastDisagreement implemented & tested. **Applied DSR to the panel program's best selections (~53 trials): 5td stride pick DSR-prob ≈ 0.000; 21td naive pick 0.015 — both far below 0.95 ⇒ the GBM panel "signal" is formally indistinguishable from selection luck. Final multiple-testing verdict: NOT promotable.** PBO on noise correctly reads high (0.84); a dominant strategy reads low (<0.2).

**Program conclusion after cycles 0–9**: every currently-testable challenger was evaluated and none met its pre-registered bar. The champion stack (bootstrap distributions + deterministic gates + withheld probabilities) survives on merit. Remaining items are BLOCKED_EXTERNAL (PIT universe membership, PIT fundamentals timestamps, derivatives/microstructure feeds) or REQUIRE_PROSPECTIVE_TIME (shadow authority, live calibration, drift observations).

---

## Review-response pass (2026-09-08) — P0 correctness + security defects

Acted on an external code-review. **All 12 P0 defects fixed and tested** (commits eac1262, 597b745):

| # | Defect | Fix | Proof |
| --- | --- | --- | --- |
| 1 | ENTRY_CONFIRMED unreachable | in-zone geometry promoted to ENTRY_CONFIRMED; ceiling is sole gate | positive+negative path tests |
| 2 | shadow outcomes assumed entry | fill-aware `simulateBracket` (NEVER_ENTERED, gap fills, same-bar→STOP) | 10 tests |
| 3 | % averaged and called R | persist realized net `rMultiple`; health/governance avg netR over FILLED only | tests + queries |
| 4 | regime/relVol bypassed with constants | real `assessRegime` per stock, fail-closed; real relVolume in rank | live scan |
| 5 | pre-entry revalidation fails open | verifies event+regime+portfolio-risk, unavailable⇒veto | code + fail-closed |
| 6 | decision policy fails open on null | null critical input ⇒ unmet gate; only HEALTHY model → BUY (policy v6) | 3 suites updated |
| 7 | sizing could exceed loss budget | qty solved incl. costs+slippage+0.2·ATR gap buffer; lossAtStop≤riskAmount | invariant test |
| 8 | adjusted levels vs raw OHLC | `toAdjustedOhlc` (×adjClose/close) so basis matches | tests |
| 9 | admin fail-open w/o ADMIN_KEY | requireAuthOrAdminKey | live 401 |
| 10 | SSRF via irPageUrl | ssrfGuard (IP/DNS-rebind/allowlist/creds) + manual redirect revalidation + 25MB cap | 27 tests |
| 11 | expensive endpoints public | auth on macro/refresh, portfolio, :ticker/refresh, /analyze | live 401 |
| 12 | npm audit failing (13, 7 high) | non-breaking `npm audit fix` → 2 moderate (express→qs needs express-5 major, deferred) | audit |
| 47 | scan params unvalidated | explicit 400 on negative budget / risk∉[0.01,5] / min>max / bad enum | tests |
| 62 | 5xx leaked internal messages | generic 500 body, real error logged server-side | code |

Live acceptance re-run after all changes: universe 151 → 3 gated → **0 qualified**; the 8-Sep four remain RESEARCH_WATCHLIST. 33 suites / 410 tests green.

### Honest triage of the remaining review items (NOT yet done)

These are real and accepted, but are multi-day infrastructure or require prospective time — classified, not hidden:

- **REQUIRES_PROSPECTIVE_TIME**: #13–#24 (forecasting-objective migration, selective prediction, per-horizon health, effective-sample rework, hierarchical cell eval, registry-per-horizon champion, challenger battery, live drift, statistically-justified promotion sample). The machinery (governance, shadow resolver, DSR/PBO, calibration) now exists; these need accumulated live cohorts. The fill-aware ledger (this pass) is the prerequisite that unblocks them.
- **BLOCKED_EXTERNAL / large-data**: #18 PIT universe membership + delistings + symbol history (no licensed source).
- **INFRA (multi-day, scoped for follow-up branches)**: #25–#32 account-scoped risk engine + HWM drawdown + factor exposure + liquidity stress + order preview; #40–#55 transactional scans, bounded-concurrency fetch, durable queue/leased worker, cron_execution_logs, multi-provider quorum, shared cache, FK/check constraints, normalized outcomes, PG pool/timeouts, graceful shutdown, real health check, structured logs, PITR/partitioning, service decomposition; #33–#39 AI immutable-evidence pointers, provenance in cache key, prompt-injection defenses, per-role breakers/canary; #56–#61 Redis-backed login throttle, refresh-token rotation/jti/revocation, session secret/issuer/rotation, roles/MFA, no-plaintext-password migration output, same-cost dummy bcrypt. Governed-data table (fees/limits/thresholds effective-dated) is the recommended umbrella for the "static values" section.

Recommended next branch: transactional + concurrency-bounded scan (#40/#41/#42) — it directly improves the reliability of the prospective-evidence pipeline the forecasting items depend on.

---

## Review-response batch (2026-09-10) — honesty & correctness follow-ups

A second external review (of the record + methodology, not a fresh code read)
raised correctness/honesty defects distinct from the P0 set above. Fixed and
tested this pass (tests: `tests/review-followups.test.ts`, updated
`tests/shadow-fill.test.ts`). **448 tests / 39 suites green; backend + frontend
tsc clean.**

| Area | Reviewer point | Fix | Proof |
| --- | --- | --- | --- |
| Intrabar ambiguity | EOD OHLC cannot order a same-bar stop+target touch; calling it a clean STOP fabricates a −1R fact | `FillOutcome` gains `AMBIGUOUS_INTRABAR` + `DATA_INVALID`; straddle is now **flagged ambiguous** but **still resolved adversely at the stop** for EV; malformed candles (`high<low`/`≤0`) ⇒ `DATA_INVALID`, unscored (`netRMultiple=null`). `BracketResult.ambiguous` persisted on every shadow outcome. | shadow-fill + follow-up tests |
| Ledger integrity | a dropped/duplicated shadow resolution silently corrupts prospective stats | pure `reconcileLedger()` asserts `total === resolved + pending`; `reconcileShadowLedger()` cron counts ambiguous/invalid separately and alarms on imbalance; aggregation queries exclude `DATA_INVALID` | accounting-identity tests |
| Tier-A honesty | Tier A was presented as "verified" while survivorship (PIT universe) is unaccounted | `EvidenceStage = BACKTEST_PROVISIONAL \| PIT_VALIDATED \| PROSPECTIVE_CONFIRMED`; `PIT_UNIVERSE_AVAILABLE=false`; tier A now carries a BACKTEST-PROVISIONAL note and `evidenceStage` on every cell | setupEvidence + study |
| Probability status | "no probability" conflated several distinct reasons | `probabilityStatus: AVAILABLE \| UNCALIBRATED \| NO_SKILL \| INSUFFICIENT_N \| STALE` on `ShortTermForecast`, machine-readable | model.ts |
| Gate monotonicity | a gate must never let a *worse* input yield a *higher* action | property tests: worsening ANY single policy input never raises `decisionStatus`; degrading ANY `composeCeiling` input never raises the ceiling rank | monotonicity tests |
| Completeness ≠ quality | a score of 100 on 2-of-6 checks read the same as 100-of-6 | `PhaseResult` gains `completeness`/`scoredChecks`/`totalChecks` (populated in `buildReport`); confirmed `scoreFromChecks` already excludes no-data (not an unknown-as-credit bug) | types + FrameworkService |

### Honest triage of the remaining review items (still NOT done)

Real and accepted; deferred because they need external data, prospective time,
or multi-day infra — classified, not hidden:

- **BLOCKED_EXTERNAL**: PIT survivorship-free universe (membership + delistings +
  symbol-history) — no licensed source. This is why Tier A is now labelled
  `BACKTEST_PROVISIONAL` rather than "verified"; it cannot be promoted to
  `PIT_VALIDATED` until this lands. Reviewer's #1 blocker; unchanged.
- **NOT_CANONICAL**: Yahoo is the sole price/level source; no independent
  canonical (e.g. NSE) cross-check, and forecast/backtest/level price domains
  are not yet reconciled to one adjusted basis across providers.
- **REQUIRES_PROSPECTIVE_TIME**: prospective (out-of-sample, forward-dated)
  confirmation of every setup×horizon cell — the `PROSPECTIVE_CONFIRMED` stage
  exists in the type but no cell has earned it yet; needs accumulated live cohorts
  through the now-fill-aware, now-reconciled shadow ledger.
- **STATISTICAL_STRINGENCY**: the 80% EV lower-bound gate does not yet correct
  for multiplicity across the setup×horizon grid (family-wise / FDR); a single
  cell clearing 80% LCB in isolation overstates grid-wide confidence.
- **INFRA (multi-day follow-up branches)**: durable queue + leased worker + PITR,
  immutable decision snapshots (hash-pinned inputs), account-scoped portfolio
  correlated-gap risk engine, independent-validation process separation.
- **AI_SEMANTIC_GROUNDING**: AI remains advisory/cap-only and may not raise an
  action; end-to-end grounding of its evidence pointers to immutable snapshots
  is part of the immutable-snapshot infra item, not yet built.

Recommended next branch: immutable decision snapshots (hash-pinned gate inputs)
— it is the prerequisite for both AI semantic grounding and a trustworthy
prospective ledger, and is self-contained enough to land without the external
data blockers.

---

## Review-response batch #2 (2026-09-10) — realized ≠ conservative correction

The reviewer accepted batch #1 but flagged that `AMBIGUOUS_INTRABAR`, while
correctly *labelled*, was still being **recorded as a realized −1R** and only
`DATA_INVALID` was excluded from the live average — conflating "what the safety
gate should assume" with "what actually happened." Fixed before starting the
immutable-snapshot branch, as advised. **454 tests / 39 suites green; backend +
frontend tsc clean.**

| Reviewer point | Fix | Proof |
| --- | --- | --- |
| **P0 #1** ambiguous scored as realized | `BracketResult` now carries **`realizedNetR`** (null when the ordering was unobservable), **`conservativeNetR`** (adverse leg — for the safety gate), **`bestCaseNetR`** (favorable bound) and **`resolutionSource`** (`DAILY_BAR` vs `CONSERVATIVE_ASSUMPTION`). `netRMultiple` is a back-compat alias of *realized* (⇒ null for ambiguous). Governance/health average **conservative** (fail-safe demotion unchanged); the reported live expectancy averages **realized** with ambiguous excluded and counted separately. `COALESCE` keeps pre-split rows valid. | realized/conservative + observed-equality tests |
| **P0 #2** reconciliation can't catch a duplicate | `reconcileLedger` now checks **two** identities — SUM (`total = resolved + pending`) *and* UNIQUENESS (`total = distinctIdentities`); the reviewer's `101 = 90 + 11` counterexample now fails. DB-level `UNIQUE (ticker, anchor_date, setup_type, horizon, model_version)` (migration `1789300000000`) makes the existing `.orIgnore()` shadow insert genuinely idempotent (it had no conflict target before). | duplicate-detection test + migration |
| **P0 #5** probabilityStatus invariant | pure `resolveProbability()` makes the impossible pairs unrepresentable: a probability is emitted **IFF** status is `AVAILABLE`; every not-available reason nulls it; `AVAILABLE` + null/NaN/out-of-range collapses to `UNCALIBRATED`. Enforced at forecast construction, not by frontend convention. | invariant tests over all statuses |

### Still open after batch #2 (reviewer's revised priority)

Unchanged blockers plus the reviewer's newly-itemised follow-ons, in his order:

- **Immutable DecisionSnapshot** (hash-pinned universe/price/fundamental/event
  inputs + versions) with a **replay-determinism** test — the next large branch.
- **AI evidence-pointer grounding** on top of snapshots (claims reference
  immutable evidence IDs; backend rejects unknown IDs / unsupported numbers).
- **DataQualityIncident** record + quarantine/second-source reconcile on
  `DATA_INVALID` (currently excluded statistically but not fixed at the data layer).
- **EvidenceStage transitions gated by persisted evidence** (manifest id, study
  run id, survivorship pass, immutable result hash) rather than a manual flag;
  `PIT_UNIVERSE_AVAILABLE=true` must not by itself promote anything.
- **sourceQuality** as a third dimension beside score+completeness (PRIMARY vs
  SCRAPED are not epistemically equal).
- **Property-based** gate monotonicity over generated multi-variable states incl.
  NaN/±Infinity/−0 (current tests are single-variable, hand-picked).
- **PublishedPhaseResult** with required completeness fields at the API boundary
  (internal phase methods keep the optional shape).
- Durable queue + leases + DLQ; PITR + restore test; portfolio correlated-gap
  risk; 80/90/95% EV-LCB multiplicity study.
- **BLOCKED_EXTERNAL** (unchanged): PIT survivorship-free universe; exchange-grade
  canonical market data. **Time-dependent**: prospective confirmation.

---

## Batch #2 correction (2026-09-10) — identity axes + legacy R migration

Reviewer follow-up on batch #2. Two real corrections, plus a factual fix to the
batch-#2 record. **454 tests / 39 suites green; backend + frontend tsc clean.**

- **Uniqueness identity was suppressing legitimate experiments.** The reviewer
  warned a re-run under a bumped policy/setup version could be `.orIgnore()`'d
  away. Investigating, the ORIGINAL table migration (`1789100000000`) already
  had `uq_st_shadow` on just `(ticker, anchor_date, setup_type, horizon)` —
  narrower even than `model_version`. So batch #2's note that "the insert had no
  conflict target" was **wrong**: it had one, and it was too narrow (a new
  MODEL version was already being suppressed). Migration `1789400000000` drops
  both the original 4-col index and batch #2's 5-col one, replacing them with a
  single 7-col identity spanning all three axes that change a prediction's
  meaning — model, policy, feature/setup definition. Two new columns
  (`policy_version`, `feature_version`) are populated at insert from the
  existing `SHORT_TERM_POLICY_VERSION` / `SHORT_TERM_FEATURE_VERSION` constants;
  `reconcileLedger`'s distinct-identity count matches. The snapshot branch will
  replace this composite with a single `decision_snapshot_id`.
- **Legacy synthetic R could leak into "realized".** The realized average uses
  `COALESCE(realizedNetR, netRMultiple)`, so a pre-split AMBIGUOUS row (whose
  synthetic adverse value sat in `netRMultiple`) could re-enter as realized.
  The migration rewrites historical outcome JSON to the explicit split —
  ambiguous ⇒ `realizedNetR=null`, `conservativeNetR=old netR`,
  `netRMultiple=null`; other filled scored ⇒ realized=conservative=best-case —
  so no synthetic number is ever read as realized, with or without the COALESCE.
  Rows written before the AMBIGUOUS label existed (recorded as STOP_FIRST) are
  unrecoverable and documented as such; no prospective rows have accrued yet, so
  the backfill is a guard, not a lossy repair.

Next: immutable DecisionSnapshot (unchanged priority), which subsumes the shadow
identity into `decision_snapshot_id` and enables AI evidence-pointer grounding.

---

## Immutable DecisionSnapshot branch (2026-09-10) — reviewer #29

Built the agreed next branch: the hash-pinned, replayable, append-only snapshot
that everything downstream (shadow ledger, AI grounding, and the future
realtime layer) will anchor to. **465 tests / 40 suites green; tsc clean.**

The gate pinned today is the pure `evaluateEntryPolicy` (deterministic
TradeGate). `decision_snapshots` already stored the gate inputs; this branch
adds the guarantees that make it trustworthy evidence:

- **Canonical hashing** (`src/services/decision/decisionSnapshot.ts`, PURE):
  `canonicalize()` sorts object keys recursively (arrays keep order; undefined /
  non-finite collapse to null) so a hash is key-order-independent — the
  serialization-stability point the reviewer flagged as easy to miss.
  `sealDecision()` runs the gate and records `inputManifestHash` = sha256 over
  `{versionManifest, inputs}` and `decisionHash` = sha256 over the output.
- **Replay determinism**: `replaySealed()` re-runs the gate on the SEALED inputs
  ONLY — never live prices/fundamentals/events — so a replayed decision is
  immune to later live-data mutation by construction. `assertReplayDeterministic()`
  throws if the decision doesn't reproduce byte-identically (catches a gate code
  change without a version bump).
- **Fail-closed**: an incomplete manifest, or one whose input hash no longer
  verifies, is REFUSED — replay never backfills from current data.
- **DB-level immutability**: `input_manifest_hash` / `decision_hash` columns +
  a `BEFORE UPDATE OR DELETE` trigger that REJECTS mutation of a published
  snapshot, with an explicit admin override GUC
  (`stocksense.allow_snapshot_mutation = 'on'`) for a deliberate retention op.
  `DecisionService` now seals the exact `PolicyInputs` and persists both hashes.
- **Tests**: the reviewer's six — replay determinism, live-mutation immunity,
  hash sensitivity, version sensitivity, missing-evidence fail-closed,
  serialization stability (`tests/decision-snapshot.test.ts`, 11 cases).

### Live Market Intelligence Agent — sequencing decision (reviewer #30)

The realtime architecture (per-second numerical evaluation of all ~151 stocks,
LLM only on material change, chart-structure engine, order flow, WebSocket UI)
is accepted as the long-term shape but **deferred**, for two reasons the
reviewer themselves gave:

1. **Data source**: it requires a licensed NSE realtime feed (or authorized
   vendor) with redistribution-compliant terms — Yahoo is not suitable and we
   do not have such a feed. The provider must sit behind a
   `RealtimeMarketProvider` abstraction so the engine is feed-agnostic.
2. **No unproven authority**: the realtime engine must run as `REALTIME_SHADOW`
   and record every `LivePredictionRevision` until prospective evidence shows it
   measurably improves entry timing / false-breakout avoidance / expected R /
   calibration / drawdown over the EOD engine. If it doesn't, we say so.

The snapshot built here is the prerequisite: realtime `LiveDecisionEvent`s will
seal the SAME way and reference `input_manifest_hash`, so the temporary 7-column
shadow identity can be replaced by a snapshot reference without a retrofit.

Recommended next (unblocked, no external feed): AI evidence-pointer grounding on
top of the sealed snapshot — the AI critic references evidence IDs belonging to
a snapshot; the backend rejects unknown IDs, numbers not present in the
evidence, or an AI action above the deterministic one.
