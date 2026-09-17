# StockSense India — Calculation Flow, Viability & Trustworthiness

**Independent code review, 2026-09-17.** Every claim below was checked against
the source at the cited `file:line`. Where this review disagrees with
`ARCHITECTURE.md`, the code is treated as the truth.

**Remediation status (updated 2026-09-17):**
- Batch 1 (correctness bugs, §5.1/§5.2 + two more found along the way) —
  ✅ done, branch `fix/correctness-bugs` (c33feba, bc60968), not yet merged.
- Batch 2 (statistical integrity, §4.1/§4.2/§4.6 fully fixed, §4.3 partially)
  — ✅ done, branch `fix/statistical-integrity` (518b657, 3eff648; branched
  from batch 1's tip, so it contains both batches' changes), not yet merged.
  §4.4 (shrinkage dead code) and §4.5 (volforecast selection bias) were in
  scope for this review but not part of the user's requested statistics
  batch — still open. **The v2 study has since been re-run against a real
  local Postgres + live Yahoo fetch (2026-09-17): 0/12 setup×horizon cells
  reach TIER A out-of-sample — see §4.2 and §13 for the full result.**
- Batch 3 (continuous learning) — ✅ done, branch `feature/continuous-learning`
  (ef33011; branched from batch 2's tip, so it contains all three batches'
  changes), not yet merged. Scoped deliberately: it schedules the existing,
  already-correct calibration/ensemble/experiment machinery (previously only
  ever run manually) on a weekly cron job, rather than adding new online
  retraining of the deterministic engine's hardcoded weights — see the new
  §12 below for the full writeup and why that scoping is the honest choice
  here, not a shortcut.

**Bottom line.** The *containment* architecture — the machinery that stops the
system making a confident claim it has not earned — is real, well built, and
genuinely unusual. The *estimation* layer underneath it is a large body of
hand-chosen constants and several statistical routines that do not do what
their names and comments say. The system is trustworthy today **because it
refuses to act**, not because its numbers are validated. The honest one-line
summary: *a well-engineered refusal machine wrapped around an unvalidated
signal engine.*

---

## 1. How to read this document

| Section | Question answered |
|---|---|
| §2 | What the system actually computes, end to end |
| §3 | What is genuinely trustworthy |
| §4 | What is named but not implemented (the serious findings) |
| §5 | Correctness bugs |
| §6 | Where numbers are fabricated or silently imputed |
| §7 | Fragility and operational risk |
| §8 | Doc-vs-code drift |
| §9 | Verification performed for this review |
| §10 | Prioritised remediation |

---

## 2. The calculation flow, end to end

### 2.1 Data in

All prices come from **one keyless vendor, Yahoo Finance**:

- Bars + adjusted close + split/dividend events — `market/yahoo.ts:156`
- Quote, 52-week range, market state — chart *meta*, `MarketDataService.ts:467`
- Fundamentals via a **cookie+crumb handshake** that depends on
  `fc.yahoo.com` returning *404 with a Set-Cookie header* —
  `FundamentalsService.ts:165`
- `^NSEI`, `^INDIAVIX`, `INR=X` for macro — `MacroService.ts:22`

Fundamental "intelligence" comes from NSE XBRL filings (authority tier 1) plus
HTML scrapes of Screener.in (tier 4), an RBI home-page regex, and BSE JSON.
Trendlyne and Tickertape return `{}` unless hand-configured env slugs exist
(`TrendlyneDataSource.ts:48`), so the advertised three-provider fallback chain
is in practice **one provider**.

Split/dividend adjustment is *not computed* — the code trusts Yahoo's
`adjclose` and falls back to the raw close where it is absent
(`canonical.ts:51`). A residual-break detector flags |return| > 25%
(`canonical.ts:116`) but only flags; it never corrects.

### 2.2 The descriptive engine

`quant/engine.ts` produces the visible 0–100 score:

```
score = clamp(50 + 50 · Σ wᵢ·vᵢ, 0, 100)          engine.ts:364
```

over eight signals — trend 0.20, momentum 0.20, MACD 0.15, Bollinger 0.10,
volume 0.10, 52-week position 0.10, relative strength 0.10, volatility penalty
0.05. Forecasts are:

```
raw      = μ·0.25·t + tilt·σ·√t·0.35              engine.ts:448
expected = clamp(raw, ±2.5·σ·√t)
band     = ±1.2816·σ·√t                            engine.ts:451
```

`MU_SHRINK 0.25`, `TILT_SCALE 0.35`, `RETURN_CLAMP_SIGMAS 2.5` and the whole
weight vector are asserted constants (`engine.ts:43-46`). The 80% band is a
pure i.i.d.-normal scaling: no fat tails, no autocorrelation, no parameter
uncertainty.

### 2.3 The decision gate

`decision/policy.ts` — one pure function, `evaluateEntryPolicy`. It is the
**sole** producer of `BUY_CANDIDATE`; every other module only reads, filters or
caps it (verified by grep). BUY requires *all* of: fresh issuance, anchor ≤ 5
days old, ≥ 30 matured samples, overlap-adjusted validated edge, positive Brier
skill, band coverage ≥ 60%, dataQuality ≥ 70, forecastConfidence ≥ 60,
entryQuality ≥ 40, EV-after-costs > 0, riskScore < 80, non-hostile regime, and
model health `HEALTHY`.

The edge test (`policy.ts:152`) uses `effectiveSamples = floor(raw/30)` and
requires effN ≥ 10 — i.e. **≥ 300 raw daily-logged 30-day predictions** before
a BUY is even arithmetically possible. The code marks the BUY branch
`unreachable on today's evidence` (`policy.ts:367`).

### 2.4 The short-term radar

Setups are classified by ~40 hand-chosen thresholds (`setups.ts:19`), scored,
then passed through a lattice of conservative ceilings (`actionStates.ts:100`)
composed from evidence tier, model health, freshness, confirmation, EV lower
bound, affordability and contradictions. Position sizing solves quantity
against *full* per-share loss including costs, slippage and a gap buffer
(`sizing.ts:49`) — this part is well done.

### 2.5 The AI layer

AI is **structurally incapable of raising an action**. Two independent clamps:
`snapshotGrounding.ts:165` compares integer action ranks and discards any
raise; `reasoning/types.ts:240` clamps the committee review to the gate
ceiling. No AI value is ever written to `DecisionSnapshot.decisionStatus`,
which is assigned only from `sealed.decision` (`DecisionService.ts:382`).

---

## 3. What is genuinely trustworthy

These were verified, not taken on trust:

1. **Zero-lookahead is proven, not asserted.** `tests/features-leakage.test.ts`
   mutates every future bar (×5 close, zeroed volume) and asserts feature
   output is byte-identical. That is the correct proof, and it passes.
2. **Immutability is enforced by Postgres triggers**, not convention —
   `migrations/1789700000000-CreateLiveHistory.ts:59` raises an exception on
   UPDATE/DELETE unless an explicit admin GUC is set.
3. **Single action authority** holds architecturally (§2.3).
4. **AI cap-only** holds for `decisionStatus` (§2.5).
5. **Purge + embargo splits are correctly implemented** —
   `experiments/splits.ts:49`, date-grouped, calendar-day purge, hard throw on
   degenerate splits.
6. **The calibrator refuses to ship** when it cannot beat baselines
   out-of-sample (`research/calibration.ts:160`), and the product then prints
   "Directional probability unavailable" — enforced in real UI code
   (`CanonicalDecisionCard.tsx:125`).
7. **`shadowFill.ts:191` refuses to record a realized R** when the intrabar
   sequence is ambiguous, rather than guessing.
8. **The cost schedule is real** — itemised Indian delivery model, versioned
   (`costs.ts:24`).
9. **Honest negative results are recorded and acted on**: the block-bootstrap
   MC simulator was measured *worse* than i.i.d. and left unwired
   (`montecarlo.ts:263`); the champion's Brier skill is recorded as negative and
   nothing was promoted.
10. **SSRF guard** with per-redirect-hop revalidation and a host allowlist
    (`intelligence/ssrfGuard.ts`).

This is a materially better honesty posture than most retail analytics code.

---

## 4. Named but not implemented — the serious findings

These matter most, because each is a place where a *statistical guarantee is
claimed by name* and the code does something weaker.

### 4.1 The EV confidence interval that gates every entry is not a block bootstrap — **FIXED** (`fix/statistical-integrity`, commit 518b657)

> Fixed with a genuine nested block bootstrap: `stationaryBlockResample()`
> resamples the daily-return HISTORY itself in contiguous blocks, and
> `simulateBracketWalk()` (the trade's own bracket simulation, extracted for
> reuse) is re-run on each of 120 resampled histories. `independentSamples`
> is now `pool.length/10` (fixed block length), no longer
> `pool.length/maxHoldDays` — it stops varying with the trade's own holding
> period. 4 regression tests in `tests/short-term-v2.test.ts` prove
> determinism, the CI no longer reproduces the old horizon-driven inflation
> factor, and a genuinely more volatile history now produces a wider CI.
> Point estimates (mean/median/R-stats) are unchanged. Cost: ~150ms/call
> (from a few ms), paid only for tickers that clear upstream gates on a
> 30-min-cached scan — measured acceptable.

`evUncertainty.ts:119` comments "Block-bootstrap the MEAN". There are no
blocks. The loop resamples the **simulator's own 3,000 path outcomes**:

```ts
const effectiveSamples = Math.max(1, Math.floor(pool.length / maxHoldDays));
for (let k = 0; k < effectiveSamples; k++) s += retPct[Math.floor(rand()*PATHS)];
```

Consequences:
- The interval measures Monte-Carlo dispersion of the simulator, **not**
  sampling uncertainty of the historical data.
- Its width is set by `floor(pool.length / maxHoldDays)` — with a 260-day pool
  and a 21-day hold that is **12**. Every 10–21d candidate's "80% CI" is the
  10th/90th percentile of a mean of 12 draws, and the width is tunable by
  changing the horizon.
- The paths are i.i.d. by construction, so the bootstrap assumes an
  independence that is *manufactured*, not earned. No serial correlation, no
  vol clustering, no regime persistence.

This is the CI behind the `ev80LowerPct > 0` entry gate.

### 4.2 The setup-expectancy study is in-sample and its "block bootstrap" has block length 1 — **FIXED** (`fix/statistical-integrity`, commit 3eff648)

> Fixed: the study now splits the shared entry calendar with the existing
> `buildPurgedSplits` (purge = longest horizon's hold in calendar days,
> embargo 5 days) and reads every promotable tier ONLY from the ~20% test
> segment (in-sample numbers still computed, labeled "not evidentiary", for
> comparison). The block-length-1 resample is replaced with a real
> `dateBlockBootstrap` at block length = the horizon's calendar-day hold.
> `independentEntryDates` is now `floor(rawDates/horizonMaxTD)`.
> `expectancyR` (gross) and `expectancyAfterCosts` (net) are now genuinely
> different numbers. Rewritten as `st-setup-expectancy-v2` — **not comparable
> to prior runs' numbers**. 8 unit tests in `tests/setup-expectancy-study.test.ts`
> cover the pure per-cell logic. `governance.ts`'s two setup-mean-reversion
> seed rows (citing the old +0.117R/+0.146R) were downgraded from CANDIDATE
> to SHADOW pending a v2 re-read, since `ON CONFLICT DO NOTHING` meant the
> stale claim would otherwise persist as documentation indefinitely.
>
> **Re-run against production infrastructure, 2026-09-17** (local Postgres +
> live Yahoo, full 151-ticker universe, 22,377 trades over 5 years): the
> train/test split produced 203 train / 50 val / 29 cal / 76 test dates
> (22 purged, 3 embargoed). **Every one of the 12 setup×horizon cells came
> back negative out-of-sample** — including the two MEAN_REVERSION cells the
> old v1 methodology had shown as TIER A (+0.117R/+0.146R in-sample):
> MEAN_REVERSION 10-21d was **−0.111R** and 5-10d was **−0.141R** on the held-out
> test segment, with 80%+ of that BH-insignificant. **0/12 cells reach TIER A;
> Deflated Sharpe on the best cell (MEAN_REVERSION 10-21d) is 0 — nowhere near
> the ≥0.95 bar, meaning it isn't distinguishable from noise even before
> accounting for the setup-threshold search.** This is exactly the outcome
> the fix predicted was possible: the v1 numbers were an in-sample/block-
> length-1-bootstrap artifact, not a real edge. See §13 for the full result
> and what it means for the product.

`scripts/setupExpectancyStudy.ts:117` labels itself "Block bootstrap by date"
but resamples **per-date means** — block length 1. That removes cross-sectional
same-day correlation and does nothing for serial correlation, while anchors run
at `STRIDE = 3` with holds up to 21 trading days, so retained anchors overlap
heavily. The CI is narrower than truth.

Worse: **the study has no train/test split at all.** It is in-sample over the
full 5-year history with the setup rules already fixed. The repo *contains* a
correct contiguous-block bootstrap (`experiments/splits.ts:135`) and a correct
purged-split builder — the study uses neither.

`independentEntryDates` counts distinct calendar dates with **no** division by
holding period, yet is checked against `minIndependentDates: 60`. The codebase
knows how to do this properly (`policy.ts:57`, `ModelHealthService.ts:99` both
divide by overlap); this study does not.

And `expectancyAfterCosts` is literally assigned the same value as
`expectancyR` (`setupExpectancyStudy.ts:157`) — the before/after-cost
distinction shown downstream is cosmetic.

### 4.3 Multiple-testing correction covers only the last step — **PARTIALLY FIXED** (`fix/statistical-integrity`, commit 3eff648)

> `deflatedSharpeRatio` and `probabilityOfBacktestOverfitting` are now wired
> into the study: DSR on the best-Sharpe test-segment cell with
> `nTrials` = cells examined, PBO over 8 time-blocks across eligible cells,
> both persisted and printed in the verdict. **Not fixed**: `nTrials` is
> stated as a floor — it still cannot see the ~40 hand-tuned setup-threshold
> and ATR-multiple-geometry degrees of freedom spent during earlier
> development, so DSR/PBO here under-state the true search space. BH's family
> is still only the setup×horizon cells (now correctly the ~9-15 TEST-segment
> cells rather than the full-history cells, an improvement, but the family
> size itself is unchanged).

BH itself is correctly implemented (`shrinkage.ts:74`). But the family is only
the ~15 setup×horizon cells. Outside the correction: the ~40 hand-tuned setup
thresholds, the ATR-multiple plan geometry, the stride/lookback choices, and
the three *correlated* horizons applied to the same anchors. `overfitting.ts`
implements Deflated Sharpe and PBO — exactly the tools for this — and **is
never called from anywhere** (verified by grep).

### 4.4 Shrinkage is dead code

`shrinkage.ts` claims "Only the SHRUNK estimate may enter the decision system."
Vacuously true: its only consumer is `conditionalForecast.ts:32`, and
`conditionalEstimate` has **zero callers**. `ScanService.ts` reads the **raw**
unshrunk per-cell expectancy. Also, `k = 25` is a fixed pseudocount, not an
estimated James–Stein weight ("James–Stein-*style*").

### 4.5 Model selection reported as unbiased out-of-sample

`volforecast.ts:522` picks HAR vs HAR-X by whichever won on the OOS window,
then reports that same maximum as the chosen model's OOS R². Taking the max of
two noisy estimates over ~60 overlapping days and reporting it as unbiased is
selection bias. In-sample R² also ships in the same object (`:603`).

### 4.6 Overlap adjustment is implemented three inconsistent ways — **FIXED** (`fix/statistical-integrity`, commit 518b657)

> `harness.ts`'s `metricsFor` now divides `distinctDates` (not pooled rows) by
> `td`, matching the other two implementations. `metricsFor` exported for
> direct testing; 4 regression tests in `tests/harness-overlap.test.ts` prove
> the corrected divisor against the old formula on the exact 40-tickers×100-dates
> scenario this section describes. Newey–West SE's narrower scope (MAE only)
> is unchanged — not part of this fix.

- `policy.ts:57` — `floor(raw/30)` ✅
- `ModelHealthService.ts:99` — `floor(distinctDates/overlap)` ✅
- ~~`harness.ts:217` — `floor(preds.length/td)` on pooled cross-sectional
  rows ❌ — over-counts by roughly the ticker count (40 tickers × 100 dates
  at 30d → ~190 "effective samples" from ~5 truly independent windows).~~
  now `floor(distinctDates/td)` ✅

Newey–West SE is correctly implemented but applied **only to MAE**, not to hit
rate, Brier or coverage.

---

## 5. Correctness bugs

### 5.1 Bank detection misses most Indian financials — highest-impact bug — **FIXED** (`fix/correctness-bugs`, commit c33feba)

> Fixed by `classifyIndustryKind()` (`IntelligenceService.ts`), which
> classifies by the universe's own sector field first (Banking/Financial
> Services/Insurance), with a name-pattern fallback only for tickers outside
> `NSE_UNIVERSE`. `calculateFcf` is now bank-gated too. Regression coverage in
> `tests/industry-classification.test.ts`.

`IntelligenceService.ts:20` detects banks with a **hardcoded 10-ticker regex**.
The universe (`nseUniverse.ts`) contains **151 stocks, of which 34 are
financial-sector**. Verified by direct test, these are classified
`NON_FINANCIAL` and therefore receive industrial ROIC / ROCE / current-ratio /
FCFF-DCF **with no refusal**:

> PNB, CANBK, BANKBARODA, UNIONBANK, YESBANK (all genuine banks), plus
> BAJFINANCE, BAJAJFINSV, SHRIRAMFIN, CHOLAFIN, MUTHOOTFIN, LICI, SBICARD,
> HDFCLIFE, SBILIFE, ICICIGI, ICICIPRULI, PFC, RECLTD, IRFC, JIOFIN, HUDCO,
> PAYTM, POLICYBZR, HDFCAMC

For the 10 matched tickers the refusals are clean and well tagged. For the
other 24 the engine emits confident, meaningless ratios. FCF is never
bank-gated at all, for any ticker.

### 5.2 Backtest grades predictions on a different price basis — **FIXED** (`fix/correctness-bugs`, commit c33feba)

> Fixed by a local `analysisClose()` helper in `backtest.ts` (adjustedClose ??
> close, matching the policy `engine.ts` builds predictions on). Regression
> test in `tests/quant.test.ts` simulates a 2-for-1 split and confirms
> `actualPct` is no longer corrupted.

Predictions are built on the **adjusted + rescaled** close series
(`engine.ts:141`) but the realized return is computed from the **raw** close
(`backtest.ts:121`). A split or large dividend inside the horizon injects a
spurious "actual" move that the model is then scored against.

### 5.3 The fail-closed claim is false at the AVOID tier

`DecisionService.ts:147` states null "can only make the gate MORE conservative,
never less". The `AVOID_NEW_ENTRY` vetoes are null-guarded
(`policy.ts:247`, `:253`): a null `riskScore` or null `vol` means the veto
**cannot fire**, so a genuinely hostile stock degrades to `WAIT` rather than
`AVOID`. True for Gate 2, false for Gate 1.

### 5.4 Inert safety machinery

`RISK_LIMITS.drawdownKillSwitchPct` never triggers — `ScanService.ts:159`
passes `equityDrawdownPct: null`. Similarly `stabilityDelta` is hardcoded null
(`DecisionService.ts:339`), so forecast-confidence has a reachable maximum of
**90, not 100**, silently tightening the 60 gate.

### 5.5 Governance seeded without evidence

`governance.transition` accepts `evidenceRunId: null` despite its docstring,
and `seedFromVerdicts` (`governance.ts:89`) writes ten model states with NULL
evidence ids — including promoting the two MEAN_REVERSION cells to CANDIDATE on
the strength of the in-sample study in §4.2.

---

## 6. Fabricated and silently imputed values

The "never fabricate" rule holds well in the bars/XBRL paths (nulls, throws and
`NOT_AVAILABLE` are used consistently). The leaks are concentrated in
**derived-score paths**, where a missing input becomes a neutral-looking number
instead of an abstention:

| Location | Behaviour |
|---|---|
| `engine.ts:243,264,286,308,328` | Every unavailable signal contributes value `0` **at full weight**; weights are never renormalized, so a stock missing MACD + volume + 52w + NIFTY still scores, diluted toward 50 with no coverage flag |
| `engine.ts:290` | `(r5 ?? 0) >= 0` — a *missing* 5-day return reads as an up-move |
| `backtest.ts:143` | Zero samples → `directionHitRatePct: 0, withinBandPct: 0` — fabricated zeros indistinguishable from measured catastrophe |
| `backtest.ts:91` | Empty probability buckets report `meanPredicted: 0, observedUpFreq: 0` |
| `MacroService.ts:104` | `vs200dmaPct` defaults to 0 when SMA200 is null → awards **10 points** for a 200-DMA never computed; `r60dPct ?? 0` → "stable INR" → **18 of 25 points**. The human-readable `notes` narrate these as measurements |
| `MarketDataService.ts:482` | `previousClose ?? price` → a fabricated **0.00% change** presented as a real quote, with no flag |
| `calculations.ts:156` | ~~ROIC debt imputed as `(borrowingsCurrent ?? 0) + (borrowingsNoncurrent ?? 0)` → debt = 0 when both absent, inflating ROIC silently~~ — **FIXED** (`fix/correctness-bugs`, commit c33feba): now refuses unless debt is known from `grossDebt` or at least one borrowing sub-concept |
| `rank.ts:68` | Missing rank components imputed as z = 0 with no renormalization; single-ticker percentile hardcoded to 50 |
| `indicators.ts:74,120` | RSI 50 / %B 0.5 for degenerate inputs |
| `yahoo.ts:197` | Missing volume → 0, persisted to DB |

### The DCF is an assumption presented as a calculation

`dcf.ts:5` — **every valuation driver is a literal constant, identical for
every stock in the universe**: bear/base/bull growth 4/8/12%, WACC 13/11/10%,
terminal growth 3/4/5%. No CAPM, no beta (Yahoo's beta is fetched and never
used), no cost of debt, no risk-free rate — *despite the repo ingesting the
live RBI repo rate and FRED CPI/GDP*. Growth is not taken from the company's
own computed growth series.

Share count is itself inferred: `marketCap / price` (`IntelligenceService.ts:111`),
not a filed figure, with no unit reconciliation against XBRL values.

~~The result is labelled `status: "CALCULATED"` and carries the **XBRL filing
URLs as its sources** — even though `DataStatus` has an `"ESTIMATED"` value
available.~~ **FIXED** (`fix/correctness-bugs`, commit c33feba): relabeled
`status: "ESTIMATED"`; `IntelligenceRepository.ts`'s row parser updated to
match. The hardcoded scenario constants themselves (growth/WACC/terminal
growth identical for every ticker) are unchanged — that is a P2 item (§10.10),
not a labeling bug — but the metric no longer overstates how sourced it is.

---

## 7. Fragility and operational risk

Ranked by blast radius:

1. **Yahoo cookie/crumb handshake** (`FundamentalsService.ts:165`) — undocumented
   private endpoint depending on a 404-with-Set-Cookie. If it breaks: no PEG, no
   DCF share count, no market cap, no earnings dates. One retry, no circuit breaker.
2. **Single-vendor price dependency** — all bars, all indices, all FX from Yahoo.
   There is no second price source anywhere.
3. **Screener.in HTML scrape** (`ScreenerDataSource.ts:83`) — depends on exact
   CSS selectors and label strings; a redesign or Cloudflare challenge yields a
   silent `{}`.
4. **RBI home-page regex** (`RBIDataSource.ts:28`) — the policy repo rate is
   extracted by stripping HTML and pattern-matching. Layout change → zero macro
   values, no error.
5. **Google News RSS hand-rolled regex parsing** (`NewsService.ts:224`).
6. **Content-addressed document cache has no TTL** (`cache.ts:17`) — an XBRL
   instance, once cached, is never re-fetched.
7. **`source: "db-fresh"` is returned for bars up to 3 days old** under the
   holiday guard (`MarketDataService.ts:329`) — an honest-labelling gap.
8. **Secrets**: `.env` holds live API keys and `OWNER_PASS`. It is correctly
   gitignored and untracked (verified), but `.env.example` currently shows as
   deleted in git status — worth restoring so the required keys stay documented.

---

## 8. Doc-vs-code drift

- **Policy version**: code is `decision-policy-v6` (`policy.ts:37`);
  `ARCHITECTURE.md` cites v3 in one place and v5 in another; the file's own
  changelog stops at v4.
- **WAIT vs WATCH**: comments and user-facing `unmetGates` strings say
  "capped at WATCH" 8 times, but the returned status is `"WAIT"`
  (`policy.ts:364`). "WATCH" exists only in the AI vocabulary.
- **"Provisional" scoping**: `policy.ts:49` labels only the four v3 thresholds
  PROVISIONAL. The six v1/v2 constants above the divider —
  `minMaturedSamples 30`, `minEffectiveSamples 10`, `minBandCoveragePct 60`,
  `maxBrier 0.3`, `maxAnnualVolPct 60`, `maxAnchorAgeDays 5` — carry **no
  validation citation anywhere**, yet inherit implied authority. Only
  `edgeZ 1.645` and `labelOverlapDays 30` are derivable from first principles.
- **Threshold provenance generally**: roughly 60 numeric thresholds across the
  decision layer, ~40 more in setup classification, ~8 risk limits, and the
  entire slippage model. Essentially none cite an experiment ID. The project's
  own risk spec exists to prevent exactly this.
- **`technicalScore` is a literal alias of `setupScore`** (`scorecard.ts:268`) —
  two independent-looking numbers that are the same number.

---

## 9. Verification performed for this review

| Check | Result |
|---|---|
| `npx jest` | **45 suites / 527 tests pass** (3.9s) |
| `npx tsc --noEmit` | **clean, exit 0** |
| Test isolation | Deterministic/offline; fixtures and injected fakes, no live network |
| Leakage test quality | Mutation-invariance — the correct proof |
| `BUY_CANDIDATE` emission sites | Only `policy.ts`; all others read/cap |
| AI raise attempt | Structurally impossible (integer rank comparison) |
| Bank regex coverage | Tested directly: 10 matched, 24 financials unmatched |
| Dead code claims | Confirmed by grep: `conditionalEstimate` and `overfitting.ts` have zero callers |

**Limitation:** no PostgreSQL instance was reachable from this checkout, and
`node_modules` was absent until installed for this review. Therefore **every
runtime "measured" number quoted in `ARCHITECTURE.md` — hit rates, Brier
scores, coverage percentages, the 8/151 intelligence coverage — could not be
independently re-verified here.** They are reported as the project's claims,
not as confirmed facts. Re-running them against a live DB is the single
highest-value follow-up.

---

## 10. Remediation, in priority order

**P0 — correctness**
1. ✅ **FIXED** (`fix/correctness-bugs`, c33feba) — Replace the 10-ticker
   `BANKS` regex with a sector/industry classification driven by the
   universe's own `sector` field, and extend bank-aware refusals to NBFCs and
   insurers. Gate FCF too. (§5.1)
2. ✅ **FIXED** (`fix/correctness-bugs`, c33feba) — Grade backtests on the
   same adjusted basis used to generate the prediction. (§5.2)
3. Return `null`, not `0`, for zero-sample backtest horizons and empty
   calibration buckets. (§6) — *deferred: every current consumer already
   guards on `samples > 0` / `n > 0` before reading these fields, so this is
   a type-contract change (`number` → `number | null`) with no active bug
   today; folding it into the P1 statistics batch instead of a standalone
   correctness fix.*
4. Make the AVOID vetoes fire on unknown inputs, or correct the fail-closed
   comment. (§5.3)
5. ✅ **FIXED** (`fix/correctness-bugs`, c33feba, found during implementation,
   not originally listed) — ROIC silently imputed debt as 0 when both
   `grossDebt` and every borrowing sub-concept were absent. Now refuses. (§6)
6. ✅ **FIXED** (`fix/correctness-bugs`, c33feba, found during implementation)
   — DCF was labeled `status: "CALCULATED"` despite every driver being a
   hardcoded assumption; relabeled `"ESTIMATED"`. (§6)

**P1 — statistical integrity**
5. ✅ **FIXED** (`fix/statistical-integrity`, 518b657) — Either implement a
   real block bootstrap in `evUncertainty.ts` or rename the output so it does
   not claim to be a sampling CI of the data. (§4.1)
6. ✅ **FIXED and RE-RUN** (`fix/statistical-integrity`, 3eff648; re-run
   2026-09-17 against live Postgres + Yahoo) — Give the setup-expectancy
   study a train/test split; use the existing `dateBlockBootstrap`; divide
   `independentEntryDates` by holding period. (§4.2) — *result: 0/12
   cells reach TIER A out-of-sample; the prior v1 "TIER A" MEAN_REVERSION
   cells are negative on the held-out test segment. See §13.*
7. ✅ **FIXED** (`fix/statistical-integrity`, 518b657) — Fix `harness.ts:217`
   to divide distinct dates, not pooled rows. (§4.6)
8. ✅ **PARTIALLY FIXED** (`fix/statistical-integrity`, 3eff648) — Call the
   DSR/PBO code that already exists, with `nTrials` reflecting the real
   search space. (§4.3) — *`nTrials` is still a floor that can't see the
   setup-threshold search from earlier development; genuinely closing this
   would mean re-deriving the setup rules themselves inside a train/test
   split, a much larger change than wiring in the existing functions.*
9. Stop reporting the selection-winning OOS R² as unbiased. (§4.5) — *not
   in scope for the statistics batch actually requested; still open.*

**P2 — honesty of presentation**
10. Relabel the DCF `ESTIMATED`, and stop attaching filing URLs as its sources;
    or derive WACC from the repo rate + beta already being fetched. (§6)
11. Renormalize engine/rank weights over *available* signals, and surface a
    coverage figure alongside every composite score. (§6)
12. Make `MacroService` abstain rather than award points for uncomputed inputs.
13. Either wire up `shrinkage.ts` or delete it. (§4.4)
14. Activate the drawdown kill switch and `stabilityDelta`, or state they are
    inert. (§5.4)

**P3 — resilience & docs**
15. Add a second price source, or a loud degraded-mode banner when Yahoo fails.
16. Add a TTL or revalidation to the document cache.
17. Reconcile policy version across code and docs; fix WAIT/WATCH vocabulary;
    label the v1/v2 thresholds provisional too, or cite their evidence.
18. Restore `.env.example`.

---

## 11. Verdict

**Can you trust what it shows you?** Largely yes as a *description*, provided
you read the labels — and the labels are unusually good. The system tells you
direction is a coin flip, refuses to print a calibrated probability it has not
earned, and currently qualifies **zero** trades for entry. That refusal is
real, enforced in multiple independent places, and backed by DB triggers and
passing tests.

**Can you trust it as a basis for money?** Not yet, and the code agrees — it
says so at `policy.ts:367`. The specific gap was that the evidence pipeline
which *would* eventually unlock action contained in-sample expectancy, CIs
that did not measure sampling uncertainty, overlap counts inflated by roughly
the holding period, and multiple-testing correction over only the final step.
Those have since been fixed (batch 2) and the study re-run against real
production infrastructure (§13): **the answer came back negative** — 0 of 12
setup×horizon cells reach TIER A out-of-sample, and the two cells the old
methodology had called TIER A are net-negative on held-out data. That is not
a disappointing result; it is the system working as designed. It would have
been a worse outcome to leave the broken methodology in place and let it
eventually unlock a BUY on evidence that was never real.

**The one-sentence characterisation:** the guardrails are production-grade and
honest; the measurements they are guarding are not yet strong enough to justify
opening the gate — and the highest-value work is fixing the measurement layer,
not the guardrails.

---

## 12. Continuous learning (batch 3, `feature/continuous-learning`, commit ef33011)

The user asked whether this could be made to "continuously learn from its
wrong predictions." The honest answer, and what was actually built:

**What this does NOT do, and why not.** It does not retrain
`quant/engine.ts`'s hardcoded 8-signal weight vector or its `MU_SHRINK`/
`TILT_SCALE` constants online. Reweighting those against recent performance
would reopen exactly the in-sample-overfitting failure mode batch 2 spent its
effort fixing for the short-term setup study (§4.2) — a rule that adapts to
its own recent errors without a held-out test segment just learns to fit
noise faster. Direction accuracy staying near a coin flip (§ "Measured truth"
in `ARCHITECTURE.md`) is very unlikely to change by reweighting a
hand-designed technical-signal blend; if there is a real, learnable edge in
this data, finding it needs a proper ML pipeline with the same purge/embargo
discipline `research/harness.ts` already has — a materially larger project
than "wire up learning," and one this batch did not attempt.

**What this does do.** The codebase already contained the right machinery for
the part of "learning" that *is* honestly achievable — recalibrating
confidence as evidence accumulates — but it only ever ran when a developer
remembered to invoke `scripts/calibrationRun.ts` by hand:

- `research/calibrationEnsembleRun.ts` (extracted from that script, which is
  now a thin CLI wrapper around it): re-runs the purged walk-forward harness,
  fits Platt/isotonic/beta calibrators on an early validation slice, selects
  the best on a later held-out slice, and reports the final effect on an
  untouched test segment — unchanged, already-correct discipline. Persists an
  append-only `ExperimentRun` + `CalibratorRecord` rows, including
  *rejections* (a calibrator that fails to beat the raw probability
  out-of-sample is recorded as rejected, not dropped).
- `ResearchJobsService.weeklyCalibrationRefresh()` additionally re-runs
  `experiments/runner.ts`'s `runLiveBaselineExperiment` — the champion-vs-
  baselines comparison that reads newly-resolved `PredictionLog` rows —
  previously reachable only via an admin POST endpoint, never scheduled.
- A new `CronService` job, `weekly-calibration-refresh` (06:00 IST Sunday, no
  trading day), runs both. The composition that isolates one sub-job's
  failure from the other is a pure, injectable function
  (`runWeeklyCalibrationRefresh`) with 5 unit tests.

**Why this is safe to run unattended.** Neither sub-job can promote or raise
anything beyond what its own logic already independently verifies. A
calibrator only takes effect once `selectCalibrator` has confirmed it beats
baselines on data it was never fit or selected on, and
`calibratorRegistry.getLatestPromotedCalibrator` re-checks the `promoted`
flag at read time — the cron job automates *when* that check runs, not *what*
it may conclude. `runLiveBaselineExperiment`'s own positive-result branch
explicitly states it "still requires effective-sample and stability review
before any promotion." No cron job constructs a `DecisionSnapshot` or writes
`decisionStatus` — that remains sealed to `decision/policy.ts` alone (§2.3,
unchanged by any of the three batches).

**What this means in practice.** As independent evidence accumulates week
over week, the product's "Directional probability unavailable — insufficient
calibrated evidence" message (§3, item 6) will now update itself
automatically once (and only once) a calibrator genuinely earns promotion on
held-out data — rather than waiting indefinitely for someone to remember to
re-run a script. It also means the experiment registry (`GET
/api/experiments/latest`) stays current without manual action. It does not,
and should not, change how skeptical the system is about whether a real
directional edge exists at all.

---

## 13. Production verification run, 2026-09-17 — the fixed pipelines actually executed

Everything in §§2–12 was verified by reading code. This section is different:
it is what the rewritten pipelines actually produced when run against a real
local Postgres 16 instance and live Yahoo Finance data, on the
`feature/continuous-learning` branch (all three batches applied). Environment
setup: created the `postgres` role and `stock_analysis` database locally, ran
all 21 pending TypeORM migrations (including the append-only triggers on
`decision_snapshots` and `live_prediction_revisions` referenced in §3), then
ran three scripts against it.

### 13.1 Setup-expectancy study v2 (§4.2) — the headline result

`npx ts-node --transpile-only scripts/setupExpectancyStudy.ts`, full
151-ticker universe, 5 years of daily bars, 22,377 trades generated, clean
exit, zero errors.

Split: 203 train / 50 validation / 29 calibration / **76 test** dates (22
dates purged for label-overlap, 3 embargoed). Out-of-sample result on the
held-out test segment — **every cell negative**:

| Setup | Horizon | n | E[R] (net) | CI lower | P(>0) | BH | Tier |
|---|---|---|---|---|---|---|---|
| MEAN_REVERSION | 10-21d | 115 | **−0.111** | −0.223 | 0 | no | C |
| MEAN_REVERSION | 5-10d | 115 | **−0.141** | −0.294 | 0.024 | no | C |
| MOMENTUM_CONTINUATION | 10-21d | 135 | −0.171 | −0.260 | 0 | no | C |
| MOMENTUM_CONTINUATION | 5-10d | 135 | −0.181 | −0.289 | 0 | no | C |
| MOMENTUM_CONTINUATION | 3-5d | 135 | −0.195 | −0.379 | 0.001 | no | C |
| MEAN_REVERSION | 3-5d | 115 | −0.211 | −0.418 | 0.056 | no | C |
| PULLBACK_IN_UPTREND | 5-10d | 328 | −0.256 | −0.292 | 0 | no | C |
| PULLBACK_IN_UPTREND | 3-5d | 328 | −0.264 | −0.343 | 0 | no | C |
| PULLBACK_IN_UPTREND | 10-21d | 328 | −0.266 | −0.274 | 0 | no | C |
| VOLATILITY_CONTRACTION | 10-21d | 275 | −0.408 | −0.414 | 0 | no | C |
| VOLATILITY_CONTRACTION | 5-10d | 275 | −0.414 | −0.496 | 0 | no | C |
| VOLATILITY_CONTRACTION | 3-5d | 275 | −0.415 | −0.563 | 0 | no | C |

**0/12 cells reach TIER A.** Deflated Sharpe on the best cell
(MEAN_REVERSION 10-21d) is **0** — nowhere near the ≥0.95 bar, i.e. not
distinguishable from selection luck even at `nTrials=12` (a floor that
under-counts the true search space per §4.3's remaining caveat).

**The in-sample (full-history, non-evidentiary) numbers for comparison** —
this is the discrepancy the fix exists to catch:

| Setup | Horizon | n (full history) | E[R] in-sample |
|---|---|---|---|
| MEAN_REVERSION | 10-21d | 622 | **+0.137** |
| MEAN_REVERSION | 5-10d | 622 | **+0.111** |
| MOMENTUM_CONTINUATION | 10-21d | 1943 | +0.080 |

The old v1 methodology reported MEAN_REVERSION 10-21d at +0.146R and 5-10d at
+0.117R (`governance.ts`'s pre-batch-2 CANDIDATE seed, §4.2) — numbers that
match this run's in-sample column almost exactly. **The out-of-sample test
segment shows the opposite sign.** This is precisely the in-sample/
block-length-1-bootstrap artifact §4.2 predicted: a rule (and, likely, entry/
stop/target geometry) that looked good over the whole history it was
implicitly shaped against, and does not hold up on data it never touched.

**What this means for the product:** nothing changes for a user today — these
setups were already `usableForEntry: false` under the v1 methodology once the
live-shadow-authority gate (§ "structural note" in §4.3) is accounted for, and
they remain `false` under v2. What changes is that the *evidence record*
`ScanService` and `setupEvidence.ts` read is now honest: a future developer
looking at `short_term_model_performance` will see a correctly-labeled
out-of-sample failure instead of a stale in-sample success. The two
`governance.ts` CANDIDATE rows this review downgraded to SHADOW in batch 2
were downgraded correctly — re-promoting them would now require explaining
away a negative out-of-sample result, not just re-running the old script.

### 13.2 Calibration/ensemble refresh (§12) — ran end-to-end, produced an honest split verdict

`npx ts-node --transpile-only scripts/calibrationRun.ts` (the same logic the
new weekly cron job calls), 39 of 40 tickers processed (1 skipped, insufficient
bars), clean exit.

- **1-day horizon**: enough independent hold-out evidence (~26 independent
  observations) for 5 of 12 models to have a calibrator promoted — modest
  Brier improvements verified on the untouched test segment (e.g.
  `champion-quant-v1`: 0.2524 → 0.2519; `stat-ewma`: 0.2835 → 0.2512).
- **7-day horizon**: only ~4 independent hold-out observations — every model
  correctly refused ("insufficient calibration evidence... directional
  probability stays unavailable").
- **30-day horizon**: only ~1 independent hold-out observation — every model
  correctly refused, and the ensemble reports `test brier null n=0`
  (no members were eligible).

This is the calibration discipline working exactly as designed: real,
verified improvement where there is enough independent data (1d), honest
refusal where there is not (7d/30d) — not a uniform "yes" or "no" but a
result that tracks how much genuine evidence actually exists at each horizon.

### 13.3 The full weekly-cron code path (`ResearchJobsService.weeklyCalibrationRefresh`)

Ran the exact function the new `weekly-calibration-refresh` cron job calls
(not a re-implementation) directly. Both sub-jobs succeeded on this run
(`calibratorsFit: 36, calibratorsPromoted: 5`, plus a completed
`live-baseline-eval` experiment run persisted to `experiment_runs`) — the
failure-isolation path (§12) was verified separately by the 5 unit tests in
`tests/weekly-calibration-refresh.test.ts` with fault-injected fakes, since a
real successful run naturally can't exercise the failure branch.

### 13.4 What this confirms about the review as a whole

The fact that fixing the methodology *changed the answer* — from "TIER A,
positive edge" to "0/12 cells, negative on held-out data" — is the strongest
available evidence that batch 2's fixes were not cosmetic. A methodology
change that leaves the substantive conclusion unchanged is much less
persuasive than one that reverses it. This result should be read as
confirmation that the original `docs/system-trust-review.md` finding (§4.2)
was correct to flag the v1 study as untrustworthy, not as a disappointing
outcome to work around.

---

*Generated by independent code review, with production verification.
Educational tool — not SEBI-registered investment advice.*
