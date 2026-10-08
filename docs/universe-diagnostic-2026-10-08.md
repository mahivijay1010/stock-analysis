# Universe diagnostic — why the Money Desk sees 110 candidates and qualifies 0 (2026-10-08)

Measured on the live database at 14:50 IST, 2026-10-08. Nothing here is a threshold change.

## A. Current universe architecture

Two identity systems that share no key:

| World | Tables | Key | Size | Who uses it |
|---|---|---|---|---|
| Yahoo (`RELIANCE.NS`) | `instruments` (151, seeded once), `stocks` (247, auto-created on bar fetch), `stock_history` (247 tickers), `watchlist_items`, ledger, forecasts, decisions | `yahoo_ticker` | 151 curated + ~96 wide-lane | Radar scan, Discover, Stock Detail, watchlist, ledger, forecasts |
| NSE symbol (`RELIANCE`) | `nse_securities` (2,686), `nse_delivery` (3,308 symbols, EQ only, close + volume + delivery, no OHLC), `stock_knowledge` (326 symbols) | `symbol` | whole exchange | Sub-₹100 wide lane, liquidity gate, surveillance, web knowledge |

Bridge: ad-hoc `${symbol}.NS` string concatenation. `ScanService` accepts any `universe: UniverseStock[]`, so the engine itself is not the limit; the lists handed to it are.

Universe lists today:
- **Radar `NSE_UNIVERSE`**: a hand-curated static array of 151 names in `src/data/nseUniverse.ts`. No index-membership refresh. Scanned by the 08:45 job and `POST /api/short-term/scan`.
- **Wide lane `WIDE_SUB100`**: `nse_delivery` ∩ `nse_securities(instrument_type='STOCK')`, `series='EQ'`, `close < ₹100` → ~96–101 pass the tradeability screen (₹2cr median turnover, 240 sessions, no surveillance). Scanned nightly at 19:50 with `persistAll`.
- **Discover / rank / top-picks / stocks / search**: all bounded by the 151 (search falls through to Yahoo).

## B. Current data providers

| Provider | Supplies | Coverage | Scheduled? |
|---|---|---|---|
| Yahoo chart | daily OHLCV + adjusted close + splits/dividends, quotes | any resolvable ticker; stored only for the 247 ever fetched | 08:45 seed of the 151 |
| Yahoo quoteSummary | fundamentals (PE, PB, margins, ROE, debt, cash, FCF, market cap, next earnings) | any; **24h memory cache, never persisted** | on demand |
| Yahoo search/news + Google News RSS | headlines + lexicon sentiment | any; memory cache, never persisted | on demand |
| NSE archives | `EQUITY_L.csv` master (EQ series only), index constituent lists, ETF list, daily bhavcopy with delivery | whole exchange | 19:50 nightly |
| NSE API (cookie) | ASM/GSM surveillance, corporate announcements, filings/XBRL financial results, annual reports | whole exchange available; filings used for 151 (10/night rotation) + env list | 08:45 rotation, Saturday |
| BSE API | results cross-check, announcements | on demand with a BSE code | no |
| Screener / Trendlyne / Tickertape scrape | ratios incl. promoter holding, ROCE, D/E | on demand per ticker | via intelligence rotation |
| Firecrawl → DeepSeek | web facts into `stock_knowledge` | 15 searches/day budget | 20:10 nightly |
| Upstox | live stream (151), instrument map (~2.6k NSE_EQ with ISIN) | no historical candles used | market hours |
| FRED / RBI / MoSPI | macro | — | monthly |
| **Unused keys in `.env`** | Alpha Vantage, Polygon, Twelve Data, Marketstack, FMP, Tiingo, NewsAPI, X | — | — |

No central provider-health or freshness record exists; `cron_execution_logs` is the only ingestion audit.

## C. Current number of securities (live counts)

| Measure | Count |
|---|---|
| `nse_securities` rows | 2,686 (2,334 STOCK, 352 ETF; 0 OTHER; no REIT/InvIT/SME classification; no inactive flag) |
| with ISIN / with industry | 2,334 / 740 |
| EQ symbols traded on 2026-10-07 (`nse_delivery`) | 2,678 |
| symbols with ≥240 delivery sessions | 2,593 |
| liquidity (30-session median turnover): ≥₹10cr / ₹2–10cr / ₹50L–2cr / <₹50L | 898 / 565 / 361 / 931 of 2,755 |
| OHLCV bars in `stock_history` | 247 tickers (246 with ≥250 bars), latest 2026-10-07 |
| fundamentals persisted | `financial_facts` 59 tickers (XBRL); `intelligence_metrics` for the rotated 151; `fundamental_data` 0 rows (dead table) |
| events / sentiment persisted | `structured_market_events` 0 rows (ingest is on-demand only); `sentiment_data` 0 (dead) |
| web facts | `stock_knowledge` 326 symbols, of which 280 are surveillance-only; results/business facts for ~14 |
| watchlist | 0 items |

## D. Why only 110 candidates are evaluated

The Money Desk reads the latest persisted scan run per universe label:
- `NSE_UNIVERSE` run: 151 scanned, but the scan persists only "interesting" rows (gates passed, or tier ≠ D with a setup) → **~14 rows**.
- `WIDE_SUB100` run: 96 scanned with `persistAll` → **96 rows**.
- Deduped: **110**. The other ~137 radar names and ~2,200 exchange-listed stocks are never evaluated at all.

So the real evaluated universe is 247 of 2,334 listed companies (10.6%), and most of those are sub-₹100 names chosen by price, not by liquidity or quality.

## E. Top rejection reasons (latest runs, 2026-10-08)

Engine gate failures on the 110 persisted candidates (a row can fail several):

| Gate | Fails | Reading |
|---|---|---|
| expected value (< 0.25% after costs or EV80 lower bound ≤ 0) | 98 | |
| liquidity (ADV < ₹2cr or zero-volume bars) | 96 | the wide lane is sub-₹100 by construction |
| setup strength (< 45) | 84 | |
| entry plan (none) | 82 | |
| setup (NO_SETUP / late / failed / event risk) | 82 | 81 of 110 have no setup in a TREND_DOWN tape |
| reward/risk (< 1.5) | 26 | |

Then the Money Desk's own reading of the same rows: evidence tier below A 110/110, entry not confirmed 110/110, R:R below profile 109, regime conflict 88 (TREND_DOWN allows mean-reversion only), invalid geometry 81, EV unavailable 81, EV lower bound ≤ 0 29.

**The two binding constraints are structural, not tunable:**
1. **Setup evidence tier A exists for 0 of 12 setup×horizon cells.** Tier A needs ≥60 independent entry dates, after-cost expectancy ≥0.1R with CI lower bound >0, P(>0) ≥0.9 and BH significance, on sealed data. `PIT_UNIVERSE_AVAILABLE=false`, so every cell is `BACKTEST_PROVISIONAL`. Every candidate is therefore capped at tier B or below → never `qualified`.
2. **Short-term model health is SHADOW for every setup** (0 setups have ≥20 independent resolved shadow trades with positive conservative expectancy). `composeCeiling` caps SHADOW at WAIT_FOR_CONFIRMATION, so `ENTRY_CONFIRMED` is unreachable.

Expanding the universe will not, by itself, produce qualified names. What it does is (a) evaluate the liquid 1,400 names the engine has never seen, (b) accrue shadow predictions and setup-evidence samples ~10× faster, which is the only honest route to tier A and HEALTHY, and (c) make every stage of the funnel observable.

## F. Data gaps

1. No security master with series (BE/BZ/SM/ST), listing status, SME/REIT/InvIT classification, symbol-change history, or inactive flag. `instrument_type` is STOCK/ETF only.
2. OHLC exists for 247 names; the other 2,400 have close-only delivery rows (no high/low → no true ATR, no gap detection).
3. Fundamentals persisted for 59 (XBRL) + the rotated 151; nothing for ~2,100 names. Yahoo fundamentals are never stored.
4. Corporate actions: only splits/dividends embedded in `stock_history` for 247 names; `structured_market_events` is empty because its ingest is on demand only.
5. News is never persisted; `stock_knowledge` has web facts for ~45 names.
6. No institutional (FII/DII) holdings anywhere; promoter holding only via scrape.
7. Industry for 740 of 2,686; sector taxonomy differs between `NSE_UNIVERSE.sector` and `nse_securities.industry`.
8. No per-gate rejection counts recorded; non-interesting candidates are not persisted, so funnel counts cannot be reconstructed after the fact.
9. No provider health / freshness registry.
10. Last two `nightly-wide-screen` runs failed (one `fetch failed` against NSE archives, one stale-process `maxPrice` bug since fixed); the catch-up ran but the morning scan took 22 minutes.

## G. Files to modify / create

New: `src/entities/Universe.ts`, `src/migrations/1791000000000-CreateUniverseEngine.ts`, `src/services/universe/{providers/SecurityMasterProvider.ts, providers/NseSecurityMasterProvider.ts, universeClassification.ts, UniverseIngestionService.ts, SecurityDataCoverageService.ts, opportunityFeatures.ts, MarketOpportunityScanner.ts, researchPriority.ts, ResearchQueueService.ts, CompanyResearchProfileService.ts, AiResearchService.ts, OpportunityOutcomeService.ts, UniverseHealthService.ts}`, `src/controllers/UniverseController.ts`, frontend `components/discover/{MarketScannerPanel,UniverseHealthPanel}.tsx`, `components/company/CompanyIntelligenceView.tsx`, tests.
Changed: `src/routes/index.ts`, `src/services/CronService.ts` (universe sync + broad scan + coverage + research queue + outcome grading), `src/services/capital/CapitalAllocationService.ts` (consume BROAD_SCAN run; coverage funnel), `src/entities/index.ts`, `src/config/database.ts`, `frontend/src/lib/api.ts`, `DiscoverView.tsx`, `Header.tsx`/`page.tsx` (company route), `MoneyDeskView.tsx` (coverage strip).

## H. Schema changes (one migration)

`security_master`, `security_master_changes` (append-only), `security_data_coverage`, `universe_sync_runs`, `opportunity_scans`, `opportunity_candidates`, `research_queue`, `company_research_profiles` (versioned, append-only), `opportunity_outcomes` (append-only). Indexes on symbol, tier, scan id, priority, snapshot date.

## I. API changes

`GET /api/universe/health`, `GET /api/universe/securities?tier=&type=&q=`, `GET /api/universe/funnel` (today's stage counts + exact reasons), `GET /api/universe/scan/latest` (scanner table with filters), `POST /api/universe/sync` (auth), `POST /api/universe/scan` (auth), `GET /api/universe/research-queue`, `POST /api/universe/research/:symbol` (auth, AI research with evidence), `GET /api/universe/company/:symbol` (Company Intelligence bundle), `GET /api/universe/learning` (segment performance, withheld below 10). Money Desk `/api/capital/today` gains `coverage` (scanned → research-qualified → setups → risk-qualified → allocations).

## J. UI changes

Discover becomes a market scanner (filters + results table + actions) with a Universe Health section; a Company Intelligence page at `#company/<SYMBOL>`; Money Desk shows "Market scan coverage"; Model Lab Learning tab gains universe-segment performance.
