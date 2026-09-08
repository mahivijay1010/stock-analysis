# Short-Term EV uncertainty

`computeEvEvidence` runs the trade's OWN bracket (entry/stop/target1/max-hold)
across 3,000 seeded bootstrap return paths and records each path's realized
R-multiple (first-touch on the path; terminal-R at the time stop). It returns
the full distribution: mean/median EV%, block-bootstrap 80%/95% CIs on the
mean, P(mean>0), expected-shortfall%, downside p10, and the R view
(expectedR, medianR, p10R, CVaR-R, MFE/MAE-R, target/stop/timeout rates).

Pre-registered EV gate (`EV_GATE`): the 80% LOWER confidence bound must be > 0
AND expectedR ≥ 0.1R AND CVaR ≥ −2R. A +0.5% mean EV with a −1% lower bound
does not pass — precisely the 8-Sep four, whose lower bounds were −0.9% to
−1.5%. Effective sample size is discounted to pool ÷ max-hold because path
outcomes over the holding window overlap.
