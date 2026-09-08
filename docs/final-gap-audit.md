# Final Gap Audit (Phase 0 of the completion directive, 2026-09-08)

**State verified before any code change:** 17 suites / 219 tests green · backend + frontend
tsc clean · 10 migrations applied (through `CreateAiReviews1788755000000`) · decision layer
per `docs/decision-report.md` · Python 3.13 available; repo-local venv created at
`research/worker/.venv` with **scikit-learn 1.9.0 + numpy 2.5.3** (Homebrew Python is
PEP-668-managed, so a venv is the correct install path).

**Engineering decision (Phase 2, made not deferred):** the ML challengers run in a
**Python worker using sklearn** — ElasticNet, LogisticRegression, and
HistGradientBoosting{Regressor,Classifier} (sklearn's native histogram GBM — the
LightGBM-style model without flaky native builds of lightgbm/xgboost/catboost on macOS).
Deep models (N-HiTS/TCN/TFT) are **rejected on data-sufficiency grounds**: ~500 usable
daily bars per ticker cannot justify them; adding them would be appearance, not science.
The worker is a stdlib-`http.server` microservice on :5102 behind a TS
`ForecastingProvider` boundary; the app functions fully when it is down.

## Rules 1–20 status entering this phase

| Rule | Status | Exact missing work (if any) |
|---|---|---|
| 1 Separate scores | **VERIFIED** | — |
| 2 Confidence gate | **PARTIAL** | thresholds provisional; Phase 18 out-of-sample threshold validation not yet run |
| 3 Overlapping backtests | **PARTIAL** | effective-N + block-bootstrap CI live in gate/registry/display, but no Newey–West/HAC anywhere; no *non-overlapping* evaluation mode; research harness absent |
| 4 Benchmark everything | **PARTIAL** | runner exists, but live-verified data was insufficient (all horizons skipped); no OFFLINE historical walk-forward comparison exists; CRPS not implemented |
| 5 Ensemble rebuild | **NOT IMPLEMENTED** | no ForecastModel interface, no challengers, no Python worker, no EnsembleForecastService, no dynamic OOS weights |
| 6 Regime model | **PARTIAL** | macro 0-100 regime only; no market/sector/stock/entry regime classifier, no confidence coupling, no tests |
| 7 Entry quality | **VERIFIED** | — (regime input arrives in Phase 4 wiring) |
| 8 Expected value | **VERIFIED** | — |
| 9 Calibrated probabilities | **NOT IMPLEMENTED** (display honesty only) | no Platt/isotonic/beta calibrators, no rolling calibration harness, no calibrator storage/promotion |
| 10 MC terminology + block bootstrap | **EXPERIMENTAL** | block bootstrap unwired and UNVALIDATED — Phase 11 comparison (coverage/CRPS/width/tails) not run |
| 11 Fundamentals | **PARTIAL** | missing-data penalties live; ROCE / working capital / cash conversion not computed (XBRL facts exist for ROCE & WC); no per-field availableAt |
| 12 Event engine | **NOT IMPLEMENTED** | no StructuredMarketEvent entity/ingestion/priority; keyword sentiment still the only news signal (labeled crude) |
| 13 AI committee | **VERIFIED (code+tests)** / runtime **BLOCKED_EXTERNAL** | no ANTHROPIC_API_KEY in env — e2e smoke impossible here; context lacks regime/structuredEvents/ensembleForecast fields (they don't exist yet — Phases 4/8/9) |
| 14 Two decisions | **VERIFIED** | — |
| 15 Scan buckets | **VERIFIED** | — |
| 16 BHEL regression | **PARTIAL** | policy/entry-quality shape tests exist; the full **historical point-in-time pipeline replay** (Phase 15) does not |
| 17 UI truth panel | **VERIFIED** (Stock Detail) / **PARTIAL** (Discover rows show no gate state — decisions only published for followed/held) |
| 18 Monitoring | **PARTIAL** | logs+verify+registry live; no rolling Brier-skill/drift monitoring, no HEALTHY/DEGRADED/SUSPENDED states, no SUSPENDED→no-BUY gate hook, no monitoring API/UI; PredictionLog lacks feature/calibrator/regime version columns |
| 19 Tests | **PARTIAL** | 219 green, but the Phase-19 additions (point-in-time features/news, adjusted CAs, calibrator separation, NW, non-overlap, promotion, suspension, regime, event precedence, worker outage) don't exist yet |
| 20 Staged workflow + acceptance | **PARTIAL** | prior report used VERIFIED/PARTIAL/…; the final matrix must reach VERIFIED/BLOCKED_EXTERNAL only |

## Data-foundation gaps (Phase 1 targets, confirmed in code)

- `fetchChart` (src/services/market/yahoo.ts:140) does **not** request `events=div,splits`
  and ignores `indicators.adjclose` — no adjusted series anywhere; corporate actions only
  *detected* (>25% jump flag in dataQuality), never corrected.
- `Bar` has no adjustedClose/splitFactor/dividend/isCompleteSession; `stock_history` has
  no such columns.
- Index/equity missing volume parsed as 0 at yahoo.ts (engine-side guard exists; the
  canonical layer must carry `volume: null` honestly).
- Trading calendar (`trading_sessions`) and staleness/duplicate handling exist and are
  reused by the canonical layer rather than rebuilt.

## Open items list from decision-report.md §6 — mapped to phases here

regime classifier→P4 · event engine→P9 · isotonic calibration→P7 · challengers+worker→P2
· rolling-skill dashboards→P13 · adjusted bars→P1 · Discover gate chips→P14 · block
bootstrap validation→P11 · before/after forecasting comparison→P16 · threshold
validation→P18 · Claude runtime verify→P12 (BLOCKED_EXTERNAL without key).

No code was modified before this audit was written.
