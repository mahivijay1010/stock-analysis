# TSP study notes — Seykota's Trading Systems Project → what applies here

**Purpose.** Read Ed Seykota's Trading Systems Project articles properly —
especially *Skid and Trading Frequency* and *Core Position Sizing* — and map
what is genuinely applicable onto this codebase, in the same form as
`docs/intraday-study-notes.md`. Written 2026-09-18.

**What was actually read (not just cited).** Both priority articles in full.
They are **scanned page images**, not text (`P1.png`…`P8.png`), so automated
text extraction returns nothing — they were read visually, page by page. Also
read: the TSP index and the *Diversification Study* (text).
**Not read:** the other linked TSP articles (Data Verification, Continuous
Contracts, Exponential Crossover, Support & Resistance, Trends, Further
Research on Continuous Contract). The greyed items on the index
(Bliss Functions, Dynamic Portfolio Selection, Dynamic Risk Modification,
Pattern Recognition …) are listed as future topics with no articles behind
them.

**Provenance caveat.** These are TSP *contributor* studies published on
Seykota's site — the Skid study is by "Stone", Core Position Sizing by "Jacky
Cheung" — not Seykota's own writing. They are careful and quantitative, but
they are one person's simulation on futures markets, not peer-reviewed work
and not Indian equities. Treat every number below as directional evidence, not
as a constant to copy.

---

## 1. Skid and Trading Frequency — the slippage study

> "When a pre-set market stop is hit, the final filled price would not exactly
> equal the stop price, we call this phenomenon as slippage."

### 1.1 The model — a fill-based slippage ratio

This is the part with direct engineering value. Rather than estimating
slippage as a percentage of price, the study models it as a **fraction of the
bar's adverse excursion beyond the stop**:

```
fill (buy / cover short) = stop + (high − stop) × slippage_ratio
fill (sell / short)      = stop − (stop − low) × slippage_ratio
```

`slippage_ratio = 0` means a perfect fill at the stop; `1.0` means the worst
possible fill in that bar. The worked example: a buy stop at $7.00 filling at
$7.50 is $0.50 of slippage; a trailing sell stop at $8.00 filling at $7.50 is
another $0.50 — turning a $1.00 gross profit into **$0.00 net**.

> "if we don't count in slippage effect, a system showing great risk-return
> characteristic in back-testing might perform poorly in reality, and might
> lead to huge loss."

**Why this matters more than the number itself:** the ratio is bounded [0, 1]
and defined against observable bar data (high/low vs the stop). That makes it
*measurable from fills* — unlike a free-floating percentage, which can only
ever be guessed. It is a slippage model you can calibrate.

### 1.2 The simulation

Double Support-Resistance system, **35 futures markets**, long-term support
length fixed at 250 days, short-term length varied **25 → 175 days**, slippage
ratio swept **0.00 → 1.00**.

| Finding | Evidence (read from the charts) |
|---|---|
| Fast systems are destroyed by slippage | 250-25: MAR **0.40 → below 0**; CAGR **~0.078 → below 0**; max drawdown **~0.19 → ~0.54** |
| Slow systems barely notice | 250-100: CAGR **~0.093 → ~0.066**; MAR ~0.51 → ~0.32; drawdown essentially **flat** across the whole sweep |
| The divergence is in drawdown, not just return | Every system except 250-25 holds drawdown ~0.17–0.25 at *any* slippage ratio; only the fastest one blows out |

Stated conclusions:

> "Shorter the short-term support length, more vulnerable SR system would be
> when slippage ratio increases."

> "Once short-term support length is larger than 100, the erosion degree that
> slippage effect puts on performance is stable and modest."

> "We can impose strict slippage assumption to system and to see if the system
> can survive under such stress test, by this way, we can examine whether a
> system would be robust in reality or not."

### 1.3 What this says about intraday

This is the same conclusion `docs/intraday-study-notes.md` reached from
Varsity and SEBI, arrived at independently and quantitatively: **trading
frequency is the dominant cost variable, and the faster the system, the more
of its backtested edge is an artifact of assuming good fills.** SEBI measured
it in outcomes (80% of >500-trades/year traders lost money; losers paid 57% of
their losses again in costs). This study measures the mechanism.

---

## 2. Core Position Sizing — bounding total portfolio risk

### 2.1 The definitions

> "core equity is equity that is not at risk, we can call it risk-free equity"

```
Core_Equity = Total_Equity − Equity_at_Risk
```

and the generalised form, once a trader states the maximum portfolio risk they
will tolerate:

```
Core_Equity = Total_Equity × Target_Risk_Percentage − Equity_at_Risk
```

Two sizing strategies follow:
- **Proportional Position Sizing** — size each trade against *Total Equity*.
- **Proportional Core Position Sizing** — size each trade against *Core
  Equity*, i.e. against the equity that is **not already committed to open
  risk**.

### 2.2 The structural result (the important one)

A 200-bet simulation, target portfolio risk 100%:

> "The total risk to equity ratio increases **linearly** with trade numbers
> under Proportional Position Sizing and after 100 trades, the total portfolio
> risk is above 100%, but increases **asymptotically** to Target Portfolio
> Risk% under Proportional Core Position Sizing."

After 100 trades: proportional sizing reaches **100% of equity at risk**; core
sizing reaches **~0.66**, converging on the target rather than crossing it.

> "Proportional Position Sizing Betting System does not have a specific max
> portfolio risk limit … it is possible that total portfolio risk would go
> beyond 100% and out of control, and the possibility of ruin is not zero."

> "Proportional Core Position Sizing Betting System has a specific max
> portfolio risk limit, and it is a target-reaching system … the possibility
> of ruin is almost zero."

**This is the transferable idea**: sizing each trade against total equity has
no ceiling on *aggregate* risk, because each new position is sized as though
the existing ones weren't there. Sizing against equity-not-already-at-risk
makes total portfolio risk converge on a stated target by construction.

### 2.3 The real simulation — and where the author's own conclusion is shakier

Long-only support/resistance system, **35 futures markets**, risk sizing factor
swept **0.002 → 0.050** in steps of 0.002.

| Metric | What the charts show |
|---|---|
| CAGR | Core sizing rises faster and peaks **higher (~0.235 at ~0.030)**, then **falls off a cliff** past that point. Proportional rises more slowly to ~0.205 and stays flat. |
| MAR | Proportional is **better almost everywhere** — flat ~0.39–0.40 across the sweep. Core starts ~0.34 and **decays steadily to ~0.08**. |
| Max drawdown | Core is **much worse** at high risk factors: **~1.12 vs ~0.52** at the top of the sweep. |
| Avg risk % | Proportional is flat/asymptotic ~0.68; core climbs **linearly to ~1.85**. |

The author concludes:

> "From the point of view of ensuring the stability of system performance
> output, Proportional Core Position Sizing Strategy is superior to
> Proportional Position Sizing Strategy."

**I do not think the presented data supports that as stated, and the
difference matters.** On the author's own charts, core sizing has *lower* MAR
across nearly the whole range, *higher* max drawdown, and a CAGR curve that
collapses past its optimum. What the data actually supports is narrower and
still useful:

- Core sizing **reaches a higher peak CAGR** — but only at one risk factor,
  and falls apart immediately beyond it. That is a knife-edge optimum, which
  is exactly the kind of parameter you should not trust out of sample.
- The **conceptual** claim (§2.2) — that aggregate risk converges on a target
  instead of growing without bound — is sound and is proven structurally, not
  by the noisy 35-market backtest.
- The confusing part is that avg-risk% climbs *linearly* for core sizing here,
  the opposite of the toy experiment. That is consistent with the target risk
  percentage being set high enough that the cap never binds — in which case
  the mechanism simply is not doing its job at those settings.

So: **adopt the concept, ignore the "superior" verdict, and do not import the
0.030 risk factor.**

---

## 3. Doctrine vs this codebase

Legend: **✅ already aligned** · **≈ partial** · **❌ gap**

| Rule (source) | Where this codebase stands | Status |
|---|---|---|
| Slippage must be in every backtest or results are fiction (Skid §1.1) | `costs.ts estimateSlippagePct` is applied in `entryExit`, `sizing`, `evUncertainty` and the expectancy study | ✅ |
| Slippage as a **fraction of adverse excursion beyond the stop** | Ours is `0.05 × ATR% × 1/√relVolume + participation impact`, floor 0.10% — a *percentage-of-price* model with **entirely invented constants** (flagged in system-trust-review §8) | ❌ **the model shape differs, and ours is uncalibrated** |
| Stress-test the system at pessimistic slippage to see if it survives (Skid conclusion 3) | No slippage sweep exists anywhere. `evUncertainty` bootstraps return uncertainty, not **cost** uncertainty | ❌ **gap** |
| Faster systems are far more slippage-fragile (Skid §1.2) | Implicitly respected — the system trades 3–21 day horizons on completed daily bars, never intraday scalps. The intraday tab is monitoring-only | ✅ by construction |
| Aggregate portfolio risk needs a hard ceiling (Core §2.2) | `RISK_LIMITS.maxOpenRiskPctOfBudget = 2.0%` — a **hard cap on the sum of open loss-at-stop**, plus ≤5 positions, ≤35% single stock, ≤50% sector | ✅ **stronger than the paper's mechanism** |
| Size against equity-not-at-risk, not total equity (Core §2.1) | `computePositionSize` sizes against `budgetInr` (total), but the open-risk cap then *refuses* new entries once 2% aggregate is committed | ≈ **different mechanism, same outcome** — ours is a hard gate rather than a shrinking base |
| Re-base equity after each fill (Core; Varsity "reduced total equity") | `computeEquityDrawdownPct` re-bases on realized P&L; open risk is summed live from paper trades | ✅ |
| "Possibility of ruin is not zero" without a cap | Daily 1.5% / weekly 3% loss halts + the now-live −6% drawdown kill switch | ✅ |
| Don't trust a knife-edge optimum (my reading of Core §2.3) | Batch-2 work explicitly guards this: purged/embargoed splits, DSR/PBO wired in, and the 0/12 out-of-sample verdict was accepted rather than tuned away | ✅ |
| Diversification raises "Bliss" = ICAGR/worst-drawdown (Diversification Study: copper .13, crude .17, **combined .26**) | `portfolioContext.ts` computes correlation/sector concentration and penalises crowding; sector cap 50% | ✅ same principle |

**Reading of the table.** On risk *containment* this codebase is already at or
beyond what the TSP articles advocate — it has a hard aggregate-risk ceiling,
which is the very thing Core Position Sizing exists to create. The genuine
gaps are both on the **cost** side, and both are things the review already
flagged as the weakest calibrated area.

---

## 4. What is actually worth doing

Ordered, small, each independently testable. None of these is "copy a constant
from a futures study into an Indian equity system" — that would be exactly the
unvalidated-threshold problem `docs/system-trust-review.md` exists to prevent.

1. ✅ **DONE 2026-09-18 — fill-ratio slippage model, alongside the current one.**
   `costs.ts` gains `fillPriceFromRatio` (fill = `stop + (high − stop) × ratio`
   for a BUY, mirrored for a SELL), `slippageRatioFromFill` (the inverse — the
   calibration primitive), and `ratioToSlippagePct` (a bridge to the existing
   percentage model). Every term is observable, so the ratio can be measured
   from real fills. **Nothing switched over**: `estimateSlippagePct` is
   untouched and still the model in use, because importing the futures study's
   numbers into Indian equities would be the unvalidated-threshold mistake
   `docs/system-trust-review.md` exists to prevent. 23 tests in
   `tests/slippage-model.test.ts`, including the article's own worked example
   ($1.00 gross → $0.00 net at ratio 0.5) and price→ratio→price invertibility.

2. ✅ **DONE 2026-09-18 — slippage stress sweep (Skid conclusion 3).**
   `setupExpectancyStudy.ts` now stores each trade's `costR`, `slippageR` and
   `entryOverRisk` separately, and `slippageStress()` re-prices slippage at
   multiples [0, 0.5, 1, 1.5, 2, 3, 5] of the modelled baseline, reporting
   `survivesUpToMultiple` and an interpolated `breakEvenMultiple` per cell.
   Persisted on every test cell and printed as its own table.
   **Two caveats carried in the output itself:** the sweep is analytic (worse
   fills never change *which* bar resolves a trade), so the break-even is an
   **upper bound**; and it scales a baseline that is itself uncalibrated.
   It is reporting-only — `tierFromEvidence` reads six fields and
   `slippageStress` is not among them, so it cannot influence a tier.

3. **Calibrate the ratio from real fills once intraday data accumulates.** The
   `DelayedCandlesProvider`/Upstox feed makes observed fills possible for the
   first time. Until there are real fills, the honest statement stays: the
   slippage constants are invented.

4. **Report aggregate open risk as a percentage of the target**, not just as a
   pass/fail gate. Core sizing's insight is that you should be able to *see*
   total portfolio risk converging on its ceiling. We enforce the ceiling but
   never display the trajectory.

**Explicitly not doing:** adopting proportional-core sizing as the position
sizer. Our hard 2% aggregate cap achieves the same containment more directly,
and the paper's own data shows core sizing with worse MAR and worse drawdown
across most of its range.

---

## Sources

- Trading Systems Project index — https://www.seykota.com/tribe/TSP/index.htm
- *Skid and Trading Frequency* (Stone) — https://www.seykota.com/tribe/TSP/Skid/Index.html (pages are images: `P1.png`–`P4.png`)
- *Core Position Sizing / An Exploration of Core Equity* (Jacky Cheung) — https://www.seykota.com/tribe/TSP/Core/index.html (images `P1.png`–`P8.png`)
- *Diversification Study* — https://www.seykota.com/tribe/TSP/Diversify/index.htm
- The Trading Tribe — https://eseykota.com/TT/PHP_TT/home/
- © Ed Seykota, 2003–2023. Quotations above are short excerpts for study purposes.
