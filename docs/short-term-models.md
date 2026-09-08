# Short-Term models

**ShortTermOpportunityModel v1 (shipping)** — deterministic: the stock's own
seeded-bootstrap return distribution at the horizon midpoint (p10/p50/p90),
excess vs NIFTY's own bootstrap median, bracket-applied EV after costs
(quantile grid clipped at stop/target2). modelConfidence is LOW by policy —
no setup type has validated out-of-sample edge, and the UI says so.

**Meta-label study (scripts/shortTermStudy.ts)** — 72,236 simulated brackets
(entry=close, stop=1.5·ATR14, target=2.25·ATR14, 7-session cap, gap-aware
fills) over 150 tickers × 5y. LightGBM classifier on point-in-time features,
purged date split. Pre-registered promotion rule: held-out ECE ≤ 0.05 AND
Brier < base-rate AND ≥30 independent windows.

**Verdict: NOT promoted** — Brier 0.1639 vs base 0.1635 (FAIL), ECE 0.0475
(ok), 54 independent windows (ok). `probabilityTargetBeforeStop` therefore
stays hidden behind the mandated text. Descriptive base rates persisted
(short_term_model_performance): pullback T17.6%/S15.3%, momentum T18.7%/S14.0%
— mildly favorable geometry; MEAN_REVERSION (T16.7%/S22.1%) and VCP
(T21.3%/S27.1%) hit stops MORE than targets historically, a caution recorded
against those setups. Challengers keep running in SHADOW; promotion is
statistical only — an LLM can never promote a model.
