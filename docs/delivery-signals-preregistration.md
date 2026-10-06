# Delivery / trade-size signals — pre-registration (batch 2)

**Registered:** 2026-10-06 ~10:00 IST, while `nse_delivery` was still being backfilled and before any
signal below was computed on any data.
**Code:** `src/services/research/deliverySignals.ts` (definitions, pure) and `deliveryStudy.ts`.
**Why this batch:** every price/volume feature in the panel (returns 1–60d, vol, 52w percentile,
volume ratio, beta, sector, relative strength) has already failed at significance — the LightGBM
panel reached stride-t 1.87 at best (docs/panel-forecast-study.md), and batch 1
(docs/stock-selection-preregistration.md) failed all three signals. This batch uses information
the system has never had: **how much of the volume was taken into delivery** and **average trade
size**, from NSE `sec_bhavdata_full` (EQ series), published after each session's close.

## Data

- `nse_delivery` (deliv_pct, turnover_lacs, no_of_trades), joined to `stocks.ticker` by symbol (`.NS` stripped).
- Returns: `stock_history.adjusted_close` (delivery-file prices are unadjusted and are not used for returns).
- Universe, splits, scoring, bad-data rule, minimum cohort (20), tiers and cost reporting are **identical
  to batch 1** (`selectionSignals.ts`, `selectionStudy.ts`): development 2022-10-01 → 2025-09-30;
  sealed 2025-10-01 → 2026-09-30; prospective ≥ 2026-10-01; cross-sectional scoring against the cohort median.
- A stock needs ≥ 50 of its 60 baseline sessions and all 5 recent sessions present in `nse_delivery`,
  else it has no signal that day.

## Signals (formation at the close of t; all inputs ≤ t)

Let D(s) = deliv_pct on session s, and A(s) = turnover_lacs / no_of_trades (average trade value).
"Recent" = sessions t−4..t; "baseline" = sessions t−64..t−5.

| Key | Definition | Horizon | Expected sign |
|---|---|---|---|
| `delivery-surge` | mean D over recent − mean D over baseline | 21 trading days | + (unusual delivery = informed accumulation) |
| `delivery-confirmed-move` | sign(r(t−5 → t)) × max(0, delivery-surge) — a move on unusually high delivery is expected to continue; on ordinary delivery the signal is 0 | 21 trading days | + |
| `trade-size-shock` | ln(mean A over recent) − ln(mean A over baseline) | 21 trading days | + (larger tickets = institutional participation) |

## Pass rule (per signal, sealed year) — as batch 1, with a stricter t

1. ≥ 10 non-overlapping formation dates.
2. Mean IC > 0 with **t ≥ 2.64** — the sealed year has now been used for 6 pre-registered signals
   (3 in batch 1, 3 here), so Bonferroni at family-wise 5%: two-sided p < 0.05/6 → |z| ≥ 2.64.
3. Cross-sectional hit > 52.0%.
4. Development-period mean IC > 0.

Cost reported (top-minus-bottom tercile spread vs 0.84% long-short round trip), never in the rule.
Confidence tier: as batch 1, only for a passing signal.

## Registered priors (learning_expectations, source STUDY)

- `delivery-surge` FAILS (p ≈ 0.75)
- `delivery-confirmed-move` FAILS (p ≈ 0.75)
- `trade-size-shock` FAILS (p ≈ 0.80)

## Result — first run, 2026-10-06 (experiment run `45158739-f01f-4fad-9f06-4b68f6792449`)

Data: 1,245 of 1,253 sessions loaded (2021-09-17 → 2026-10-05), all 152 stocks. 8 sessions refused by the
date guard (7 where `stock_history` has a row on an NSE holiday / the Diwali Muhurat session and NSE serves
the previous day's file; 1 served as xlsx). The sealed year is now spent for these definitions.

| Signal | Sealed IC (t) | Sealed stock-picking | Dev IC (t) | Verdict |
|---|---|---|---|---|
| delivery-surge | −0.020 (−0.86), 11 dates | 48.9% | −0.016 (−0.86) | FAIL |
| delivery-confirmed-move | −0.006 (−0.19) | 48.7% | −0.016 (−1.09) | FAIL |
| trade-size-shock | +0.011 (+0.35) | 50.0% | −0.003 (−0.14) | FAIL |

All three priors ("will FAIL") resolved CORRECT. No tier of any signal had a 95% lower bound above 50%.
Not a finding, only a note: delivery-surge leans NEGATIVE in both periods (|t| < 1) — opposite to the
"informed accumulation" story; if anything, unusual delivery precedes slight underperformance in these
large caps. Testing that would need a new pre-registration and a new untouched window.
