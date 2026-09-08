# Event-reaction study (upgrade Parts 4/7)

`scripts/eventStudy.ts` over point-in-time `structured_market_events`
(announcedAt ≤ observation start), abnormal returns vs NIFTY and vs
equal-weight sector baskets at +1/3/5/10/20 sessions, with hierarchical
sample-size floors: stock×type ≥10 · sector×type ≥15 · type-pooled ≥20;
below a floor the cell reports **INSUFFICIENT_SAMPLES**, never a number.

## Results (ExperimentRun `event-reaction-study`)
- **dividend** (n=432, the only well-powered class): +5s abnormal
  −0.05% ±0.16 → **no tradable effect** (consistent with efficient ex-date
  pricing); +20s +0.66% ±0.36 → under 2·SE, not significant.
- **split** (n=20): +5s −0.36% ±0.96 — nothing.
- **"other" / Capital Goods (BHEL announcements)** shows +20s ≈ +10.7%, but
  the observations are overlapping same-ticker windows clustered inside one
  rally period — **confounded; treated as non-evidence** (stated here so
  nobody mistakes clustering for signal).
- rating_change / regulatory: below floors ⇒ INSUFFICIENT_SAMPLES.
- Order-value extraction (luna): 0/0 — no order_win headlines with explicit
  values exist in the store yet; the extractor is wired and id-validated.

## Consequence
Event features remain descriptive inputs (counts, recency) in the panel and
the event engine remains an EVIDENCE surface (Research page), not a
forecasting signal. No event-based signal ships. The study reruns in one
command as event history deepens.
