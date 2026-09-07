# Decision-System Remediation Architecture (Stage SECOND of docs/risk-spec.md)

**Basis:** every design below cites the defect it fixes in `docs/decision-audit.md` (§ refs).
**Prime directive (spec):** the system must prefer NO TRADE / WATCH / INSUFFICIENT EDGE over
false confidence; action words come from exactly one gate.

## Design principle: one action authority

The single biggest architectural fault (audit §1, §10.1, §10.6) is that action-flavored
words (BUY, BUY TODAY) are minted in three ungated places (`engine.recommendation`,
`entryTiming.action`, Top-5 ordering). Remediation does **not** delete those computations —
they become *inputs* (descriptive scores) to the one authority:

```
ScoreCard (pure)  ──►  TradeGate (policy v3, pure)  ──►  DecisionService (publishes)
   ▲    ▲    ▲                    │
 engine framework entry           ▼ (cap only, never raise)
 rank   intel    quality   InvestmentReasoningProvider (Claude committee)
```

- Every UI surface either reads a published decision snapshot or displays *scores with
  score words* (Setup 79/100), never action words.
- The AI committee (Rule 13) can **lower** the gate's output or add caveats; it can never
  raise an action past the gate cap.

## S1. ScoreCard — separate scores (Rule 1; audit §2 gaps)

New pure module `src/services/decision/scorecard.ts` assembling from existing computations
(nothing re-invented; provenance recorded per field):

| Field | Source | Notes |
|---|---|---|
| `setupScore` | quant composite (audit 2.1) | **renamed everywhere from "conviction"**; UI word "Setup" |
| `technicalScore` | = setupScore (alias, one formula) | |
| `momentumScore` | engine momentum signal rescaled 0-100 | |
| `valuationScore` | framework phase-5 score | null-aware: null ≠ 50 |
| `fundamentalScore` | framework phase-4 score | null-aware |
| `businessQualityScore` | intelligenceQuality (audit 2.6, fix FCF double-count) | null <2 inputs |
| `entryTimingScore` | entryQuality v2 (S5) | extension/reward-risk penalties added |
| `riskScore` | **new single formula** 0-100 from annualized vol + 1y max drawdown + liquidity proxy | replaces 3 inconsistent labels (audit §10.4) as the *gating* source; display labels derive from it |
| `dataQualityScore` | **new**: bar coverage/freshness/source (db-stale −), corporate-action risk flag, fundamentals field completeness, filings metrics availability, news availability | missing ⇒ penalty, never neutral (Rule 11) |
| `forecastConfidenceScore` | **new, measured-only**: Brier skill vs 0.25, effective sample size, band-coverage error, model stability (recent vs prior window), interval width | with today's evidence computes LOW (<40) for every stock — honest |
| `overallOpportunityScore` | min(blend, caps from forecastConfidence & dataQuality) | UI caption: "descriptive blend — NOT a probability" |

## S2. TradeGate — decision-policy v3 (Rule 2, 8; audit §0, §10.11)

Extends policy v2 (which already gates on effective samples, edge test, coverage, Brier,
vol, staleness). New inputs and vetoes:

```
if brierSkill(30d, system or ticker) <= 0        → cap WATCH        (already implied; make explicit + reason)
if effectiveSamples < minEff (10)                → cap WATCH        (exists, v2)
if dataQualityScore < DQ_MIN (70, provisional)   → cap WATCH + reason "insufficient data quality"
if forecastConfidenceScore < FC_MIN (60, prov.)  → cap WATCH
if expectedValueAfterCosts <= 0                  → cap WATCH        (S6)
if riskScore >= RISK_VETO (80, prov.)            → AVOID_NEW_ENTRY  (closes audit §10.11's 45–60 window)
if entryTimingScore < ENTRY_MIN (40, prov.)      → cap WATCH ("setup strong, entry unattractive")
regime: adverse regime caps, never boosts        (S7)
```

Thresholds are **versioned constants marked `provisional`** in `POLICY_THRESHOLDS_V3`;
Stage FOURTH walk-forward experiments validate/tune them and the validation run id is
recorded next to the constants (spec: "do not hard-code without validation" — we ship the
gate immediately because every provisional threshold only *restricts* further; loosening
requires the validation evidence).

## S3. Overlap-honest statistics everywhere (Rule 3; audit §5)

New pure `src/services/experiments/effectiveStats.ts`:
- `effectiveSamples(raw, horizonDays)` (move from policy so all surfaces share it),
- hit-rate CI via the existing (unused!) `dateBlockBootstrap` (blockLen = horizon),
- Newey–West SE (lag = horizon−1) for mean error metrics.

Wire into: `GET /api/accuracy` (per-horizon `rawSamples`, `effectiveIndependentSamples`,
`ci80`), `/api/calibration`, research-brief accuracy context, AccuracyView + per-stock
panels ("39 raw ≈ 1 independent — VERY LOW confidence"), decision reasons (exists).

## S4. Benchmarks (Rule 4; audit §5 "zero callers")

`src/services/experiments/runner.ts`: per horizon, champion (engine directionProb + bands)
vs constant-50, train-base-rate, always-up, zero-return/last-price, historical-mean —
Brier, Brier skill, log loss, MAE/RMSE, direction accuracy, calibration error, coverage +
interval score (all functions already exist in `baselines.ts`). Persists `experiment_runs`
rows (table exists, unused). Exposed at `GET /api/experiments/latest`; Track Record gets a
"model vs naive baselines" table. **Promotion rule:** nothing surfaces as a product
probability unless its experiment run beats baselines out-of-sample (Rule 4/9).

## S5. Entry-quality model v2 (Rule 7; audit §3.3, §10.2)

`entryTiming.ts` → add extension/quality penalties: distance above SMA50/200 (z of ATR),
52-week-high proximity after rapid run-up (the BHEL case), ATR spike vs 3-month median,
interval width percentile, valuation-vs-growth (expensive valuation without earnings
growth), reward/risk from the issued distribution. Output keeps score + reasons, **loses
the action vocabulary**: `BUY_TODAY` label is retired from this layer (chip becomes
"entry quality: attractive/neutral/unattractive"); only the TradeGate can say buy-anything.
Supports the "LONG-TERM POSITIVE **but** ENTRY UNATTRACTIVE" split (pairs with horizon
suitability which already exists).

## S6. Expected value (Rule 8)

Pure `src/services/decision/expectedValue.ts` from the **issued distribution** (no second
model, consistent with forecast spec): EV = mean(scenario P&L) − round-trip costs
(`framework/fees.ts`) − slippage haircut; `expectedShortfall` = mean of worst decile;
`rewardRiskRatio` = (p90−anchor)/(anchor−p10); probabilities labeled *scenario
frequencies* until calibration validated (Rule 10). Gate consumes EV≤0 ⇒ WATCH.

## S7. Regime model (Rule 6)

`src/services/decision/regime.ts` (pure) + inputs from MacroService/bars:
`marketRegime` (NIFTY vs 50/200 DMA + realized vol + VIX zone), `stockRegime`
(trend/vol/drawdown/52wk percentile/volume regime), `entryRegime` classification
(extended_uptrend / breakout / mean_reverting / late_trend / high_event_risk …).
**Consumed as confidence caps in the gate, never as a bullish additive factor.**
Stored in snapshot inputs for monitoring by regime (Rule 18).

## S8. Calibration (Rule 9) + Monte Carlo honesty (Rule 10)

- Isotonic calibration harness fitted ONLY on verified live PredictionLog rows
  (train/val split by date, purged); today 743 rows across 5 horizons ⇒ **insufficient ⇒
  the product displays "Directional probability unavailable / insufficient evidence"** —
  implement the display path now, the calibrator activates when data matures and its
  experiment run beats baselines.
- UI renames: "Probability of profit" → **"Historical bootstrap scenario frequency"**;
  "confidence range" → "80% interval"; the research-brief silent directionProb-for-pop
  substitution (audit §4) is removed — missing MC horizon renders as unavailable.
- `montecarlo.ts` gains a **stationary block bootstrap** variant (seeded, mean block ~10d)
  as `simulate*V2`; compared against i.i.d. in experiment runs before any product use.

## S9. Two decisions (Rule 14) + committee (Rule 13)

- `decision_snapshots` gains `new_entry_action` (≡ current status) and
  `existing_holder_action` (HOLD / REVIEW / REDUCE_CONSIDERATION / INSUFFICIENT_DATA)
  with separate reasons; PortfolioView shows the holder action on held rows. User context
  (purchasePrice, horizon, riskTolerance, maxAcceptableLoss) accepted via POST — never inferred.
- `src/services/reasoning/`: `InvestmentReasoningProvider` interface
  (evaluateStock / evaluateExistingPosition / explainDecision / identifyMissingEvidence);
  `ClaudeProvider` behind it (ANTHROPIC_API_KEY; absent ⇒ honest "committee unavailable").
  Input contract = ScoreCard + gate outputs + measured stats (exact spec JSON). Output
  validated against the strict schema; **committee may only cap, never raise**; audit
  table `ai_reviews` (promptVersion, model, inputHash, response, latency, tokens, ts).

## S10. Daily scan buckets (Rule 15; audit §3.5)

`scanUniverse` output re-bucketed: BEST NEW ENTRIES (gate-passed only — currently always
empty ⇒ **"No statistically attractive entries today."**), STRONG BUT EXTENDED,
WATCH FOR PULLBACK, HIGH-RISK MOMENTUM, INSUFFICIENT EDGE. TopPicksView renders buckets;
no forced five.

## S11. UI truth panel (Rule 17; audit §10)

Stock Detail: Setup / Entry / Model confidence / Data quality / Risk / EV / Calibration
status panel; "Why not Buy?" (gate reasons); "What would change the decision?" (unmet
gates with thresholds); "Model disagreement" (setup vs valuation vs forecast vs committee);
footer: *"Forecast confidence is based on measured out-of-sample performance, not the
setup score."* Renames: conviction→Setup. CanonicalDecisionCard error state becomes
visible (never silently absent). DecisionSummary loses action words (renders scores +
links to the canonical decision).

## S12. Defect fixes (audit §5, §6, §9 — independent of new features)

P0: research-brief P(up) substitution; partial today-bar returned to callers (apply the
15:40 rule at the read path); PredictionLog DB uniqueness constraint; verify window
(1y → span covering oldest pending row) so old rows aren't silently never-verified;
DecisionService measured SQL gains model_version + recency filter; `getUniverse` TTL;
framework null verdict → explicit `NO_DATA`; yahoo volume null→0 and previousClose
masking → honest nulls; corporate-action data risk: flag affected tickers in
dataQualityScore now, adjusted-bars ingestion as follow-up.
P1: Top-5 risk carve-out (`HIGH && ≥75`) retired in favor of buckets; backtest/live model
parity (add RS signal to backtest or measure both, labeled); flat-day convention unified.

## Rule 5 (ensemble) & Rule 12 (event engine) — phased, honest scope

- **Rule 5:** challenger framework runs SHADOW-ONLY through `buildPurgedSplits` + S4
  benchmarks: TS-native first (EWMA-vol zero-drift, momentum baseline, ridge/logistic on
  lagged features). LightGBM/XGBoost/CatBoost/TFT require the Python research worker
  (open owner decision, plan §8 Q5) — **BLOCKED-pending, stated, not faked.**
- **Rule 12:** the XBRL filings pipeline already provides provenance-first events for
  filings; structured event records + LLM-assisted classification ride the S9 provider
  (no key ⇒ unavailable). Keyword sentiment stays but capped and labeled crude
  (it already self-labels); it can no longer be the sole driver of an entry penalty/bonus.

## Stage THIRD implementation order (each step: code + tests + live verify + commit)

- **T1 (core):** ScoreCard + riskScore + dataQualityScore + forecastConfidenceScore;
  EV module; entryQuality v2; TradeGate v3; two-action snapshots; generalized
  extended-entry regression test (BHEL case, not hardcoded).
- **T2 (surfaces):** Top-5 buckets; Stock Detail truth panel + renames + effective-sample
  displays; CanonicalDecisionCard visibility; DecisionSummary de-action-ed.
- **T3 (integrity):** S12 defect fixes; block-bootstrap MC v2 (experimental); S4 runner +
  /api/experiments; accuracy/calibration effective stats.
- **T4 (committee):** reasoning provider + ai_reviews + endpoint + UI card.
- **T5 (Stages FOURTH–SIXTH):** before/after walk-forward report; threshold validation;
  retain only what beats baselines; README methodology chapter.

## What stays deliberately unchanged

Immutable issuances/outcomes, the ledger, session calendar, horizon policy, purged-split
infra (gets callers), the honest Track Record — all already spec-aligned. The heuristic
engine keeps running **as a feature extractor** whose output is a labeled setup score.
