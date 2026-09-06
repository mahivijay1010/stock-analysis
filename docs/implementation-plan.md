# StockSense India — Implementation Plan (Phases B–E)

Companion to `docs/upgrade-audit.md` (evidence) and `docs/upgrade-spec.md` (binding contract). Everything here is **[PROP]** unless cited as **[OBS]** (observed, see audit) or **[DOC]** (ARCHITECTURE.md claim). No measurements are invented; all row counts / file:line cites come from the Phase A audits.

Standing constraints (spec §1–2, next-session.md): preserve all historical records (prediction_logs 1,793, model_performance 181, ensemble_weights 169, kelly_drift 4, rank_snapshots 302, the paper account); never reset user state; DB deletions only via separate reviewed migration + backup (`backups/stock_analysis_pre_upgrade_20260905.dump` exists, sha256 in `backups/CHECKSUMS.txt`); keep the app usable after every phase; no fabricated numbers.

---

## 1. Migration strategy: getting off `synchronize:true` (Phase B, step 0 — blocks everything else)

[OBS] `src/config/database.ts:48` enables sync whenever NODE_ENV=development, and `.env` sets NODE_ENV=development — the real DB auto-DDLs on every boot. Only one real migration exists (`src/migrations/1788217200000-CreateIntelligenceEngine.ts`). 13 dead zero-row tables are resurrected each boot. Any entity edit under sync = unreviewed DDL; entity removal = silent data drop.

Ordered procedure [PROP, from A3's sketch]:

0. Fresh `pg_dump --schema-only` beside the existing verified backup; record sha256.
1. Set `synchronize: false` **unconditionally**; add explicit `migrationsTableName`.
2. Generate a `BaselineSchema` migration against an **empty scratch DB**; diff its DDL vs the live schema dump; reconcile (especially sync-generated hash constraint names like `PK_5a569a37…`); then **mark it applied** on the live DB via a reviewed insert into the migrations table — never run it there.
3. Verify: boot with sync off produces zero DDL; full jest green; a scratch DB builds from `npm run migration:run` alone.
4. All subsequent schema change is reviewed migrations, each with a tested `down()` (spec §13.20). Separate reviewed migrations (with backup) for: dead-table archive/drop (resolving users/watchlists/positions name collisions — see §8 open question 3), timestamptz normalization, NUMERIC/decimal policy changes, new §11 entities.

**Reversibility:** every migration ships `down()`; the pre-upgrade dump plus schema-only dump allow full restore; marking-applied (not running) the baseline means the live DB is never touched by step 2.

---

## 2. Schema plan per spec §11 concept

Disposition legend: **NEW** = new table via migration; **MIGRATE** = existing data carried into new structure; **REUSE** = existing entity kept (possibly extended); **FREEZE** = existing table kept read-only as historical evidence.

| §11 concept | Disposition | Plan | Existing asset [OBS] |
|---|---|---|---|
| User/Account | NEW (do not reuse dead `users`) | `accounts` (+ auth identity per §8 Q1). Server-side identity on every private route from the first new endpoint. PaperAccount 'admin' row preserved as the desk sandbox's account, linked to the owner account — never grown into a global ledger (spec §3) | `users` table: 0 rows, unreferenced, bcrypt/jwt deps unused — archive/drop in reviewed migration |
| Instrument / InstrumentAlias | NEW + MIGRATE | `instruments` (canonical id, ISIN where obtainable, exchange symbol, name, listing/delisting dates) + `instrument_aliases` (effective-dated symbol/name aliases: ZOMATO→ETERNAL, TATAMOTORS→TMCV/TMPV lineage, LTIM delisted-no-successor). Migrate 151-universe + live stocks rows; flag 10 junk rows as quarantined. `stocks`/`stock_history` remain the bar store keyed to instrument id; resolver guard in persistBars so a provider re-key can't merge companies | Stock (209 rows) + `nseUniverse.ts` hardcoded renames |
| TradingSession | NEW | `trading_sessions` (date, exchange, type: normal/holiday/special/half-day, close time, source, version, override flag). Seed from published NSE holiday lists + observed bar dates; feeds freshness, §5 window math, verification maturity. Replaces `TRADING_DAY_OFFSETS` and the 15:40 heuristic for product logic (heuristic may remain as fetch-time hint only) | none — weekday heuristic only |
| CorporateAction | NEW | `corporate_actions` (instrument, type: split/bonus/dividend/demerger/merger/rename, ex-date, ratio/amount, source, applied-adjustment record). First rows: TMPV demerger 2025-10-14 (fixes the −40.15% fake bar risk), TMCV listing, ETERNAL rename. Entitlement quantity handling per spec §3 | none |
| Watchlist / WatchlistItem | NEW (do not reuse dead jsonb-blob `watchlists`) | Per-item rows: account, instrument, note, selected horizon, optional alert config, created/removed timestamps. Removing an item never touches holdings (§13.1) | dead `watchlists` (jsonb array, 0 rows) |
| Transaction / LotAllocation | NEW + pattern-MIGRATE | Immutable `transactions` (account, instrument, type BUY/SELL/DIVIDEND/SPLIT/CORRECTION, executed date, qty, price, separately recorded charges, idempotency key, correction/reversal linkage — never edited in place) + `lot_allocations` (sell→lot links with stored decimal fee/cost allocation). Reuse the desk's proven FIFO + partial-lot-split + tx-wrapped cash logic (AdminService.ts:333-353, :523-620) rebuilt on decimal.js. PaperTrade stays the desk's own ledger, frozen | PaperTrade ≈ hybrid but mutable (lots decremented in place) |
| Position projection | derive-only (no table) | Computed from transactions/lots on read (the live desk already does this correctly via buildOpenPositions). Dead `positions` editable-aggregate table dropped (it is the anti-pattern §11 forbids) | live pattern good; dead table bad |
| ForecastRun / ForecastPoint | NEW; FREEZE PredictionLog | `forecast_runs` (instrument, issuedAt, featureCutoffAt, anchorSession→trading_sessions, anchorPrice + price basis, model/calibration/policy versions, input-manifest hash, seed) + `forecast_points` (target session/date, median, quantile set p05/p10/p50/p90/p95, mean when genuinely computed, probability fields). **Immutable — no update path exists in code.** Generalizes the proven forecastLock pattern (PaperTrade.entry_context.forecastLock: frozen anchor + bands, never recomputed [OBS]). PredictionLog (1,793 rows) frozen read-only as historical evidence feeding Track Record | PredictionLog ≈ ForecastPoint but delete+reinserted same-day |
| ForecastOutcome | NEW | `forecast_outcomes` separate from points (observed close, observedAt, session verified against trading_sessions, evaluation revision id). Verify job writes here only; never touches forecast_runs/points. Maturity gate = target session's close actually available (§13.9), not bar-index arithmetic | actuals currently written into the same PredictionLog row |
| ModelVersion / EvaluationRun | NEW; FREEZE ModelPerformance | `model_versions` (name, version, artifact hash, promotion status) + `evaluation_runs` (immutable run id, split definition, period, metrics jsonb, experimental/walk-forward/prospective label). GET /api/backtest stops upserting (audit §4 #1). ModelPerformance (181) + model_registry (8) + training_samples (1,206) frozen as artifacts | ModelPerformance = latest-only mutable upsert |
| DecisionSnapshot | NEW | `decision_snapshots` (account-or-public scope, instrument, decisionStatus, intendedHorizon, riskLevel, evidenceStatus, reasons, risks, asOf, validUntil, modelVersion, decisionPolicyVersion). Written by DecisionService on publication; immutable; not subject to the 365-day Analysis cleanup (that cron keeps deleting only legacy `analysis` rows) | none; Analysis rows deleted >365d |
| DataQualityIssue | NEW | `data_quality_issues` (instrument/table ref, type: duplicate-bar/ohlc-violation/ca-jump/missing-session/unit, severity, status: open/quarantined/resolved, evidence). First backfill: TMPV break, 570 duplicate day-rows, 22 orphan 2025-11 prediction_logs, 58 extra stocks rows. Quarantine, never silently delete genuine extremes (§6) | console.warn only |
| MonthlyReport | NEW | `monthly_reports` (account, period, opening/closing snapshot refs, forecast-issuance refs, reconciliation status, version for later corrections). Created by the idempotent month-renewal job (Phase C) | none |
| JobRun | NEW | `job_runs` (job name, run key for dedup/idempotency, status, attempts, started/finished, error, lock holder) backing a **Postgres-based durable queue** (pg-boss proposed, or hand-rolled `FOR UPDATE SKIP LOCKED` — §8 Q4). node-cron becomes just the tick source; ordering per §11: ingestion/finalization → features → forecast → decision publication; verification waits for real closes; monthly rollover + startup recovery catch up without duplicates | cron_execution_logs exists, never written |

**Money policy (spec §4)** [PROP, from audit §6]: decimal.js; money scale 2 (paise), execution/quote prices scale 4, qty integer (instrument-specific quantity policy for corporate-action entitlements); ROUND_HALF_EVEN internally, ROUND_HALF_UP at display; FIFO fee/cost allocation in integral paise with largest-remainder so Σ allocations ≡ totals, allocations stored not recomputed; TypeORM transformer string↔Decimal everywhere (kills the string-typed-as-number bug class); money never in jsonb; timestamptz normalization migration. §4 fixtures (1,010 basis / 90 marked / 190 projected / 70 realized / 606 residual / 2-for-1 split) as deterministic jest fixtures.

---

## 3. API change plan

### 3.1 Fix (read must not mutate) — Phase B
- `GET /api/backtest/:ticker?days=` → returns computed stats **without** upserting ModelPerformance (StockService.ts:853, 902-918 persistence stripped). Official stats only via job-submitted evaluation runs.
- `GET /api/research/:ticker` → non-persisting analyze variant (no Analysis write, no PredictionLog delete+reinsert).
- `POST /api/analyze` → analysis becomes read-computation; forecast issuance moves to the explicit issuance path (Phase C). Interim: analyze stops deleting/rewriting the day's PredictionLog.

### 3.2 Remove — Phase B (per audit feature-removal matrix; redirects per audit §3.1)
`POST /api/portfolio/suggest` · `POST /api/assistant` · `GET /api/options/skew/:t` · `GET /api/position-size/:t` · `GET /api/execution/summary` · `GET /api/admin/daily-plan` · `POST /api/holdings/calculate` (absorbed into real Holdings) — plus cron steps evening-2 (ensemble) and evening-3 (Kelly drift), and frontend api fns/types for each. Removal completeness verified per §13.17.

### 3.3 Add (typed, documented, ownership-enforced; freshness + evidence states in every response schema — quoteTimestamp, quoteType, marketState, latestCompletedBarDate, providerDelay, featureCutoffAt)
- Watchlists: `GET/POST /api/watchlist`, `PATCH/DELETE /api/watchlist/items/:id` (Phase B)
- Transactions/Holdings: `POST /api/transactions` (idempotency key; contradictory qty/price/amount rejected; estimated-input labeling), `POST /api/transactions/:id/correct`, `GET /api/holdings`, CSV import/export (formula-injection-safe) (Phase B)
- Forecasts: `GET /api/instruments/:id/forecast` (current issuance, both window views), `GET /api/instruments/:id/forecast/history` (original vs latest vintages, monthly snapshots) (Phase C)
- Decisions: `GET /api/instruments/:id/decision` (+ holdings review status), batch endpoint for Watchlist/Discover (Phase C)
- Portfolio marked values / projected P&L: `GET /api/holdings/projection` — same distribution transformed, never another model (Phase C)
- Track record (public aggregate): evolve `GET /api/accuracy` + `GET /api/calibration` with live-vs-backtest split, interval width, evaluation dates, limitations (Phase C/D)
- Protected: `POST /api/jobs/...` (authenticated experiment submission, immutable run ids), diagnostics (stress, calibration deep-dive, desk) behind admin authorization (Phase B skeleton, D full)

### 3.4 Frontend
Phase B nav rework to Watchlist/Holdings/Discover/Track Record + Stock Detail drill-down per audit §3.1 redirect map; component dispositions per audit feature-removal matrix (A2's table); one chart + one daily table in Stock Detail (Phase C); required states (loading/empty/**stale**/insufficient-history/blocked-provider/partial-data/pending-verification/error) as shared UI patterns — the OptionsSkewCard NOT_AVAILABLE-with-evidence pattern survives its card's deletion as the generic blocked-provider state; delete fabricated "Systems normal"/"NSE intelligence online" badges (Header.tsx:108-110,123-125) or wire to `/health`.

---

## 4. Phase B — foundations + safe removal + watchlist/holdings slice

Scope (order matters):
1. §1 migration strategy (sync off, baseline migration, scratch-DB verification).
2. **Extract-before-delete**: `computeTradeBreakdown` out of executionStats.ts (keeper prediction-audit imports it [OBS]); `mulberry32` out of montecarlo.ts if the MC cone goes (stress.ts imports it [OBS]); confirm fees.ts/plan.ts untouched (load-bearing for keepers [OBS]).
3. Feature removals per audit matrix rows 1,2,5,8,9 + cron steps + dead npm deps (bcrypt, jsonwebtoken, mathjs, ml-matrix, random-forest-classifier, simple-statistics); archive feature-specific tests (`kelly`, `dcf-prior`, `execution-analytics`, `factor-insights`, `models`) with the experiment code; re-point stress/calibration default legs off desk PaperTrades; goal computation removal (matrix row 7 — DB values preserved); disable `confirmReset` destructive path pending rework.
4. Read-mutation fixes (§3.1 items 1–2; item 3 interim).
5. New entities: accounts/auth skeleton, Instrument/Alias (+ TMPV/LTIM/ETERNAL records), TradingSession, CorporateAction, DataQualityIssue (+ backfill of known issues), Watchlist/Item, Transaction/LotAllocation on decimal.js with §4 fixtures.
6. Watchlist (new default screen) + Holdings vertical slice; nav rework + redirect map; Discover assembled from StocksView skeleton + TopPicks/Leaders merges; Track Record from AccuracyView (+ mobile prominence).
7. Delete orphaned frontend files (VerdictCard, EntryTimingCard, SignalsPanel, CalibrationSection [OBS zero imports]).

Exit: tsc + jest green (with archived suites removed from the run), app usable, §13.17 sweep clean, scratch DB builds from migrations, spec §4 fixtures pass.

**Reversibility:** every removal is a git-revertible commit on `upgrade/product-v2`; DB changes only via migrations with tested `down()`; archived code moves to an `archive/` path outside build/cron rather than deletion where records matter; no destructive data operations (dead-table drop deferred to its own reviewed migration, §8 Q3).

## 5. Phase C — immutable forecasting, projections, verification, renewal

Scope: ForecastRun/Point/Outcome + issuance pipeline (one distribution engine — the shrunk-drift baseline with explicit quantiles; MC cone and ensemble blends already severed in B); DecisionService (BUY_CANDIDATE/WAIT/AVOID_NEW_ENTRY/INSUFFICIENT_EVIDENCE + separate holdings review status; versioned thresholds; "Candidate for next session" after close) + DecisionSnapshot; morning job issues immutable forecasts (replacing PredictionLog delete+reinsert); verification via TradingSession-gated outcomes; two window views (rolling 30 calendar days / calendar month) with every-calendar-day display and "Market closed" states; holdings projected P&L transformed from the same distribution; original-vs-latest vintage UI; monthly renewal + MonthlyReport (idempotent, recoverable); durable JobRun queue; freshness contract (kills `dataStatus:"live"`-on-weekend [OBS]).

Exit: §13 tests 5–10, 12–15 pass; PredictionLog/ModelPerformance frozen; Track Record reads from both legacy evidence and new outcomes with labels.

**Reversibility:** new tables additive; legacy tables frozen not dropped; issuance pipeline behind a switch until verified, with the legacy path removable in a follow-up commit; migrations with `down()`.

## 6. Phase D — experiments, benchmarks, promotion discipline

Scope: experiment registry on ModelVersion/EvaluationRun (immutable run ids, experimental/walk-forward/prospective separation); reproducible baselines (last-price/no-change, documented shrinkage-drift, empirical distributions, EWMA vol; HAR/HAR-X vs a real vol baseline); date-grouped splits with purge/embargo (no random row splits); challenger pipeline (regularized model + one gradient-boosted quantile model — Python research worker if justified, §8 Q5); baseline comparisons per spec §8 (constant-50%, base-rate, always-up, last-price); calibration on held-out matured outcomes; date-block resampling uncertainty; decision-policy evaluation separate from forecasts with costs/slippage; prospective shadow mode before any promotion. If nothing wins: keep the stronger baseline and label "No validated directional edge" (spec §8 — historical measurements say ~coin-flip; do not manufacture improvement).

Exit: §13.11 passes; experiment registry reproducible; promotion gate documented; shadow mode running.

**Reversibility:** experiments are additive artifacts; production model changes only via explicit promotion records, revertible by demotion; the untouched holdout is never consumed by iteration.

## 7. Phase E — hardening, a11y/browsers/perf, observability, release review

Scope: security tests (cross-user access, concurrent sells, replayed imports, CSV injection, rate limiting, secrets); session/CSRF per chosen auth (§8 Q1); backup-restore + migration-rollback drills in an isolated env; structured logs, health/readiness, job/provider/model monitoring, failure alerts; performance with dataset/hardware/concurrency/cold-warm identified (no long computation on page load — rank cold path ~90s [DOC] must move to jobs); browser matrix (Chromium available; Firefox/WebKit reported untested if absent on this machine [OBS: prior audits were Chrome-only]); updated ARCHITECTURE.md, API/schema docs, model/evaluation cards, before-vs-after report, rollback instructions, docs/next-session.md; final report distinguishing IMPLEMENTED / VERIFIED / EXPERIMENTAL / BLOCKED.

**Reversibility:** documented rollback per release step; tested restore from verified backups; no public deployment or commercialization without the spec §12 qualified review.

---

## 8. Open questions needing the owner's decision

1. **Auth approach (blocks Phase B API design):** app is localhost single-user today with no auth [OBS]. Options: (a) full email/password + server sessions (secure cookie + CSRF) — spec-§12-complete, heaviest; (b) single-owner local deployment with a real `accounts` model + one seeded owner and session auth, multi-user-ready but registration disabled — recommended for free-first local use; (c) keep header-key stopgap — not spec-compliant. **Recommend (b).**
2. **Decimal library:** decimal.js (recommended: rounding-mode completeness) vs big.js (smaller). Both free/MIT.
3. **Dead-table disposition** (users, watchlists, positions, portfolios, alerts, stock_metrics, market_context, sentiment_data, fundamental_data, rate_limit_logs + legacy-ML model_registry/training_samples with data): archive-rename (e.g. `legacy_` prefix) vs drop after backup. Name collisions (users/watchlists/positions) force a decision before the new entities land. **Recommend archive-rename in the baseline cleanup migration; drop later.**
4. **Job queue:** pg-boss (maintained, Postgres-only, free) vs hand-rolled `FOR UPDATE SKIP LOCKED` tables. **Recommend pg-boss** unless the no-new-deps preference wins.
5. **Python research worker in Phase D** (spec §7 permits, for gradient-boosted quantile models) vs TS-only challengers. Decides repo layout + artifact exchange format.
6. **TMPV history remediation:** (a) truncate stored TMPV bars to the post-demerger period; (b) keep full series with the pre-demerger segment quarantined via CorporateAction/DataQualityIssue and excluded from model consumers; (c) attempt adjusted-series refetch. **Recommend (b)** — preserves evidence, fixes consumers. Needs sign-off since it changes measured backtest inputs.
7. **22 orphan 2025-11 prediction_logs + 570 duplicate stock_history day-rows + 58 junk stocks rows:** flag via DataQualityIssue only, or also clean up in a reviewed migration? **Recommend flag in B, clean in a dedicated reviewed migration with backup.**
8. **Desk sandbox future:** keep reachable at secondary `#desk` read-only from Phase B, or fully archive UI until the "optional isolated sandbox later"? Records preserved either way.
9. **Node LTS move** (v21.6.1 non-LTS today): pin Node 22 LTS at the Phase B boundary?

---

## 9. Acceptance criteria — spec §13's 20 tests → phase + verification

| § | Test | Phase | Verification method |
|---|---|---|---|
| 13.1 | Watch-only additions create no fictional purchase/P&L | **B** | Integration test: create watchlist item → assert zero transactions/lots/P&L rows; UI shows no P&L; removing item leaves holdings untouched |
| 13.2 | Purchases, partial FIFO sales, corrections, charges, dividends reconcile; overselling rejected atomically | **B** | Ledger integration suite: multi-lot scenarios incl. corrections/dividends; concurrent oversell via two parallel transactions → one rejected, balances intact (serializable/row-lock assert) |
| 13.3 | §4 money fixtures with deterministic rounding | **B** | Jest fixtures encoding 1,010/90/190/70/606/split exactly, on decimal.js; run twice → identical outputs |
| 13.4 | Splits/symbol changes preserve ownership; unrelated instruments never merge | **B** (identity) / **C** (full CA handling) | Unit: 2-for-1 split doubles qty, halves basis, P&L unchanged. Regression fixtures from live findings: LTTS≠LTIM never aliased; TMPV pre/post-demerger bars never treated as one continuous series; persistBars resolver-guard test |
| 13.5 | Backdated holdings never create falsely live historical predictions | **C** | Integration: backdated purchase → earlier dates show actuals + "forecast not recorded"; only genuine stored issuances (issuedAt ≤ date) render as forecasts; reconstructed backtests labeled separately |
| 13.6 | Calendar days display correctly (weekends/holidays/special sessions/Feb/leap/year boundaries) | **B** (TradingSession) / **C** (UI) | Property-based tests over the session calendar incl. 2028 leap Feb, Dec→Jan boundary, a Muhurat special session, an unexpected closure; UI snapshot of a month view with "Market closed" cells |
| 13.7 | Monthly renewal preserves holdings/basis/lifetime history; idempotent after retries/downtime | **C** | Run renewal twice + kill-mid-run then recover → identical single MonthlyReport (unique run key), holdings/cost basis/lifetime P&L byte-identical before/after |
| 13.8 | Original forecasts byte-identical after refreshes/model changes/rollover | **C** | Store serialized-issuance hash at creation; trigger re-analysis, refresh-outlook (new issuance), model-version bump, month rollover → re-read original, hash equal. (Currently impossible: analyze delete+reinserts PredictionLog [OBS] — fixed by ForecastRun immutability) |
| 13.9 | Outcomes cannot mature before target close available; missing observations pending | **C** | Mock calendar/provider: attempt verify before session close-finalization → outcome stays pending; holiday-shifted target resolves to the real session, not bar-index+offset |
| 13.10 | Future bars/filings cannot alter earlier point-in-time forecasts or fitted pipelines | **C** (forecasts) / **D** (training) | Mutate bars/filings after issuance in a test DB → stored issuance + manifest hash unchanged; training-pipeline test asserts feature cutoffs exclude post-cutoff data |
| 13.11 | Train/val/calibration/test labels obey time cutoffs + overlap rules across all stocks | **D** | Unit tests on the registry splitter: date-grouped splits, purge/embargo ≥ longest horizon, no random row splits; leakage probe (deliberately overlapping label rejected) |
| 13.12 | Quantiles don't cross; probabilities bounded; price-basis/P&L transforms consistent | **C** | Property-based tests on the single pipeline: monotone p05≤p10≤p50≤p90≤p95 per horizon; 0≤p≤1; holdings projection = q×(forecast−basis) reconciles with the same distribution |
| 13.13 | No edge / inadequate data → evidence-limited state, not forced buy | **C** | DecisionService unit tests: insufficient history / stale data / unvalidated horizon → INSUFFICIENT_EVIDENCE; Discover renders <5 candidates without padding (removes forced "Top 5" [OBS]) |
| 13.14 | Identical decision context agrees across all UI surfaces | **C** (service) / **E** (e2e) | Single DecisionService + DecisionSnapshot as sole source; e2e: same instrument/timestamp read via Watchlist, Discover, Stock Detail, Holdings APIs → identical decisionStatus/versions |
| 13.15 | Provider failures degrade honestly; no unsafe retries or invented values | **C** / **E** | Fault-injection tests (Yahoo 4xx/5xx/timeout): responses carry blocked-provider/stale states, bounded retries with backoff, no fabricated prices; UI shows the generic blocked-provider pattern |
| 13.16 | No cross-user access to holdings/transactions/exports/private forecasts | **B** (ownership) / **E** (full security suite) | Two seeded accounts; API tests asserting 403/404 on cross-account object ids, exports, private forecast history; identity derived server-side only |
| 13.17 | Removed features: no active jobs, dead routes, orphan imports, hidden requests | **B** (re-checked each phase) | Route-inventory test vs the documented API list; cron job list assert; `tsc` + eslint no-unused + grep for removed symbols; frontend network capture over all screens → zero requests to removed endpoints; `npm ls` shows dead deps gone |
| 13.18 | Core flows on mobile+desktop in Chromium/Firefox/WebKit where supported | **E** | Playwright (or CDP fallback) across available engines at 375/768/1440; **untested browsers reported explicitly** (this machine measured Chrome-only in prior audits [DOC]) |
| 13.19 | Performance measurements identify dataset/hardware/concurrency/cold-warm; no long computation blocks rendering | **E** | Documented perf runs (machine spec, row counts, cold vs warm); assert no page-load path triggers synchronous scans (rank ~90s cold path moved to jobs); Lighthouse re-run vs V11 baseline [DOC: analyze 86/desk 76] |
| 13.20 | Backup restoration + migration rollback/recovery exercised in isolation | **B** (first migrations) / **E** (full drill) | Scratch-DB: restore verified dump; `migration:run` to head; `migration:revert` each step; boot + smoke test after each; documented transcript |

Phase gate: a phase is done only when its mapped §13 rows pass with recorded commands/outputs (spec §13: report failures and unsupported checks; never alter tests to conceal defects).
