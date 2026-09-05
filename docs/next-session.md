# Upgrade progress & next-session checkpoint

**Read first:** `docs/upgrade-spec.md` (the binding contract, verbatim) and `ARCHITECTURE.md` (current-system source of truth). Work happens on git branch **`upgrade/product-v2`**.

## State as of 2026-09-05 (Phase A started)

DONE:
- Git initialized (repo was never under version control). Baseline commits: `2215349` (full tree) + `ba2f283` (frontend absorbed — it was an embedded create-next-app repo, now fully tracked). Branch `upgrade/product-v2` active; `main` = baseline.
- `.gitignore` fixed: lockfiles now tracked (reproducibility); logs/backups excluded.
- Verified DB backup: `backups/stock_analysis_pre_upgrade_20260905.dump` (5.9MB, sha256 in `backups/CHECKSUMS.txt`).
- Spec preserved verbatim at `docs/upgrade-spec.md`.

NOT YET DONE (Phase A remainder — the immediate next work):
1. **Audit workflow** (multi-agent, parallel read-only):
   - Backend inventory: all routes/controllers/services/cron jobs/entities per disposition-table row; removal blast radius; shared-utility overlap (what Kelly/allocation/desk code is reused by keepers).
   - Frontend consumers: component→endpoint map; nav migration (7 tabs → Watchlist/Holdings/Discover/Track Record + Stock Detail drill-down); redirect map.
   - Data/schema gap analysis vs spec §11 required concepts (User/Account, Instrument/Alias, TradingSession, CorporateAction, Transaction/LotAllocation, ForecastRun/Point/Outcome, ModelVersion/EvaluationRun, DecisionSnapshot, DataQualityIssue, MonthlyReport, JobRun). Money-type audit (current numeric transformers → decimal-money lib). **Instrument-identity audit incl. the LTIM→LTTS mapping — spec §6 flags this: LTTS (L&T Technology Services) is a DIFFERENT COMPANY from LTIMindtree (LTIM); verify what our universe actually claims and whether any history was spliced.**
   - Reproducible baseline runner: `npx tsc --noEmit` (both tiers), full `npx jest` (expect 12 suites/178 tests), record versions (`node -v`, package.json deps), DB row counts (prediction_logs, model_performance, paper_trades, stock_history, kelly_drift, rank_snapshots), server state.
2. **Synthesize** `docs/upgrade-audit.md` + `docs/implementation-plan.md` per spec §1 (dependency map, reproducible baseline, risks, feature-removal matrix, schema/API changes, phased acceptance criteria mapped to spec §13's 20 tests).
3. Commit Phase A outputs.

THEN Phase B (first safe slice, per spec §14): navigation cleanup + typed contracts + transaction ledger (NUMERIC + decimal money, FIFO lots, spec §4 fixtures as tests) + watchlist/holdings vertical slice + `synchronize:false` + first reviewed migration. Key spec constraints to honor from the start: multi-account ownership (do NOT grow the single-user desk into a global ledger), immutable forecasts (ForecastRun/Point with issuedAt/featureCutoffAt/anchor/versions/manifest hash), read endpoints must not mutate (fix `GET /api/backtest/:ticker` overwrite), real session calendar (not the weekday heuristic).

## Ground rules already in force (do not relitigate)
- Historical measurements (51% direction, Brier 0.2525, ~85% coverage, ensemble no-win) are historical, not current constants.
- Preserve ALL historical data (paper trades, prediction logs, model performance); archiving ≠ deleting; DB deletions need separate reviewed migration + backup.
- Never reset the paper account; user state.
- Feature removals per the spec's disposition table = remove routes/jobs/imports/deps/tests, keep reusable math, keep records.
- No fabricated numbers anywhere, incl. tests/screenshots (label fixtures).

## Exact next commands
```bash
cd /Users/gouravpundir/Desktop/stock && git status && git log --oneline | head -3   # confirm branch state
# then: launch the Phase A audit workflow (agents read docs/upgrade-spec.md + ARCHITECTURE.md; read-only except docs/)
# then: review + commit docs/upgrade-audit.md docs/implementation-plan.md
```

## Environment notes
- Backend :5101 (`npm run dev`, single ts-node-dev as of Sep 4), frontend :3001 (`npx next dev -p 3001`). Port 3000 = user's other project (dazz_nest) — never touch.
- Postgres db `stock_analysis`. Today Sep 5 = Saturday (no new bars; lastCompletedTradingDate = Fri Sep 4).
- Paper account: ₹10,000, 0 trades (user state — untouched).
