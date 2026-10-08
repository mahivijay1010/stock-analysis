# Stock Universe + Research Engine 2.0 — implementation report (2026-10-08)

Diagnostic that preceded this work: `docs/universe-diagnostic-2026-10-08.md`. The pipeline is now
SECURITY MASTER → DATA COVERAGE → LIQUIDITY FILTER → TECHNICAL SCREEN → FUNDAMENTAL/EVENT SCREEN → SHORT-TERM SETUP ENGINE (unchanged) → EXISTING DECISION GATES (unchanged) → RISK / MODEL HEALTH (unchanged) → MONEY DESK, with every stage counted and every rejection recorded.

## What was built (by phase)

| Phase | Delivered | Where |
|---|---|---|
| 1 Security master + ingestion | `security_master` (3,543 rows: 2,601 equity incl. BE/BZ, 580 SME, 4 REIT, 6 InvIT, 352 ETF), append-only `security_master_changes`, `UniverseIngestionService` (sync / new listings / symbol changes / name changes / liquidity+activity classification), `NseSecurityMasterProvider` behind a `SecurityMasterProvider` interface, provider health | `src/services/universe/`, `src/entities/Universe.ts`, migration `1791000000000` |
| 2 Coverage + health | `security_data_coverage` per security (price / OHLCV / close-only / depth / fundamentals / results / corporate actions / announcements / news / technical features + timestamps + score), `GET /api/universe/health`, Discover → Universe health panel | `SecurityDataCoverageService`, `UniverseHealthService`, `UniverseHealthPanel.tsx` |
| 3 Broad scanner | `MarketOpportunityScanner`: stage-1 close-only features (trend, momentum, RS vs NIFTY, volatility, ATR proxy, volume ratio, breakout/pullback, SMA distances, 52w position, gap, liquidity, delivery) over tier A/B in one set-based query; configurable keeps; survivors go to the EXISTING `ScanService.scan` with label `BROAD_SCAN`; funnel + reasons persisted in `opportunity_scans` / `opportunity_candidates` | `opportunityFeatures.ts`, `MarketOpportunityScanner.ts` |
| 4 Research profiles | `CompanyResearchProfileService`: business / fundamentals / valuation / market / events / news / results / short-term sections, every value `{value, source, asOf}`, explicit gaps, numbered evidence items; versioned append-only `company_research_profiles` | `CompanyResearchProfileService.ts` |
| 5 Research queue + AI | `researchPriority` (unusual volume, momentum, breakout, pullback, news, results, corporate action, gap, watchlist, setup evidence, regime fit, staleness), `ResearchQueueService` (rebuild + budgeted drain), `AiResearchService` emitting FACT / INFERENCE / HYPOTHESIS that must cite evidence ids; statements with uncited claims, invented numbers or banned wording are dropped and logged | `researchPriority.ts`, `ResearchQueueService.ts`, `AiResearchService.ts` |
| 6 Discover UI + Company page | Discover → Market scanner (filters: liquidity tier, cap, sector, trend, signal, setup, price, relative volume, volatility, 52w, fundamental; funnel buttons; actions Research / Company / Setup / Watch / Simulate) and Universe health; `#company/<SYMBOL>` Company Intelligence page with Overview, Technical, Fundamentals, Valuation, Ownership, News, Events, Research, Short-term setup, Risk, Decision history | `components/discover/*`, `components/company/CompanyIntelligenceView.tsx`, `DiscoverView.tsx`, `page.tsx`, `Header.tsx` |
| 7 Money Desk integration | Candidates now come from radar + BROAD_SCAN + sub-₹100 runs (198 evaluated vs 110 before); response carries `coverage` (scanned → data valid → liquid → technical → research-qualified → setups → passed gates → risk → model health → allocations) plus `zeroBecause`; UI strip "Market scan coverage" | `CapitalAllocationService.ts`, `MoneyDeskView.tsx` |
| 8 Learning / outcomes | `opportunity_outcomes` (append-only): every candidate with a plan is graded with the shared bracket simulator + NIFTY leg (features at decision time, feature cutoff, decision time, maturity time); `GET /api/universe/learning` segments by setup, cap bucket, liquidity tier, regime, volatility regime, stage, sector — withheld below 10; Model Lab → Learning tab | `OpportunityOutcomeService.ts`, `ModelLabView.tsx` |

Cron: `nightly-universe-sync` 20:05 and `nightly-broad-scan` 20:25 (scan → queue → research → grade), both weekdays, both in the catch-up list.

## A data defect fixed on the way (not a threshold change)

Yahoo emits placeholder bars on NSE holidays (open = high = low = close = prior close, volume 0). Two such bars inside the last 20 sessions (2026-09-14 and 2026-10-02) made the engine's "≤1 zero-volume bar" liquidity gate fail for almost every stock, including RELIANCE. The parser now drops them (`yahoo.ts::isHolidayPlaceholder`); 2,054 stored placeholder rows were purged; a test pins the rule. After the fix the engine's liquidity failures on the broad scan went from 75/100 to 0/100.

## Results (live, 2026-10-08 evening)

| Measure | Count |
|---|---|
| securities discovered | 3,543 |
| securities active | 3,328 |
| tradable (EQ series, tier A/B, no surveillance) | 1,291 (tier A 849 · tier B 527 · tier C 288 research-only · 1,879 excluded) |
| with OHLCV bars stored | 500 (was 246; the broad scan backfills ~100 names per run) |
| with fundamentals | 148 |
| with news facts | 43 |
| with corporate events / announcements | 362 |
| candidates generated (broad scan) | 1,291 entered → 1,210 data-valid → 1,207 liquid → 250 technical → 100 research-qualified → 100 to the setup engine |
| candidates researched (profiles / AI) | 17 profile builds, 4 with AI research (budgeted) |
| candidates reaching the short-term engine | 100 (33 with a named setup) |
| rejected by each gate (engine, on the 100) | expected value 73 · setup 67 · setup strength 67 · entry plan 67 · reward/risk 33 · liquidity 0 (after the fix) |
| passed gates / risk / model health | 0 / 0 / 0 |
| final Money Desk recommendations | 0 — correct for this evidence; regime TREND_DOWN, every setup's model health SHADOW, no setup×horizon cell at tier A |
| broad-scan outcomes graded so far | 4 (66 pending maturity) |

The Money Desk still says NO NEW CAPITAL ALLOCATION TODAY — and now shows exactly why at every stage. Nothing was lowered to make a stock appear.

## Tests, typecheck, build

- Backend: 86 suites, 1,035 tests pass (26 new: parsing, classification, dedupe, symbol/name changes, new listings, inactivity, coverage score, stage-1 features, leakage refusal, stale series, signals, research priority, AI grounding, and three tests proving broad-scan candidates cannot bypass tier / health / EV / ENTRY_CONFIRMED gates).
- `npm run build` pass; frontend `tsc`, `eslint`, `next build --webpack` pass; `git diff --check` clean.

## Limits that remain

- The exchange feed is close-only; true ATR, gaps and intrabar structure exist only for names with stored OHLCV (500 today, growing ~100/night). Stage-1 labels its ATR as a proxy.
- Fundamentals cover 148 names (XBRL + scraped ratios); the fundamental screen records "no stored data" rather than penalising it. Institutional (FII/DII) holdings have no configured source.
- Market-cap buckets come from NSE index membership (labelled) unless a value is stored; 1,656 active equities are "UNKNOWN".
- News/events persist only via the web-knowledge job (15 searches/day) and the on-demand event ingest; a scheduled exchange-announcement ingest across the universe is the next data gap.
- The setup engine is called on ≤150 names per run (configurable) to keep the nightly job short; raising it raises Yahoo load.
