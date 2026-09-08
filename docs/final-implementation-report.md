# Final implementation report — Rules 1–20 (completion Phase 20)

Date: 2026-09-08 · Branch: `upgrade/product-v2` · Policy: `decision-policy-v5`

Status vocabulary (per the completion directive): **VERIFIED** or
**BLOCKED_EXTERNAL** only. Every VERIFIED row cites its evidence: a commit, a
persisted ExperimentRun, a test suite, or a live check performed this session.

Core objective restated: *calibrated, out-of-sample, leakage-free, risk-aware,
honest forecasting*. The measured verdict is that **no model demonstrates
predictive directional edge**, so the product's answer is
**WATCH / INSUFFICIENT EDGE / NO TRADE** — by design, not by omission.

## Rule-by-rule acceptance matrix

| Rule | Status | Evidence |
| --- | --- | --- |
| 1 — Separate scores (setup ≠ probability ≠ confidence ≠ risk ≠ data quality) | **VERIFIED** | ScoreCard with independent sub-scores (`scorecard.ts`); truth panel renders each separately; setup labeled "technical description, not a probability". Commits 696294f…84d7298; live BHEL snapshot shows all fields. |
| 2 — Forecast confidence gate | **VERIFIED** | `decision-policy-v5` gates: fresh issuance, validated edge on ≥10 effective obs, Brier ≤ 0.3, coverage ≥ 60%, dataQuality ≥ 70, forecastConfidence ≥ 60, entryQuality ≥ 40, EV>0, risk<80, regime caps, model-health cap. `tests/decision-policy.test.ts`, `tests/model-health.test.ts` (control fixture reaches BUY_CANDIDATE; each gate caps it). |
| 3 — Fix overlapping backtests | **VERIFIED** | `effectiveSamples = floor(raw/overlap)` everywhere (policy, harness, calibration, ensemble, monitoring); harness additionally evaluates genuinely non-overlapping strides + Newey–West SEs + date-block bootstrap CIs (`harness.ts`, `metrics.ts`). BHEL replay: 39 raw → ~1 effective, gate refuses. |
| 4 — Benchmark everything | **VERIFIED** | ExperimentRuns `1b73e326`, `86b07227`: champion + 8 challengers vs constant-50/zero-return/historical-mean/base-rate/momentum at 1/7/30d. Champion BSS negative at all horizons; recorded, not hidden. |
| 5 — Rebuild forecasting (ForecastModel interface, TS + Python models) | **VERIFIED** | `ForecastModel` interface + 5 baselines + AR1/ridge/logistic (TS) + sklearn worker (`research/worker/worker.py`, elastic-net/logistic/HGB reg+quantile+clf) behind `pythonProvider.ts` with graceful outage degradation. Engineering decision documented in `final-gap-audit.md` §Python; GARCH/deep rejected with reasons in `models.ts`. |
| 6 — Market regime model | **VERIFIED** | `regimeEngine.ts` (regime-v1): market bull/bear × vol (NIFTY 50/200DMA + realized vol + VIX), stock (8 states), sector hook, entryRegime through the market lens; cap-only in policy. `tests/regime-engine.test.ts` (12); live: BHEL bear_low_vol/late_trend. |
| 7 — Entry quality model | **VERIFIED** | `entryQuality.ts` v2.1 (extension, gap-risk, reward/risk, interval width, regime penalty); gate ≥ 40. BHEL replay entry quality 35 ⇒ cap — exactly the failure case it was built for. |
| 8 — EV, not just P(up) | **VERIFIED** | `expectedValue.ts` after-cost EV + reward/risk; EV ≤ 0 caps BUY (policy); fee model in UI. Replay: EV stated (6.10%) yet decision still WAIT on other gates — P(up) alone can never produce BUY. |
| 9 — Calibrated probabilities | **VERIFIED** | Platt/isotonic/beta walk-forward calibration with held-out promotion (`calibration.ts`, `calibrators` table, 39 rows). 1d: 7 promoted (~26 indep obs). 7d/30d: refused (insufficient independent evidence) ⇒ product displays the mandatory text (live-verified on BHEL snapshot: raw 0.7216 kept for audit, shown as unavailable). |
| 10 — Monte Carlo honesty + block-bootstrap validation | **VERIFIED** | Terminology fixed ("historical scenario frequencies"); block bootstrap implemented and VALIDATED OOS: ExperimentRun `3a591851`, 429 non-overlapping anchors — iid coverage closest to nominal ⇒ **iid kept** per pre-registered rule (a successful negative result). |
| 11 — Fundamentals (ROCE, working capital, completeness, availableAt) | **VERIFIED** | `calculateRoce` + `calculateWorkingCapital` in the XBRL pipeline (bank-aware refusals; `tests/event-engine.test.ts`); `fundamentalsCompleteness.ts` reports per-field availableAt (XBRL ingestion time / Yahoo fetch time) + completeness %, stored in snapshots (BHEL honestly 0% XBRL / 50% Yahoo). Yahoo calendar adds `nextEarningsDate`. |
| 12 — News/event engine (structured, tiered, point-in-time) | **VERIFIED** | `structured_market_events` + `EventService`: NSE tier-1 (live: 40 BHEL + 50 RELIANCE announcements), corporate actions tier-2, earnings calendar tier-2 (BHEL 2026-10-15), classified news tier-4 (deterministic keywords, `tests/event-engine.test.ts`). Point-in-time verified: replay at 2026-03-01 sees 0 events. Feeds `regime.upcomingEventRisk`. |
| 13 — AI investment committee | **VERIFIED** (code + tests) / **BLOCKED_EXTERNAL** (live call: no ANTHROPIC_API_KEY in this environment) | Advisory + cap-only + clamped + audit-trailed (`ai_reviews`); context extended with regime, structured events, ensembleForecast (abstention stated), modelDisagreement; key read from env only, never committed; absent key ⇒ honest 503, deterministic decision unaffected (live-verified). |
| 14 — Two different decisions (new entry vs existing holder) | **VERIFIED** | `evaluateHolderPolicy` separate from entry policy; holder REVIEW ≠ sell; separate chips in UI; committee evaluates both separately. |
| 15 — Daily scan redesign (buckets, no forced picks) | **VERIFIED** | Buckets (best new entries — honest emptiness — strong-but-extended, watch-for-pullback, high-risk momentum) + Phase 14 published-gate chips (GATE/SETUP/ENTRY/CONF) on all three Discover sections via `/api/decision/batch` (live-verified over HTTP). |
| 16 — BHEL regression test | **VERIFIED** | `scripts/bhelReplay.ts` (not hardcoded; queries the evidence that existed on 2026-09-04) → `docs/bhel-regression-final.md`: old surface BUY/78.8/63.8% → replay **WAIT** with 3 unmet gates + withheld probability. |
| 17 — UI changes (truth panel, why-not-buy, honest labels) | **VERIFIED** | Truth panel (setup/entry/confidence/data quality/risk/EV/calibration/directional probability), "Why not Buy? / What would change the decision?" gate table, model-health chip, BUY TODAY and "conviction" removed product-wide (grep-clean). |
| 18 — Model monitoring | **VERIFIED** | `ModelHealthService` (rolling Brier/hit/coverage over resolved immutable prediction_logs, overlap-adjusted): HEALTHY/DEGRADED/SUSPENDED/INSUFFICIENT_HISTORY; SUSPENDED hard-caps BUY (policy-v5, tested); `/api/monitoring/model-health` + UI chip; live state today: INSUFFICIENT_HISTORY (~6 independent live dates) — stated, never guessed. |
| 19 — Tests | **VERIFIED** | 24 suites / 281 tests green (leakage invariance, regime, policy gates incl. SUSPENDED cap, calibration held-out discipline, ensemble eligibility/abstention, canonical data, event classifier, ROCE/WC, MC determinism, scorecard, ledger, …). Backend + frontend `tsc` clean; `next build` clean. |
| 20 — Implementation workflow (audit → implement → verify → document) | **VERIFIED** | Phase 0 gap audit (82dec06) → staged commits C1–C10 (each with run/verify evidence) → this report. Offline research clearly labeled; live PredictionLog untouched (the 2026-09-04 BUY rows remain, immutably, as the "before" record). |

## Phase 18 — threshold validation (conservative-only)

Every gate threshold was checked against the measured walk-forward evidence;
**none was loosened**. Where evidence exists it either supports the current
value or argued for keeping it strictly conservative:

| Threshold | Value | Evidence check |
| --- | --- | --- |
| minEffectiveSamples | 10 | With ~94 effective 30d test obs across 40 tickers, per-ticker live counts are ~1 — any lower floor would re-admit the BHEL mirage. KEPT. |
| maxBrier | 0.30 | Champion OOS Brier 0.25–0.26; 0.30 only excludes catastrophically wrong models (ridge 0.42). KEPT (conservative). |
| minBandCoveragePct | 60 | Measured coverage 85–88% (research) / 78.6% (MC study) — a 60 floor only trips on genuine breakdowns. KEPT. |
| Calibrator promotion floor | ≥10 indep hold-out obs + Brier improvement + ECE non-degradation | Enforced in `selectCalibrator`; refused 7d/30d on real data. KEPT. |
| Ensemble eligibility | effN ≥ 10, Brier ≤ 0.26, ECE ≤ 0.1 | Excluded every confidently-wrong challenger; 30d abstention is the correct outcome. KEPT. |
| Monitoring suspension | Brier > 0.35 or coverage < 55% | Chosen before observing the live tape; current live 1d Brier 0.258 / coverage 79.7% would read HEALTHY once history suffices — thresholds only catch real breakdowns. KEPT. |
| MC promotion rule | pre-registered in `mcValidationRun.ts` | Applied as written; challenger failed; champion kept. |

Loosening any of these now requires a persisted ExperimentRun demonstrating the
looser value is safe — per `promotion-policy.md`.

## What remains BLOCKED_EXTERNAL (and only this)

- **Live Claude committee call**: `ANTHROPIC_API_KEY` is not present in this
  runtime environment. Code, clamps, context, storage and the honest 503 path
  are complete and tested; setting the key in `.env` activates it with no code
  change. (Rule 13, runtime half.)

## Experiment registry (persisted, append-only)

| Run | Name | Verdict |
| --- | --- | --- |
| `1b73e326` | walk-forward-research (baselines) | champion BSS < 0 at all horizons |
| `86b07227` | walk-forward-research (+ML worker) | every challenger ≤ baselines; none promotable |
| `02ffd5a8` | calibration-ensemble-study | 7 calibrators promoted @1d only; 7d/30d refused; 30d ensemble abstains |
| `3a591851` | mc-block-vs-iid | iid kept per pre-registered rule |
