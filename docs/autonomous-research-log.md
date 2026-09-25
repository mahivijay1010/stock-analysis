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

---

## AI snapshot grounding (2026-09-10) — reviewer #17/#18, next-branch #1

Built the first item on the reviewer's NEXT list — the mechanical enforcement
of AI containment on top of the sealed DecisionSnapshot. **476 tests / 41 suites
green; tsc clean.** `src/services/ai/snapshotGrounding.ts` (PURE):

- **Fixed factual vocabulary**: `buildEvidenceSet(sealed, ticker)` flattens the
  snapshot's sealed gate inputs into stable, snapshot-scoped evidence items
  (`EV:measured.directionHitRatePct`, `EV:riskScore`, …), each bound to the
  snapshot's `inputManifestHash`. The AI sees exactly these facts — no more.
- **Cannot invent facts**: `validateGroundedResponse` rejects any claim that
  references an unknown evidence id, cites a number that does not match the
  evidence value, or cites no evidence at all. Only structured, validated claims
  are consumed — the AI's free text is never trusted for facts.
- **Cap-only**: the AI action is clamped to AT MOST the deterministic decision.
  Lowering is honoured (fail-safe); an attempt to RAISE is flagged and ignored.
- **Adversarial-safe**: a wrong ticker, a wrong snapshot hash, or an unknown
  action is a hard violation that discards the AI contribution entirely and
  lets the deterministic decision stand. The validator never throws.

This is the reviewer's rule made physical: MODEL → prediction → AI critique
(cap/lower only, grounded in immutable evidence) → RISK → TradeGate → final.

### Realtime V1 — scope locked (reviewer's clarification)

Private-use clarified: a broker/vendor API permitting personal use (e.g. an
Upstox-style WebSocket feed) is acceptable — no enterprise NSE feed required —
provided the source's terms allow personal use. Chosen V1 shape (deferred build,
in this order):

1. **10-minute evaluation cadence**, NOT per-second — enough intraday adaptation
   to test whether looking intraday adds value, without HFT complexity.
2. **Continuous 1-minute candle collection** between checkpoints (never a single
   point every 10 min — that discards the intervening path). Ingestion cadence
   is decoupled from evaluation cadence so 10→5→1 min is a config change.
3. **State + StateDelta**: each checkpoint builds a full `LiveStockContext` and a
   delta vs the prior; the AI analyses the CHANGE, not the snapshot in isolation.
4. **No manufactured probabilities**: live layer emits qualitative assessment
   (IMPROVING/STABLE/WEAKENING/INVALIDATED), never a % unless a realtime
   probabilistic model is separately validated.
5. **Two rankings**: OpportunityRank (interesting) vs ActionableRank (clears the
   gates) — preserving interesting≠actionable. Rank by risk-adjusted expected R
   / LCB / liquidity / portfolio impact, NOT max upside %, and NOT a revived
   composite conviction score (components stay separate). Hard safety gates are
   never overridden by rank.
6. **Separate holder vs non-holder decisions** (ENTRY/WAIT/AVOID vs
   HOLD/REDUCE_REVIEW/EXIT_REVIEW) — a bad BUY setup is not a SELL.
7. **Replay engine alongside**: LIVE and REPLAY modes share code; feed historical
   1-min bars incrementally (no lookahead) to test "what would it have said at
   10:20?" before trusting it.
8. **REALTIME_SHADOW**: runs in shadow, records every `LivePredictionRevision`,
   and earns authority ONLY if it beats the EOD engine on expected R / win rate /
   Brier skill / false-breakout rate / drawdown / entry efficiency — else it
   doesn't, and we say so.

Every live material-change event will seal a DecisionSnapshot the same way and
ground its AI critique through the module built above.

---

## Realtime feed-agnostic core (2026-09-10) — reviewer's next code batch

Built the entire feed-independent realtime core, no broker connected yet, all
unit-testable with synthetic/replayed data. **498 tests / 42 suites green; tsc
clean.** Modules under `src/services/realtime/`:

- **types.ts** — `MarketTick`, `ProviderHealth`, `MarketEvent` (TICK | CLOCK),
  `MarketDataSource`, `RealtimeMarketProvider`, discriminated `FormingBar` vs
  `CompletedBar`, `LiveFeatures`, `LiveStockContext`, `StateDelta`.
- **tickValidator.ts** — rejects/flags NaN·≤0 price·negative qty·future ts·
  crossed book·duplicates·sequence regression·**sequence gaps** (surfaced, not
  absorbed)·stale feed. A corrupt tick never reaches a bar.
- **barBuilder.ts** — canonical 1m bars from ticks (+ clock closes a quiet
  minute); PURE `aggregateBars` derives 5m/10m/15m from the ONE 1m series; a
  partial coarse bar is FORMING, never completed.
- **featureEngine.ts** — EMA/RSI/ATR/VWAP/relVol/range as both a PURE full
  recompute AND an incremental engine; the parity test proves
  `incremental === full` bar-for-bar.
- **stateStore.ts** — hot in-memory current state per security (Postgres is not
  the per-tick machine).
- **liveStockContext.ts** — `computePosture` (∈[-1,1], NOT a probability),
  `assessLive` with a hysteresis dead-band (no flicker), `buildLiveStockContext`
  assembling the prepared single-truth object.
- **stateDelta.ts** — deterministic diff between consecutive checkpoints (the AI
  reasons about the change, not the snapshot alone).
- **materiality.ts** — fires the AI only on meaningful change (breakout, VWAP
  cross, RS/vol shock, gate/regime/risk/data-quality change); a ₹0.05 drift is
  not material.
- **opportunityRanker.ts** — two lists (Opportunity vs Actionable), ranked by a
  deterministic MULTI-KEY comparator over independent fields (LCB → expected R →
  RS percentile → entry quality → −risk), NOT a revived composite conviction
  score; a high score can NEVER promote a gated-out or data-unavailable stock.
- **replayProvider.ts** — `ReplayMarketDataSource` (time-ordered, no lookahead) +
  `ReplayMarketProvider` so LIVE and REPLAY run identical code.

Tests (`tests/realtime-core.test.ts`, 22) cover the reviewer's required
invariants: tick ordering/duplicate/gap/invalid/stale, 1m OHLC, 5/10/15m
aggregation, forming≠completed, incremental==full features, StateDelta
determinism, hysteresis, materiality, ranking determinism + gate supremacy,
replay ordering, no-lookahead, and LIVE/REPLAY parity (byte-identical bars).

Also FIXED an operational gap: the DecisionSnapshot hash columns + prior shadow
migrations had not been applied to the live DB (runtime error
`column input_manifest_hash does not exist`). Ran `migration:run`; verified the
hash columns, single `uq_shadow_identity` index, immutability trigger, and
shadow version columns are all present. Going forward migrations are applied in
the same batch they are authored.

### Not yet built (deliberate)

- ONE broker adapter (e.g. `UpstoxRealtimeProvider`) implementing
  `RealtimeMarketProvider` — the only piece that needs a real personal-use feed.
- The 10-minute scheduler, the durable `LivePredictionRevision` (append-only)
  and `LiveDecisionEvent` entities, the live TradeGate, chart-structure
  classification, market/sector/relative-strength context wiring, and the
  REALTIME_SHADOW dashboard.

The engine seals each material-change decision via the DecisionSnapshot core and
grounds its AI critique through the snapshot-grounding module already shipped, so
the broker adapter can start collecting prospective 1-minute data immediately
while the analytical layers keep improving — and it stays REALTIME_SHADOW until
it beats the EOD engine on prospective evidence.

---

## Scraping MarketDataProvider (2026-09-11) — reviewer's V1 data layer

Built the swappable data-provider abstraction so scraping is the CURRENT
implementation, not baked into the engine. **515 tests / 43 suites green; tsc
clean; migration applied.** Under `src/services/realtime/`:

- **marketDataProvider.ts** — `MarketDataProvider` interface (`fetchStock`,
  `fetchUniverse`, `health`), normalized `MarketSnapshot`, `PriceSource` (the
  injected, vendor-specific fetch), and `MarketDataMode`
  (SCRAPED_SNAPSHOT | INTRADAY_CANDLES | STREAMING). `modeAuthorityCeiling` /
  `capActionByMode`: a scraped snapshot lacks intra-interval observability so it
  caps live authority at WAIT — it can never justify a live BUY on its own.
  `snapshotToDataQuality` maps freshness×validity → HEALTHY/DEGRADED/UNAVAILABLE.
- **snapshotValidation.ts** (PURE firewall) — `validateQuote` (missing price ⇒
  PARSER_ERROR to catch a markup/selector change; low>high / price∉[low,high] /
  negative volume / implausible change% / ticker mismatch ⇒ DATA_INVALID),
  `classifyFreshness` (FRESH/STALE/UNKNOWN_FRESHNESS/FAILED — mandatory),
  `reconcilePrices` + `buildScrapedSnapshot` (multi-source: agree→median,
  disagree beyond tol ⇒ SOURCE_DISAGREEMENT/quarantine).
- **asyncUtils.ts** — `mapWithConcurrency` (never 151 at once; order preserved),
  `withRetry` (backoff + injectable jitter/sleep for deterministic tests),
  `withTimeout` (cancels its timer on settle — no dangling handle).
- **scrapingMarketProvider.ts** — `ScrapingMarketProvider` orchestrates bounded
  concurrency + per-source retry/timeout, absorbs a source failure as a FAILED
  quote (never a cycle crash), de-dupes by ticker, reports health.
  `buildProvenanceRows` emits one `MarketSourceSnapshot` per source with a
  rawHash + parsingVersion for reproducibility / parser-drift detection.
- **entity + migration** — `market_source_snapshots` (append-only provenance).
  Explicitly LIVE-panel only; never feeds `financial_facts` (backtest firewall).

Honesty preserved (reviewer): the mode is labelled SCRAPED_SNAPSHOT (a polling
snapshot — we know 1430→1436, NOT the intra-interval path), and a
stale/failed/invalid/disagreeing reading yields dataQuality != HEALTHY, which the
ranker/gate already treat as no-new-entry.

### Not yet built (next batch)
- The concrete `PriceSource` implementations (real HTML/endpoint parsers) — the
  only site-specific piece; kept out of the engine deliberately. Screener stays
  for fundamentals; a current-price source for live snapshots.
- Append-only `LivePredictionRevision` + `LiveDecisionEvent` entities and the
  10-minute scheduler that: scrape → validate → StateDelta → revision →
  materiality→AI (grounded) → gate (capped by mode) → seal DecisionSnapshot →
  Opportunity/Actionable rank, all in REALTIME_SHADOW.

---

## Realtime V1 — live history + 10-minute orchestrator + scraped source (2026-09-13)

Built the keystone of the realtime agent (reviewer priorities 1/2/3). **527 tests
/ 45 suites green; tsc clean; migrations applied.**

- **Append-only live history** (`LivePredictionRevision`, `LiveDecisionEvent` +
  migration). Every checkpoint writes a NEW revision (never an update); a
  transition writes an event with its trigger + grounded evidence ids. Both
  tables carry a `BEFORE UPDATE OR DELETE` trigger (same admin-GUC override as
  decision_snapshots) — this prospective dataset is immutable. A unique key
  `(ticker, evaluated_at, model, feature, policy)` makes a re-run idempotent.
- **LiveEvaluationOrchestrator** (`liveOrchestrator.ts`) — the 10-minute cycle,
  coordination only, all analytics + persistence injected (deterministic, unit-
  tested with a fake provider):
  * market-closed / empty-universe → honest skip;
  * NO silent partial universe — a stock with UNAVAILABLE data is a recorded
    failure, `universeCoverage` is exposed, and the cycle is flagged
    `lowConfidence` below the threshold (never ranks 140/151 as the whole market);
  * ranking computed BEFORE persistence so each append-only revision carries its
    rank; the mode ceiling caps the persisted gate (a SCRAPED_SNAPSHOT BUY ⇒ WAIT);
  * material change fires the (grounded, cap-only) AI hook; an assessment change
    writes a LiveDecisionEvent; revisions chain via previousRevisionId;
  * previous checkpoint held in memory drives the StateDelta — on restart the
    first cycle has null deltas (honest, not fabricated).
- **ScrapedPriceSource** (`scrapedPriceSource.ts`) — generic, config-driven
  (URL builder + CSS selectors), injected `httpGet`, so it is vendor-agnostic
  and fixture-tested. `parseScrapedNumber` strips ₹/comma/% and returns null on
  non-numbers (no `Number("")===0` trap; a missing selector ⇒ null ⇒ PARSER_ERROR
  downstream, never a fake 0).

Also fixed a live-ops issue: the passcode login was returning 403 only because
the dev server (ts-node-dev, respawns on .ts not .env) predated the ADMIN_PASSCODE
line. Verified end-to-end: wrong code ⇒ 401, correct code ⇒ 200 owner session.

### Still to wire (owner-supplied / next)
- Concrete selector config for a chosen personal-use price site (owner supplies
  URL + selectors to ScrapedPriceSource; Screener stays for fundamentals).
- The context builder that fuses a scraped snapshot with backend-held daily bars/
  forecast/setup/EV into a full LiveStockContext, and the real repositories that
  back the orchestrator's saveRevision/saveEvent/getPreviousRevisionId.
- The cron wiring (10-min schedule with holiday/session calendar) and the
  REALTIME_SHADOW dashboard + Realtime-vs-EOD evaluator.

---

## Ledger filters + selective-prediction analysis (2026-09-25)

Owner asked to (a) filter the Evidence ledger by wrong/correct and (b) "make the
model ≥80% correct". (a) shipped as asked. (b) shipped as the HONEST version:
no directional model gets 80% on every stock every day, so the only truthful
lever is ABSTENTION — measure what hit rate the system would have if it only
spoke above each confidence level. **704 tests / 57 suites green; tsc clean.**

- **Filters**: `/api/evidence/predictions?grade=WRONG|CORRECT|PENDING&ticker=X`
  (parameterized SQL; totals stay whole-table so a filter can never shrink the
  denominator; `filteredCount` reported separately). Frontend: grade chips +
  ticker search on the Evidence tab, server-side so all 8.6k rows are searched,
  not the visible 200.
- **Selectivity** (`selectivity.ts`, PURE + 9 tests): confidence = max(p,1−p);
  per-threshold coverage/hit-rate curve; rates WITHHELD under 30 calls; a
  target is "met" only when the Wilson 95% LOWER BOUND clears it; headline
  states the best supported operating point. Endpoint
  `/api/evidence/selectivity` + included in the bundle + rendered as a card.
- **Measured result on the current champion (4,769 graded)**: 50.4% at full
  coverage; best supported point 53.0% at ≥55% confidence (43.7% coverage);
  max confidence EVER emitted = 63.5%, so no high-confidence tier exists yet.
  The 80% target is not reachable by any operating point today, and the card
  says so verbatim. Wrong rows carried AVOID recommendations — the TradeGate,
  not the raw hit rate, is what protects capital.
- Path to a higher rate (already in the roadmap, no new claims): calibrated
  meta-labeling + regime-conditioned challengers through the existing
  governance battery — models promote only by beating baselines out-of-sample.
