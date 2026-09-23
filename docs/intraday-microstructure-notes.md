# Intraday microstructure — what the literature says, what our data says, and what changes

**Why this document exists.** On 2026-09-23 the 1-minute forecaster graded
13,806 live forecasts and scored **46.5%** — about 8 standard errors *below*
a coin flip (SE ≈ 0.43% at that n). The 5-minute horizon scored 46.6% on
3,171. That is not noise; it is a systematic anti-signal, and a systematic
anti-signal is information about what the model has wrong. This note records
the mechanism (from the literature), the number that actually matters (cost),
and the concrete changes each finding forces. Same format as
`intraday-study-notes.md` and `tsp-study-notes.md`: source → finding → what
applies to *our* code.

Companion evidence: `docs/live-sessions/2026-09-23-intraday-scorecard-1127.json`
(the aggregate snapshot, captured before the in-memory data could be lost).

---

## 1. The mechanism: bid-ask bounce (Roll 1984)

**Source.** Roll (1984), summarised in
[Boston College WP 693, "On the Correlation Structure of Microstructure Noise"](http://fmwww.bc.edu/EC-P/wp693.pdf)
and [MQL5, "Microstructure Noise"](https://www.mql5.com/en/articles/22938);
stylised-facts confirmation in
[Revisiting Cont's Stylized Facts (arXiv 2311.07738)](https://arxiv.org/pdf/2311.07738).

**Finding.** Trades alternate between the bid and the ask. Even when the
efficient price is a perfect random walk, transaction-price returns therefore
show **negative first-lag autocorrelation** — a down-tick from ask→bid is
followed, more often than not, by an up-tick back. "Linear autocorrelations of
returns are insignificant, *except* for very small intraday timescales (≃20
minutes) for which microstructure effects come into play"; at 1 minute the
first-lag autocorrelation is negative and outside the white-noise band. In fast
markets the rebounce happens within one minute.

**What it means for our code.** `intradayForecast.ts` computes an EWMA of
1-minute close-to-close returns and projects it *forward* (`driftSign = +1`).
That is a **momentum** model applied at exactly the horizon where the dominant
effect is **mean reversion** induced by the spread. The 46.5% hit rate is the
fingerprint of having the sign backwards. This is not a tuning problem; it is
the wrong model class for the timescale.

## 2. But the bounce has no direction (arXiv 2606.29591)

**Source.** ["The Bounce Has No Direction: Sign, Magnitude, and the
Microstructure of Equity Return Predictability"](https://arxiv.org/pdf/2606.29591).

**Finding.** Bounce makes the **magnitude** of the next return predictable,
not its **sign**. "Direction-forecasting at minute horizons lacks predictive
power." The effect is strongest at 1 minute and "diminishes sharply beyond
5-minute horizons."

**What it means for our code — and the trap it closes.** The obvious "fix" to
a 46.5% model is to flip the sign and claim 53.5%. On the *same* data that is
arithmetically guaranteed and scientifically worthless: it fits the artifact.
And even if the flipped sign held out of sample, §3 shows why it could not be
monetised — you would be buying at the ask and selling at the bid, paying the
very spread whose bounce you were "predicting". Therefore:

- A mean-reversion challenger (`driftSign = -1`) is a *legitimate hypothesis*
  because Roll gives a prior reason to expect it — but it is registered in the
  learning journal **before** tomorrow's session and tested only on tomorrow's
  data (`learning_expectations`, resolve after 2026-09-24 close). It is never
  scored on the day that suggested it.
- The **null model** (`driftSign = 0`, P(up) ≡ 0.5, direction withheld) is a
  first-class challenger. If the incumbent loses to a coin, the coin is the
  better model and the honest display is "no directional call".
- What the literature says *is* predictable at this horizon — magnitude — is
  what our 80% band already encodes. Band **coverage** (is the realised return
  inside the band 80% of the time?) is the metric that should be headline for
  minute horizons, and it is not measured today. Added to the scorecard.

## 3. The number that actually matters: cost

**Source.** Our own schedule, `src/services/shortterm/costs.ts`
(`COST_SCHEDULE_INTRADAY_2024_10`: brokerage 0.03%/side capped ₹20, STT 0.025%
sell-side, exchange 0.00297%/side, SEBI 0.0001%/side, stamp 0.003% buy, GST
18% on brokerage+txn; slippage floor 0.10%). NSE tick ₹0.05; historical median
LOB spread 0.77% of price per
[NSE research paper 128](https://nsearchives.nseindia.com/content/research/comppaper128.pdf)
(older data — Nifty-50 names today are far tighter, often one tick).

**Finding, computed 2026-09-23:**

| Order value | Fees | Slippage (floor) | **Round trip** |
|---|---|---|---|
| ₹25k–50k | 0.106% | 0.100% | **20.6 bps** |
| ₹1 lakh | 0.082% | 0.100% | **18.2 bps** |
| ₹5 lakh | 0.045% | 0.100% | **14.5 bps** |

Against today's forecasts:

| Horizon | Predicted mean \|move\| | **Actual** mean \|move\| | Cost |
|---|---|---|---|
| 1 min | 0.29 bps | 5.79 bps | 14.5–20.6 bps |
| 5 min | 1.50 bps | 11.16 bps | 14.5–20.6 bps |

**The predicted 1-minute move is ~70× smaller than the cost of acting on it.
The *actual* realised 1-minute move is 3.5× smaller.** A perfect oracle —
100% direction accuracy — loses money at one minute. At five minutes the
realised move still fails to clear cost. Direction accuracy was never the
binding constraint on these horizons; cost was, and the scorecard did not say
so.

**What it means for our code.**
- Every persisted forecast records `round_trip_cost_pct` and `clears_cost`
  (migration `1789900000000-CreateIntradayLearning`). "Could this have netted
  anything" becomes answerable per row, forever.
- The entry/exit cards must show **NOT ACTIONABLE — expected move below
  cost** whenever `|expectedReturnPct| < roundTripCostPct`. On today's numbers
  that is every 1-minute card and every 5-minute card. Showing a target and a
  stop on a trade that cannot clear its own fees is the single most misleading
  thing the UI currently does, and it was built at the user's explicit
  direction with accuracy shown beside it — the cost gate is the missing half
  of that honesty.
- This is the same lesson `tsp-study-notes.md` §4 records from Seykota's
  *Skid and Trading Frequency* at a longer horizon: frequency multiplies cost;
  the shortest horizon is the one where cost dominates most completely.

## 4. Intraday seasonality on the NSE (the U-curve)

**Sources.**
[Do Intraday Volatility Patterns Follow a 'U' Curve? — Indian evidence (SSRN 2255391)](https://papers.ssrn.com/sol3/Delivery.cfm/SSRN_ID2255391_code551806.pdf?abstractid=2255391&mirid=1);
[Sampath & Gopalaswamy 2020, *Intraday Variability and Trading Volume: Evidence from NSE*](https://journals.sagepub.com/doi/abs/10.1177/0972652720930586);
[Intraday liquidity patterns in Indian stock market (Monash)](https://www.monash.edu/__data/assets/pdf_file/0008/925811/intraday_liquidity_patterns_in_indian_stock_market.pdf);
[Intraday timing and volatility in Indian markets, 2018–2025 1m/5m data](https://www.researchgate.net/publication/401078172_Intraday_Timing_and_Market_Volatility_in_Indian_Financial_Markets_An_Econometric_Approach).

**Finding.** NSE volatility, volume and trade count are U-shaped: elevated for
the first ~30 minutes after 09:15, lowest mid-session, rising again in the
last ~15 minutes before 15:30. Morning volatility is attributed to information
bunching (overnight news), closing volatility to private information and
position squaring.

**What it means for our code.**
- Our volatility estimate is a flat `stdev` over the last N bars. In the first
  30 minutes it is estimated from the *quietest* regime it will see all day
  (there are no prior bars), and at the close it is dragged by the calm
  midday. A time-of-day-aware volatility (session-bucketed, or a GARCH-family
  estimate) is the principled upgrade — but it is a *magnitude* upgrade,
  which is the part the literature says is learnable. Queued, not built:
  first prove the magnitude metric (band coverage) is even being measured.
- The chronological train/test split in the nightly calibration job must be
  understood in this light: the last 40% of a session includes the closing
  volatility spike, so a challenger that wins there has survived the hardest
  regime, not an easy one. Recorded in the job so it is not later
  "corrected" into a random split.
- Our own session monitor reproduced the curve on 2026-09-22: ~3,000 accepted
  ticks/min mid-session collapsing to ~150/min in the final 12 minutes, with
  most names going `STALE` from illiquidity — the pre-close thinning is real
  and visible in `docs/live-sessions/2026-09-22.jsonl`.

## 5. Order flow, not price history, is what moves minute-scale prices

**Sources.**
[Returns and Order Flow Imbalances (arXiv 2508.06788)](https://arxiv.org/html/2508.06788);
[OFI shock dynamics, CSI 300 futures (arXiv 2505.17388)](https://arxiv.org/pdf/2505.17388);
[Intraday Momentum and Return Predictability](https://www.diva-portal.org/smash/get/diva2:1878991/FULLTEXT01.pdf).

**Finding.** Over short intervals, price changes are driven mainly by
**order-flow imbalance** at the best bid/ask, with shocks that mean-revert
(Ornstein–Uhlenbeck-like) and dissipate within seconds. Past *prices* carry
little; the *book* carries the information, and predictive content
concentrates at specific frequencies.

**What it means for our code.** Our tick carries `bid` and `ask`
(`StreamingSecurityState.bid/ask`) and `quantity`. We use none of it in the
forecast. A microprice (`(bid×askSize + ask×bidSize)/(bidSize+askSize)`) or a
simple OFI feature is the only thing in this literature that predicts minute-
scale direction at all — and even then the paper in §2 says the edge is small
and the cost in §3 says it is unlikely to be monetisable for a retail account.
This is recorded as the *right* direction of research, explicitly deferred:
building it before the cost gate exists would be another confident number
with no economic content.

## 6. The base rate, restated with the source

**Source.** [SEBI press release 37/2024, "7 out of 10 individual intraday
traders in equity cash segment make losses"](https://www.sebi.gov.in/media-and-notifications/press-releases/jul-2024/sebi-study-finds-that-7-out-of-10-individual-intraday-traders-in-equity-cash-segment-make-losses_84948.html);
[Business Standard summary](https://www.business-standard.com/markets/news/7-in-10-intraday-traders-in-equity-cash-suffered-losses-in-fy23-sebi-study-124072400975_1.html);
F&O follow-up: [93% of individual F&O traders lost money FY22–FY24, aggregate
> ₹1.8 lakh crore](https://www.sebi.gov.in/media-and-notifications/press-releases/sep-2024/updated-sebi-study-reveals-93-of-individual-traders-incurred-losses-in-equity-fando-between-fy22-and-fy24-aggregate-losses-exceed-1-8-lakh-crores-over-three-years_86906.html).

**Finding.** FY23, sample = clients of the top-10 brokers (~86% of individual
equity-cash clients): 7 in 10 intraday traders lost money; loss-makers traded
*more* often than profit-makers; participation tripled FY19→FY23; under-30s
went from 18% to 48% of intraday traders. Earlier SEBI work: 71% overall,
rising to ~80% for >500 trades/year, with loss-makers paying a further ~57% of
their losses in costs.

**What it means for our code.** §3 is the mechanism behind this base rate,
measured on our own tape: at retail cost levels, minute-scale trading is a
negative-expectancy activity *before* any question of skill. The Live tab's
permanent SEBI block stays; it now has our own cost table beside it.

## 7. Operational lessons from the same three days (not microstructure, but they cost more data than the model did)

| # | What happened | What I first said | What was actually true | Change |
|---|---|---|---|---|
| 1 | Feed silent 09:48–17:25 on 09-21 (7.6 h) | — | Hung WebSocket, no `close`/`error`, no heartbeat | Watchdog + reconnect (`be541af`); recovered a real hang in ~90 s on 09-22 |
| 2 | 08:45 scan missed 09-21 | my hot-reloads detached timers | **Laptop asleep** — 2-second dark-wake at 08:45:06 | Auto catch-up of missed runs; `caffeinate` before every session |
| 3 | 08:45 scan missed 09-22 | long-armed node-cron timer bug | **Laptop asleep** — deep sleep from 01:03, dark-wake 08:43→08:52 | as above |
| 4 | Midnight cleanup missed 09-23 | "new unexplained failure mode" | **Laptop asleep** — clamshell at 23:59:43 | as above |
| 5 | Feed frozen 09:46–10:12 on 09-23 | — | Clamshell sleep; `caffeinate` had expired and I did not re-arm it | Operator checklist; catch-up job also covers it |
| 6 | 13,806 graded forecasts about to be lost | — | Never persisted; in memory only | `intraday_forecast_outcomes` table |
| 7 | Weekly Sat/Sun jobs never fired (2 weeks) | — | **Real** node-cron bug: `matchNext()` advances a year when weekday mismatches | Daily expression + `istWeekday()` guard (`7ac13ec`) |

Rows 2–4 are the important correction: I gave two different wrong diagnoses
for the same class of failure before checking the power log. The daily+guard
conversion those diagnoses produced is harmless and stays, but the *lesson*
had to be rewritten, and the two `cron_execution_logs` rows carrying the wrong
reason now carry a dated second correction naming sleep. A laptop is not a
server: a scheduled job's instant is lost forever if the OS is suspended
through it, and node-cron will never tell you. The engineering answer is a
catch-up loop that compares expected runs against `cron_execution_logs` and
runs whatever is missing, logged as `(auto catch-up)`.

---

## 8. What changes, in order

1. **Persist** every graded intraday forecast with its cost (`1789900000000`).
2. **Cost gate on the UI**: `NOT ACTIONABLE` whenever `|expected| < cost`.
3. **Band coverage** on the scorecard — the magnitude metric the literature
   says is the learnable one.
4. **Nightly challenger evaluation** (`intradayCalibrationRun.ts`): incumbent
   vs `{sign:-1}`, `{sign:0}`, shrinkage `{0.5, 1.0}`, on a chronological
   60/40 split of the day, promotion only if hold-out hit rate > 50% AND beats
   incumbent by ≥ 1.5 pp on n ≥ 500 AND Brier improves. Pre-registered here.
5. **Missed-run catch-up** for cron, so sleep can never again silently lose a
   scheduled job.
6. Queued, not built: time-of-day volatility; microprice/OFI features.

*Written 2026-09-23 during the live session, from the session's own numbers.
Educational tool — not SEBI-registered investment advice.*
