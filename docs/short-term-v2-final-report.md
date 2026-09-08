# Short-Term V2 — final report (2026-09-08)

## What changed
A hard wall between INTERESTING SETUP and ACTIONABLE TRADE. A candidate is
QUALIFIED (may show ENTRY_CONFIRMED) only when ALL hold: evidence tier A
(validated realized-R expectancy), confirmation trigger satisfied, data fresh
(EOD_FINAL/LIVE, not delayed intraday), EV-after-costs 80% lower bound > 0,
affordable under the risk budget, and live authority earned (prospective
shadow, not just backtest). Otherwise it lands on the RESEARCH WATCHLIST with
an explicit "why not entry" list. Every ceiling is deterministic; AI is
cap-only.

## Honest findings
- MEAN_REVERSION at 5-10d (+0.117R) and 10-21d (+0.146R) DO earn backtest
  TIER A once realized-R (not just target-first rate) is measured — the
  earlier "16.7% target-first" was a symmetric-bracket artifact.
- PULLBACK and VOLATILITY_CONTRACTION LOSE after costs on this universe/period.
- Backtest evidence is survivorship-exposed; TIER A is therefore NOT enough for
  live entry — the SHADOW live-authority gate holds even validated setups at
  WAIT_FOR_CONFIRMATION until ≥20 independent resolved shadow trades confirm a
  positive live expectancy.
- Today: QUALIFIED = 0. The 8-Sep four are Research Watchlist / tier C.

## Statistical limitations (stated, not hidden)
Survivorship bias (no point-in-time membership); ~243–446 independent dates per
setup — enough for a directional read, not a small-sample guarantee; regime-
conditional cells not yet split (pooled only); DSR/PBO deferred until live
equity curves exist; the free data provider is delayed (never called LIVE).
