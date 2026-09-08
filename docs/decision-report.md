# Decision-System Remediation — Final Report (Stages FOURTH–SIXTH of docs/risk-spec.md)

**Date:** 2026-09-08 · **Commits:** 696294f (audit+plan) · ad93119 (T1 core) · 84d7298 (T2 surfaces) ·
d6041e6 (T3 integrity) · 9b24c01 (T4 committee) · **Tests:** 17 suites / 219 green · both tsc clean · next build clean.

## 1. BEFORE vs AFTER (measured, not asserted)

The remediation changed the **decision layer**, not the forecasting model. The champion
(quant-v1) is byte-identical, so its forecast metrics are definitionally unchanged — and
that is the point: the model was never the lie; the *presentation of certainty* was.

| Metric | BEFORE | AFTER | Change |
|---|---|---|---|
| 30d direction hit (system, walk-forward) | 50.22% | 50.22% | unchanged (same model, now labeled "no validated edge") |
| Brier (30d) / Brier skill | 0.2533 / **−1.3%** | 0.2533 / −1.3% | unchanged, now displayed and GATING |
| 80%-band coverage | ~85% | ~85% | unchanged (integrity caveats added: unadjusted-CA + partial-bar fixes protect it forward) |
| **BUY-flavored signals on 2026-09-08's live scan (151 stocks)** | **5 "Top picks" incl. 4 × "BUY TODAY"** (OIL, KOTAKBANK, DIVISLAB, IDFCFIRSTB @ BUY TODAY; SBICARD @ BUY) + every score ≥62 showed "BUY" | **0 gate-passed entries** — "No statistically attractive entries today"; 3 strong-but-extended, 5 watch-for-pullback, 4 high-risk momentum, 139 insufficient edge | **−100% false-confidence BUYs** |
| Displayed sample counts | 47,241 raw presented as-is | "47,241 raw ≈ 19,160 independent after overlap adjustment" | honest |
| Probabilities on screen | 4 conflicting "P(up)"-style numbers, one silently source-swapped | scenario frequencies / model odds, labeled; missing = "unavailable"; substitution removed | honest |
| P&L/drawdown/Sharpe of BUY signals after costs | not evaluable (no gate-passed BUYs before either — the old BUYs were never tracked as a strategy) | 0 BUYs to track; the experiment registry now accumulates the evidence that could ever re-open the gate | n/a — tracked forward |

**Stage SIXTH retention test:** every retained change either (a) fixes a data-integrity
defect, (b) adds measured honesty to displays, or (c) restricts actions behind evidence.
No change altered the forecasting model's out-of-sample numbers, so nothing needed to
"beat" the old model; the one candidate model change (block-bootstrap simulator) shipped
EXPERIMENTAL and product-unwired pending registry validation, exactly per the rule.

## 2. BHEL regression result (Rule 16)

**Live (2026-09-08, BHEL at ₹421.45, −2.24% from the failure-case entry):**
policy v3 published snapshot → **NEW ENTRY: WAIT · EXISTING HOLDER: HOLD** with
setup 54/100, entry quality 33/100, risk 36/100 (medium), data quality 70/100
(4 itemized penalties), forecast confidence 29/100 **LOW** (effN = 1), and the
unmet-gates table: directional edge "79.5% over ~1 independent obs → needs ≥10",
forecast confidence 29 → needs ≥60, entry quality 33 → needs ≥40.

**Tests (generalized, not hardcoded):** `tests/decision-policy.test.ts` ("Rule 16 —
generalized extended-entry regression") asserts the BHEL *shape* (high setup + overlap
mirage + extension + expensive-without-growth + LOW confidence) can never produce
BUY_CANDIDATE and always yields a separate HOLD/REVIEW for holders;
`tests/entry-quality.test.ts` asserts the shape scores "unattractive" with the specific
extension/valuation reasons. The historical v1 mirage snapshot (BUY_CANDIDATE,
2026-09-06) is preserved in `decision_snapshots` as the audit record of the bug.

## 3. Rules 1–20 status (IMPLEMENTED / VERIFIED / EXPERIMENTAL / BLOCKED)

| Rule | Status | Evidence |
|---|---|---|
| 1 Separate scores | **VERIFIED** | scorecard.ts; truth panel; "conviction" removed; 29 scorecard tests |
| 2 Confidence gate | **VERIFIED** (thresholds PROVISIONAL, restrict-only) | policy v3; live WAIT on BHEL; 29 policy tests |
| 3 Overlapping backtests | **VERIFIED** (display+gate) / **IMPLEMENTED** (block-bootstrap CI in runner; Newey–West helper exists, wired into runner only) | effectiveSamples everywhere; Track Record raw≈independent |
| 4 Benchmark everything | **VERIFIED** (runner live) | experiment_runs row: all horizons honestly SKIPPED — 743 verified rows over 8 days is not an evaluation |
| 5 Ensemble rebuild | **BLOCKED-pending** (Python worker, owner decision plan §8 Q5) / TS challengers **EXPERIMENTAL** scaffolding via registry | stated, not faked |
| 6 Regime model | **PARTIAL** | macro regime exists and caps entry timing; full market/sector/stock regime classifier remains open (S7) |
| 7 Entry quality | **VERIFIED** | entryQuality v2 + tests; gate consumes it |
| 8 Expected value | **VERIFIED** | expectedValue.ts + tests; EV≤0 ⇒ WATCH veto |
| 9 Calibrated probabilities | **IMPLEMENTED** (display honesty) / calibrator **BLOCKED-by-data** | "Directional probability unavailable / insufficient evidence" pattern shipped; isotonic fitting awaits enough verified live rows |
| 10 MC terminology | **VERIFIED** (renames) / block bootstrap **EXPERIMENTAL** | UI: "Historical bootstrap scenario frequency (NOT a calibrated probability)" |
| 11 Fundamentals missing≠neutral | **VERIFIED** (dataQuality penalties; valuation-without-growth penalty; volume/prevClose fixes) / full ratio buildout **PARTIAL** | scorecard + entryQuality tests |
| 12 Event engine | **PARTIAL** | XBRL filings pipeline is provenance-first already; structured event extraction + LLM classification rides the provider when a key exists — full engine remains open |
| 13 AI committee | **VERIFIED** (cap-only, audit-trailed, honest 503 without key) | 8 committee tests; live 503 check |
| 14 Two decisions | **VERIFIED** | snapshots carry both actions; live WAIT/HOLD split; user context never inferred |
| 15 Scan buckets | **VERIFIED** | live: 0 best entries banner + 4 buckets + 139 insufficient |
| 16 BHEL regression | **VERIFIED** | §2 above |
| 17 UI truth panel | **VERIFIED** | browser-checked truth panel, Why-not-Buy, unmet gates, footer caption |
| 18 Monitoring | **PARTIAL** | PredictionLog+verify+registry live; rolling-skill dashboards and auto-degradation beyond the gate's 14-day recency remain open |
| 19 Tests | **VERIFIED** (58 new decision-layer tests this phase; leakage/effective-samples/gate/veto/AI-schema/BHEL all covered) | 219 total |
| 20 Staged workflow | **VERIFIED** | FIRST audit → SECOND plan → THIRD T1-T4 incremental commits → FOURTH/FIFTH this report → SIXTH retention rule applied |

## 4. Threshold validation status (Rule 2's "do not hard-code without validation")

`POLICY_THRESHOLDS` v3 additions (minDataQuality 70, minForecastConfidence 60,
minEntryQuality 40, riskScoreVeto 80) are **PROVISIONAL and restrict-only**: with the
measured record showing no edge, every one of them only prevents BUYs that the edge gate
already prevents — they add explanation, not risk. **Loosening any threshold requires a
walk-forward experiment run recorded in `experiment_runs` and cited next to the
constant.** The registry is live and accumulating verified rows nightly (~150/day once
horizons mature); the 30d horizon reaches its first minimally-evaluable window
(≥10 distinct eval dates post-split) around mid-October 2026.

## 5. What did NOT change (deliberately)

Immutable forecast issuances and outcome grading; the transaction ledger; the session
calendar; horizon suitability; the Track Record's measured honesty; the heuristic engine
itself (now consumed as a labeled setup DESCRIPTION). The historical mirage snapshot and
all pre-v3 decisions remain in the database as append-only audit evidence.

## 6. Open items (tracked in docs/next-session.md)

Full regime classifier (S7); structured event engine (Rule 12); isotonic calibration once
data suffices (Rule 9); TS challenger models through the registry + Python-worker decision
(Rule 5, owner Q5); rolling-skill monitoring dashboards (Rule 18); adjusted-bars ingestion
for corporate actions (the dataQuality flag covers the risk meanwhile); Discover tables'
per-row gate chips (decisions currently published for followed/held instruments only).
