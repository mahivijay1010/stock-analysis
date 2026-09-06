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

## PHASE D NEXT (plan §5, spec §7–9): one engine, evidence-gated decisions, leak-proof validation
1. Experiment registry: model_registry rows for challengers; EXPERIMENTAL labels end-to-end.
2. Leak-proof validation harness (purged/embargoed walk-forward; no test-set reuse for selection).
3. Challenger models run SHADOW-ONLY (log alongside champion, never surfaced as product output).
4. Evidence-gated DecisionService: BUY/HOLD/AVOID + entry gating driven by measured stats with explicit thresholds; remove residual heuristic pathways or label them.
5. Promotion procedure: challenger → champion only on out-of-sample superiority (document the test).

## Environment
Backend :5101 (`npm run dev`, single watcher), frontend :3001 (`npx next dev -p 3001`), port 3000 = other project. Postgres `stock_analysis`. Org agent-spend limit hit 2026-09-06 — work inline until reset.
