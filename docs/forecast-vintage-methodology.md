# Forecast vintages + drift methodology (upgrade Parts 10/11)

Vintages are immutable `forecast_runs` rows; nothing is ever rewritten.
- **ORIGINAL** = oldest next-30 issuance whose window still covers today —
  the accountability record, scored against actuals.
- **CURRENT** = latest issuance (freshest anchor); a separate row.

`GET /api/forecast/:ticker/vintage` returns both plus the drift verdict from
`ForecastDriftService` (thresholds fixed in code before observing outputs):
- **INVALIDATED**: price outside the original 80% interval at today's offset,
  or |price − median| > 1.5 forecast-σ, or regime flipped to downtrend;
- **DRIFTING**: > 1.0 ATR(14) or > 1.0 σ from the original median, or a
  tier ≤2 event arrived after issuance, or last-session volume > 2.5× its
  20-session average;
- **NORMAL** otherwise.

Every reason is displayed verbatim; the UI (`ForecastVintageCard`) shows
"Issued / Anchor / Median at today / error% / Inside original 80% interval"
per vintage. Live check (BHEL, 2026-09-08): DRIFTING — price 1.0 ATR below
the original median, still inside the band, error −2.64%; original stays
immutable, state announced, nothing re-anchored.
