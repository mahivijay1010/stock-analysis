# Upgrade progress & next-session checkpoint

**Read first:** `docs/upgrade-spec.md` (binding contract) → `docs/implementation-plan.md` (plan) → `docs/upgrade-audit.md` (evidence) → `ARCHITECTURE.md` (v2 state block at top). Branch **`upgrade/product-v2`**.

## State as of 2026-09-06 — PHASE B COMPLETE (verified live)
Phase A committed (ce1f1e3). Phase B implemented by B1 agent + inline completion after an org spend-limit killed B2/B3/B4 agents mid-flight; all their partial work was completed and verified inline.

VERIFIED (live API evidence in session log):
- sync:false exit (boot = zero DDL; migrations table authoritative; scratch-DB rebuild works)
- decimal money §4 fixtures EXACT via unit tests AND live ledger API (basis 1010 → sell 4@120−₹6 → realized +70.00, 606.00/6 sh)
- oversell atomic reject; watch-only creates no P&L; auth 401 + CSRF enforced; watch-remove never touches holdings (by schema)
- mutating-read proofs: /api/backtest ×2 → model_performance 181→181; /api/research ×2 → prediction_logs 1793→1793
- 7 removed routes → 404; jest 9 suites/122 green; both tsc clean; frontend build clean; :3001 serves
- owner account: username `owner`, password in `.env` OWNER_PASS (regenerate: openssl rand; re-hash via bcrypt script — see git log for the one-liner)
- test artifacts cleaned (ledger/watchlist back to 0 rows; paper account untouched ₹10,000/0 trades)

DEFERRED FROM B (do early in C or E):
- CSV import/export UI + endpoint verification (backend routes exist per api.ts: export.csv/import — untested)
- corrections endpoint live test (corrects_id reversal)
- browser/CDP pass on the new views incl. redirects (plan puts full browser matrix in E; do a smoke earlier)
- SELL-before-BUY date validation edge (trade_date ordering inside FIFO) — add test
- dividends/split transaction types live test (§13.2/.4 partially covered by unit tests only)

## PHASE C NEXT (plan §4): immutable forecasting
1. TradingSession calendar entity + ingestion (real session resolution; replaces weekday heuristic for product dates)
2. ForecastRun/ForecastPoint (immutable issuance: issuedAt, featureCutoffAt, anchorSession/price, basis, target dates, model/calibration/policy versions, input manifest hash) — generalize the forecastLock pattern
3. ForecastOutcome verification job (waits for real target-session closes; pending states)
4. Next-30-calendar-days + calendar-month views (IST; every calendar day rendered; "Market closed" states)
5. Monthly snapshot + renewal job (idempotent, downtime-recovering); original vs latest-outlook issuances
6. Holdings P&L projection = same distribution transformed (no second model)
7. UI: daily forecast/P&L table + one forecast chart with issuance boundary; monthly prediction-vs-actual history

## Environment
Backend :5101 (`npm run dev`, single watcher), frontend :3001 (`npx next dev -p 3001`), port 3000 = other project. Postgres `stock_analysis`. NOTE: org monthly agent-spend limit was hit 2026-09-06 — subagent workflows unavailable until reset; work inline.
