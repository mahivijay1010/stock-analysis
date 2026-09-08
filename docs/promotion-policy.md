# Model promotion policy + the 2026-09-08 decision (completion Phase 17)

## Policy (binding)

A challenger forecasting model may replace the production champion **only if
ALL of the following hold on the walk-forward harness** (purged + embargoed
chronological splits; `src/services/research/harness.ts`):

1. **Better out-of-sample Brier** than the champion at the product's display
   horizon (30d) on the TEST segment, with the improvement's date-block
   bootstrap 80% CI excluding zero.
2. **Brier skill vs constant-50 > 0** at that horizon (a model worse than
   "always say 50%" is disqualified outright, whatever its hit rate).
3. **No degradation** in 80% interval coverage (must stay within [70%, 90%])
   or CRPS (> 2% relative worsening disqualifies).
4. **Calibration**: ECE at or below the champion's, measured on the same rows.
5. **Effective samples**: all of the above on ≥ 10 overlap-adjusted independent
   observations; raw counts are never quoted as evidence.
6. **No leakage**: the model's features pass the future-bar mutation invariance
   test (`tests/features-leakage.test.ts` pattern) and use `availableAt`-stamped
   inputs only.
7. **Registered**: the full run persisted as an `ExperimentRun` (config, splits,
   dataset hash, metrics, baselines) BEFORE the promotion is enacted; the
   decision references the run id.

If **no challenger qualifies: the incumbent stays.** That is a successful
outcome of the process, not a failure — the alternative is shipping unvalidated
models, which is precisely the failure mode this system was rebuilt to prevent.

Threshold changes ride the same rule: a gate threshold may move in the
**more conservative** direction freely, but may only be loosened with a
validated study persisted in the experiment registry (see Phase 18 section of
`final-implementation-report.md`).

## Decision — 2026-09-08

**Champion `quant-v1` (seeded bootstrap ranges + gated presentation) is KEPT.
No challenger is promoted. No calibrator is promoted at the 30d display
horizon. The 30d ensemble abstains.**

Evidence (ExperimentRuns `86b07227`, `02ffd5a8`):

- Rule 1 fails for every challenger: best 30d Brier among challengers is
  py-elastic-net at 0.2497 — statistically indistinguishable from the
  constant-50 floor and from the champion; it adds nothing.
- Rule 2 fails for every challenger and for the champion itself (champion
  30d BSS −0.024): NO direction probability from any source is displayable,
  which the product states verbatim.
- The only promotions anywhere are 1d CALIBRATORS (7, on ~26 independent
  hold-out obs) — they repair miscalibration, claim no edge, and do not touch
  the 30d display horizon.

Consequence for the product: forecasts remain the calibrated RANGES; direction
stays `WATCH / INSUFFICIENT EDGE / NO TRADE` until some future run passes this
policy. The TradeGate (decision-policy-v5) is unchanged in strictness.
