# Global Market Intelligence — implementation report (2026-10-08)

Purpose: diagnose the global risk environment and measure how global conditions have historically transmitted to Indian equities. It predicts nothing; it enriches the Money Desk as context and as an evidence-gated risk input, and it can never veto a stock.

Pipeline: GLOBAL MARKETS → GLOBAL REGIME → INDIA TRANSMISSION → SECTOR IMPACT → STOCK-LEVEL CONTEXT → MONEY DESK RISK CONTEXT, in front of the existing SECURITY MASTER → … → CAPITAL ALLOCATION chain.

## What was built

| Spec § | Delivered | Where |
|---|---|---|
| 27 Global asset universe | 40 instruments with exchange timezone, local close, asset class, region; 6 have no configured source (TOPIX, CSI 300, USD/CNH, German and French 10Y, HY credit spread) and are tracked as coverage gaps, never invented | `src/services/global/globalUniverse.ts` |
| 28 Data model | `global_market_observations` (instrument × local session; price, 1D/5D/20D, vol, volume, source, source timestamp, freshness, quality, tz, local and UTC close) and immutable `global_market_snapshots` (append-only trigger) | migration `1791100000000`, `GlobalMarket.ts` |
| 29 Regime engine | `classifyGlobalRegime`: EquityTrend, EquityBreadth, Volatility, Rates, Dollar, Commodities, Credit, CrossAssetStress — each with score (−2..+2), value, unit, reasons, covered flag; regime by listed rules (`REGIME_RULES`), with `featureCutoff`, `dataCoverage` and `reasons` | `globalRegime.ts` |
| 30/31 Transmission + relationship research | 12 shock definitions (US10Y ±, DXY, Brent ±, VIX, Nasdaq, S&P ±, Asia composite, Gold, USD/INR) × targets (NIFTY, Bank, IT, Pharma + 12 sector proxies) × horizons 1/3/5/10 → n, mean, median, win rate (Wilson LB), vol, average max drawdown, unconditional benchmark; displayable only at n ≥ 20; de-overlapped triggers; India-close leakage rule | `globalRelationships.ts`, `global_relationship_studies` (+ `experiment_runs` row) |
| 32 Sector transmission | 5-session beta/correlation of each sector to its candidate drivers, lag-aligned; displayable at ≥ 20 non-overlapping blocks; sector proxies are equal-weight by NSE industry from exchange closes (NSE's own sector-index history is not reachable keylessly) | `sectorSensitivity`, `GlobalMarketDataService.sectorProxySeries` |
| 33 Events | `global_events` with expected/actual/surprise/market reaction fields; seeded with the official FOMC (28 Oct, 9 Dec) and BLS (CPI 14 Oct, PPI 15 Oct, ECI 30 Oct) dates with source URLs; no keyless calendar feed exists, so ingestion is a seed + manual path | `seedEvents()` |
| 34 Dashboard | Discover → **Global pulse**: regime + components, US / Europe / Asia / Rates / FX / Commodities / Volatility / India tables with 1D/5D/20D, local session, status and freshness; Impact on India; sector impacts; events; shock-study and sensitivity tables; regime track record | `GlobalPulsePanel.tsx` |
| 35 Money Desk integration | Each allocation carries `environment {global, india, sector, setup, label}`; a qualified setup in a hostile environment is labelled "Qualified setup with elevated macro risk", never vetoed | `capitalAllocation.ts` |
| 36 Risk adjustment | `GLOBAL_RISK_POLICY` (CAUTIOUS ×0.75, RISK_OFF ×0.5, STRESSED ×0.25; transmission HEADWIND ×0.85, STRESS ×0.7; RISK_OFF −1 position, STRESSED −2) applied to risk per trade and position cap **only when the regime's own evidence is displayable (n ≥ 20) and shows a worse-than-unconditional NIFTY 5-session median**; otherwise the multiplier stays 1 and the reason is shown. Env-configurable, tested | `riskProfiles.ts::macroRiskAdjustment` |
| 37 Company profile | `globalContext` section with measured driver statements and their evidence (beta, corr, n) | `CompanyResearchProfileService`, Company page → Global context |
| 38/39 Learning + track record | `global_regime_days` (point-in-time backfill) × NIFTY/sector forward returns × setup performance from the shadow ledger (withheld < 10); studies registered as `experiment_runs` | `regimeTrackRecord()`, `backfillRegimeDays()` |
| 40 Freshness | Every observation: exchange tz, market status, local close, UTC close, last session, freshness; Money Desk shows GLOBAL DATA AS OF / INDIA DATA AS OF | everywhere |
| 41 Diagnostic pipeline | Money Desk "Global risk context": markets scanned, valid observations, per region and per asset class x/x, regime, transmission, India regime, sector impacts, active shocks — then the existing stock funnel | `CapitalAllocationService.globalDiagnostics` |
| Cron | `morning-global-snapshot` 08:40 weekdays (before the 08:45 scan and 08:55 desk snapshot); `weekly-global-studies` Saturday 07:30 | `CronService.ts` |

API: `GET /api/global/pulse`, `POST /api/global/snapshot`, `GET /api/global/studies`, `POST /api/global/run-studies`, `GET /api/global/track-record`, `POST /api/global/backfill`, `GET /api/global/events`.

## The leakage rule (tested)

A US / European / US-settled commodity / FX session on date T closes after India's 15:30 IST close, so it is usable for an India decision on T **only from T+1**; Asian sessions close before 15:30 IST and are usable on T. Live snapshots use everything that has closed before *now* (US overnight data is available to the 08:40 snapshot); historical studies and the regime backfill use the India-close rule per day. `tests/global-intelligence.test.ts` pins both, plus DST-correct conversions, partial-bar exclusion while a market is open, and forward-return leakage.

## Results (live, 2026-10-08 ~17:00 IST)

| Measure | Value |
|---|---|
| global instruments scanned / valid observations | 34 / 27 (US 9/11, Europe 5/7, Asia 6/9, global commodities+FX 7/7; rates 3/6; credit 0/1) |
| global data as of / India data as of | 2026-10-08 08:00Z (Hong Kong close) / 2026-10-08 10:00Z (NSE close); US as of 2026-10-07 20:00Z |
| global regime | CAUTIOUS (score −3): equity trend −1 (mean 20d −1.2%), breadth −2 (4 of 15 indices up), volatility +1 (VIX 15.1), rates 0 (US10Y 5.28%, −2 bps/5d), dollar −1 (DXY +0.8%/5d), commodities 0 (Brent −3.2%/5d), credit not covered |
| India transmission | NEUTRAL — no driver is past its 5-session shock threshold today |
| regime days backfilled (point-in-time) | 500 (RISK_ON 235 · NEUTRAL 179 · CAUTIOUS 57 · RISK_OFF 26 · STRESSED 4) |
| relationship studies | 768 computed, 176 displayable at n ≥ 20; 40 sector sensitivities, all displayable; registered as experiment run `bb33fd01` |
| macro risk adjustment applied today | ×1.0 — CAUTIOUS days show NIFTY 5-session median +0.07% vs unconditional −0.23% (n=54), which does not demonstrate higher risk, so the regime is context only |

What the evidence actually says (NIFTY, 5 sessions after a shock, last ~5 years): Nasdaq-100 falls ≥4% → median +0.79%, win 59% (n=41); S&P falls ≥3% → +0.64%, 56% (n=34); Asia falls ≥4% → +1.00%, 65% (n=37); US10Y rises ≥25 bps → +1.02%, 62% (n=21); DXY rises ≥1.5% → −0.40%, 46% (n=28); Brent rises ≥8% → −0.20%, 48% (n=31); VIX rises ≥30% → −0.19%, 45% (n=20). Unconditional 5-session mean +0.11%. Measured 5-session sector betas to Brent, copper, Nasdaq, US10Y and USD/INR are all near zero (|corr| < 0.13). In plain terms: over this sample, Indian equities mostly rebounded after global equity shocks and were slightly weaker after dollar, oil and VIX shocks; none of the "obvious" sector channels is strong. The engine therefore reports these as context and keeps allocations unchanged, which is what the evidence supports.

## Limits

- Six instruments have no keyless source; credit is uncovered, so the Credit component is always "not covered" until a FRED key is configured.
- Sector proxies are equal-weight constructions from exchange closes (labelled), not NSE's official sector indices.
- Events are seeded from official calendars, not ingested automatically; expected/actual/surprise are recorded only when entered.
- Yahoo FX quotes are stamped in Europe/London; they are modelled as a 24h market with a New York close.
