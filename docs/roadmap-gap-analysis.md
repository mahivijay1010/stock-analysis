# Master Roadmap — gap analysis against the live repository (2026-10-08)

Required response before coding (roadmap §19). Everything below is measured from the running system, not assumed. Companion docs: `universe-diagnostic-2026-10-08.md`, `universe-engine.md`, `global-intelligence.md`, `money-desk.md`, `short-term-architecture.md`.

## 1. EXISTING — already implemented and matching the roadmap

| Roadmap | Implementation | Live evidence |
|---|---|---|
| §4.1–4.4 Global diagnosis | `src/services/global/*`: 40-instrument universe with tz/local+UTC close/freshness/quality; `global_market_observations`; immutable `global_market_snapshots`; regime engine with 8 explained components (`REGIME_RULES`); 12 shock studies × NIFTY/Bank/IT/Pharma + 12 sector proxies × 4 horizons; sector sensitivities; evidence-gated transmission; `global_events` seeded from official calendars; Global Pulse UI; India leakage rule tested | 501 point-in-time regime days; 216 displayable studies; today CAUTIOUS (−3), transmission NEUTRAL |
| §5.1–5.2 Security master + tiers | `security_master` + append-only `security_master_changes`; `UniverseIngestionService` (idempotent sync, new listings, symbol/name changes, deactivation); tiers A/B/C/X from median traded value; EQUITY/SME/REIT/InvIT/ETF classified separately | 3,543 securities, 1,291 tradable (A 849 / B 527 / C 288) |
| §5.3–5.4 Coverage + health | `security_data_coverage` per security + `coverageScore` (never gates tradability); `GET /api/universe/health`; Universe Health UI with sync runs, provider health, failed symbols, retry queue | OHLCV 500, fundamentals 148, news 43 |
| §7 Broad scanner | `MarketOpportunityScanner`: close-only stage-1 features → liquidity → technical → fundamental/event → the EXISTING `ScanService` → existing gates; every stage counted, every rejection reason-coded in `opportunity_candidates` | latest funnel 1,291→1,210→1,207→250→100→0, each 0 explained |
| §8 AI company research | `CompanyResearchProfileService` (every value `{value, source, asOf}`, explicit gaps) + `AiResearchService` (FACT / INFERENCE / HYPOTHESIS, must cite evidence ids, invented numbers dropped and logged, versions stored) + research priority queue (budgeted) | profiles + AI runs persisted, drops logged in `ai_reviews` |
| §9 Short-term setup engine | Pre-existing radar pipeline, unchanged and authoritative (setups, entry/stop/targets, EV lower bound, tiers, health, confirmation) | — |
| §10 Money Desk | Immutable `capital_plans` / `capital_allocations`; DEPLOY / WATCH / HOLD / TRAIL / REDUCE / EXIT / CASH; risk profiles + absolute limits; NO DEPLOYMENT is first-class; global/India/sector environment labels per card; evidence-gated macro risk policy (today ×1, reason shown) | 8 immutable plans; tested that a hostile regime never vetoes a qualified setup |
| §11 System diagnosis | `GET /api/universe/funnel` + Money Desk "Market scan coverage" + "Global risk context" with exact per-stage reasons and `zeroBecause` | — |
| §12–13 Outcomes + evaluation | `capital_decision_outcomes`, `opportunity_outcomes`, shadow ledgers — all graded by the shared fill-aware bracket simulator + NIFTY benchmark leg; MFE/MAE; track records with Wilson bounds, precision@k, segments by setup/horizon/regime/sector/cap/liquidity/vol-regime, withheld < 10 | 4 broad-scan outcomes graded, 66 pending maturity |
| §14 Model Lab | Experiment registry (now append-only by trigger), governance transitions, promotion gates evaluated against measured sample sizes, LLM cannot promote/change thresholds | "Only 0 resolved desk outcomes. No model update recommended." |
| §15 Time/leakage rules | UTC + exchange tz stored everywhere; India-close rule for studies; features-after-cutoff refused by `computeStageOneFeatures`; grader uses bars strictly after decision date; all pinned by tests | 1,056 backend tests pass |

## 2. PARTIAL — exists but needs improvement

1. **§4.5 India Market Diagnosis** — only NIFTY trend/vol/drawdown (`RegimeService`). Missing: BANKNIFTY/financials, India VIX as a component, advance/decline breadth, volume/turnover, INR, sector relative strength as a composite. **← Milestone 1, built below.**
2. **§6 Sector intelligence** — sector proxies, sensitivities and shock impacts exist; no per-sector trend/momentum/breadth regime (STRONG/NEUTRAL/WEAK/STRESSED).
3. **Events** — `global_events` seeded from official calendars, not auto-ingested; NSE announcements ingest is on-demand per ticker, not universe-wide.
4. **Fundamentals/ownership coverage** — 148 of 2,334 companies; FII/DII holdings have no configured source.
5. **OHLCV depth** — 500 names with true OHLC (grows ~100/night via the broad scan); the rest are close-only exchange rows (ATR is a labelled proxy).
6. **Credit component** — always "not covered" until a FRED key is configured.
7. **§16 UI** — "System Diagnosis" and "India Market" exist as sections inside Money Desk / Discover, not as the roadmap's dedicated pages.

## 3. MISSING

- India breadth / turnover / INR / India-VIX composite diagnosis (Milestone 1).
- Sector regime engine (Milestone 2).
- FII/DII flows (no reliable keyless source — recorded as a data gap, not faked).
- Scheduled universe-wide announcement/results-calendar ingestion.

## 4. CONFLICTING (candidates for cleanup, none urgent)

- Dead tables with no writers: `fundamental_data`, `sentiment_data`, `stock_metrics`, `market_source_snapshots`, legacy `portfolios`/`positions` — keep archived, do not build on.
- Two India regime vocabularies coexist by design: `RegimeService` (TREND_UP…CRISIS, gates sizing) and `decision/regimeEngine` ("bear_high_vol", gates the long-horizon scan). Documented; not unified in this phase.
- Discover's older sections (Relative strength / Daily scan / All covered) remain bounded to the hand-curated 151 and say so; the Market scanner covers the broad universe.

## 5. BOTTLENECKS — why ₹20,000 → 0 qualified is happening (measured)

The funnel no longer hides anything: 1,291 tradable → 100 reach the engine → 0 pass gates. The binding constraints, in order:

1. **Setup-evidence tier A exists for 0 of 12 setup×horizon cells** (needs ≥60 independent dates, after-cost expectancy ≥0.1R with CI lower bound >0, P(>0)≥0.9, BH-significant). Every candidate is capped ≤ B → never `qualified`.
2. **Model health is SHADOW for every setup** (<20 independent resolved shadow trades each) → `composeCeiling` caps at WAIT_FOR_CONFIRMATION → `ENTRY_CONFIRMED` unreachable.
3. **Regime TREND_DOWN** allows mean-reversion only, halving the candidate set.
4. **EV gate** (80% lower bound > 0 after costs) fails 73 of the 100.

These are evidence floors working as designed. The honest fix is **sample accrual**, which the broad scan now does (~100 engine evaluations/night logged to the shadow ledger for tier-A names, graded in ~2 weeks), not threshold changes. No gate will be lowered.

## 6. Phased plan (first milestone only is implemented now)

| Milestone | Scope | Status |
|---|---|---|
| **M1 India Market Diagnosis** | Breadth (advance/decline from the exchange-wide delivery feed), turnover vs 20-session median, BANKNIFTY/financials, India VIX, INR, sector relative strength, FII/DII recorded as uncovered; per-component scores + reasons; point-in-time daily history; `GET /api/india/pulse` + `POST /api/india/backfill`; wired into the global snapshot (`india.diagnosis`), the 08:40 cron and Discover → India market; pure-function tests (10). The existing `RegimeService` remains the authoritative gate input — this is diagnosis, not a new gate. **DONE 2026-10-08: live read WEAK (−3) for 2026-10-07 — TREND_DOWN (−2), BANKNIFTY −3.6%/20d (−2), breadth 39% advancing (−1), India VIX 13.9 (+2), turnover 1.03× (0), INR +0.33%/5d (0), 5/12 sectors ahead (0); FII/DII uncovered. 109 sessions backfilled point-in-time: 70 NEUTRAL · 18 STRONG · 2 WEAK.** |
| M2 Sector intelligence | Per-sector regimes from 7 components (trend, rel strength, momentum, constituent breadth, turnover-with-breadth, realized vol, measured global transmission); `sector_regime_days` point-in-time; `GET /api/india/sectors`; Money Desk sector env = more cautious of global impact and domestic regime; sector table in Discover. **DONE 2026-10-08: 1,080 rows backfilled; live - Realty & Telecom STRESSED; Fin/IT/Auto/Metal/CapGoods WEAK; FMCG/Pharma/Energy/Chem/Consumer NEUTRAL with positive relative strength.** |
| M3 Event ingestion | `AnnouncementIngestService`: NSE bulk announcements (publication timestamps, keyword-classified) + the forthcoming results calendar, mapped through the security master, idempotent, run inside nightly-universe-sync; research-queue `resultsDue` also reads the calendar. **DONE: 2,209 events / 1,458 companies over 3 days incl. 210 scheduled results meetings to 2026-11-13; a UTC/IST date off-by-one was caught by a test and fixed.** |
| M4 Fundamentals breadth | `FundamentalsRotationService`: stalest-first tier-A/B rotation through the existing scrape engine (25/night, throttled); metrics into `intelligence_metrics`; scraped market caps fill `market_cap_inr` so cap buckets become value-based. Cron 20:45 weekdays. **DONE: live batch 8/8 refreshed, 82 metrics, 7 caps set.** |
| M5 System Diagnosis page | `SystemDiagnosisView` (gear menu): Environment (global regime, transmission, India diagnosis, sector chips), Universe & data, and the funnel with the bottleneck called out (stage, counts, top reasons) plus the zero-explanation chain. Read-only composition of existing endpoints. **DONE.** |
| M6 Learning → Model Lab | No code: let outcomes accrue; review promotion gates when any setup reaches its floors | ongoing |

Schema changes in M1: one upsertable table `india_market_days` (point-in-time, like `global_regime_days`). API: `GET /api/india/pulse`, `POST /api/india/backfill` (auth). UI: Discover → India market section. Tests: pure diagnosis module (breadth, turnover, components, missing data, leakage).
