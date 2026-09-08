# Panel excess-return forecast study (upgrade Parts 5/6)

Dataset: `panel.ts` — stock×date rows over the covered NSE universe, 5y
adjusted bars, WARMUP 210 sessions. 21 point-in-time features (returns
1–60d, vol, drawdown, SMA distances, 52w percentile, volume ratio, gap, trend
persistence, rolling beta-60, NIFTY/sector returns, relative strength) plus
announcedAt-gated event counts. **Yahoo snapshot fundamentals are excluded** —
they carry today's values with no point-in-time history; including them would
be leakage dressed as alpha. Targets: forward excess return vs NIFTY (and vs
an equal-weight ≥3-member sector basket) at 5/10/21 trading days.

Splits: chronological BY DATE across the whole panel, purge = maxH+2, embargo
= 3 (`splitPanelByDate`, leakage-tested in `tests/panel-leakage.test.ts` with
future-bar mutation invariance). Selection on VALIDATION; TEST reported once.

Models (worker v2): LightGBM regression/classifier/LambdaRank, XGBoost,
CatBoost, ElasticNet. Baselines on identical rows: momentum r20,
sector-neutral momentum, seeded random, stored composite ranking (no date
overlap with the test window — stated).

## Results (ExperimentRuns `0208bb27` naive, final stride run in registry)

Signal direction: GBMs produce **consistently positive out-of-sample rank
ICs** (+0.02…+0.06 across horizons and model families) while momentum
baselines sit at ≈0 or negative, and GBM top-minus-bottom spreads are
positive (up to ~2.0% at 21td) where baselines are ~0. ElasticNet finds
nothing (shrinks to the mean).

**The honest significance test fails.** Daily anchors overlap at 10/21td, so
naive per-date t-stats (up to 5.4) overstate evidence; on strided,
NON-OVERLAPPING windows the best result is stride-t **1.87 (validation,
lgbm-cls, 5td)** and **1.78 (test, lgbm-reg, 5td)** — everything at 10/21td
is under 1.1 because only ~14 independent 21td windows exist in the test
segment.

## Verdict

**No promotion.** The pattern is promising and worth re-testing as
independent history accumulates (the pipeline is retained and re-runnable in
one command), but StockSense does not ship ranking signals whose evidence
disappears under overlap adjustment — that is precisely the BHEL failure
mode, cross-sectionalized. The current descriptive ranking stays, labeled as
descriptive.
