# Decision-System Audit (Stage FIRST of docs/risk-spec.md)

**Date:** 2026-09-07 · **Method:** 7 parallel read-only inspectors + 7 adversarial fact-checkers
(167 verified findings, 18 corrections applied) + live database evidence. **No code was modified.**

## 0. Verdict up front

Every claim in the owner's failure case is **CONFIRMED** by code and live data:

| Spec claim | Measured / found | Evidence |
|---|---|---|
| Walk-forward direction ≈ 50–52% | 50.22% (30d) … 51.45% (7d) across 181 tickers | `model_performance.horizons`, live query 2026-09-07 |
| Brier ≈ 0.251–0.253 (≈ naive 0.25) | 0.2508–0.2533; **30d Brier skill is NEGATIVE** (0.2533 > 0.25) | same |
| Per-stock 30d hit rates on overlapping windows | 1-trading-day step × 21-td windows ⇒ consecutive predictions share 20/21 of their outcome window; "39 samples" ≈ **1–2 independent observations** | `src/services/quant/backtest.ts` (1-day step, offsets {1,2,5,10,21}) |
| ~79% hit rate is a mirage | BHEL 30d: 79.49% over 39 raw samples. Cross-section: **36/181 tickers ≥70% AND 34/181 ≤30%**, σ=22.4pp, range 7.7–100%. Independent n=39 would give σ≈8pp. Pure overlap+multiplicity noise, symmetric in both directions. | live query |
| UI showed BUY / BUY TODAY / 79 "conviction" | Confirmed chain, §3 below. The word **"conviction"** captions the raw technical setup score (`DecisionSummary.tsx:52,71,145`). | §3 |
| The 79 can read as 79% probability | The same page shows four different numbers labeled "P(up)"-style (§10.5) and the score sits beside them captioned "conviction". | §10 |

**Partially fixed already (2026-09-06, this repo):** the canonical `DecisionService`
(`src/services/decision/policy.ts`, decision-policy-v2) overlap-adjusts samples
(`effectiveSamples = max(1, floor(rawN/30))`, min 10 effective, one-sided 95% edge test,
band-coverage ≥60%, Brier ≤0.3, vol ≤60%, anchor ≤5 days) and currently outputs **WAIT**
for BHEL with the reason "79.5% over 39 matured predictions ≈ 1 independent observation."
A regression test pins this ("the BHEL mirage", `tests/decision-policy.test.ts`).
**The disease that remains:** that gate is consumed by exactly **two** surfaces
(CanonicalDecisionCard, PortfolioView). Everything else — the Stock Detail hero verdict,
Top-5, Discover tables, research brief — still renders the ungated heuristic chain,
so one page shows canonical **WAIT** beside heuristic **BUY / BUY TODAY / 79**.

---

## 1. Current architecture

Two parallel judgment systems:

**A. Heuristic chain (renders almost everywhere):**
`MarketDataService` bars → `quant/engine.ts` (8-signal composite score 0-100, recommendation
BUY/HOLD/AVOID, riskLevel, per-horizon predictions + `directionProb`) → `framework/entryTiming.ts`
(timing score 0-100 → BUY_TODAY/WAIT/AVOID_ENTRY) → `StockService.analyze()` (Stock Detail)
and `StockService.runScan()` (Top-5/Discover, news-less) → `DecisionSummary`, `EntryChip`,
`TopPicksView`, `StocksView`, research brief.

**B. Evidence-gated canonical path (renders in 2 places):**
nightly cron → immutable forecast issuances (`forecast_runs/points`, seeded bootstrap
quantiles) + outcome grading (`forecast_outcomes`) → `DecisionService.publish`
(policy v2 gates on measured stats) → `decision_snapshots` → `GET /api/decision/:ticker`
→ CanonicalDecisionCard + PortfolioView chips. Published **only for watchlisted/held
instruments** (`DecisionService.ts:197-201`) — the other ~149 universe tickers never get
a canonical decision, yet appear ranked in Discover.

Supporting subsystems: walk-forward backtest + live PredictionLog verification (§5),
cross-sectional rank (§2.5), 8-phase framework (§2.2), XBRL intelligence engine (§6),
HAR-RV vol model, paper-trading sandbox. Phase-D evaluation infrastructure
(`experiments/splits.ts` purged splits + `dateBlockBootstrap`, `experiments/baselines.ts`)
**exists but has zero production callers.**

## 2. Exact source of each score

| # | Score | Formula (verified) | Where |
|---|---|---|---|
| 2.1 | **Quant score** (`analysis.score`, the "79") | `clamp(50 + 50·Σ(wᵢ·sᵢ), 0, 100)`; weights: trend SMA-alignment .20, momentum .20 (0.7·returns + 0.3·RSI), MACD .15, Bollinger mean-reversion .10, volume .10, 52-week position .10, rel-strength vs NIFTY .10, volatility penalty .05 | `engine.ts:154-332` |
| 2.2 | **Framework masterScore** | renormalized weighted mean of phase pass-rates (pass=1/neutral=.5/fail=0): macro .10, industry .15, fundamentals .20, **valuation .20**, technicals .15; null under 3 scored phases; verdict >85 STRONG / ≥70 WATCH / else PASS | `FrameworkService.ts:30-37,75,193-209` |
| 2.3 | **Entry timing score** | `50 + Σ deltas`: quant anchor ±(score−50)·0.5 (up to ±25 — **not independent of 2.1**), RSI −15/+5/+8, %B −10/+8, regime −12/+5, pop7d ±10, next-day −5, news −20/−12/+8 | `entryTiming.ts:51-200` |
| 2.4 | **Macro regime score** | additive: NIFTY vs 200DMA (0/10/20) + vs 50DMA (0/10/20) + VIX zone (0/12/25/35) + USDINR (5/18/25); risk-on ≥65 / risk-off ≤35; cached 6h, stale-served on failure | `MacroService.ts:139-147` |
| 2.5 | **Rank composite/percentile** | z(momentum60d)·.5 + z(quality)·.3 + z(sentiment)·.2, z clamped ±3, missing→z=0; percentile 0-100 | `rank.ts:17,98-119` |
| 2.6 | **Intelligence quality** | equal-weight mean over ≤5 filing sub-signals ×100 (ROIC≥15, FCF>0, FCF-margin graded, CR≥1, 0<PEG<1.5); null <2 inputs; **FCF double-counted** (fcf + fcf-margin are two "equal" slots) | `intelligenceQuality.ts:73-97` |
| 2.7 | **News sentiment/hype** | keyword lexicon (22 pos / 24 neg stems), 48h-half-life decay mean ×100; hype = min(100, 8·fresh24h + 50·\|sent\|); self-labeled "crude deterministic keyword count" | `NewsService.ts:32-264` |
| 2.8 | **directionProb** (the only heuristic-path probability) | `clamp(Φ(expected/(σ√t)), .05, .95)` where `expected = clamp(0.25·μ·t + tilt·σ√t·0.35, ±2.5σ√t)` and **tilt = (score−50)/50 from the ROUNDED score** — the setup score circularly manufactures its own "probability" | `engine.ts:415-421,332-333` |
| 2.9 | **Per-prediction "confidence"** | `PredictionLog.confidence = directionProb` — every persisted prediction carries the uncalibrated CDF heuristic as a 0-1 "confidence" | `PredictionLog.ts:39`, `StockService.ts:547-548` |

**Scores the spec requires that DO NOT exist:** standalone `valuationScore` (only inside
framework phase 5), `riskScore` 0-100 (three inconsistent categorical labels instead, §10.4),
`dataQualityScore` (absent), `forecastConfidenceScore` (absent), `overallOpportunityScore`
(absent), `businessQualityScore` (≈ 2.6, partially).

## 3. Exact source of BUY / BUY TODAY / HIGH RISK / 79

1. **BUY**: `engine.ts:346-348` — `score ≥ 62 → BUY` unless (riskLevel HIGH AND bearish trend); `≤38 → AVOID`; else HOLD.
2. **HIGH RISK**: `engine.ts:336-340` — annualized vol >35% → HIGH (BHEL ≈36% ⇒ HIGH), <20 LOW, else MEDIUM; 1y drawdown < −40% bumps a level. Max volatility penalty inside the score itself is **−2.5 points** (weight .05) — risk containment relies entirely on the recommendation gate.
3. **BUY TODAY**: `entryTiming.ts:203-206` — timing score ≥62 → BUY_TODAY for any non-AVOID stock (**a HOLD stock can show BUY TODAY**); rendered uppercase by `Chip.tsx` ENTRY_META.
4. **79 "conviction"**: `analysis.score` rendered by `DecisionSummary.tsx:145` ("Quant signal 79/100") with the ScoreOrb captioned **"conviction"** (`DecisionSummary.tsx:52,71`).
5. **#1 Top-5 rank**: `StockService.ts:569-586` — sort by raw score desc, filter `(riskLevel !== 'HIGH' || score ≥ 75)`, slice 5. **No BUY-only gate, no minimum score, no DecisionService consultation, no freshness flag**; BHEL at 79 with HIGH risk passed the ≥75 carve-out and ranked #1.
6. **Circularity on the scan path**: score → tilt → expectedReturn → directionProb7d → entryTiming pop7d input (+10 at ≥0.60) → timing score → BUY TODAY. The setup score feeds the "probability" that then boosts the timing verdict; on the Analyze path pop7d comes from Monte Carlo instead (`StockService.ts:305-313` vs `698-707`) — **two different estimators feed the same ±10 rule depending on surface.**

## 4. Forecasting implementation

- **Engine path:** per horizon t∈{1,2,5,10,21}td: `expected = clamp(0.25μt + tilt·σ√t·0.35, ±2.5σ√t)`; 80% band = ±1.2816σ√t (width from historical σ only — signals move the center, never the width); `directionProb` = normal CDF of the model's own output.
- **Bootstrap path:** `montecarlo.ts` — seeded (mulberry32, 20240915) 10,000-path **i.i.d.** single-day resampling (NOT block: autocorrelation/vol clustering destroyed), pool ≤250 returns, throws <60; `pop` = fraction of paths >0; **no drift shrinkage** (engine shrinks μ by 0.25 — the two "P(up)" families disagree by construction).
- **Immutable issuances:** `ForecastService` converts per-step quantiles to prices, `calibrationVersion: 'raw-quantiles-v0'` (honestly labeled uncalibrated); graded by `verifyOutcomes` (insideBand80/90); universe = watchlist/held only.
- **Probability-labeled surfaces:** MonteCarloCard "Probability of profit"; ForecastChart "P(up)" (=directionProb); DailyForecastCard "P(up)" (=issued pop); InvestmentBriefCard "P(up)" — where `StockService.ts:1258` **silently substitutes directionProb for MC pop** when an MC horizon is missing, under a frontend type comment (`types.ts:455`) claiming "P(return > 0)"; `layout.tsx:10` and `ProjectionsTable.tsx:114` call the 80% band a "confidence range".
- **Calibration is measured, never applied.** Brier/reliability buckets exist for directionProb only; **MC pop has no reliability measurement anywhere**; no displayed probability is recalibrated.

## 5. Backtesting methodology

- Walk-forward, 1-trading-day step over `testDays` (default 60, clamp 10–250), ≥120-bar lookback; each day re-runs `analyzeBars(bars[0..T])`, grades at T+offset. **Consecutive 30d predictions share 20/21 of their windows ⇒ "39 samples" per ticker.**
- "samples" = raw overlapping count everywhere: per-horizon stats, `upsertModelPerformance` totals, `GET /api/accuracy` and `/api/calibration` aggregates (raw-sample weighted). **The overlap correction exists only inside decision-policy v2** — not in the backtest, accuracy, or calibration surfaces (prose caveat only).
- **No Newey-West / HAC / block-bootstrap uncertainty in production.** `dateBlockBootstrap` (`experiments/splits.ts:135`) was built for exactly this and has **zero callers**.
- **Live loop:** 08:45 IST cron logs 5 PredictionLog rows/ticker/day (append-only-if-absent — application-level only, **no DB uniqueness constraint**, race-prone); 18:30 verify fills actuals, then **immediately overwrites ModelPerformance with a fresh 60-day backtest** — so the "measured" stats the decision gate reads are backtest-derived, not live-verified (**provenance mismatch**: policy reason text says "matured predictions"). Verified live rows (743 of 2,528) feed only the /api/calibration "live" table.
- Additional defects: `verifyMaturedPredictions` fetches only 1y bars → rows older than the window are **silently never verified**; flat-day convention differs live (≥0 = UP) vs backtest (>0); near-zero deadband (|actual|<0.05% hits iff |pred|<0.3%); `accuracyBelowThreshold = accuracy < 0.65` — always true at ~51%, nothing consumes it; **the backtest omits the weight-.10 relative-strength signal that live predictions use** (1y vs 2y bar depth also differs) — measured accuracy describes a *different model* than the one logging; `DecisionService`'s measured-stats SQL has **no model_version filter and no recency cutoff**; `PredictionLog.targetDate` stored in calendar days but graded at trading-day offsets (cosmetic field disagrees with actual outcome date).

## 6. Data providers

Yahoo bars (DB-cached, freshness rules, stale explicitly labeled `db-stale`; **partial
today-bar dropped only at persist time — the fetch path returns it to callers**, §9);
quotes 5-min cache (**missing previousClose masked as 0% change**, `MarketDataService.ts:444-455`);
index bars 6h cache with **unlimited-age stale fallback**; Yahoo quoteSummary fundamentals
(all-nullable, 24h); Google News RSS + lexicon sentiment (§2.7); NSE XBRL filings (27
concepts, `NOT_AVAILABLE` flagged, bank-aware — the one subsystem that treats missingness
correctly, though **gross-debt fallback treats a missing side as ₹0** `xbrl.ts:266-269`);
RBI rates. **`yahoo.ts:184` records missing volume as 0 for all tickers** (fabricated-zero
volume days feed the volume signal).

## 7. Database schema

~40 registered tables; ~25 live. Live core: stocks, stock_history, analyses, prediction_logs,
model_performance, rank_snapshots, intelligence_{sources,metrics,evidence}/financial_facts,
macro_observations, accounts/instruments/instrument_aliases/watchlist_items/ledger_transactions/
lot_allocations, trading_sessions, forecast_runs/points/outcomes, decision_snapshots,
experiment_runs (**created, unused**), paper_accounts/trades, cron_execution_logs.
15 legacy artifacts preserved (users, portfolios, positions, watchlists, alerts,
stock_metrics, rate_limit_logs, training_samples, model_registry, fundamental_data,
sentiment_data, market_context, ensemble_weights, kelly_drift).

## 8. API endpoints

~45 endpoints (auth/watchlist/ledger/portfolio-overview; forecasts + decisions; analyze/
top-picks/rank/backtest/accuracy/calibration/research; intelligence; admin sandbox; jobs).
Security findings: **POST /api/analyze is unauthenticated and mutates canon** (Analysis +
first-of-day PredictionLog rows fixed permanently); intelligence refresh endpoints
unauthenticated persistence; admin routes documented as session-gated but actually
**adminKeyGuard only** (`routes/admin.ts:44` vs comments in `routes/index.ts:94-95`).

## 9. Potential leakage (verified)

**The replay core is leak-free** — `backtestBars` slices `bars[0..T]` before computing;
indicators are trailing-only; rank IC measured only on pre-persisted snapshots; HAR OOS
fits strictly before targets; morning 08:45 logging uses the prior session close (ex-ante);
no news reaches any backtest path. The real problems:

1. **No adjusted close anywhere** (price data): `fetchChart` never reads Yahoo `adjclose`; `persistBars` delete/reinserts only the fetched range ⇒ splits/demergers stitch two price scales into one series (the universe includes the 2025 TMPV demerger, −40% fake jump). Fake return jumps feed μ/σ/momentum/backtest actuals/rank-IC; inflated σ widens bands ⇒ **the ~85% band coverage is partly artifact**. (The ledger handles splits for *positions*; the *bar store* does not for *analytics*.)
2. **Partial today-bar returned to callers** on the Yahoo-fetch path (guard only at persist): an intraday-triggered backtest/log/issuance treats a mid-session price as a final close; intraday-triggered verification can grade and **freeze** an outcome against a partial bar.
3. probBuckets calibration is fitted on the same 60-day sample it reports (descriptive, not fed back — must be labeled, not trusted).
4. Backtest model ≠ live model (missing RS signal; 1y vs 2y depth) — accuracy statements attach to a model nobody runs live.
5. Vol model's headline OOS R² = max of two models selected on the same reporting window (selection bias).

## 10. Logical contradictions

1. **Canonical WAIT beside heuristic BUY/BUY TODAY** on the same Stock Detail overview; both use the phrase "Buy candidate" for different things. CanonicalDecisionCard **returns null on error/pending** — the conservative verdict silently disappears, the aggressive one never does.
2. **HOLD headline + BUY TODAY chip** on one card (entry timing hard-gates only on AVOID).
3. **Same ±10 timing rule, two different probability estimators** (MC pop on Analyze, directionProb on scans) ⇒ Discover and Analyze chips can disagree on identical bars. Scan path also passes `news: null` (never news-penalized) and a failed regime fetch silently disables the −12 risk-off penalty for all 151 tickers.
4. **Three risk formulas**: engine (20/35 realized vol), policy (25/45 band-implied vol), horizon policy (28/45 vol + drawdown + quality) ⇒ one stock can simultaneously show "HIGH RISK", "medium", and "Moderate hold". Policy's own BUY_CANDIDATE isn't blocked by its own "high" label (vol 45–60 window).
5. **Four "P(up)"-style numbers on one page** that disagree by construction: directionProb (shrunk drift + tilt), MC pop (unshrunk), issued pop (anchored), measured hit rate (~50%); research brief mixes two under one field.
6. Top-5 needs no BUY and consults no gate; canonical decisions exist only for watchlist/held instruments — **Discover's whole surface is ungated**.
7. Framework verdict "PASS" (=reject) is also the null/no-data verdict — data absence rendered as a negative judgment.
8. Fee claims: ~2% (fees.ts round-trip on ₹1k), 0.2–0.5% (research brief text), ~1.9% (sandbox breakdown) across surfaces.
9. Trade plan (3:1 target) renders for HOLD stocks beside a WAIT snapshot; DecisionSummary shows the plan without the reward-risk plausibility flag that TradePlanCard applies to the identical plan on the same tab.
10. PortfolioView tints the forecast median as buy/sell coloring next to snapshot text saying "the median is a distribution centre, not a signal"; StocksView mixes an **uncapped-age** scan cache (`getUniverse` skips the TTL check that `peekScanEntry` enforces) with stored analyses of any age.

---

## Appendix: measured evidence (live DB, 2026-09-07)

```
per-horizon system means (181 tickers, raw overlapping samples):
  1d  hit 51.36%  Brier 0.2522        prediction_logs: 2,528 total / 743 verified
  3d  hit 50.75%  Brier 0.2517        BHEL.NS 30d: hit 79.49%, Brier 0.2195,
  7d  hit 51.45%  Brier 0.2508          band 100%, rawSamples 39 (≈1 independent)
 15d  hit 51.15%  Brier 0.2514        30d hit-rate cross-section: 36 tickers ≥70%,
 30d  hit 50.22%  Brier 0.2533          34 tickers ≤30%, σ=22.4pp, range 7.7–100%
```

Brier skill vs 0.25 constant: −0.9% (1d) … **−1.3% (30d)** — ≤0 at every horizon.
Per risk-spec Rule 2: `brierSkill <= 0 ⇒ maximumAction = WATCH` — system-wide, today.
