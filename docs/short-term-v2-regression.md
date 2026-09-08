# Short-Term V2 regression — 8-Sep four-stock replay

`scripts/shortTermV2Regression.ts` runs BERGEPAINT / M&M / ATGL / BDL through
the live V2 ScanService (point-in-time: DB bars end 2026-09-08, so a scan
today reproduces the 8-Sep state). Not hardcoded.

Result (budget ₹50,000, 0.5% risk, 5-10d):
- universe 151 → 2 passed base gates → **QUALIFIED 0** → all four on the
  RESEARCH WATCHLIST, tier C, action RESEARCH_WATCH.
- Each cites the binding reasons, e.g. BERGEPAINT: "EV 80% lower bound −1.107%
  ≤ 0", "expected −0.037R < 0.1R after costs", "model confidence LOW".
- **ACCEPTANCE PASS** — none is ENTRY_CONFIRMED or QUALIFIED.

Note the honesty: MEAN_REVERSION 5-10d is a backtest TIER A setup, yet these
specific instances are tier C because THIS trade's EV lower bound is negative
(and live authority is SHADOW). The system distinguishes "the setup family has
edge on average" from "this instance, now, is an actionable trade."
