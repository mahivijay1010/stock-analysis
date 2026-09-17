# StockSense India — Calculation Flow, Viability & Trustworthiness

**Independent code review, 2026-09-17.** Every claim below was checked against
the source at the cited `file:line`. Where this review disagrees with
`ARCHITECTURE.md`, the code is treated as the truth.

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

### 4.1 The EV confidence interval that gates every entry is not a block bootstrap

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

### 4.2 The setup-expectancy study is in-sample and its "block bootstrap" has block length 1

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

### 4.3 Multiple-testing correction covers only the last step

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

### 4.6 Overlap adjustment is implemented three inconsistent ways

- `policy.ts:57` — `floor(raw/30)` ✅
- `ModelHealthService.ts:99` — `floor(distinctDates/overlap)` ✅
- `harness.ts:217` — `floor(preds.length/td)` on **pooled cross-sectional
  rows** ❌ — over-counts by roughly the ticker count (40 tickers × 100 dates
  at 30d → ~190 "effective samples" from ~5 truly independent windows).

Newey–West SE is correctly implemented but applied **only to MAE**, not to hit
rate, Brier or coverage.

---

## 5. Correctness bugs

### 5.1 Bank detection misses most Indian financials — highest-impact bug

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

### 5.2 Backtest grades predictions on a different price basis

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
| `calculations.ts:156` | ROIC debt imputed as `(borrowingsCurrent ?? 0) + (borrowingsNoncurrent ?? 0)` → **debt = 0** when both absent, inflating ROIC silently |
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

The result is labelled `status: "CALCULATED"` and carries the **XBRL filing
URLs as its sources** — even though `DataStatus` has an `"ESTIMATED"` value
available. It does attach an assumption-sensitivity caveat, but a number whose
every driver is a guess should not be tier-tagged as sourced from filings.

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
1. Replace the 10-ticker `BANKS` regex with a sector/industry classification
   driven by the universe's own `sector` field, and extend bank-aware refusals
   to NBFCs and insurers. Gate FCF too. (§5.1)
2. Grade backtests on the same adjusted basis used to generate the prediction.
   (§5.2)
3. Return `null`, not `0`, for zero-sample backtest horizons and empty
   calibration buckets. (§6)
4. Make the AVOID vetoes fire on unknown inputs, or correct the fail-closed
   comment. (§5.3)

**P1 — statistical integrity**
5. Either implement a real block bootstrap in `evUncertainty.ts` or rename the
   output so it does not claim to be a sampling CI of the data. (§4.1)
6. Give the setup-expectancy study a train/test split; use the existing
   `dateBlockBootstrap`; divide `independentEntryDates` by holding period.
   (§4.2)
7. Fix `harness.ts:217` to divide distinct dates, not pooled rows. (§4.6)
8. Call the DSR/PBO code that already exists, with `nTrials` reflecting the real
   search space. (§4.3)
9. Stop reporting the selection-winning OOS R² as unbiased. (§4.5)

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
says so at `policy.ts:367`. The specific gap is that the evidence pipeline
which *would* eventually unlock action contains in-sample expectancy, CIs that
do not measure sampling uncertainty, overlap counts inflated by roughly the
holding period, and multiple-testing correction over only the final step. If
those are fixed and still show an edge, the edge is real. If action were
unlocked on the current evidence machinery, it would be unlocked on numbers
that are more confident than the data supports.

**The one-sentence characterisation:** the guardrails are production-grade and
honest; the measurements they are guarding are not yet strong enough to justify
opening the gate — and the highest-value work is fixing the measurement layer,
not the guardrails.

---

*Generated by independent code review. Educational tool — not SEBI-registered
investment advice.*
