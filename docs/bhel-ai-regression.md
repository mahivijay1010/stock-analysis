# BHEL as a generalized AI-era regression case (upgrade Part 19)

Nothing here is hardcoded to BHEL: every state below comes from generic
features/services that produce the same classifications for ANY ticker with
this pattern (verified by the fixture eval `bhel-failure-pattern`, which uses
a synthetic ticker).

## Current-state recognition (live, 2026-09-08, BHEL ≈ ₹422)
- Technical Analyst (gpt-5.6-terra, from deterministic indicators only):
  long-term **BULLISH**, short-term **UPTREND-late / consolidation within a
  bearish low-vol market**, momentum **NEUTRAL**, participation
  **INSUFFICIENT_DATA/WEAK**, "trend-aligned stock in an unfavorable
  contextual regime… not a confirmed breakout."
- Deterministic regime: market bear_low_vol · stock healthy_uptrend · entry
  **late_trend** (cap).
- Forecast Critic (gpt-5.6-sol): **forecastUsable = false**, cap
  INSUFFICIENT_DATA — "only ~1 overlap-adjusted effective sample supports the
  30-day forecast, despite 39 raw samples."
- aiDisagreementScore: **55/100** — "high-quality company but weak current
  entry" + critic-vs-fundamental conflict; fed to the committee, not averaged
  away.
- Risk Committee (sol): **INSUFFICIENT_DATA / LOW / 25**, unclamped (the raw
  model respected the ceiling; the clamp exists regardless).
- Drift engine: **DRIFTING** (1.0 ATR below original median, inside band);
  original vintage immutable.
- Directional probability: withheld — "Directional probability unavailable —
  insufficient calibrated evidence."

## Forecast-model comparison on the BHEL pattern (Part 19 study)
A. absolute-return champion: Brier skill ≤ 0 at all horizons (unchanged).
B. market/sector/residual decomposition: implemented as targets (Part 5).
C. panel excess-return models: positive but insignificant on independent
   windows (stride-t ≤ 1.87) — not promoted.
D. ranking model: not promoted (see ranking-model-study.md).
E. event-reaction model: no tradable effect on powered classes; BHEL's own
   announcement cluster explicitly flagged as confounded.
F. calibrated ensemble: abstains at 30d (unchanged).

## Conclusion
The 2026-09-04 failure (BUY / 78.8 / 63.8% shown at ₹431) remains impossible
on this pipeline, and the NEW AI layer independently reproduces the honest
verdict from generic evidence — while every quantitative attempt to
manufacture an edge on this pattern was measured and declined.
