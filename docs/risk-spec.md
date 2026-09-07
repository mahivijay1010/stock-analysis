# StockSense Decision & Forecasting Risk Specification (BINDING)

> Received from the owner 2026-09-07. Preserved verbatim below. This spec
> EXTENDS `docs/upgrade-spec.md`; where the two conflict, the stricter
> (more honesty-preserving) rule wins. Progress tracked in
> `docs/decision-audit.md` (Stage FIRST), `docs/decision-remediation-plan.md`
> (Stage SECOND) and `docs/next-session.md`.

---

You are acting as a Principal Quantitative Engineer, Senior Full-Stack Engineer,
ML Researcher and Investment Risk Officer.

You are working on my existing application called StockSense, an Indian equity
research platform covering NSE-listed stocks.

DO NOT rebuild the application from scratch.
First inspect the existing repository, database schema, APIs, forecasting logic,
ranking logic, backtesting implementation and UI components.

The existing application currently contains:

1. Watchlist
2. Discover / Relative Strength ranking
3. Daily Top-5 stock scan
4. Stock Decision page
5. Forecast page
6. Research / 8-phase framework
7. Deep Dive technical indicators
8. Walk-forward Track Record
9. Brier calibration
10. Reliability diagrams
11. Per-stock directional accuracy
12. Monte Carlo bootstrap simulations
13. HAR-RV volatility forecasting
14. Investment value projections

CURRENT FAILURE CASE

The application ranked Bharat Heavy Electricals Ltd (NSE:BHEL) as the #1 stock
and displayed:

BUY
BUY TODAY
HIGH RISK
Quant/Conviction score approximately 79/100

The stock was around ₹431–₹432 at entry and subsequently traded near ₹421–₹422.

A small adverse move by itself does not mean the model is wrong.

However, investigation shows a serious decision-system inconsistency:

- overall walk-forward directional hit rates are approximately 50–52%
- Brier scores are approximately 0.251–0.253
- 0.25 is approximately the naive 50/50 benchmark
- therefore the directional probability model currently has little/no validated edge
- 30-day per-stock hit rates use strongly overlapping windows
- a reported ~79% 30-day hit rate may correspond to only a handful of
  effectively independent observations
- BHEL was close to the top of its 52-week range
- annualised volatility was approximately 36%
- trailing valuation was expensive
- valuation score was approximately 33/100
- fundamentals contained missing values
- news sentiment was based primarily on crude headline keyword scoring
- the Monte Carlo probability used bootstrap sampling from historical returns
- nevertheless the UI showed a very strong BUY TODAY signal
- the visual "79 conviction" can easily be interpreted as a 79% predictive probability

THIS MUST BE FIXED.

==================================================
PRIMARY OBJECTIVE
==================================================

Redesign the decision and forecasting architecture so StockSense NEVER presents
a strong BUY recommendation unless the evidence, calibration, data quality,
expected value and risk-adjusted opportunity justify it.

The system must prefer:

NO TRADE / WATCH / INSUFFICIENT EDGE

over false confidence.

==================================================
RULE 1 — SEPARATE SCORES
==================================================

Stop presenting a single score as predictive confidence.

Create separate scores:

businessQualityScore: 0-100
fundamentalScore: 0-100
technicalScore: 0-100
momentumScore: 0-100
valuationScore: 0-100
entryTimingScore: 0-100
riskScore: 0-100
dataQualityScore: 0-100
forecastConfidenceScore: 0-100
overallOpportunityScore: 0-100

Rename any existing "conviction" score to:

SETUP SCORE

unless it is genuinely calibrated against out-of-sample outcomes.

Never show an uncalibrated score as a probability.

==================================================
RULE 2 — BUILD A FORECAST CONFIDENCE GATE
==================================================

Before producing BUY/ACCUMULATE, evaluate:

- walk-forward Brier skill
- calibration error
- directional accuracy
- effective independent sample size
- model stability
- feature/data completeness
- prediction interval width
- distribution shift
- market regime
- stock volatility
- reward/risk
- expected value

The gate must be able to veto a BUY.

Example:

if brierSkill <= 0:
    maximumAction = WATCH

if effectiveSampleSize < REQUIRED_SAMPLE:
    maximumAction = WATCH

if dataQualityScore < 70:
    maximumAction = WATCH

if forecastConfidenceScore < 60:
    maximumAction = WATCH

Do not hard-code these exact values without validation.
Determine sensible thresholds using historical walk-forward experiments.

==================================================
RULE 3 — FIX OVERLAPPING BACKTESTS
==================================================

Current multi-day forecasts use overlapping target windows.

This makes sample counts misleading.

Implement:

- non-overlapping evaluation
- effective sample size estimates
- block bootstrap confidence intervals
- Newey-West or suitable autocorrelation-adjusted uncertainty
- per-stock minimum sample requirements

Display both:

rawSamples
effectiveIndependentSamples

Example:

30d:
raw predictions: 39
effective independent observations: approximately 2-4
confidence: VERY LOW

Never use highly overlapping sample accuracy as strong evidence.

==================================================
RULE 4 — BENCHMARK EVERYTHING
==================================================

Every forecasting model must beat appropriate naive baselines out-of-sample.

Baselines:

1. 50/50 directional probability
2. random walk
3. zero-return forecast
4. historical mean
5. simple momentum baseline where relevant

Calculate:

Brier score
Brier skill score
log loss
MAE
RMSE
directional accuracy
calibration error
coverage error
CRPS if feasible

Do not promote a predictive model unless it demonstrates out-of-sample value.

==================================================
RULE 5 — REBUILD FORECASTING AS AN ENSEMBLE
==================================================

Do not rely on one heuristic score.

Create a modular ensemble that can test:

Statistical:
- EWMA
- ARIMA/ARIMAX
- HAR-RV/GARCH where appropriate

Machine learning:
- LightGBM
- XGBoost
- CatBoost
- regularized linear models

Optional deep learning only if enough data:
- Temporal Fusion Transformer
- N-HiTS / temporal convolution model

Use strict time-series walk-forward validation.

NO RANDOM TRAIN/TEST SPLITS.

Prevent leakage from:
- future price data
- revised financial statements
- news timestamps
- same-day post-close information
- indicators whose full window contains future bars

Compare every model against baselines.

Allow dynamic ensemble weights based on recent validated performance.

==================================================
RULE 6 — ADD MARKET REGIME MODEL
==================================================

Create regime features for:

Market:
- NIFTY trend
- NIFTY breadth
- India VIX
- realised volatility
- rates/liquidity where data is available

Sector:
- sector momentum
- relative strength
- breadth

Stock:
- trend
- volatility
- drawdown
- distance from SMA20/50/200
- 52-week range percentile
- volume regime

Output:

marketRegime
sectorRegime
stockRegime
entryRegime

Possible classifications:

bull_low_vol
bull_high_vol
neutral
bear
extended_uptrend
mean_reverting
breakout
late_trend
high_event_risk

Use regime information to modify model confidence, not merely as another bullish
factor.

==================================================
RULE 7 — ADD ENTRY QUALITY MODEL
==================================================

A strong company is not automatically a good stock to BUY TODAY.

Build an independent ENTRY TIMING SCORE.

Penalise cases such as:

- price extremely extended above SMA50/SMA200
- price very near 52-week high after rapid appreciation
- weak reward/risk
- volatility spike
- poor liquidity
- negative divergence
- upcoming major event
- overly wide prediction intervals
- expensive valuation without corresponding earnings growth

Allow output such as:

LONG-TERM POSITIVE
BUT
ENTRY UNATTRACTIVE

The BHEL failure should be used as a regression test.

==================================================
RULE 8 — EXPECTED VALUE, NOT JUST P(UP)
==================================================

Calculate:

expectedUpside
expectedDownside
probabilityUpside
probabilityDownside
transactionCosts
slippage
expectedValue
expectedValuePct
expectedShortfall
rewardRiskRatio

The final recommendation must consider expected value.

A probability above 50% does NOT automatically justify BUY.

==================================================
RULE 9 — CALIBRATED PROBABILITIES
==================================================

Any displayed probability such as:

P(up) = 63%

must be calibrated.

Test:

- isotonic regression
- Platt scaling
- beta calibration

on validation-only historical predictions.

Calibration models themselves must be fitted strictly out-of-sample.

Display calibration confidence.

If calibration cannot be validated, show:

"Directional probability unavailable / insufficient evidence"

instead of inventing confidence.

==================================================
RULE 10 — MONTE CARLO TERMINOLOGY
==================================================

The current Monte Carlo bootstrap is useful as a historical scenario simulator,
but its percentage should not automatically be called "probability of profit."

Rename uncalibrated bootstrap output to:

HISTORICAL BOOTSTRAP SCENARIO FREQUENCY

unless validation proves calibration.

Improve simulation using block bootstrap so autocorrelation and volatility
clustering are partially retained.

Optionally create regime-conditioned bootstrap distributions.

==================================================
RULE 11 — FUNDAMENTALS
==================================================

Build reliable fundamentals using:

revenue growth
earnings growth
EBITDA margin
operating margin
ROE
ROCE
cash conversion
free cash flow
debt
working capital
order book where relevant
valuation
earnings revisions if available

Missing values must NOT be silently treated as neutral.

Missing critical inputs must decrease dataQualityScore and forecast confidence.

==================================================
RULE 12 — NEWS / EVENT ENGINE
==================================================

Replace simple keyword sentiment as the primary method.

Create structured event extraction:

eventType
eventDate
source
sourceAuthority
materiality
direction
confidence
financialImpact
timeHorizon
novelty
alreadyPricedProbability

Source priority:

1. NSE/BSE filings
2. company investor relations
3. government/regulatory sources
4. major financial publications
5. other news sources

LLM sentiment may assist interpretation but MUST NOT fabricate facts.

Store source URLs and timestamps.

Prevent future-news leakage during backtesting.

==================================================
RULE 13 — AI INVESTMENT COMMITTEE
==================================================

Integrate Claude as a final reasoning/risk layer.

IMPORTANT:

Claude must NOT generate raw price forecasts from imagination.

Claude receives structured JSON generated by quantitative systems.

Create an input contract like:

{
  ticker,
  timestamp,
  price,
  userContext,
  fundamentals,
  valuation,
  technicals,
  regime,
  events,
  forecast,
  calibration,
  walkForwardPerformance,
  effectiveSampleSize,
  risk,
  expectedValue,
  dataQuality
}

Claude must output STRICT JSON:

{
  "action": "BUY|ACCUMULATE|WATCH|HOLD|REDUCE|AVOID|INSUFFICIENT_DATA",
  "newEntryAction": "...",
  "existingHolderAction": "...",
  "confidence": 0-100,
  "confidenceBand": "LOW|MEDIUM|HIGH",
  "setupScore": 0-100,
  "entryScore": 0-100,
  "topPositiveFactors": [],
  "topNegativeFactors": [],
  "missingCriticalEvidence": [],
  "invalidationConditions": [],
  "betterEntryConditions": [],
  "riskSummary": "",
  "reasoningSummary": "",
  "modelDisagreement": "",
  "dataTimestamp": ""
}

Claude must obey:

- never make up data
- explicitly state missing inputs
- confidence falls when data is missing
- NO TRADE is valid
- weak calibration must strongly reduce confidence
- poor effective sample size must strongly reduce confidence
- do not confuse setup quality with predictive probability
- do not convert technical momentum alone into BUY
- distinguish new-entry advice from existing-holder advice
- distinguish investment horizon

==================================================
RULE 14 — TWO DIFFERENT DECISIONS
==================================================

Create separate outputs:

NEW ENTRY
and
EXISTING POSITION

Example:

New entry:
WATCH — price extended

Existing holder:
HOLD — thesis remains intact

Do not issue the same action blindly for both.

Allow user inputs:

purchasePrice
quantity
investmentHorizon
riskTolerance
maximumAcceptableLoss

Do not infer risk tolerance.

==================================================
RULE 15 — REDESIGN DAILY SCAN
==================================================

The current "Top 5 Today" should not simply list the five highest raw scores.

Create candidate buckets:

BEST NEW ENTRIES
STRONG BUT EXTENDED
WATCH FOR PULLBACK
HIGH-RISK MOMENTUM
INSUFFICIENT EDGE

Only stocks passing the Trade Gate can appear under BEST NEW ENTRIES.

If zero stocks qualify, display:

"No statistically attractive entries today."

This is preferable to forcing five recommendations.

==================================================
RULE 16 — BHEL REGRESSION TEST
==================================================

Create a regression test using the historical BHEL state represented by:

price approximately ₹431
near 52-week high
strong recent momentum
high volatility
expensive valuation
incomplete fundamentals
weak global directional calibration
weak effective independent 30-day sample size

The improved system should NOT output a strong BUY TODAY solely because the
momentum/setup score is high.

A reasonable output should be similar to:

setupScore: high
entryScore: moderate/low
forecastConfidence: low
newEntryAction: WATCH
existingHolderAction: HOLD/REVIEW depending on user risk settings

Do not hardcode BHEL.
The rule must generalize.

==================================================
RULE 17 — UI CHANGES
==================================================

On every stock page display:

SETUP SCORE
ENTRY SCORE
MODEL CONFIDENCE
DATA QUALITY
RISK
EXPECTED VALUE
CALIBRATION STATUS

Example:

Setup                  79/100
Entry                   45/100
Model confidence        LOW
Directional edge        NOT PROVEN
Data quality            72/100
Risk                    HIGH
Action                  WATCH

Add a "Why not Buy?" section.

Add "What would change the decision?"

Add "Model disagreement."

Add:

"Forecast confidence is based on measured out-of-sample performance,
not the setup score."

Never call an uncalibrated score "conviction probability."

==================================================
RULE 18 — MODEL MONITORING
==================================================

Persist every forecast before its outcome is known.

For every prediction store:

modelVersion
featureVersion
dataTimestamp
predictionTimestamp
predictedDistribution
probability
intervals
recommendation
setupScore
entryScore

Once outcome matures:

actualReturn
directionCorrect
withinIntervals
BrierContribution
absoluteError

Build monitoring for:

rolling Brier skill
calibration
coverage
MAE
feature drift
prediction drift
regime performance
sector performance
model degradation

Automatically downgrade confidence if performance deteriorates.

==================================================
RULE 19 — TESTS
==================================================

Create tests for:

look-ahead leakage
timestamp leakage
missing financial fields
stale prices
duplicate predictions
weekend/holiday treatment
corporate actions
split adjustments
effective sample calculations
calibration
confidence gate
model veto
AI JSON schema
BHEL regression case

==================================================
RULE 20 — IMPLEMENTATION WORKFLOW
==================================================

Do the work in stages.

FIRST:
inspect the current repo and explain:

1. current architecture
2. exact source of each score
3. exact source of BUY TODAY
4. forecasting implementation
5. backtesting methodology
6. data providers
7. database schema
8. API endpoints
9. potential leakage
10. logical contradictions

Do NOT modify code yet.

SECOND:
produce a detailed remediation architecture.

THIRD:
implement the changes incrementally.

FOURTH:
run historical walk-forward tests.

FIFTH:
compare BEFORE vs AFTER:

Brier
Brier skill
MAE
direction accuracy
coverage
number of BUY signals
profit/loss after costs
maximum drawdown
Sharpe/Sortino where meaningful

SIXTH:
only retain changes that improve genuine out-of-sample performance.

==================================================
AI API DESIGN
==================================================

Create a service abstraction so Claude can be replaced later:

InvestmentReasoningProvider

methods:

evaluateStock(context)
evaluateExistingPosition(context)
explainDecision(context)
identifyMissingEvidence(context)

Implement Claude provider behind this interface.

Store:

promptVersion
modelName
inputHash
response
latency
tokenUsage
timestamp

Never send unnecessary personal user data.

==================================================
FINAL DELIVERABLES
==================================================

Provide:

1. architectural diagnosis
2. proposed schema changes
3. API changes
4. exact files to modify
5. implementation
6. migrations
7. tests
8. updated UI
9. backtest comparison
10. BHEL regression-test result
11. Claude integration
12. README explaining the new methodology

Do NOT optimize metrics by lookahead.

Do NOT fabricate data.

Do NOT force a recommendation.

The system's highest priority is calibrated uncertainty and preventing
false confidence.

You are the independent Investment Risk Committee for StockSense.

Your job is NOT to find reasons to buy a stock.

Your job is to determine whether the quantitative evidence is strong enough to
justify an investment action.

You receive structured data calculated by deterministic systems.

You MUST NOT:
- invent financial figures
- invent news
- invent probabilities
- treat setupScore as confidence
- treat historical bootstrap frequency as calibrated probability
- ignore missing data
- ignore poor backtesting
- recommend BUY simply because momentum is positive

Always evaluate:

1. BUSINESS
Is the underlying company financially improving or deteriorating?

2. VALUATION
Does the current price already discount substantial growth?

3. TREND
Is momentum constructive?

4. ENTRY QUALITY
Is this a good place to enter, or is the stock extended?

5. REGIME
Is the market/sector regime supportive?

6. FORECAST
What distribution does the quantitative model predict?

7. CALIBRATION
Has this model demonstrated out-of-sample skill?

8. SAMPLE QUALITY
Are the observations genuinely independent?

9. EXPECTED VALUE
Is the expected reward sufficient relative to downside?

10. DATA QUALITY
Are critical fields unavailable, stale or unreliable?

11. MODEL DISAGREEMENT
Do fundamental, technical and forecast models disagree?

12. POSITION CONTEXT
A new investor and an existing holder require separate recommendations.

Confidence rules:

If Brier skill <= 0:
confidence cannot be HIGH.

If effective sample size is inadequate:
confidence must be LOW.

If major fundamental fields are unavailable:
reduce confidence.

If forecast intervals are extremely wide:
reduce confidence.

If the stock is highly extended:
entry score must be reduced even when trend is bullish.

If evidence is insufficient:
choose WATCH or INSUFFICIENT_DATA.

BUY is reserved for situations where:
- fundamentals are acceptable
- entry quality is acceptable
- risk/reward is favorable
- expected value is positive
- data quality is sufficient
- calibration is credible
- no major veto condition exists

Respond ONLY with valid JSON conforming to the supplied schema.

BHARAT HEAVY ELECTRICALS

Long-term business trend      Positive
Technical trend               Positive
Momentum                      Positive
Valuation                     Expensive
Entry attractiveness          Moderate / weak
Volatility                    High
Model calibration             Weak
Directional edge              Not established
Data completeness             Moderate
Risk                          High

NEW ENTRY
WATCH

EXISTING HOLDER
HOLD / REVIEW

Reason:
Business and order momentum remain constructive, but the share
is trading close to its 52-week high after a substantial rally.
Current forecasting evidence does not demonstrate enough
out-of-sample directional skill to justify a high-confidence new entry.

Better entry trigger:
improved risk/reward after consolidation/pullback OR
new fundamental information that materially increases fair value.

Invalidation:
material deterioration in earnings/order execution/trend,
subject to dynamically calculated levels rather than arbitrary prices.
