# Setup-evidence methodology

Entry authority is per setupType×horizon (and, where dense enough, ×regime),
computed from REALIZED R-multiples — never from a chart rule alone.

`SetupEvidenceService` reads the persisted expectancy study and returns:
target/stop/timeout rates, mean/median/win/loss R, after-cost expectancy R,
profit factor, max-drawdown R, a block-bootstrap expectancy CI,
P(expectancy>0), a Benjamini–Hochberg significance flag, an evidence tier
(A/B/C/D) and `usableForEntry`.

Pre-registered promotion (fixed before the final study read,
`SETUP_PROMOTION`): TIER A / usableForEntry requires
after-cost expectancy ≥ 0.1R, CI lower bound > 0, ≥ 60 independent entry
dates, P(>0) ≥ 0.9, AND Benjamini–Hochberg significance across all cells.
Positive-but-not-decisive ⇒ B (not usable); any realized ⇒ C; none ⇒ D.

No study row ⇒ UNVALIDATED ⇒ tier C at best. Nothing is hardcoded per setup;
a setup earns — and can lose — promotion as evidence changes.
