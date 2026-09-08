# Short-Term survivorship-bias audit

The expectancy study uses TODAY's covered NSE universe over 5y of history.
Point-in-time historical index/coverage membership is NOT available in this
system, so the backtest is exposed to survivorship bias: stocks that were
delisted, merged, or fell out of coverage are absent, and the surviving names
skew toward those that did not blow up.

**We do NOT call this backtest unbiased.** Consequences, applied:
- promotion thresholds are deliberately conservative (CI lower bound > 0, FDR,
  ≥60 independent dates);
- backtest TIER A is NOT sufficient for live entry — prospective shadow
  confirmation on the live (survivorship-free going forward) tape is required;
- this limitation is restated in the final report and the Model Lab footnote.

If point-in-time membership data is later sourced, the study should be re-run
against the as-of universe and this file updated.
