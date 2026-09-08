# StockSense India

Honest, free-data Indian stock analysis: measured accuracy (Brier-calibrated), relative ranking, volatility forecasting, Kelly sizing that learns from your own paper trades, and an NSE-XBRL fundamental intelligence engine — every number traceable to a formula, an input, and a source.

**Everything — architecture, endpoints, measured results, version history, ops notes — lives in one doc: [ARCHITECTURE.md](ARCHITECTURE.md).**

Run: `npm run dev` (backend :5101) · `cd frontend && npx next dev -p 3001` (UI :3001).

Educational tool — not SEBI-registered investment advice. Markets are uncertain; measured past accuracy does not guarantee future results.

## Short-Term Trade Radar V2 — qualification integrity (2026-09-08)

The Short-Term section separates INTERESTING SETUP from ACTIONABLE TRADE. A
stock reaching a computed entry zone is NOT actionable: ENTRY_CONFIRMED needs
evidence tier A (validated realized-R expectancy, CI lower > 0, FDR-significant,
≥60 independent dates), a satisfied confirmation trigger, fresh EOD/LIVE data,
an EV-after-costs 80% lower bound > 0, affordability, and prospective shadow
authority. Deterministic ceilings compose to the most conservative action; AI
is cap-only. Results split into QUALIFIED TRADES (0–5) and a RESEARCH WATCHLIST
with per-stock "why not entry". Studies: realized-R expectancy (2/12 cells tier
A — mean-reversion 5-10d/10-21d), EV uncertainty, empirical-Bayes shrinkage,
Benjamini–Hochberg FDR, gap policy, survivorship audit. The 8-Sep four
(BERGEPAINT/M&M/ATGL/BDL) now correctly land on the watchlist, not as entries.
See docs/short-term-v2-final-report.md.

## OpenAI-first AI layer (2026-09-08 upgrade)

OpenAI is the primary reasoning provider (`AI_PROVIDER=openai`,
`OPENAI_API_KEY` server-side only): Responses API + strict Structured Outputs,
multi-role pipeline (fundamental/event/technical analysts on gpt-5.6-terra;
Forecast Critic + Risk Committee on gpt-5.6-sol; extraction on gpt-5.6-luna)
over a provenance-carrying evidence graph, with deterministic disagreement
scoring, counterfactual "what would make this a BUY" conditions, evidence-hash
caching, fixture evals (10/10 PASS gate for prompt changes), and a hard
cap-only clamp — AI can explain and lower, never raise. Without a key the
deterministic system runs identically. Research verdicts from this upgrade
(panel GBMs, LambdaRank ranking, event reactions): consistent positive
patterns, none significant on overlap-honest independent windows ⇒ **no
promotion; champion and current ranking kept** (docs/model-promotion-final.md).
Forecast vintages are immutable with a NORMAL/DRIFTING/INVALIDATED drift state
(docs/forecast-vintage-methodology.md).

## Completion state (2026-09-08 — Rules 1–20 finished)

All twenty rules of `docs/risk-spec.md` are **VERIFIED** (one runtime item —
the live Claude committee call — is BLOCKED_EXTERNAL until `ANTHROPIC_API_KEY`
is configured; the code path is complete and tested). The full acceptance
matrix with evidence lives in `docs/final-implementation-report.md`; the
research verdicts in `docs/forecast-before-after.md`; the promotion decision
("no challenger qualifies — champion kept, a successful result") in
`docs/promotion-policy.md`; the point-in-time failure-case replay in
`docs/bhel-regression-final.md`. Measured bottom line, stated on every
surface: **no model — champion, statistical, or ML — demonstrates a validated
out-of-sample directional edge**; the product ships calibrated RANGES, refuses
direction claims (the mandatory "Directional probability unavailable —
insufficient calibrated evidence" text), and answers WATCH / WAIT until edge
is earned in the experiment registry.

## Decision methodology (2026-09 risk-spec remediation)

StockSense's highest priority is **calibrated uncertainty and preventing false
confidence** (`docs/risk-spec.md`). How that works in practice:

1. **One action authority.** Only the evidence-gated TradeGate
   (`src/services/decision/policy.ts`, versioned) may emit BUY-flavored words.
   Everything else on screen — setup score, entry timing, rankings, scenario
   frequencies — is a labeled *description*, never a recommendation.
2. **BUY must be earned, all gates at once:** a fresh stored forecast issuance;
   a directional edge validated at 95% one-sided confidence on
   **overlap-adjusted independent samples** (daily-logged 30-day predictions
   are ~1/30th as informative as they look); positive Brier skill vs a constant
   50% forecast; measured band calibration; data quality ≥ threshold (missing
   inputs are penalties, never neutral); acceptable entry quality (a strong
   chart near its 52-week high after a rapid run is penalized, not chased);
   positive **expected value after round-trip costs**; and non-extreme unified
   risk. Any failed gate caps the decision at WATCH — and the UI shows exactly
   which gates failed and what they would need ("Why not Buy?").
3. **Two decisions, not one.** New-entry advice and existing-holder advice are
   computed and displayed separately; a new-entry caution is never a sell
   instruction, and risk tolerance is used only when the user supplies it.
4. **Probabilities are earned, not styled.** Bootstrap outputs are labeled
   *historical scenario frequencies*; the engine's normal-CDF number is
   labeled *model odds (uncalibrated)*; a calibrated probability will only
   appear once a calibrator beats naive baselines out-of-sample in the
   experiment registry (`experiment_runs`). Until then: "Directional
   probability unavailable / insufficient evidence."
5. **The registry is the promotion court.** Champion and challenger models are
   evaluated on VERIFIED live predictions (logged before outcomes) against
   constant-50 / base-rate / always-up / zero-return baselines with
   date-grouped chronological splits and block-bootstrap uncertainty. Nothing
   ships to the product without beating the baselines there. Today's honest
   verdict: **no validated directional edge exists** — so the scan says
   "No statistically attractive entries today" rather than forcing five picks.
6. **The AI committee advises, code decides.** The optional Claude committee
   (Rule 13) receives only the deterministic systems' structured output and is
   **cap-only by code**: it can lower an action or add caveats, never raise
   one past the gate; every call is audit-trailed in `ai_reviews`.

Full diagnosis and design: `docs/decision-audit.md`, `docs/decision-remediation-plan.md`,
`docs/decision-report.md`.
