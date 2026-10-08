# Money Desk — capital-allocation layer (2026-10-08)

**What it is.** A decision surface on top of the existing short-term engine that answers: where to put money today, where to take it out, how much per position, how much cash to keep, what the risk is, why, what would change it, how such decisions have performed, and whether the system is learning. It adds **no prediction model**. The deterministic engine stays authoritative; AI stays cap-only.

**What it is not.** It does not promise profit. It never shows a probability unless the engine's calibrated-probability status is `AVAILABLE` (today: never). "NO NEW CAPITAL ALLOCATION TODAY" is a successful result. The desk measures whether its own recommendations beat NIFTY; it does not assume they will.

---

## 1. Dependency map (what is reused, verbatim)

| Need | Reused from | Notes |
|---|---|---|
| Qualified setups, gates, tier, action, EV lower bound, plan geometry, freshness, model health | `short_term_candidates.payload` (the persisted `ShortTermCandidateView`) from the latest `short_term_scan_runs` per universe (NSE_UNIVERSE + WIDE_SUB100) | Read-only; the desk never re-scans. `qualified`, `action === ENTRY_CONFIRMED`, `tier`, `ev.ev80LowerPct`, `plan.*` are consumed as-is. |
| Position sizing | `shortterm/sizing.ts::computePositionSize` | Risk-based: `(equity × risk%) ÷ loss-per-share` with costs, slippage and a 0.2×ATR gap buffer inside; ADV participation and sector caps. Never capital ÷ price. |
| Regime and size multiplier, setups allowed per regime | `shortterm/RegimeService.detect`, `shortterm/regimeGates.ts` | CRISIS → entries off; TREND_DOWN/HIGH_VOL → ×0.5; CHOPPY → mean-reversion only. |
| Circuit breaker | `shortterm/RiskControlService.circuitBreaker` | Tripped → no new risk, holdings reduced per profile. |
| Market state / freshness | `shortterm/LiveMarketDataProvider.getMarketStatus / getDataFreshness` | Mapped to the contract `{quoteTimestamp, quoteType, marketState, latestCompletedBarDate, providerDelay, featureCutoffAt}`. `LIVE` is never claimed from Yahoo. |
| Holdings with observed prices | `ledger/LedgerService.getPositions(accountId, quoteLookup)` + `marketDataService.getQuote` | Decimal strings converted at the edge; an unpriced holding is HELD with `PRICE_UNAVAILABLE`, never guessed. |
| AI cap | `wide_shadow_predictions.ai_dossier.capAction` | `CAP_TO_NO_TRADE` rejects; `CAP_TO_WATCH` demotes to conditional. Never raises. |
| Exit levels for holdings | the holding's own plan: `invalidationPrice`, `initialStop`, `target1/2`, `atr14`, the trailing rule ("after T1 exit half, trail close − 1.5×ATR14") from `fullPlan.ts` | No new exit logic. A holding without a plan on file is HELD with `NO_EVALUATION_ON_FILE`. |
| Outcome grading | `shortterm/shadowFill.ts::simulateBracket` + `toAdjustedOhlc` | Same fill-aware, gap-aware, ambiguity-flagging simulator as the radar and sub-₹100 ledgers. |
| Benchmark | `marketDataService.getNiftyBars` | Close-to-close NIFTY over the same sessions → excess return. |
| Wilson bound, withheld-below-10 | `evidence/selectivity.ts::wilsonLb95`, `MIN_GRADED = 10` convention | |
| Model registry, governance, calibrators, setup evidence, lessons | `experiment_runs`, `model_governance(+_transitions)`, `calibrators`, `short_term_model_performance`, `learning_lessons` | Model Lab is a **read-only view**; it adds no second registry. |
| LLM | `reasoning/providerRegistry.getOpenAIProvider().structured` + `aiCostGovernor` + `ai_reviews` | Learning Analyst only re-phrases supplied facts; sentences without a valid fact id are dropped. |
| Cron | `CronService` job pattern (daily expression + `isIstWeekday()` guard, `guarded()` logging, catch-up list) | |

Not reused, and why: `decidePaperOrders` (paper pilot) sizes with `floor(risk ÷ (entry−stop))` without costs — the desk uses the stricter `computePositionSize`. `entryExit.ts::assessExit` needs live features that the persisted payload does not carry; the desk applies the plan's stored levels instead and says so.

## 2. Files

**New backend**
- `src/services/capital/types.ts` — contracts, reason codes and their plain-English text
- `src/services/capital/riskProfiles.ts` — CONSERVATIVE / BALANCED / AGGRESSIVE + `ABSOLUTE_LIMITS` clamp
- `src/services/capital/capitalAllocation.ts` — pure allocation engine (`buildCapitalPlan`)
- `src/services/capital/capitalWithdrawal.ts` — pure HOLD / TRAIL / REDUCE / EXIT engine
- `src/services/capital/capitalOutcome.ts` — pure grader (`gradeAllocation`)
- `src/services/capital/capitalTrackRecord.ts` — pure aggregation, precision@k, segments
- `src/services/capital/CapitalAllocationService.ts` — loads inputs, persists immutable plans, daily snapshot, history
- `src/services/capital/CapitalOutcomeService.ts` — grades matured recommendations, track record
- `src/services/capital/ModelLabService.ts` — read-only Model Lab view + promotion gates
- `src/services/capital/LearningAnalystService.ts` — measured facts → optional validated LLM narrative
- `src/controllers/CapitalController.ts`
- `src/entities/CapitalDesk.ts`
- `src/migrations/1790900000000-CreateCapitalDesk.ts`

**Changed backend**: `src/routes/index.ts` (9 routes), `src/services/CronService.ts` (job `morning-capital-snapshot` 08:55 weekdays; grading inside `evening-verify-predictions`), `src/entities/index.ts`, `src/config/database.ts`.

**New frontend**: `frontend/src/components/capital/MoneyDeskView.tsx`, `frontend/src/components/modellab/ModelLabView.tsx`.
**Changed frontend**: `frontend/src/lib/api.ts` (types + 9 functions, `put` helper), `frontend/src/components/Header.tsx` (nav: Money Desk, Watchlist, Discover, Short-Term, Track Record, Model Lab; Live and Evidence move to the gear menu), `frontend/src/app/page.tsx` (routes `#money-desk`, `#model-lab`; Money Desk is the default), `frontend/src/app/globals.css` (desk/lab compositions on the existing tokens).

**Tests**: `tests/capital-allocation.test.ts`, `tests/capital-withdrawal.test.ts`, `tests/capital-outcome.test.ts`, `tests/capital-track-record.test.ts`, `tests/capital-desk-governance.test.ts`.

## 3. Database migration — `CreateCapitalDesk1790900000000` (applied)

| Table | Purpose | Immutability |
|---|---|---|
| `capital_plans` | one row per generated plan (REQUEST or SNAPSHOT) with the full result JSON, freshness, feature cutoff, versions | trigger `reject_live_history_mutation` |
| `capital_allocations` | ALLOCATE / WATCH / HOLD / TRAIL / REDUCE / EXIT / CASH lines with levels, amounts, reason codes, `decision_snapshot_id` | trigger |
| `capital_decision_outcomes` | graded forward outcomes; unique `(allocation, grader_version)`; carries `feature_cutoff_at`, `decision_time`, `outcome_maturity_time` | trigger |
| `daily_capital_decision_snapshots` | one per account per session; the exact state believed at session start | trigger, unique `(account, date)` |
| `experiment_runs` | existing; was append-only by convention only | trigger added |

Verified live: `UPDATE capital_plans …` → "capital_plans is append-only: UPDATE blocked"; `DELETE FROM capital_allocations …` → blocked.

## 4. APIs

| Route | Auth | Returns |
|---|---|---|
| `GET /api/capital/today?capital=&profile=&horizon=&maxPositions=` | yes | plan (persisted, immutable): `asOf, capitalAvailable, recommendedDeployment, recommendedCashReserve, marketRegime, riskProfile, allocations[], conditional[], holds[], withdrawals[], rejected[] (why not), cash, scenario, summary, evidence, modelHealth, freshness {quoteTimestamp, quoteType, marketState, latestCompletedBarDate, providerDelay, featureCutoffAt}, planId` |
| `POST /api/capital/simulate` | yes | same engine, nothing persisted, labelled SCENARIO |
| `GET /api/capital/history` | yes | past plans |
| `GET /api/capital/settings` · `PUT` | yes | capital / profile / horizon / maxPositions / dailySnapshot |
| `GET /api/capital/track-record` | no | win rate (Wilson), avg/median return, profit factor, expectancy, max drawdown, MFE/MAE, benchmark excess (95% CI), precision@1/3/5; segmented by setup, horizon, regime, profile, sector, liquidity bucket, model version; withheld below 10 |
| `POST /api/capital/grade` | yes | grade matured recommendations now |
| `GET /api/model-lab` | no | pipeline, governed models, experiments, promotions, calibrators, setup cells, shadow models, lessons, desk record, promotion gates, verdict, policy |
| `GET /api/model-lab/learning?ai=1` | no | Learning Analyst facts + narrative (`ai=1` asks the LLM to phrase; validated and cost-governed) |

## 5. Risk profiles (configurable per call, clamped)

| | Cash reserve | Max position | Portfolio risk | Risk/trade | Min R:R | Tier | Max positions | Risk-off hold |
|---|---|---|---|---|---|---|---|---|
| CONSERVATIVE | 40% | 15% | 1.0% | 0.25% | 2.0 | A | 2 | 25% |
| BALANCED | 25% | 25% | 2.0% | 0.5% | 1.8 | A | 3 | 50% |
| AGGRESSIVE | 10% | 35% | 3.0% | 1.0% | 1.5 | A | 5 | 60% |

Absolute ceilings: cash ≥ 5%, position ≤ 35% (`SIZING_LIMITS`), portfolio risk ≤ 3% (`RISK_LIMITS.maxWeeklyLoss`), risk/trade ≤ 1%, R:R ≥ 1.2, positions ≤ 5 (`RISK_LIMITS.maxOpenPositions`).

## 6. Learning loop

DECISION (`capital_plans`/`capital_allocations`, `feature_cutoff_at` = the scan's timestamp) → ENTRY CONDITION (zone / trigger recorded) → ENTRY TRIGGERED / EXPIRED (3-session window) → POSITION MONITORED → TARGET / STOP / TIME EXIT (bracket simulator) → OUTCOME (`capital_decision_outcomes` with `decision_time`, `outcome_maturity_time`) → EVALUATION (`/api/capital/track-record`, Model Lab gates) → LEARNING DATASET (the outcome rows joined to the allocation's stored levels and reason codes; point-in-time by construction because only bars strictly after the decision date are used — pinned by the leakage test).

## 7. Results

- Backend tests: **84 suites, 1,008 tests, all pass** (`npx jest --runInBand`), including the 5 new suites (72 tests).
- Backend typecheck/build: `npm run build` — pass.
- Frontend: `tsc --noEmit` pass; `eslint` on the changed files pass; `next build --webpack` pass.
- Live smoke (2026-10-08 13:34 IST): `/api/capital/today` → 110 candidates evaluated, 0 qualified, plan persisted; reasons: tier below A (110), entry not confirmed (110), R:R below minimum (109), regime conflict (88, TREND_DOWN), invalid geometry (81), EV unavailable (81), EV lower bound ≤ 0 (29). `/api/model-lab` → "Only 0 resolved desk outcomes. No model update recommended."

## 8. Remaining limitations

- **Holdings' exit rules depend on a plan being on file.** A holding the scan never evaluated is HELD with that stated; `assessExit` (feature-driven) is not wired because the persisted payload lacks live features.
- **Correlation/CVaR for the book** (`computePortfolioRisk`) is not called in the allocation pass because it needs aligned return series; the desk applies position, sector and risk-budget caps instead and `canAddPosition` remains available for a follow-up.
- **Partial fills are not modelled** (the bracket simulator fills the whole quantity at one price); slippage is a scenario constant from the ledger default.
- **Sector for holdings** comes from the candidate payload; a holding with no evaluation has sector `null` and is treated as "Unclassified" for sector caps.
- **The daily snapshot uses each account's saved desk settings** (default ₹20,000 / BALANCED / 5–10d); accounts can opt out via `dailySnapshot: false`.
- **No deep link into the Short-Term detail cockpit**; "View full plan" opens the Stock Detail page.

## 9. What requires real historical data accumulation

Every number in the track record, precision@k, the segment tables, the Learning Analyst findings and the two desk promotion gates. The first graded outcomes arrive ~2–3 weeks after the first ALLOCATE lines (entry window + horizon). Until 10 observed outcomes exist, every rate is withheld by design. Today the engine qualifies zero setups in a TREND_DOWN regime, so the desk is accumulating NO-NEW-ALLOCATION days — which are also recorded.

## 10. Deterministic vs AI-derived

- **Deterministic**: everything that moves money — candidate qualification (engine), sizing, caps, cash, withdrawals, grading, track record, promotion gates, every fact in the Learning Analyst.
- **AI-derived (cap-only / phrasing-only)**: the AI scout's `capAction` (can only lower), and the optional Learning Analyst narrative (can only re-state supplied facts; uncited or banned-wording sentences are dropped and the drop is logged in `ai_reviews`).

## 11. What can and cannot learn automatically

- **Can, automatically**: outcomes accrue nightly; the track record, segments, precision@k and gate evaluations update themselves; the daily challenger / calibration jobs already register experiment runs and lessons.
- **Cannot, by design**: nothing promotes itself. A desk-policy change or a model promotion requires a registered experiment run and a governance transition with a written reason. The LLM cannot change thresholds, weights or labels. Thresholds may only loosen with a validated study.

The goal is a system that can discover whether it has an edge — not one that assumes it does.
