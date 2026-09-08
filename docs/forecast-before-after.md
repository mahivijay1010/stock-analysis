# Forecasting: before vs after (completion Phase 16)

All "after" numbers are from the strict walk-forward harness (purged + embargoed
chronological splits, TEST segment only, overlap-honest evaluation) —
ExperimentRuns `1b73e326` (baselines), `86b07227` (all challengers),
`02ffd5a8` (calibration + ensemble), `3a591851` (Monte Carlo validation).
40-ticker universe, horizons 1/7/30 calendar days. Nothing here is fabricated;
every number is reproducible from the persisted runs.

## 1. The headline: forecast ACCURACY did not change — the claims did

No challenger (TS-statistical or Python-ML) beat the naive baselines
out-of-sample, so **no forecasting model was replaced** (see
`promotion-policy.md`). What changed is everything AROUND the forecast:
adjusted data, leakage-proof features, overlap-honest evaluation, refusal
layers, and hard decision gates. The BEFORE column below is therefore the same
champion engine — but presented then as "conviction 79 / BUY TODAY", and now as
calibrated ranges with an evidence-gated WATCH/WAIT.

## 2. Champion (production engine) measured honestly — TEST segment

| Horizon | Brier | Brier skill vs constant-50 | Non-overlap hit rate | MAE (median path) | 80% band coverage |
| --- | --- | --- | --- | --- | --- |
| 1d | 0.2530 | **−0.012** | 49.0% | 1.02% | 86.6% |
| 7d | 0.2517 | **−0.007** | 49.1% | 2.20% | 87.7% |
| 30d | 0.2561 | **−0.024** | 51.3% | 5.03% | 85.1% |

Baselines on the same rows: constant-50 Brier 0.2500 (skill 0 by definition);
zero-return MAE 1.00% / 2.17% / **4.90%** — i.e. the champion's point forecast
LOSES to "predict nothing changes" at every horizon on MAE.

**Reading**: there is no validated directional edge. The bands are usable
(coverage 85–88% vs 80% nominal = slightly conservative, the safe direction);
the direction probabilities are not — and the product now says so.

## 3. Challengers (all rejected)

| Model | 30d Brier | 30d BSS | Note |
| --- | --- | --- | --- |
| stat-ridge | 0.4180 | −0.672 | overconfident regression — catastrophic |
| stat-logistic | 0.3857 | −0.543 | same failure mode |
| py-elastic-net | 0.2497 | ~0 | shrinks to the mean = matches baselines, no lift |
| py-logistic | 0.4474 | −0.790 | worst of all |
| py-hgb-regressor | 0.2724 | −0.090 | worse than doing nothing |
| py-hgb-classifier | 0.2779 | −0.112 | 56.4% 30d hit rate is noise: worse Brier on ~94 eff obs |

GARCH-family and deep-sequence models were evaluated on paper and rejected
before training (~500 usable bars/ticker cannot support them without
overfitting; documented in `src/services/research/models.ts`).

## 4. Calibration layer (Phase 7)

39 calibrator fits persisted in `calibrators` (promoted AND rejected):

- **1d**: 7 promoted on held-out evidence (~26 independent obs). Platt for the
  champion (val-hold Brier 0.2547 → 0.2507; untouched-test 0.2530 → 0.2508);
  beta repairs the grossly miscalibrated ML models (py-hgb-regressor
  0.4023 → 0.2502) by pulling their overconfidence back toward 0.5 —
  calibration fixes honesty, it cannot create edge.
- **7d/30d**: ALL refused — ~4 and ~1 independent hold-out observations
  respectively (< 10). The product therefore displays, verbatim:
  *"Directional probability unavailable — insufficient calibrated evidence."*

## 5. Ensemble (Phase 8)

Validation-built with hard eligibility (≥10 eff obs, Brier ≤ 0.26, ECE ≤ 0.1),
inverse-Brier-excess weights, test-evaluated: 1d skill −0.0012, 7d −0.0032,
**30d: abstains** (no eligible member). Every ML challenger was excluded as
"confidently wrong". The ensemble abstaining at the product's display horizon
is the correct, honest outcome.

## 6. Monte Carlo (Phase 11)

429 non-overlapping 21-trading-day anchors × 40 tickers, resample pool strictly
pre-anchor: i.i.d. bootstrap 80%-band coverage **78.6%** at 30d (closest to the
80% nominal) vs block5 77.9% / block10 76.0%; CRPS identical to 4 decimals.
Pre-registered rule ⇒ **i.i.d. kept**.

## 7. Presentation before → after (the part users see)

| | Before (2026-09-04, live BHEL log) | After (same date replayed, policy v5) |
| --- | --- | --- |
| Action | **BUY** | **WAIT** (3 unmet gates) |
| Score | "78.8" conviction-style | setup 73.8/100 labeled "descriptive, never an action" |
| P(up 30d) | 63.8% shown as-is | withheld — mandatory insufficient-evidence text |
| Sample honesty | "39 samples" | "~1 independent observation after overlap adjustment" |
| Regime | none | bear_low_vol market · late_trend entry ⇒ cap |
| Full trail | none | `docs/bhel-regression-final.md`, reproducible by script |
