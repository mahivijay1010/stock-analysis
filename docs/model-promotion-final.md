# Model promotion — final decision (2026-09-08, upgrade Part 21)

The binding gauntlet (extends docs/promotion-policy.md): every challenger vs
constant-50, random-walk/zero-return, historical mean, momentum, and the
existing champion; ranking challengers additionally vs the current ranking,
sector-neutral momentum, and random. Metrics: Brier (+skill), logloss, MAE,
RMSE, CRPS, ECE, coverage, width, Rank IC (overlap-honest), precision@k,
top-decile, after-cost return, turnover, drawdown; segment discipline:
select on validation, report test once; **no optimization on the final test
period** (all thresholds and rules pre-registered in scripts before runs).

## Decisions
| Candidate | Evidence | Decision |
| --- | --- | --- |
| Panel GBMs (LightGBM/XGBoost/CatBoost reg/cls) | test IC +0.02…+0.06 but stride-t ≤ 1.78; after-cost edge over momentum ≈ 0.2pp | **NOT promoted** — retest as history grows |
| LambdaRank Discover ranker | stride-t ≤ 1.03; p@10 within noise of momentum | **NOT promoted** — current ranking kept |
| ElasticNet panel | IC ≈ 0/negative | rejected |
| Event-reaction signals | dividends n=432 ⇒ no effect; other classes under floors or confounded | **no event signal ships** |
| Calibrators (30d display horizon) | unchanged: refused on independent-sample floors | probability stays withheld |
| MC block bootstrap | unchanged verdict from 3a591851 | iid kept |
| Champion quant-v1 | still no directional edge (BSS < 0) — and still the best-behaved distribution engine available | **KEPT**, presented as ranges + WATCH |

**Outcome: the existing champion stays; no challenger is promoted.** That is
the correct result of a working promotion court on today's evidence, stated
per the directive. The entire gauntlet is re-runnable in three commands
(`researchRun`, `panelRun`, `eventStudy`).
