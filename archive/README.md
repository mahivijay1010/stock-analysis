# archive/ — removed-feature code (Phase B1, upgrade/product-v2)

Code removed from the ACTIVE product per `docs/upgrade-spec.md` §2 and
`docs/upgrade-audit.md` §3 (feature-removal matrix), preserved here as
reference/experiment artifacts instead of being deleted outright.

**Nothing in this directory is compiled, tested, scheduled, or routed:**
`tsconfig.json` excludes `archive/`, jest roots stay on `tests/`, and no
`src/` file imports from here. Files keep their original relative layout.

| Path | Matrix row | What it was |
|---|---|---|
| `src/services/quant/kelly.ts`, `quant/dcfPrior.ts`, `src/services/PositionSizeService.ts` | 1 | Consumer Kelly sizing + DCF-implied payoff prior (route `GET /api/position-size/:t` removed) |
| `src/services/admin/ExecutionAnalyticsService.ts`, `admin/executionStats.ts` | 1 | Adaptive execution feedback / Kelly drift (route `GET /api/execution/summary` + evening cron step removed). `computeTradeBreakdown` was EXTRACTED first to `src/services/admin/tradeBreakdown.ts` (keeper: prediction audit) |
| `src/services/quant/models/` (10 files), `src/services/ensemble/EnsembleService.ts` | 2 | Six-model voting pool + FTRL regret-weight ensemble (evening cron step removed; `ensemble_weights` rows preserved in DB) |
| `src/services/assistant/AssistantService.ts`, `src/controllers/AssistantController.ts` | 8 | Sensei chatbot (route `POST /api/assistant` removed) |
| `src/services/market/OptionsRadar.ts` | 9 | NSE options-skew radar — measured permanently Akamai-403 (route `GET /api/options/skew/:t` removed) |
| `src/controllers/HoldingsController.ts` | 4 | Stateless holdings-calculator HTTP handler (route `POST /api/holdings/calculate` removed). `HoldingsService` itself is KEPT in `src/` — its fee math and NIFTY comparison are reused by the real Holdings ledger (B2) |
| `scripts/recordKellyDrift.ts`, `scripts/updateEnsemble.ts` | 1, 2 | One-off runners for the removed cron steps |
| `tests/*.test.ts` (kelly, dcf-prior, execution-analytics, factor-insights, models) | 1, 2 | Tests specific to removed behavior (spec §2: remove feature-specific tests). The still-consumed TradeBreakdown assertions were preserved in `tests/trade-breakdown.test.ts` |

Historical DATA is untouched: `kelly_drift` (4 rows), `ensemble_weights`
(169 rows), `prediction_logs`, `model_performance`, and the paper account are
all preserved in the database per the standing preserve-history rule.
