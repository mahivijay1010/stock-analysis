# Learning-to-rank Discover study (upgrade Part 7)

Ranking challengers evaluated inside the panel study (`scripts/panelRun.ts`)
against the Discover question — "what are the best opportunities today?" —
with targets = future excess-return ranks at 5/10/21td.

Models: LightGBM LambdaRank (per-date groups, within-date quintile grades),
plus GBM regressors/classifier used as scorers. Baselines: current stored
composite ranking, momentum r20, sector-neutral momentum, random.

Metrics: per-date Spearman Rank IC (naive AND overlap-honest stride version),
precision@5/@10, top-decile mean excess, top-minus-bottom spread, top-10
turnover, after-cost top-decile (0.2%/side), evaluated dates.

## Results (test segment, stride-honest)
- lgbm-rank: IC +0.016/+0.039/+0.034 at 5/10/21td; stride-t ≤ 1.03 — not
  significant on independent windows.
- Best after-cost top-decile at 21td: xgb-reg 2.98% vs momentum baseline
  2.74% and random 1.11% — the GBM edge over momentum after costs is ~0.2pp
  per 21td window on this sample: within noise.
- precision@10 at 21td: GBMs 0.62–0.65 vs momentum 0.61 — small, unproven.

## Verdict
**The current ranking is KEPT.** No challenger demonstrated significant
held-out improvement on independent windows. Re-run
`npx ts-node --transpile-only scripts/panelRun.ts` after more history
accumulates; the promotion bar is pre-registered in
`docs/model-promotion-final.md`.
