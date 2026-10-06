# Stock-selection signals — pre-registration

**Registered:** 2026-10-01, before any of these signals was computed on this data.
**Code:** `src/services/research/selectionSignals.ts` (definitions, pure), `selectionStudy.ts` (study + rule).
**Why:** quant-v1's daily calls have no stock-picking skill (47–49% vs the cohort median,
2026-09-17..29; memory `daily-model-findings`). Raw hit rate is the tape. These signals are
judged **only** on whether they rank stocks correctly *within* a day, where the market's
direction cancels out.

Any change to a definition, horizon, threshold or split below is a methodology change: it
is appended here with a date, the original left visible, and the sealed year is then
spent — it cannot be used to judge the changed signal.

## Data

- `stock_history.adjusted_close`, 152 current NSE constituents, 2021-09-17 → 2026-09-30.
- Sector: `stocks.sector` (30 sectors). A sector with < 3 stocks on a date uses the universe median instead.
- Earnings: NSE broadcast time of `INTEGRATED_FINANCIAL_XBRL` filings (`intelligence_sources.published_at`), 38 stocks, 2023-04 → 2026-08.
- A daily |return| > 40% is treated as a data error; that stock is excluded on any formation date whose look-back or forward window contains it.
- **Known bias:** the universe is *today's* constituents (survivorship). This flatters momentum; a momentum pass is discounted accordingly.

## Signals (all use data ≤ the formation close; return measured close-to-close forward)

| Key | Definition | Horizon |
|---|---|---|
| `sector-momentum` | r(t−252 → t−21) minus the sector median of the same | 21 trading days |
| `sector-reversal` | −[ r(t−5 → t) minus its sector median ] | 5 trading days |
| `earnings-drift` | Abnormal return on the announcement reaction [d0, d0+1] (stock minus universe median), where d0 is the first session whose close is after the broadcast. Signal is live for 60 sessions after d0+1; stocks without a live event are not in the cohort. | 21 trading days |

## Scoring

Per formation date, among stocks with a signal:
- **Call** UP if signal > cohort median signal, else DOWN.
- **Cross-sectional hit**: the call agrees with sign(forward return − cohort median forward return).
- **IC**: Spearman rank correlation of signal vs forward return.
- **Spread**: mean forward return of the top tercile minus the bottom tercile.
- **Non-overlapping dates**: every h-th trading day only, so forward windows never overlap. All t-stats use these dates only.
- A formation date needs ≥ 20 stocks with a signal (≥ 8 for `earnings-drift`).

## Splits

- **Development:** formation dates 2022-10-01 → 2025-09-30. May be inspected.
- **Sealed:** 2025-10-01 → (last date with a complete forward window ≤ 2026-09-30). Evaluated once under the rule below.
- **Prospective:** formation dates ≥ 2026-10-01, re-scored nightly as bars arrive.

## Pass rule (per signal, on the sealed year)

1. ≥ 10 non-overlapping formation dates.
2. Mean IC > 0 with t ≥ 2.4 on non-overlapping dates (2.4 ≈ two-sided p < 0.05 / 3 signals, Bonferroni).
3. Cross-sectional hit > 52.0%.
4. Mean IC on the development period has the same sign (> 0).

Cost is **reported** (top-minus-bottom spread vs 0.42% round trip on each leg = 0.84% per rebalance of a long-short book), never part of the rule — skill and economics are separate questions.

## Confidence tier (only for a signal that passes)

Calls restricted to the extremes: all (median split), outer terciles, outer quintiles, outer deciles. Each tier reports cross-sectional hit and a date-clustered 95% lower bound (mean ± 1.96·sd/√n over non-overlapping per-date hit rates). The confident tier is the most selective one whose lower bound > 50% **on the sealed year**; it is shown only for passing signals, and re-judged prospectively.

## Registered predictions (learning_expectations, source STUDY)

Written before the run — my priors, to be resolved by it:
- `sector-reversal` **fails** the rule on the sealed year (p ≈ 0.70).
- `sector-momentum` **fails** (p ≈ 0.75) — 12 non-overlapping dates is very little power.
- `earnings-drift` **fails** (p ≈ 0.85) — too few events.

## Amendments

**2026-10-01, before the first computation of any signal.** Earnings events also include
`FINANCIAL_RESULTS_XBRL` filings (2023-04 → 2024-05, 37 stocks), which the original text
omitted. This adds development-period events only; the sealed year is unchanged. Consolidated
and standalone results are filed separately, so per stock a broadcast within 10 calendar days of
the previous kept one is the same event and is dropped (the earliest broadcast stands).

## Result — first run, 2026-10-01 (experiment run `b674556b-eabf-43f9-9b79-b5dc951ed2e2`)

The sealed year is now **spent** for these three definitions.

| Signal | Sealed IC (t) | Sealed stock-picking | Sealed spread | Dev IC (t) | Verdict |
|---|---|---|---|---|---|
| sector-momentum (21d) | +0.018 (0.92), 11 dates | 49.8% | +0.10% | +0.017 (0.70) | FAIL |
| sector-reversal (5d) | +0.003 (0.25), 50 dates | 50.2% | +0.05% | +0.016 (1.77) | FAIL |
| earnings-drift (21d) | −0.046 (−0.80), 11 dates | 47.7% | −0.94% | −0.045 (−0.76) | FAIL |

All three registered priors ("will FAIL") resolved CORRECT. No tier of any signal had a
date-clustered 95% lower bound above 50% in either period, so no confidence tier is unlocked.

Not findings, only candidates for a *new* pre-registration (which would need a new sealed window):
earnings-drift is negative in both periods (announcement reactions partially reversed rather than
drifted), but at |t| < 1 in each. Momentum and reversal are positive in development and near zero
when sealed — the pattern of no effect.
