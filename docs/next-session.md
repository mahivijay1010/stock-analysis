# Upgrade progress & next-session checkpoint

**Read first:** `docs/upgrade-spec.md` (binding contract) → `docs/implementation-plan.md` (plan) → `docs/upgrade-audit.md` (evidence) → `ARCHITECTURE.md` (v2 state block at top). Branch **`upgrade/product-v2`**.

## State as of 2026-09-06 — PHASE C COMPLETE (verified live + browser)

Phases A (ce1f1e3), B (8ddeab9), CORS fix (9931095) committed. Phase C implemented fully inline (agents still unavailable — org spend limit).

VERIFIED (live evidence in session log):
- Migration `CreateForecastTables` applied (trading_sessions, forecast_runs, forecast_points, forecast_outcomes; partial unique indexes for next30-per-anchor and month-per-revision; tested down()).
- Calendar reconcile from real bars: 85 observed sessions + 56 weekend + 50 projected weekday rows; future = provisional `weekday_projection`, unexpected closures become explicit `no_data` after 2-day grace. NO invented holiday list (official-calendar ingestion hook exists in the schema).
- Live issuance RELIANCE.NS: anchor 2026-09-04 close ₹1,322; window 2026-09-07→10-06; 30 calendar days rendered, 22 resolved sessions; weekends NULL-quantile rows; pop ≈ 0.49; re-POST returns the SAME run (idempotent). Month 2026-09 original rev 0 covers only remaining days (mid-month rule), 4 actuals listed separately.
- Maintenance endpoint: outcomes 0 examined (all targets future — correct), sweeps no-op on empty watchlist/ledger (correct).
- jest 10 suites / 134 tests green (12 new: per-step MC determinism/ordering/widening/refusal + IST date helpers). Both tsc clean; frontend production build clean.
- Browser (headless Chrome CDP): #stock/RELIANCE.NS → Forecast tab renders daily table ("22 expected sessions · anchored on the 4 Sept 2026 close (₹1,322.00)"), Market-closed rows, 80%/90% intervals, reality check, issuance chip + hash; zero console errors.
- Also fixed inline: frontend axios never sent the CSRF header (`X-Requested-With`) — added to the client defaults; browser mutations would have 403'd.

NOTE: the RELIANCE.NS runs in forecast_runs are GENUINE issuances (real data, real engine, real API) — kept per immutability; the evening job will grade them from 2026-09-07.

ALSO COMPLETE — DecisionService (spec §9, plan-§5 item; acceptance 13.13):
- `decision_snapshots` migration applied; append-only publications; GET /api/decision/:t (stored only) + POST /api/decision/:t/publish (auth) + nightly publishForAll in evening cron.
- Policy v1 (`src/services/decision/policy.ts`, PURE, 12 unit tests): BUY_CANDIDATE requires fresh issuance + VALIDATED directional edge (one-sided 95% > 50%) + calibration + non-extreme vol → honestly unreachable today ("No validated directional edge"). INSUFFICIENT_EVIDENCE on missing/stale/thin evidence; AVOID_NEW_ENTRY on coverage <60% / Brier >0.30 / vol >60%; else WAIT. Separate holdings-review note (never a sell instruction). After-close ⇒ "candidate for NEXT session"; validUntil = next session close.
- LIVE VERIFIED: RELIANCE.NS → WAIT / PARTIAL / low risk, reasons include "43.6% over 39 matured predictions ≈ coin flip", validUntil 2026-09-07 15:30 IST. jest 11 suites / 146 tests green.
- NOT YET: UI surfaces don't render decision snapshots yet (13.14 e2e is Phase E; wire Stock Detail/Watchlist/Discover to GET /api/decision/:t during D/E).

DEFERRED (do in D/E):
- Outcome-grading live check after 2026-09-07 close (first maturation) — verify `verified` rows + band hits appear.
- Month-view UI (original vs latest outlook vs actuals chart) — backend done, no dedicated frontend view yet (spec §5 monthly history display).
- From B: CSV import/export live test, corrections live test, dividends/split live test, SELL-before-BUY validation test.

## OWNER AMENDMENTS (2026-09-06, supersede spec §2 where they conflict)
The owner merged Watchlist + Holdings into ONE unified destination and asked for a risk-based holding-horizon label everywhere. Implemented:
- **Unified Watchlist** (`frontend/src/components/portfolio/PortfolioView.tsx`): watchlist ∪ holdings rows via GET /api/portfolio/overview (one read: held state from ledger, observed price+freshness, THIS month's stored forecast — rolls at month change via the renewal job — latest decision + horizon chips). Rows expand on click; DailyForecastCard (chart+table) mounts ONLY when expanded. AddPurchaseForm + TransactionsPanel live inside the same screen (purchase form collapsed until asked). #holdings → #watchlist redirect; Holdings nav entry removed; old WatchlistView/HoldingsView deleted (git history keeps them). Data model unchanged: watch ≠ own is intact underneath.
- **Horizon suitability** (`src/services/decision/horizonPolicy.ts`, horizon-policy-v1, 8 tests): risk-character classification short/moderate/long from 1y measured vol + max drawdown + stored filings quality score; LONG gated on fundamentals evidence (spec §9); INSUFFICIENT below 200 bars. Stored on decision_snapshots.horizon_suitability (migration applied); published nightly with decisions; shown on unified rows + Stock Detail.
- **DECISION POLICY v2** (important fix): v1 treated daily-logged 30d predictions as independent → BHEL briefly got a mirage BUY_CANDIDATE from 79.5%/39 overlapping windows (~1 independent obs). v2 divides samples by the 30d label overlap before the significance test (spec §8). Regression test pinned ("the BHEL mirage").
- **Stock Detail**: CanonicalDecisionCard on the overview section (same snapshot as the unified list — 13.14).
- Also fixed this session: login field mismatch (email→username, c62d024) and ledger form field mismatch (executedAt→tradeDate, 04d96ba); owner credentials now testing@gmail.com / OWNER_PASS in .env.

## RISK-SPEC REMEDIATION COMPLETE THROUGH T4 (2026-09-08)
Owner's binding risk spec (docs/risk-spec.md, Rules 1-20) delivered in stages:
FIRST audit (docs/decision-audit.md, 167 verified findings) -> SECOND plan
(docs/decision-remediation-plan.md) -> THIRD T1-T4 (commits ad93119, 84d7298,
d6041e6, 9b24c01) -> FOURTH-SIXTH final report (docs/decision-report.md, incl.
Rules 1-20 IMPLEMENTED/VERIFIED/EXPERIMENTAL/BLOCKED table).
Headlines: policy v3 TradeGate (Brier-skill/dataQuality/forecastConfidence/
entryQuality/EV/risk vetoes, thresholds PROVISIONAL restrict-only); ScoreCard
with riskScore/dataQualityScore/forecastConfidenceScore; two-decision
snapshots (new entry vs holder); scan buckets with honest '0 best entries';
truth panel + Why-not-Buy + unmet gates on Stock Detail; conviction/BUY TODAY
vocabulary retired; raw-vs-independent sample counts everywhere; P0 data
fixes (partial-bar to callers, prediction_logs unique index, brief P(up)
substitution, model_version+recency pin, volume/prevClose nulls, NO_DATA
verdict, getUniverse TTL); experiment registry live (first run: all horizons
honestly SKIPPED - 743 verified rows/8 days); block bootstrap EXPERIMENTAL;
AI committee cap-only + ai_reviews audit (honest 503 without ANTHROPIC_API_KEY).
OPEN (see decision-report.md §6): full regime classifier, event engine,
isotonic calibration once data suffices (~mid-Oct for 30d), TS challengers +
Python-worker decision (owner Q5), rolling-skill dashboards, adjusted bars,
Discover per-row gate chips.

## PHASE D IN PROGRESS (plan §6, spec §7–8)
DONE (committed):
- `src/services/experiments/splits.ts`: date-grouped chronological splits with PURGE (label-interval overlap dropped) + EMBARGO (post-boundary gap); dateBlockBootstrap for uncertainty (resample dates in contiguous blocks, never rows). Pure, throws on degenerate configs.
- `src/services/experiments/baselines.ts`: constant-50 Brier (0.25 definitional), train-only base-rate Brier, always-up/majority hit rates, last-price MAE%/RMSE%, EWMA vol (λ=.94, no lookahead — tested), pinball quantile loss, Gneiting-Raftery interval score (+coverage+width).
- tests/experiments.test.ts: 11 tests green (12 suites / 157 total).
- DecisionService done earlier in this session (see above) — that was D-item 4.

REMAINING for D:
1. ExperimentRun entity + registry (immutable run rows: config/splits/dataset-hash/metrics/baseline-comparisons; untouched-holdout discipline).
2. Runner: evaluate the CURRENT engine (shrunk-drift) + baselines over purged splits on real stock_history; report per-horizon vs baselines (spec §8 report set). Expect: no directional edge (state it).
3. Challenger: TS-only regularized logistic/linear on lagged features, shadow-only PredictionLog-style logging (never surfaced). GBM quantile model = BLOCKED pending owner Q5 (Python worker).
4. Promotion gate doc (docs/promotion-gate.md): primary metrics, min evidence, holdout discipline, shadow period.
5. Wire decision snapshots into UI surfaces (Stock Detail first).

## Environment
Backend :5101 (`npm run dev`, single watcher), frontend :3001 (`npx next dev -p 3001`), port 3000 = other project. Postgres `stock_analysis`. Org agent-spend limit hit 2026-09-06 — work inline until reset.
