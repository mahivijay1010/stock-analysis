# StockSense India — Phase A Upgrade Audit

Synthesized 2026-09-06 from four parallel read-only audits (A1 backend, A2 frontend, A3 schema/data, A4 baseline) run on branch `upgrade/product-v2`. No code, DB, or server state was modified (SELECT-only psql; servers found running were used as-is).

**Provenance convention (used throughout):**
- **[OBS]** — observed in code or measured live this session (file:line, psql, curl).
- **[DOC]** — documented claim from `ARCHITECTURE.md` not independently re-verified here.
- **[PROP]** — proposal constrained by `docs/upgrade-spec.md` (the binding contract).

---

## 1. Reproducible baseline (run 2026-09-06, Sunday, ~07:04–07:10 IST) [OBS]

### 1.1 Environment

| Item | Command | Observed |
|---|---|---|
| Date at run | `date` | `Sun Sep  6 07:04:24 IST 2026` (Sunday; last completed trading day = Fri 2026-09-04) |
| Node | `node -v` | `v21.6.1` (non-LTS, via nvm) |
| npm | `npm -v` | `10.2.4` |
| Branch | `git branch --show-current` | `upgrade/product-v2` |
| Log | `git log --oneline \| head -3` | `3585fda` Phase A checkpoint · `ba2f283` Baseline: absorb frontend into monorepo · `2215349` Baseline: full working tree pre-audit |
| Working tree | `git status --short` | clean |
| PostgreSQL | `SELECT version()` | PostgreSQL 14.15 (Homebrew), aarch64-apple-darwin23.6.0 |

Backend deps (`npm ls --depth=0`): express@4.21.2, typeorm@0.3.27, pg@8.16.3, typescript@5.9.3, ts-node@10.9.2, ts-node-dev@2.0.0, jest@29.7.0, ts-jest@29.4.5, axios@1.13.1, node-cron@4.2.1, mathjs@15.0.0, ml-matrix@6.12.1, simple-statistics@7.8.8, random-forest-classifier@0.6.0, bcrypt@6.0.0, jsonwebtoken@9.0.2, dotenv@16.6.1, cors@2.8.5, pdf-parse@1.1.1, reflect-metadata@0.1.14. Frontend deps: next@16.0.1, react@19.2.0, tailwindcss@4.1.16, recharts@3.3.0, framer-motion@13.1.1, @tanstack/react-query@5.90.5, axios@1.13.1, lucide-react@0.552.0 (one flag: `@emnapi/runtime@1.6.0 extraneous`). Matches the documented stack [DOC confirmed by OBS].

### 1.2 Typecheck + tests

- `npx tsc --noEmit` (root): **exit 0, no output**.
- `cd frontend && npx tsc --noEmit`: **exit 0, no output**.
- `npx jest` — verbatim tail:

```
PASS tests/execution-analytics.test.ts
PASS tests/factor-insights.test.ts
PASS tests/intelligence-quality.test.ts
PASS tests/rank.test.ts
PASS tests/dcf-prior.test.ts
PASS tests/kelly.test.ts
PASS tests/stress.test.ts
PASS tests/intelligence.test.ts
PASS tests/volforecast.test.ts
PASS tests/models.test.ts
PASS tests/quant.test.ts
PASS tests/montecarlo.test.ts

Test Suites: 12 passed, 12 total
Tests:       178 passed, 178 total
Snapshots:   0 total
Time:        1.661 s
Ran all test suites.
```

Exactly matches the documented claim (12 suites / 178 tests) [DOC confirmed by OBS]. Cosmetic: repeated ts-jest `isolatedModules` deprecation warnings.

### 1.3 Database row counts (psql `stock_analysis`, SELECT-only)

| Table | Rows | Notes |
|---|---|---|
| stocks | 209 | vs 151-ticker universe — 58 extra (ad-hoc/legacy incl. AAPL/TSLA/GOOGL/MSFT/META junk rows with 0 bars) |
| stock_history | 94,039 | 93,469 distinct (stock_id, trading_date) → 570 duplicate day-rows, deduped at read "latest wins" |
| prediction_logs | 1,793 | verified (actual_return NOT NULL): 743 (2026-08-27..09-03); pending: 1,050 — incl. **22 legacy orphans dated 2025-11-02..06** that will never verify |
| model_performance | 181 | 30 more than universe — consistent with the documented `GET /api/backtest` upsert side effect |
| analysis | 573–574 | (both counts observed across A3/A4 runs; table name is `analysis`) |
| ensemble_weights | 169 | experiment artifact — preserve |
| rank_snapshots | 302 | since 2026-09-01 — retain for evaluation |
| kelly_drift | 4 | experiment artifact — preserve |
| paper_accounts | 1 | `admin`, start_capital 10,000.00, cash 10,000.00, **target_amount 100,000.00 / target_days 30** (active wealth-milestone record; user state — preserve row, remove goal computation) |
| paper_trades | 0 | ideal ledger-migration window |
| intelligence_sources / _metrics / _evidence | 208 / 175–181 / 0 | |
| financial_facts | 6,091 | **not in ARCHITECTURE.md entity list** |
| macro_observations | 5 | |
| **Dead tables (0 rows, zero code refs)** | users, portfolios, positions, watchlists, alerts, market_context, stock_metrics, cron_execution_logs, sentiment_data (4), fundamental_data (2), model_registry (8), training_samples (1,206), rate_limit_logs (103) | resurrected on every boot by `synchronize:true`; several with legacy data — preserve as artifacts, drop/archive only via reviewed migration |

### 1.4 Server state + live behavior

- `lsof`: **:5101** node PID 90001 (ts-node-dev backend, up ~1d13h, single instance); **:3001** next-server v16.0.1 (up ~6d); :3000 = user's other project (untouched).
- `curl http://localhost:5101/health` verbatim: `{"success":true,"data":{"status":"ok","service":"Indian Stock Analysis & Prediction System","timestamp":"2026-09-06T01:36:02.187Z","db":true}}`
- `POST /api/analyze {"ticker":"RELIANCE"}`: success, 65,564 bytes. Quote `price 1322, asOf 2026-09-04T09:45:00.000Z` (Fri 15:15 IST); chart last bar `2026-09-04` close 1322 (= quote); analysis score 59 HOLD, directionProb ~0.52 at every horizon; entryTiming WAIT 59.5. **`dataStatus:"live"` on a Sunday for a Friday quote — live, reproducible spec §6 violation.**
- `GET /api/accuracy` (updatedAt 2026-09-04T13:00:13Z) overall table verbatim:

| horizonDays | samples | directionHitRatePct | avgAbsErrorPct | avgPredictedPct | avgActualPct | withinBandPct |
|---|---|---|---|---|---|---|
| 1 | 10679 | 51.36 | 1.3118 | 0.029 | 0.07 | 86.44 |
| 3 | 10498 | 50.75 | 1.8694 | 0.0473 | 0.1338 | 86.45 |
| 7 | 9955 | 51.45 | 2.9519 | 0.0957 | 0.2816 | 87.26 |
| 15 | 9050 | 51.15 | 4.2802 | 0.1642 | 0.6101 | 86.73 |
| 30 | 7059 | 50.22 | 6.5438 | 0.2729 | 1.5509 | 85.22 |

Consistent with documented claims (direction 50–51.5%, ~85% band coverage). Samples overlap across horizons — not independent observations.

### 1.5 Exact reproduction commands

```bash
cd /Users/gouravpundir/Desktop/stock
node -v; npm -v; git branch --show-current; git log --oneline | head -3
npm ls --depth=0
(cd frontend && npm ls --depth=0)
npx tsc --noEmit                     # exit 0
(cd frontend && npx tsc --noEmit)    # exit 0
npx jest                             # 12 suites / 178 tests, ~1.7s
psql -d stock_analysis -c "SELECT count(*) FROM prediction_logs WHERE actual_return IS NOT NULL;"  # 743
lsof -nP -iTCP:5101 -sTCP:LISTEN
curl -s http://localhost:5101/health
curl -s -X POST http://localhost:5101/api/analyze -H 'Content-Type: application/json' -d '{"ticker":"RELIANCE"}'
curl -s http://localhost:5101/api/accuracy
```

### 1.6 Baseline drift log (documented vs observed)

1. Universe file has exactly 151 entries — MATCHES [DOC=OBS].
2. stocks 209 / model_performance 181 / ensemble_weights 169 all exceed the 151 universe — undocumented ad-hoc/legacy rows [OBS].
3. 15 tables in DB absent from ARCHITECTURE.md's entity list (several with data) [OBS].
4. `dataStatus:"live"` for a weekend-cached Friday quote — spec §6 drift, reproducible [OBS].
5. 22 orphaned pending prediction_logs from 2025-11 inflate the pending count [OBS].
6. paper_accounts carries an active ₹1L/30d milestone target [OBS].
7. ARCHITECTURE.md API list omits three endpoints the frontend actually consumes: `GET /api/stocks`, `GET /api/stocks/:ticker/chart`, `POST /api/holdings/calculate` [OBS vs DOC].
8. `frontend/src/lib/api.ts:223` defines `GET /api/admin/trades` but no such backend route exists (only POST) — dead client path with zero component consumers by default (AdminView calls it only when the account payload lacks trades) [OBS].

---

## 2. Dependency map — observed vs documented

### 2.1 Backend HTTP surface [OBS] — all mounted at `/api` via `src/app.ts:33` → `src/routes/index.ts` (+ `src/routes/admin.ts` at `/api/admin`)

| Route | Handler → Service | Side effects on request | Spec §2 disposition |
|---|---|---|---|
| `GET /health` | app.ts:20 | none | keep |
| `GET /api/admin/account` | AdminService.getAccount (AdminService.ts:623) | first call seeds paper_accounts (routes/admin.ts:20); bar cache-fill | desk: out of primary |
| `POST /api/admin/account/settings` | AdminService.updateSettings (:907-979) | **`confirmReset:true` DELETEs all paper_trades (:968)** | rework; strip goal fields |
| `POST /api/admin/trades` | AdminService.recordTrade (:212) | writes PaperTrade (+forecastLock/entry_context on BUY), cash | desk: preserve records, extract logic |
| `GET /api/admin/daily-plan` | AdminService.getDailyPlan (:1027) | calls portfolioService.suggest per request; bar writes | **remove** (cash-split + pick + goals) |
| `GET /api/admin/prediction-audit` | AdminService.getPredictionAudit (:1214) | read-only (+bar cache) | keep → Track Record (protected) |
| `GET /api/admin/forecast-locks` | AdminService.getForecastLocks (:424) | read-only (+bar cache) | extract lock logic; archive route |
| `POST /api/holdings/calculate` | HoldingsService (stateless, 270 ln) | none (bar cache only) | merge into real Holdings |
| `POST /api/portfolio/suggest` | PortfolioService.suggest (:102) | none persisted | **remove** |
| `GET /api/portfolio/stress` | PortfolioService.stress (:535) | none; **defaults legs to desk open PaperTrades (:506)** | retain risk calc; re-point default |
| `GET /api/portfolio/calibration` | PortfolioService.calibrationFor (:650) | read-only | retain (diagnostics) |
| `POST /api/assistant` | AssistantService (401 ln) | none | **remove (Sensei)** |
| `POST /api/intelligence/macro/refresh`, `POST /api/intelligence/:t/refresh` | IntelligenceController | network fetch + intelligence_* writes (intended) | keep; isolate MoSPI |
| `GET /api/intelligence/:t`, `/macro`, `/source-registry`, `POST /portfolio` | IntelligenceService | read-only | keep |
| `GET /api/rank/universe` | RankService.getRankUniverse (:296) | no rank writes (persist is cron-only); cache-fill; ~90s cold [DOC] | merge → Discover; retain snapshots |
| `GET /api/volatility/forecast/:t` | VolatilityService.getForecast | read-only (+bar cache) | keep as labeled diagnostic |
| `GET /api/options/skew/:t` | OptionsRadar.getSkew | NSE probe every 30 min per request; **permanently NOT_AVAILABLE (Akamai 403)** [OBS] | **remove** |
| `GET /api/position-size/:t?capital=` | PositionSizeService (:72) | read-only | **remove (consumer Kelly)** |
| `GET /api/execution/summary` | ExecutionAnalyticsService.getSummary (:149) | read-only | **remove (adaptive execution feedback)** |
| `GET /api/search` | StockService.search | may create stocks rows via resolve/persist | keep |
| `POST /api/analyze` | StockService.analyze (:194-406) | writes Analysis + **delete+insert PredictionLog** for that day (:602-640) | keep, consolidate; issuance rework |
| `GET /api/top-picks` | StockService.getTopPicks | 30-min cached scan; no prediction logging (:719) | merge → Discover |
| `GET /api/backtest/:t?days=` | StockService.runBacktest (:836) | **upserts ModelPerformance with caller's N (:853, :902-918)** | fix: read must not mutate |
| `GET /api/accuracy` | StockService.getAccuracy (:921) | read-only | keep (Track Record) |
| `GET /api/calibration` | StockService.getCalibration (:1026) | read-only | keep; ensemble sub-blocks go |
| `GET /api/research/:ticker` | StockService.getResearchBrief (:1305) | **calls analyze() (:1306) → mutates Analysis + PredictionLog on a GET** | keep brief; fix mutation |
| `GET /api/stocks/popular`, `/api/stocks`, `/api/stocks/:t/chart`, `/api/stocks/:t/history` | StockController | read-only + bar cache-fill | merge → Discover / Stock Detail |

### 2.2 Cron jobs [OBS] — `src/services/CronService.ts` (Asia/Kolkata, in-process node-cron; no persistence, no locks; JobRun concept absent — `cron_execution_logs` exists but is never written)

| Job / step | Schedule | Writes | Disposition |
|---|---|---|---|
| morning 1: refreshUniverseBars → seedUniverse | 08:45 M-F | stocks, stock_history | keep |
| morning 2: scanUniverse({logPredictions:true}) | ″ | PredictionLog (delete+insert per ticker/day) | keep → becomes immutable issuance (rework) |
| morning 3: rankService.persistTodaySnapshot (:130) | ″ | rank_snapshots upsert | retain (spec row 2) |
| morning 4: rotatingIntelligenceRefresh (:143) | ″ | intelligence_* | keep |
| evening 1: verifyMaturedPredictions (StockService.ts:1703) | 18:30 M-F | PredictionLog actuals + ModelPerformance upsert (pool-merged :1772) | keep verify; drop pool merge |
| evening 2: ensembleService.updateFromLatestMaturedDay (:202) | ″ | ensemble_weights | **stop** (FTRL out of production) |
| evening 3: recordDriftSnapshot (:215) | ″ | kelly_drift upsert | **stop** (Kelly drift) |
| midnight-cleanup-analyses | 00:00 | deletes Analysis >365d | keep (conflicts with DecisionSnapshot reuse — see plan) |
| weekly-official-filings-refresh (:234) | 20:15 Sat | env-gated ticker refresh + refreshMacro → RBI + **MoSPI** (IntelligenceService.ts:148) | keep; config-gate MoSPI |

**No cron exists for allocation, cash-split, goals, Kelly consumer advice, or options** — the "daily cash-split" is request-time inside `GET /api/admin/daily-plan` (AdminService.ts:1127-1142).

### 2.3 Frontend consumers [OBS] — all traffic through `frontend/src/lib/api.ts` (axios, `{success,data}` envelope, base `NEXT_PUBLIC_API_URL || http://localhost:5101`); zero `fetch`/`axios` outside it; all 24 exported api fns have ≥1 consumer; `x-admin-key` attached only when `NEXT_PUBLIC_ADMIN_KEY` set → **no auth by default**

| Component (frontend/src/…) | Endpoint | Notes |
|---|---|---|
| analyze/SearchBox.tsx (mounted 3×) | GET /api/search | header, mobile bar, launchpad |
| analyze/AnalyzeView.tsx | POST /api/analyze | one payload feeds StockHero, DecisionSummary, ForecastChart, ProjectionsTable, MonteCarloCard, NewsPanel, EnsembleCard, FrameworkPanel, TechnicalsGrid, AccuracyStrip, TradePlanCard, RecentWindowsPanel (prop-fed) |
| analyze/PriceChartCard.tsx | GET /api/stocks/:t/chart | range selector |
| analyze/InvestmentBriefCard.tsx | GET /api/research/:t | 404-hides |
| analyze/VolForecastCard.tsx | GET /api/volatility/forecast/:t | 404-hides |
| analyze/OptionsSkewCard.tsx | GET /api/options/skew/:t | renders NOT_AVAILABLE evidence |
| analyze/KellySizingCard.tsx | GET /api/position-size/:t | half-Kelly headline |
| HoldingCalculator.tsx (mounted 2×) | POST /api/holdings/calculate | AnalyzeView + AdminView |
| TopPicksView.tsx | GET /api/top-picks?count=5 | budget in localStorage `stocksense.topPicksBudget` |
| LeadersView.tsx | GET /api/rank/universe | ~90s cold [DOC] |
| StocksView.tsx | GET /api/stocks | universe table |
| PortfolioView.tsx | POST /api/portfolio/suggest | |
| StressTestCard.tsx (mounted 2×) | GET /api/portfolio/stress | Portfolio + AdminView |
| AccuracyView.tsx | GET /api/accuracy | |
| CalibrationPanel.tsx + ModelsSection.tsx | GET /api/calibration | shared query cache |
| admin/AdminView.tsx | GET /api/admin/account (**60s poll — only polling in app**), GET /api/admin/daily-plan, GET /api/admin/trades (dead route), POST /api/admin/trades | |
| admin/SettingsCard.tsx | POST /api/admin/account/settings | confirmReset double-confirm |
| admin/PredictionAudit.tsx | GET /api/admin/prediction-audit | |
| admin/PerformanceFeedbackCard.tsx | GET /api/execution/summary | Kelly drift + factor insights |
| admin/ForecastLockCard.tsx | GET /api/admin/forecast-locks | |
| assistant/ChatWidget.tsx (global FAB) | POST /api/assistant | fetch only on send |

**Endpoints with zero frontend consumers** [OBS]: `GET /api/backtest/:t` (script/backend only — the mutating read), `GET /api/portfolio/calibration`, all `/api/intelligence/*`, `/health` (the Header's "Systems normal" / "NSE intelligence online" badges are hardcoded, not backed by any fetch — Header.tsx:108-110,123-125).

**Already-orphaned frontend files (zero imports)** [OBS]: `analyze/VerdictCard.tsx`, `analyze/EntryTimingCard.tsx`, `analyze/SignalsPanel.tsx`, `CalibrationSection.tsx`.

### 2.4 npm dependency audit [OBS]

- Used: axios, cors, dotenv, express, node-cron (CronService only), pdf-parse (CompanyDocumentSource only), pg, reflect-metadata, typeorm.
- **Unused (0 imports in src/scripts/tests): bcrypt, jsonwebtoken, mathjs, ml-matrix, random-forest-classifier, simple-statistics (+ @types/bcrypt, @types/jsonwebtoken)** — legacy ML/auth residue, removable immediately.
- No dependency is exclusive to any removal-candidate feature (Kelly/ensemble/allocation/Sensei/desk/goals are pure TS).
- No decimal-money library is installed anywhere.

---

## 3. Feature-removal matrix

Per spec §2: removing = routes + scheduled calls + imports + deps + feature-specific tests + doc references; preserve records and reusable math; DB deletion only via separate reviewed migration.

| # | Disposition row | REMOVE (files/routes/jobs) | EXTRACT / KEEP | Tests | Blast radius [OBS] |
|---|---|---|---|---|---|
| 1 | **Kelly sizing / drift / adaptive execution feedback** | `src/services/quant/kelly.ts`, `quant/dcfPrior.ts`, `PositionSizeService.ts` (411), `admin/ExecutionAnalyticsService.ts` (233), `scripts/recordKellyDrift.ts`; routes `GET /api/position-size/:t`, `GET /api/execution/summary`; evening cron step 3; frontend `KellySizingCard.tsx`, `KellyAppliedBadge.tsx`, `admin/PerformanceFeedbackCard.tsx`, api fns `getPositionSize`/`getExecutionSummary` | **Extract `computeTradeBreakdown` from `admin/executionStats.ts`** — imported by keeper `AdminService.getPredictionAudit` (AdminService.ts:31). `kelly_drift` (4 rows) preserved as archive | Archive `tests/kelly.test.ts`, `dcf-prior.test.ts`, `execution-analytics.test.ts`, `factor-insights.test.ts`; keep TradeBreakdown assertions | Only importers of kelly/dcfPrior are the two removed services. PositionSizeService reads ModelPerformance/PaperTrade read-only — safe to sever |
| 2 | **Six-model voting + FTRL** | `src/services/quant/models/` (10 files), `ensemble/EnsembleService.ts` (237), `scripts/updateEnsemble.ts`; evening cron step 2; frontend `EnsembleCard.tsx`, `ModelsSection.tsx` → protected diagnostics, `lib/models.ts` (mostly) | `ensemble_weights` (169 rows) preserved as experiment artifact; `ModelPerformance.horizons[].models/ensemble` jsonb keys stop being written (historical rows untouched) | Archive `tests/models.test.ts`; `tests/quant.test.ts` unaffected | 5 production touchpoints to sever in StockService: buildEnsembleBlock (:415-480); pop7d 50/50 MC×ensemble blend (:312-339 → MC-only fallback); backtestWithModelPool merge (:863-877 — affects GET /api/backtest, evening verify :1772, scripts/refreshBacktests.ts); getCalibration per-model/modelDrift blocks (:1057-1275); cron step |
| 3 | **Forecast chart / MC cone / repeated rupee tables → ONE pipeline** | `analyze/MonteCarloCard.tsx`; the three parallel probability engines in one analyze() response (engine bands, seeded 10k bootstrap MC pop/quantiles, ensemble blendedProbUp + pop7d blend) collapse to one distribution pipeline | **`mulberry32` (quant/montecarlo.ts:16) must survive any MC removal — `quant/stress.ts` imports it.** ONE chart (merge PriceChartCard + ForecastChart), ONE daily table (rebuilt ProjectionsTable) | `tests/montecarlo.test.ts` follows whatever pipeline survives; `tests/stress.test.ts` keeps | Rupee projections currently rendered in ≥5 places (ProjectionsTable, TopPicks BudgetProjection, AllocationCard CombinedOutcomes, HoldingCalculator, TodayPlanCard) — all but one die |
| 4 | **Standalone holdings calculator → real Holdings** | Route `POST /api/holdings/calculate` absorbed; `HoldingCalculator.tsx` (both mounts) | `HoldingsService` fee math + NIFTY compare reused by real holdings; `framework/fees.ts` is load-bearing (HoldingsService, AdminService, PortfolioService, plan.ts) | none exist | AssistantService was the only other consumer (itself removed) |
| 5 | **Allocation builder + daily cash-split** | Route `POST /api/portfolio/suggest`; `PortfolioService.suggest()`; allocation block of `GET /api/admin/daily-plan` (AdminService.ts:1127-1142); frontend `PortfolioView.tsx`, `AllocationCard.tsx` | Retain `stress()`/`calibrationFor()` + `quant/stress.ts` (spec: reusable risk calcs) — **but both default legs to desk open PaperTrades (:506) → re-point to real holdings**; keep `downloadAllocationCsv` pattern for Holdings export | No tests cover suggest() (blast-free); `tests/stress.test.ts` stays | Inbound importers of portfolioService: AdminService (daily plan), AssistantService (removed), PortfolioController |
| 6 | **Paper Trading Desk → secondary; preserve records; extract logic** | Out of primary nav; `GET /api/admin/daily-plan` removed; AdminView becomes secondary route | **Extract:** FIFO lot matching with partial-lot split + fee allocation (executeSell :523-620); cash-sufficiency BUY in DB transaction (:333-353); **forecastLock issuance** (executeBuy :296-317 — freeze anchor close + 7d/30d band + targetDate, never recomputed) + grading (getForecastLocks :424-521); entry_context snapshot (:381-414); derive-don't-store equity curve. PaperAccount (1 row) + PaperTrade (0 rows) preserved | none desk-specific | Keepers reading PaperTrade: PortfolioService stress/calibration defaults (re-point). **Danger: updateSettings confirmReset hard-DELETEs paper_trades (:968) — must not survive into multi-account product as-is.** Admin routes have no auth unless ADMIN_KEY set (routes/admin.ts:24-38) |
| 7 | **Wealth milestones / target-growth / guaranteed copy → DELETE** | `milestonesFor` (AdminService.ts:92-107), `goalParams`/`buildGoalTracker` (:853-905), `buildRealityCheck` (:983-1023), goal fields in updateSettings (:907-979), types GoalMilestone/GoalTracker (src/types/index.ts:247-268), goals in account (:642) + goalTracker/realityCheck in daily-plan (:1122-1153); frontend `admin/GoalStepper.tsx`, EquityCurveChart milestone overlay (:28,98-136,200), CommandDeck "Challenge day X of Y" (AdminView.tsx:159-203), SettingsCard challenge fields (:18-23,77-80) | `PaperAccount.targetAmount/targetDays/challengeStartedAt` **columns/values preserved** (user state) — computation removed. RealityCheck honesty pattern kept as plain-disclaimer copy guidance | none cover goals | Response-shape surgery on 2 desk GETs; no cron, no dedicated route |
| 8 | **Sensei chatbot** | `assistant/AssistantService.ts` (401), AssistantController, route `POST /api/assistant`; frontend `assistant/ChatWidget.tsx` (global FAB), api fn `askAssistant` | nothing | none | **Zero inbound importers — cleanest removal in the codebase.** No exclusive npm dep (rule-based) |
| 9 | **Options skew / MoSPI / dead providers** | `market/OptionsRadar.ts` (307; measured permanently Akamai-403), route `GET /api/options/skew/:t`, frontend `OptionsSkewCard.tsx` (its NOT_AVAILABLE-with-evidence *pattern* must survive as the generic blocked-provider state) | Config-gate `MoSPIDataSource` (wired into refreshMacro, IntelligenceService.ts:148 — returns nothing without key); keep RBI path. BSEDataSource/CompanyDocumentSource stay latent (CompanyDocumentSource is sole pdf-parse consumer) | none | OptionsRadar outbound dep `rankService.topTickersByMarketCap` (RankService.ts:345) is reverse — removal harmless |
| 10 | **8-phase framework → concise reasons** | FrameworkPanel.tsx; masterScore KeyMetric; redundant verdict orchestration | `FrameworkService.ts` (847) features feed DecisionService reasons; **`framework/fees.ts` + `framework/plan.ts` are load-bearing for keepers** (plan.buildTradePlan: StockService, AdminService, PortfolioService); entryTiming.ts logic feeds DecisionService | keep shared-math tests | consumers: StockService.analyze, PortfolioService.frameworkFor (:393), research brief |
| 11 | **HAR/HAR-X → labeled diagnostic** | primary-flow placement only | VolatilityService + quant/volforecast.ts keep; `tests/volforecast.test.ts` keeps | keep | spec §7 wants a real vol-baseline comparison later |
| 12 | **News hype gauge** | gauge/decoration in NewsPanel | timestamped items keep | none | response/frontend-level only |
| 13 | **Accuracy/calibration/track record** | nothing removed | getAccuracy, getCalibration (live Brier), prediction-audit, forecast-locks; PredictionLog 1,793 + ModelPerformance 181 rows = the evidence base to preserve | keep | ensemble sub-blocks of calibration change (row 2) |
| 14 | **Unused npm deps** | bcrypt, jsonwebtoken, mathjs, ml-matrix, random-forest-classifier, simple-statistics, @types/bcrypt, @types/jsonwebtoken | — | — | zero imports anywhere [OBS] |

**Dead legacy tables (13)** — users, watchlists, positions, portfolios, alerts, stock_metrics, market_context, sentiment_data, fundamental_data, model_registry, training_samples, rate_limit_logs, cron_execution_logs — 0 code references; cannot be cleaned up until `synchronize:false`; drop/archive via separate reviewed migration with backup (spec §2). Note name collisions with future spec §11 entities (users, watchlists, positions).

### 3.1 Route migration / redirect map [PROP]

New primary routes: `#watchlist` (default) · `#holdings` · `#discover` · `#track-record` · drill-down `#stock?ticker=X` · secondary `#desk`, `#settings`, `#diagnostics`, `/ui-showcase`.

| Old route | Redirect | Rationale |
|---|---|---|
| `#analyze` (no ticker) | `#watchlist` | new default screen |
| `#analyze` + `?ticker=`/sessionStorage | `#stock?ticker=X` | preserve deep links + restore (page.tsx:38-40) |
| `#top` | `#discover` (ranked preset) | merge |
| `#leaders` | `#discover` (composite-rank sort) | merge |
| `#stocks` | `#discover` | merge |
| `#accuracy` | `#track-record` | rename |
| `#portfolio` | `#holdings` + one-time "allocation builder removed" notice | nearest concept |
| `#desk`, legacy `#admin` | secondary desk route | records preserved |
| unknown hash | `#watchlist` | new fallback |

Storage keys: keep `stocksense.lastTicker` (Stock Detail restore); migrate `stocksense.topPicksBudget` → Discover filter; retire Collapsible ids `portfolio.*`/`desk.*` with their owners.

Mobile note [OBS]: current bottom nav = analyze/top/leaders/portfolio with accuracy behind "More" — Track Record is buried on mobile today, contra spec §10; the 4-destination nav fixes this structurally.

---

## 4. Read endpoints that mutate state (complete observed list) [OBS]

1. **`GET /api/backtest/:ticker?days=`** → `upsertModelPerformance` overwrites official per-ticker stats with the caller's N (StockService.ts:853, 902-918). Known; spec §11 mandates the fix.
2. **`GET /api/research/:ticker`** → calls `analyze()` (:1306) → persistAnalysis + persistPredictionLogs, which **DELETEs that day's PredictionLog rows and re-inserts** (:611-639). Same severity class as #1; previously undocumented.
3. **Bar cache-fill on nearly every read** — MarketDataService.persistBars does transactional DELETE+INSERT into stock_history + stocks upsert when coverage is stale (MarketDataService.ts:641-696). Benign cache semantics, but delete+insert of price history on read paths — relevant to §6 raw-price/immutability work.
4. **Boot/first-request seed** — any `/api/admin/*` call idempotently INSERTs the paper account (routes/admin.ts:20).
5. **POST-shaped but read-intent**: `POST /api/analyze` writes Analysis + PredictionLog every call (delete+insert, "latest wins") — breaks §13.8 byte-identical-forecast acceptance until issuance is reworked.
6. Verified read-only: GET accuracy, calibration, stocks, history, intelligence/:t, rank/universe (rank persistence is cron-only), execution/summary, prediction-audit, forecast-locks, portfolio/stress|calibration (except bar cache-fill).

---

## 5. Instrument identity findings (spec §6 priority) [OBS — live curl to Yahoo + psql, 2026-09-06]

### 5.1 LTIM/LTTS verdict

- **`src/data/nseUniverse.ts:68` maps LTTS.NS → "L&T Technology Services" — this is CORRECT.** Live Yahoo: longName "L&T Technology Services Limited", firstTradeDate 2016-09-23. Stored 506 bars (2024-08-28→2026-09-04), largest daily moves ±8–9.6% (plausible earnings moves), **no splice detected**. No LTIM.NS rows exist in stocks / prediction_logs / model_performance.
- **The defect is at documentation level**: ARCHITECTURE.md line 14 writes "LTIM→LTTS" as if LTIMindtree mapped to LTTS. LTTS is a **different listed company** (since 2016). What actually happened is a **universe membership substitution** (LTIM removed, LTTS added), not identity continuity — exactly the confusion spec §6 warns about.
- **LTIMindtree today**: LTIM.NS and LTIM.BO both return `{"code":"Not Found","description":"No data found, symbol may be delisted"}`; Yahoo v1 search for "LTIMindtree"/"Mindtree"/"LTIM" returns zero India quotes. **Fully delisted from Yahoo; merger/absorption destination NOT observable from free endpoints — UNVERIFIED.** A backdated LTIM holder (spec §3 use case) cannot be served today; this is precisely the missing Alias/CorporateAction machinery.

### 5.2 TMPV demerger — the concrete live §6 violation

- TMCV.NS: live longName "Tata Motors Limited" (CV), firstTradeDate **2025-11-12**; stored history starts exactly there (206 bars, clean fresh listing).
- TMPV.NS: live longName "Tata Motors Passenger Vehicles Limited", firstTradeDate **1991-01-02** — Yahoo serves the original Tata Motors continuous series under TMPV. **Stored TMPV history (506 bars from 2024-08-28) spans the demerger with an unadjusted break: close 660.75 (2025-10-13) → 395.45 (2025-10-14) = −40.15% in one day** (verified with lag() SELECT). ~283 pre-demerger combined-company bars sit under the TMPV id; every consumer of >10.5 months of TMPV history (2y backtests, HAR vol, drift, ATR, beta) ingests a fictitious −40% daily move as market risk. model_performance's TMPV 60d test window (2026-06-15→09-04) postdates the break, but walk-forward training/vol windows reach through it.

### 5.3 Other findings

- ETERNAL.NS (ex-Zomato): rename continuity is economically correct (Yahoo continuous since 2021 IPO; 2022 moves genuine) — **by accident**, since no alias record exists; input "ZOMATO" resolves to nothing.
- The system has exactly one identity mechanism — editing the ticker string in `nseUniverse.ts`. Renames come out right by accident; demergers come out wrong. Nothing distinguishes the cases; no listing-date guard.
- Code-level risk: `upsertStock` keys identity on the ticker string; `persistBars` delete+inserts under the same `stock_id` (MarketDataService.ts:590+) — if Yahoo re-keys a symbol to a different company, histories silently merge. **No ISIN anywhere in the codebase.**
- 10 junk stocks rows (AAPL, TSLA, GOOGL, MSFT, META, suffix-less ADANI/JIO/SAIL/INFY/LODHA — all 0 bars).

### 5.4 Session calendar [OBS]

Only `lastCompletedTradingDate()` (MarketDataService.ts:496-514): IST weekday + 15:40 close constant (:81); Sat/Sun→Fri. Comment admits holidays are handled by the 30-min retry guard, not a calendar. Gaps: NSE holidays (~15/yr) cause all-day per-ticker 30-min re-probing; Muhurat/special sessions unrepresentable; half-days/suspensions have no states; 15:40 assumes normal close with no provider-finalization verification; `TRADING_DAY_OFFSETS = {1:1, 3:2, 7:5, 15:10, 30:21}` (quant/engine.ts:33-39) hardcodes calendar→session mapping (the exact pattern spec §5 bans); verification computes maturity as bar-index + offset (StockService.ts:1749-1751), so holiday clusters silently shift real target dates.

---

## 6. Money / float audit [OBS]

**Storage is already NUMERIC; the float boundary is TypeScript.**

- Columns (psql `\d`): paper_trades price/fees/stop_loss/target/exit_price/realized_pnl `numeric(14,4)`, qty integer; paper_accounts start_capital/cash/target_amount `numeric(14,2)`; stock_history OHLC `numeric(12,4)`. Inconsistent: `created_at`/`fetch_timestamp` are `timestamp` (no tz) vs executed_at/exit_at `timestamptz`.
- `NumericTransformer` (PaperAccount.ts:12-21): `parseFloat` on read, raw JS float on write — every read/write crosses IEEE-754. Coverage inconsistent: **only PaperAccount/PaperTrade use it; all other decimal columns (StockHistory, PredictionLog, ModelPerformance, Analysis) return runtime strings typed as `number`**, defended ad hoc (`toNum()` StockService.ts:156, parseFloat in readBarsFromDb, toNum AdminService.ts:1218) — latent string-arithmetic bug class wherever a path misses coercion.
- Float money math: buy `totalCost = round2(qty*price+fees)` and `cash = round2(cash − totalCost)` (AdminService.ts:264-266, :350) — per-transaction rounding drift accumulates in cash. Sell FIFO (:552-600): `buyFeePortion = lot.fees*(sold/lot.qty)` proportional float allocation with **no remainder reconciliation** (allocations need not sum to the total fee); per-lot `round2` then re-rounded sum. `round2 = Math.round(x*100)/100` — binary-float rounding, `Math.round` asymmetric for negatives, classic `1.005 → 1.00` mis-round. forecastLock band prices stored as JS floats in jsonb.
- **No decimal library installed.** mathjs has BigNumber but is unused for money (and is on the dead-dep removal list).
- [PROP] Adopt **decimal.js** (MIT, zero-dep); policy: money at scale 2 (paise), execution/quote prices at scale 4 (matches `numeric(14,4)`), qty integer; ROUND_HALF_EVEN internal, ROUND_HALF_UP display only; FIFO fee allocation in integral paise with largest-remainder so Σ allocations ≡ total, allocations stored never recomputed; TypeORM transformer string↔Decimal (never parseFloat), `toFixed(scale)` on write; money never in jsonb. Spec §4 fixtures (1,010 / 90 / 190 / 70 / 606 / split) encoded as deterministic tests.
- Timing note [OBS]: paper_trades has 0 rows and account cash = start capital — the ledger/money migration window is ideal.

---

## 7. Spec §11 concepts — what already exists (summary; full plan in implementation-plan.md) [OBS]

| §11 concept | Status | Closest asset |
|---|---|---|
| User/Account | dead partial | `users` table (0 rows, unreferenced; bcrypt/jwt deps unused; middleware empty). Live "account" = PaperAccount 'admin' |
| Instrument/Alias | partial / alias missing | Stock entity (ticker-string identity); no ISIN/alias/listing-history anywhere |
| TradingSession | missing | weekday+15:40 heuristic only |
| CorporateAction | missing | consequence: TMPV break (§5.2) |
| Watchlist/Item | dead partial | jsonb tickers[] blob, 0 rows, unreferenced — not per-item |
| Transaction/LotAllocation | partial | PaperTrade ≈ hybrid; FIFO but **mutable** (lots decremented/rewritten in place); no corrections/dividends/splits/idempotency |
| Position projection | partial | live derive-on-read (good); dead `positions` table is the editable-aggregate anti-pattern spec forbids |
| ForecastRun/Point | partial | PredictionLog ≈ ForecastPoint but **not immutable** (same-day delete+reinsert, StockService.ts:611-614); no issuedAt/featureCutoffAt/manifest hash/quantile set |
| ForecastOutcome | partial | actuals written into the same PredictionLog row by the 18:30 job |
| Immutable issuance ancestor | exists | **PaperTrade.entry_context.forecastLock** — frozen anchor + bands, "NEVER recomputed", graded vs real close — reuse the pattern, generalize off the desk |
| ModelVersion/EvaluationRun | partial | ModelPerformance = latest-only mutable upsert (overwritable from a GET); model_registry (8) + training_samples (1,206) dead legacy |
| DecisionSnapshot | missing | Analysis rows are per-analysis summaries deleted after 365d |
| DataQualityIssue | missing | bad bars silently skipped; 570 duplicate day-rows deduped at read |
| MonthlyReport | missing | — |
| JobRun | dead partial | cron_execution_logs exists, never written; in-process node-cron, no locks/retries |

---

## 8. Risks

| # | Risk | Sev | Evidence | Mitigation |
|---|---|---|---|---|
| R1 | **`synchronize:true` runs against the real DB on every boot** (.env NODE_ENV=development; database.ts:48). Any Phase B entity removal/rename auto-drops columns/tables with data; sync-generated hash constraint names are unaddressable by future migrations; a fresh env cannot be built from migrations alone (only 1 real migration exists) | CRITICAL | [OBS] A3 §5 | First Phase B step: schema-only dump, `synchronize:false` unconditional, reconciled BaselineSchema migration marked applied (never run) on live DB, scratch-DB build verification. See implementation-plan §1 |
| R2 | **TMPV unadjusted −40.15% demerger break** + ~283 combined-company bars feeding backtests/vol/beta as fake market risk | HIGH | [OBS] §5.2 | Phase B data-quality quarantine: CorporateAction record for the 2025-10-14 demerger; exclude/flag pre-listing-boundary TMPV bars from model consumers until adjusted handling lands; regression fixture (§13.4) |
| R3 | **Reads that mutate canon**: GET /api/backtest upsert; GET /api/research → analyze() delete+reinsert of the day's PredictionLog; POST /api/analyze "latest wins" | HIGH | [OBS] §4 | Phase B: strip persistence from read paths (backtest returns computed stats without upsert; research uses a non-persisting analyze variant). Phase C: immutable issuance replaces delete+reinsert |
| R4 | **No auth anywhere**: admin routes open unless ADMIN_KEY set; frontend attaches key only if env var present; destructive `confirmReset` DELETE of paper_trades reachable via open POST | HIGH | [OBS] routes/admin.ts:24-38, AdminService.ts:968 | Phase B: account ownership + server-side identity on every private route from the first new endpoint; disable confirmReset until reworked as authorized, ledger-preserving archive |
| R5 | **Float money math + un-reconciled FIFO fee allocation** for authoritative ledger | HIGH | [OBS] §6 | Phase B decimal.js policy + §4 fixtures; window is ideal (0 paper_trades) |
| R6 | **No session calendar**; hardcoded 30d→21 sessions; verification maturity by bar-index; holiday re-probe storms | HIGH | [OBS] §5.4 | Phase B TradingSession entity (versioned, sourced, overridable) feeding freshness, §5 window math, and outcome maturity gates |
| R7 | **Forecast/evaluation mutability** breaks §13.8/9/10 acceptance | HIGH | [OBS] §7 | Phase C ForecastRun/Point + separate Outcome; PredictionLog frozen as read-only legacy evidence |
| R8 | **Removal blast radius on shared utilities** — executionStats.computeTradeBreakdown (keeper prediction-audit imports it), mulberry32 (stress.ts imports from montecarlo.ts), fees.ts/plan.ts load-bearing for keepers, stress/calibration default legs = desk PaperTrades | MED | [OBS] §3 | Extract-before-delete order in Phase B; tsc + jest + route-inventory check after each removal |
| R9 | **In-process cron, no JobRun/locks**; documented duplicate ts-node-dev watcher races on :5101 → two concurrent schedulers/syncs possible | MED | [OBS]+[DOC] | Phase C durable Postgres-backed jobs (pg-boss or equivalent) with locks/idempotency; until then, single-watcher ops discipline |
| R10 | **Instrument identity = mutable ticker string**; Yahoo re-key would silently merge companies; LTIM holders unservable | MED | [OBS] §5 | Phase B Instrument/Alias with ISIN where obtainable, listing dates, effective-dated aliases; resolver guards on persistBars |
| R11 | **`dataStatus:"live"` on weekend-cached quotes** drives actionable chips | MED | [OBS] §1.4 | Phase B/C freshness contract: quoteTimestamp/quoteType/marketState/latestCompletedBarDate/providerDelay in schemas; stale blocks actionable decisions |
| R12 | Dead tables name-collide with §11 entities (users, watchlists, positions) | MED | [OBS] | Resolve in BaselineSchema step: archive-rename or reviewed drop before creating new entities |
| R13 | Data pollution: 570 duplicate stock_history day-rows; 22 orphan 2025-11 prediction_logs; 58 junk stocks rows; 'yahoo' vs 'Yahoo Finance' data_source values | LOW | [OBS] | DataQualityIssue records + reviewed cleanup migration (flag, don't silently delete) |
| R14 | Node v21.6.1 non-LTS; ts-jest deprecation; extraneous @emnapi/runtime | LOW | [OBS] | Move to Node LTS at a phase boundary; move isolatedModules to tsconfig |
| R15 | MoSPI adapter fetches on cron/refresh with no key (returns nothing); OptionsRadar re-probes blocked NSE every 30 min per request | LOW | [OBS] | Config-gate MoSPI; remove OptionsRadar route (matrix row 9) |

**Historical measurements** (51% direction, Brier ≈0.2525, ~85% coverage, ensemble no-win) are treated per spec §1 as historical, unverified-in-this-session context — the A4 live `/api/accuracy` read (§1.4) is consistent with them but is itself an overlapping-sample scorecard, not an independent validation.
