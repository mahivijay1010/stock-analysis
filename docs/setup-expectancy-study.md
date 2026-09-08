# Setup expectancy study (results)

`scripts/setupExpectancyStudy.ts` replays the LIVE setup classifier + trade-plan
builder across 5y of adjusted bars for the whole universe, simulates each
detected setup's own bracket forward GAP-AWARE, and records the realized
R-multiple (net of costs, TIMEOUT trades included at their actual P&L).

Result (per setupType × horizon; E[R] net of costs, CI = 90% block-bootstrap):

| setup | horizon | ind. dates | target/stop/timeout | E[R] | CI low | P(>0) | BH | tier | entry |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| MEAN_REVERSION | 10-21d | 243 | 0.62/0.35/0.03 | **+0.146R** | +0.040 | 0.99 | Y | **A** | YES |
| MEAN_REVERSION | 5-10d | 243 | 0.56/0.30/0.14 | **+0.117R** | +0.043 | 0.995 | Y | **A** | YES |
| MOMENTUM_CONTINUATION | 10-21d | 360 | 0.70/0.17/0.13 | +0.083R | +0.016 | 0.985 | Y | B | no |
| MEAN_REVERSION | 3-5d | 243 | 0.47/0.23/0.30 | +0.072R | −0.009 | 0.94 | n | B | no |
| MOMENTUM_CONTINUATION | 5-10d | 360 | 0.60/0.12/0.28 | +0.035R | −0.041 | 0.69 | n | C | no |
| PULLBACK_IN_UPTREND | 10-21d | 446 | 0.71/0.19/0.09 | −0.042R | −0.082 | 0.01 | n | C | no |
| PULLBACK_IN_UPTREND | 5-10d | 446 | 0.63/0.15/0.22 | −0.080R | −0.126 | 0 | n | C | no |
| VOLATILITY_CONTRACTION | all | 295 | ~0.4/~0.5/~0.1 | −0.24 to −0.30R | <0 | 0 | n | C | no |

**Verdict: 2 of 12 cells earn TIER A** — MEAN_REVERSION at 5-10d and 10-21d.
This is the nuance the directive anticipated: the raw target-first rate (16.7%
in the earlier symmetric-bracket meta-label study) understated mean-reversion
because the realized win/loss asymmetry and timeout drift over the radar's own
(tighter-target) bracket produce positive after-cost expectancy. Pullbacks and
volatility-contraction, by contrast, LOSE after costs on this universe/period.

Crucially, TIER A is BACKTEST authority only — live trading additionally
requires prospective shadow confirmation (docs/short-term-v2-final-report.md).
