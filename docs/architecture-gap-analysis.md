# Architecture gap analysis — the 35-section spec against what is actually built

**Written 2026-09-24, market closed, after four live sessions. Updated the same evening after the barrier layer shipped and the 16:00 promotion was re-evaluated on clean data (see `learning_lessons`, `experiment_runs` note "RE-EVALUATION").**

**Purpose.** The spec ("Build an Adaptive Intraday Trading Intelligence
System", 35 sections, 15 phases) describes a target architecture. This
document maps every section of it against the code and tables that exist in
this repository *today*, with a file or table as evidence for every claim of
"built". It exists so that the spec does not become a reason to rebuild a
tested, evidence-backed system from a template, and so that the genuinely
missing pieces are named precisely and built in the spec's own phase order.

**How to read the status column.**
- **BUILT** — exists, tested, running in production; evidence cited.
- **PARTIAL** — the mechanism exists but is narrower than the spec (usually:
  built for the daily/short-term engine, not yet for intraday).
- **MISSING** — not present in any form.
- **EXCEEDS** — the codebase does something the spec asks for more rigorously
  than the spec itself specifies. Noted because it must not be regressed.

**The one-paragraph honest summary.** The *governance, evidence and learning*
layers the spec calls "most important" (§1, §11, §13, §18, §23, §30, §34) are
BUILT and in several places EXCEED the spec: pre-registered thresholds,
immutable append-only ledgers enforced by database triggers, Deflated Sharpe
Ratio and PBO for overfitting control, purge/embargo walk-forward, and a
champion/challenger promotion rule that has already run against live data. The
*intraday-specific* layers (§2 tick/derivatives ingestion, §4 session-phase
regimes, §5–6 barrier probabilities and multi-horizon MFE/MAE, §16 feature
importance, §19 event-driven backtester, §32 execution-engine) are PARTIAL or
MISSING. The system is roughly at the spec's **Phase 7–9** for the
daily/short-term engine and **Phase 6–7** for intraday. The single most
valuable missing piece — and the one built next — is **barrier-first outcome
labelling** (§5/§6/§11), because it converts the intraday forecast from a
quantity the week's evidence proved untradeable (1-minute direction, 0.3 bps
expected vs 20 bps cost) into one that can, in principle, clear cost.

---

## Section-by-section

| § | Spec asks for | Status | Evidence in this repo | Gap |
|---|---|---|---|---|
| 1 | Every prediction is a hypothesis; NO TRADE when confidence is insufficient | **BUILT / EXCEEDS** | `policy.ts` (v6): WAIT/BUY_CANDIDATE ceilings by data mode; `intradayForecast.ts` `actionable=false` cost gate; every surface labels UNPROVEN below n=10; headline = "least flattering true statement" (`EvidenceService`). 100% of 2026-09-24 intraday calls were refused as NOT ACTIONABLE. | — |
| 2 | Modular ingestion: OHLCV, ticks, 1/3/5/15m bars, bid/ask, VWAP, prev-day OHLC, derivatives, breadth, VIX, events | **PARTIAL** | Ticks: `upstoxStreamProvider` (protobuf, 151 instruments, watchdog). 1-min bars: `barBuilder` (420 retained). Daily: `stock_history`, Yahoo. bid/ask/prevClose on `StreamingSecurityState`. Macro: `macro_observations` (RBI/FRED). Events: `structured_market_events`, `intelligence_*` (NSE filings). Provider abstraction: `RealtimeMarketProvider` / `MarketDataProvider` — push→pull bridge, injectable, fakes in tests. | 3/15m aggregation from 1m (trivial, not done). **No derivatives data at all** (OI, IV, futures basis). No breadth/advance-decline. VIX only daily. |
| 3 | Time-aware data model: `availability_timestamp` on every feature; automated leakage tests | **BUILT / EXCEEDS** (daily) · PARTIAL (intraday) | `prediction_logs` has `prediction_date`/`target_date`/`created_at`; `decision_snapshots` seals inputs by hash and REFUSES replay if the manifest is incomplete (`decisionSnapshot.ts:108`); `completeCandlesOnly` grid-alignment rule (Yahoo synthetic-row bug caught 2026-09-18); purge/embargo splits in `harness.ts`; `tests/harness-overlap.test.ts`, `canonical-data.test.ts`. `market_source_snapshots` records source + fetch time. | No single `FeatureSnapshot` entity with a uniform `availability_timestamp` column across intraday features; `computeFeatures()` output is not persisted per prediction. No survivorship-bias test (universe is a fixed 151 list). |
| 4 | Regime engine gating which strategies may run; session phases (opening/midday/closing) | **PARTIAL** | `regimeEngine.ts` (regime-v1): market `bull/bear × low/high vol`, sector `leading/inline/lagging`, stock and entry regimes; consumed by `policy.ts` and `DecisionService`. | **Daily-scale only.** No intraday session-phase regime (opening 09:15–09:45 / midday / closing 15:15–15:30), despite the U-curve being documented in `intraday-microstructure-notes.md` §4 and visible in our own tick logs. No regime-conditional strategy enable/disable learned from data. |
| 5 | Ensemble of simple→complex models; barrier probabilities P(+a before −b); not direction accuracy alone | **PARTIAL → barrier half BUILT 2026-09-24** | Daily: `models.ts` (ridge/logistic/AR/EWMA/HAR-RV/quant-v1), `ensemble.ts` (validation-built, test-evaluated), `panel.ts` (LightGBM panel via `pythonProvider`); baselines constant-50/base-rate/momentum/zero-return. Daily bracket outcomes TARGET_FIRST/STOP_FIRST/TIMEOUT in `setupExpectancyStudy.ts`; MC bracket walk with MFE/MAE in `evUncertainty.ts`. | Ex-ante P(+0.5% before −0.3%) now stamped on every intraday forecast by seeded MC (`barrierOutcomes.ts`) and graded against the realised bar path. Ensemble/ML for intraday remains not built — deliberately, until the barrier target shows any calibration. |
| 6 | Multi-horizon 5/10/15/30/60m with P(up), E[ret], E[vol], P(target), P(stop), E[MFE], E[MAE] | **BUILT 2026-09-24** | Horizons {1,5,15,30,60}; P(up), E[ret], 80% band, P(target-first/stop-first/neither), realised first-hit, minutes-to-hit, MFE, MAE, returns at 5/10/15/30/60 (`intraday_forecast_outcomes`, migration `1790000000000`). | 10-minute horizon not a forecast horizon (return-at-10 is recorded). E[MFE]/E[MAE] ex-ante not computed (realised only). |
| 7 | Signal engine separate from prediction; full signal record | **BUILT** (daily) · PARTIAL (intraday) | `DecisionService` → `policy.ts` → `decision_snapshots` (sealed, replayable, hash-pinned). Intraday: `buildEntryExitPlan()` produces entry/stop/target/RR/accuracy/actionable — but it is a display object, not a persisted `Signal` entity, and carries no `signal_expiry`. | Persist intraday signals with expiry; `model_probability_calibration` field. |
| 8 | Calibrated confidence; Brier, ECE, AUC, EV, PF, Sharpe, DD, slippage tracked | **BUILT / EXCEEDS** | `calibration.ts` (Platt/isotonic/beta), `calibrators` table with before/after Brier+ECE, promotion only on held-out improvement; `metrics.ts` (Brier, CRPS, ECE, Newey-West SE); `ModelHealthService` rolling Brier/coverage → HEALTHY/DEGRADED/SUSPENDED; `overfitting.ts` **Deflated Sharpe, PBO (CSCV)** — the spec does not ask for these. Band coverage + clears-cost on intraday scorecard (2026-09-23). | ROC/PR-AUC not computed (binary-direction task; Brier/ECE are the right metrics for calibrated probabilities — deliberate). |
| 9 | Trade only on positive EV after costs; regime supports; data quality ok; not duplicated | **BUILT** | `expectedValue.ts` (EV after costs, notional ₹25k); `costs.ts` (intraday schedule 2024-10 + slippage model incl. Seykota fill-ratio); `policy.ts` gates on EV, data quality, regime, model health; `portfolioContext.ts` for correlated exposure. Intraday cost gate `actionable`. | — |
| 10 | Independent risk engine the model cannot override | **BUILT** | `sizing.ts`: `SIZING_LIMITS`, `RISK_LIMITS`, `computePositionSize`, `computeEquityDrawdownPct`, `assessPortfolioRisk`; `riskCritic.ts`; `PreEntryRevalidationService`; data-mode authority ceilings enforce "stale ⇒ WAIT". | Kill switch is not a single named control (`stop` endpoints exist per subsystem). No max-consecutive-losses counter. |
| 11 | Every prediction becomes an evaluation record with target/stop/first-hit/MFE/MAE/returns at 5–60m | **BUILT** (direction) · PARTIAL (barrier fields) | `prediction_logs` (770→1,520 rows, graded nightly); `intraday_forecast_outcomes` (append-only, params + cost + clears_cost + band); `forecast_outcomes`; `short_term_shadow_predictions`. | Built 2026-09-24: first_hit, minutes_to_hit, mfe_pct, mae_pct, returns_at_pct, path_complete on every graded intraday row. Rows graded before the migration carry nulls (not backfilled — honest). |
| 12 | Failure analysis by category; aggregated empirical findings | **BUILT** (mechanism) · PARTIAL (automation) | `learning_lessons` (MISS/COST/CALIBRATION/DATA/PROCESS/REGIME; `action_taken` incl. NONE); 8 lessons written from real failures; `contradictions.ts`, `riskCritic.ts`. | Categorisation is written by hand/LLM, not derived automatically per failed trade. No aggregation query surfaced in UI ("lost 37% within 10 min of an event"). |
| 13 | Scheduled improvement pipeline with statistical gates; never promote on backtest profit alone | **BUILT / EXCEEDS** | `weekly-calibration-refresh` (Sun), `nightly-intraday-calibration` (16:00), `evening-verify-predictions` (18:30) — all durable-logged with auto catch-up. Promotion rules pre-registered in code (`PROMOTION_RULE`, `setupEvidence.ts`). Ran for real 2026-09-24 16:00 (see runbook). | Regime-stratified and multi-symbol tests inside the gate (§13.8–9) — partial: overlap-adjusted effective samples yes; per-regime gates no. |
| 14 | Walk-forward, chronological, never shuffled | **BUILT / EXCEEDS** | `harness.ts` purge+embargo splits; `setupExpectancyStudy.ts` v2 (fixed the v1 in-sample leak — §13.1 trust review); block bootstrap; `intradayCalibrationRun.ts` chronological 60/40 within-session. `tests/harness-overlap.test.ts`. | — |
| 15 | Performance by regime/session/expiry/sector/symbol; strategies self-deactivate | **PARTIAL** | `model_performance`, `short_term_model_performance`, `tiers.ts` (setups earn tier authority; demotion to SHADOW on evidence — `model_governance` has real demotion reasons). Sector on `NSE_UNIVERSE`. | No session-phase or expiry-day breakdown. Self-deactivation exists for setups (tiers), not per-regime. |
| 16 | Feature importance, SHAP, stability, drift, redundancy | **PARTIAL** | `featureRegistry.ts`, `features.ts`; panel LightGBM importance via Python; `model_performance.feature_drift_score`. | No SHAP; no intraday feature importance at all (the intraday model has two features). Intentionally deferred: a model with no edge has no importances worth ranking. |
| 17 | Concept drift detection → flag, reduce confidence, retrain candidates | **PARTIAL** | `ForecastDriftService.ts`; `ModelHealthService` (rolling Brier/coverage → SUSPENDED caps BUY); `kelly_drift`; `stateDelta.ts`. | Feature-distribution drift tests (PSI/KS) not implemented; drift does not yet auto-trigger challenger evaluation. |
| 18 | No self-modification; every model change versioned with dataset/features/periods/approval | **BUILT / EXCEEDS** | `experiment_runs` (dataset_hash, splits, config, used_final_test); `model_governance` + `model_governance_transitions`; `intraday_model_params` (one ACTIVE, immutable rows, evidence jsonb); `model_registry`; DB triggers make prediction_logs, decision_snapshots, live history, learning_expectations, intraday outcomes/params **append-only** — the spec asks for versioning, not immutability. | — |
| 19 | Realistic event-driven backtester: brokerage, taxes, slippage, spread, partial fills, latency, holidays, corporate actions | **PARTIAL** | `quant/backtest.ts`, `setupExpectancyStudy.ts` (costR, slippageR, `slippageStress()` 0–5×), `costs.ts` full Indian fee schedule + Seykota fill-ratio model, `AddAdjustedBars` migration (corporate actions), `SessionCalendarService` (holidays reconciled from bars). | **Bar-level, not event-driven.** No partial fills, no latency model, no intraday backtester over 1-min bars. |
| 20 | Paper trading with predicted vs actual execution, slippage, P&L | **PARTIAL** | `paper_accounts`, `paper_trades`, `short_term_paper_trades`, `shadowFill.ts`, `PreEntryRevalidationService`. | Intraday forecasts are graded but not paper-executed (no simulated fills against the tick stream). |
| 21 | Explainable signals using only factors actually used | **BUILT** | `decision_snapshots.reasons/risks/unmetGates`; `snapshotGrounding.ts` "closes the AI-containment loop" — LLM may only cite sealed snapshot facts; `EvidenceGraphService`. Intraday: `notActionableReason` states the exact bps comparison. | — |
| 22 | Auto trade journal + discovered analytics | **BUILT** (journal) · MISSING (auto-discovery) | `learning_expectations` / `learning_lessons`; Evidence tab (wrong-first ledger). | No automatic mining of "model performs best 09:30–11:00" — see §12 gap. |
| 23 | Champion/challenger; replace only on robust multi-regime/symbol/DD/calibration improvement | **BUILT** | `governance.ts` (`champion-quant-v1` + SHADOW/CANDIDATE/RETIRED challengers with written reasons); `calibrationEnsembleRun.ts`; `intradayCalibrationRun.ts` (4 fixed challengers, pre-registered rule, NULL-model fallback). | Multi-symbol/multi-regime stratification inside the promotion rule. |
| 24 | Benchmarks: buy-and-hold, VWAP, MA, momentum, random, ORB | **BUILT** (daily) · PARTIAL (intraday) | `calibrationEnsembleRun`: baseline-constant50, base-rate, historical-mean, momentum, zero-return. Setup study: 12 setups incl. pullback/breakout/mean-reversion, all vs cost. | Intraday: null model (P=0.5) only. No VWAP-reversion or ORB baseline for intraday. |
| 25 | Source registry with provider, latency, quality, licence | **PARTIAL** | `market_source_snapshots` (source, fetch time), `intelligence_sources`, `snapshotValidation.ts` (SOURCE_DISAGREEMENT quarantine), provider health with reasons. | No single `DataSource` registry table with licence/latency fields. |
| 26 | Market / strategy / model memory in structured DB, not LLM history | **BUILT / EXCEEDS** | 60 tables. My own memory dir is operator notes, explicitly not the model's memory (`honesty-conventions` memory). | — |
| 27 | LLM only for summarisation/explanation/classification, never numeric prediction | **BUILT** | `ai/RoleOrchestrator`, `aiAnalyst.ts`, `ReasoningService` — all grounded on sealed snapshots; numeric models are TS/Python quant code. | — |
| 28 | Daily learning report | **PARTIAL** | Evidence tab live; `cron_execution_logs`; scorecards. `docs/live-sessions/*.jsonl` per session. | No end-of-day generated report with best/worst setup, drift, suggested experiments. |
| 29 | Weekly model review with proposed experiments | **PARTIAL** | `weekly-calibration-refresh` produces experiment_runs + lessons. | No generated review document; experiments proposed by hand (5 registered 2026-09-23). |
| 30 | Experiment tracking, never lose history | **BUILT / EXCEEDS** | `experiment_runs` immutable with dataset_hash; `learning_expectations` claim-immutable, resolution write-once (trigger-enforced). | — |
| 31 | Production safety: kill switch, staleness ⇒ NO TRADE, feed-failure protection, signal expiry, audit | **BUILT** (feed) · PARTIAL (execution) | `tickValidator` (STALE/DUPLICATE/INVALID/SEQUENCE_GAP by reason), stream watchdog + reconnect (recovered a real hang 2026-09-22 in 90 s), `securitiesLive`, universe-wide staleness escalation, data-mode ceilings, cron durable log + catch-up, token vault + feed supervisor (2026-09-24). | No broker, so no order-level protections yet (duplicate-order, reconciliation). Single named kill switch. |
| 32 | Named services, independently testable | **PARTIAL** | Present: market-data (`realtime/`), feature-engine (`featureEngine.ts`, `features.ts`), regime-engine, prediction-engine, signal-engine (`policy.ts`), risk-engine (`sizing.ts`), backtesting (`quant/backtest.ts`), paper-trading, trade-journal, model-registry, experiment-tracker, model-evaluation (`metrics.ts`, `overfitting.ts`), drift-detection, learning-pipeline (`research/`), news/event (`intelligence/`), analytics (`evidence/`), audit (triggers + cron log), dashboard (Next.js). 58 test files. | **execution-engine: MISSING** (deliberately — §35 Phase 15, last). |
| 33 | Entities: MarketData…NewsEvent | **BUILT** (≈18/23) | See table list: stock_history, prediction_logs, decision_snapshots, model_registry, experiment_runs, calibrators, model_performance, paper_trades, structured_market_events, intraday_forecast_outcomes, intraday_model_params, learning_*. | Missing as first-class entities: `FeatureSnapshot`, `MarketRegime` (computed, not stored per prediction), `TradeOutcome` for intraday (→ built next), `DriftEvent`, `DataQualityEvent`, `RiskEvent`, `BacktestRun` (in experiment_runs). |
| 34 | Never "BUY because I think"; always probability + OOS history + RR + expiry | **BUILT** | Entry/exit card: accuracy first and largest, UNPROVEN, cost ratio; decision snapshot reasons. | `signal_expiry` on intraday plans (resolveAt exists; not framed as expiry). |
| 35 | Phase order 1→15; no jumping to live | **FOLLOWED** | Daily engine ≈ Phase 9–11; intraday ≈ Phase 6–7. Broker execution not started. | — |

---

## Where the codebase exceeds the spec — and must not be regressed

1. **Immutability by trigger**, not convention (`reject_live_history_mutation`,
   `reject_expectation_rewrite`). The spec asks for versioning; this prevents
   the edit.
2. **Overfitting control**: Deflated Sharpe Ratio and Probability of Backtest
   Overfitting (`overfitting.ts`). The spec's §13 "robustness" is vaguer.
3. **Pre-registration as a discipline**: runbook pass criteria written before
   the session; `learning_expectations` must state `falsifiable_if` and
   resolve in the future; failed criteria are *amended with the original left
   visible*, never reinterpreted (runbook §3, 2026-09-21).
4. **Corrections are appended, dated, never overwritten** — including my own
   two wrong diagnoses of the 08:45 misses.
5. **Cost as a first-class outcome column** (`clears_cost`), computed at issue
   time from the live schedule.

## Where the spec conflicts with our evidence

- **§6 asks for 5-minute predictions as a first-class horizon.** Four
  sessions of data say a 5-minute realised move averages 11 bps against a
  14.5–20.6 bps round-trip cost — untradeable regardless of accuracy. The
  horizon is kept for *measurement* (it is where the anti-signal is clearest)
  but the barrier-based reformulation below is what can make any intraday
  horizon economically meaningful: a fixed +0.5%/−0.3% bracket is above cost
  by construction.
- **§5's "start with simple models"** is exactly what was done — and the
  simple model's failure (46.5%, 8σ) is the most informative result so far.
  Adding model complexity before changing the *target quantity* would be
  optimising the wrong thing more precisely.

---

## Roadmap — spec phases mapped to this codebase

| Spec phase | Status here | Next concrete step |
|---|---|---|
| 1 Ingestion + history | BUILT (equities) | 3/15m aggregation; derivatives feed is a separate decision (vendor, cost) |
| 2 Features | PARTIAL | Persist `FeatureSnapshot` per intraday forecast (availability-stamped) |
| 3 Regime | PARTIAL | Intraday session-phase regime (opening/midday/closing) from the U-curve |
| 4 Baselines | BUILT (daily) | Intraday VWAP-reversion and ORB baselines |
| 5 Backtester | PARTIAL | 1-min-bar intraday backtester reusing `setupExpectancyStudy` bracket rules |
| 6 Baseline ML | BUILT | — |
| 7 Prediction | PARTIAL → barrier layer BUILT 2026-09-24 | Barrier probabilities + path grading shipped. Next: barrier-probability calibration as the nightly challenger target; session-phase regime if E6/E7 say so |
| 8 Signal + risk | BUILT (daily) | Persist intraday `Signal` with expiry; single kill switch |
| 9 Walk-forward | BUILT | — |
| 10 Paper trading | PARTIAL | Simulated fills for intraday against the tick stream |
| 11 Registry + champion/challenger | BUILT | Add barrier-probability calibration as the challenger target |
| 12 Drift | PARTIAL | PSI/KS feature drift; drift → auto-evaluate challengers |
| 13 Continuous learning | BUILT | Regime-stratified gates |
| 14 Dashboard | BUILT | End-of-day report (§28) |
| 15 Broker execution | **NOT STARTED — by design** | Requires explicit go-ahead; not before paper results exist |

**What will not be built without a decision from the owner:** broker order
routing (§15/§32 execution-engine) and any derivatives data subscription (§2).
Both are cost/risk decisions, not engineering ones.

*Educational tool — not SEBI-registered investment advice.*
