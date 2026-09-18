# Intraday study notes — Varsity, SEBI, NSE → rules the system must encode

**Purpose.** Before building any intraday surface, learn the doctrine from the
official/free sources the owner named, then map every concrete rule to where
this codebase already encodes it, where it diverges, and what an intraday tab
would have to enforce. Written 2026-09-18 on `feature/continuous-learning`.

**What was actually read (not just cited).** Zerodha Varsity Module 2
(Technical Analysis, 177-page PDF, chapters 3, 8, 10, 11, 12, 14, 15, 18, 19
in full) and Module 9 (Risk Management & Trading Psychology, 131-page PDF,
chapters 11–16 in full), both pulled from Zerodha's own S3 mirror because the
website rate-limits scripted reads (HTTP 429). SEBI's July-2024 intraday study
via its press-release reproduction. SEBI investor do's/don'ts via search.
**Not reachable:** `nseindia.com/learn` (404; `nseindia.com` APIs are
Akamai-blocked from this environment per `ARCHITECTURE.md`), and Varsity's
newer web-only chapter 22 (Central Pivot Range — not in the PDF). NSE Academy
material is therefore not covered here and should be read by a person.

---

## 1. What the sources say — the rules, verbatim where it matters

### 1.1 Varsity TA — the first rule is *don't day-trade yet*

> "If you are starting out fresh or if you are not a seasoned trader I would
> suggest you avoid day trading. Start with trades with an intention to hold
> the trade for a few days." (ch. 19.2)

> "As a thumb rule, the higher the timeframe, the more reliable the trading
> signal is." (19.2) · "an intraday trader executing 1 or 2 trades per day is
> better off looking at end of day (EOD) or at best 15 mins charts." (3.5) ·
> Key takeaway: "Choose EOD chart for both day trading and swing trading." (19)

> Scalping is "for a seasoned swing trader", uses 1–5 minute charts, and
> "Containing transaction charges is one of the keys to successful scalping."
> (19.5)

**Look-back:** swing 6–12 months; scalper "last 5 days"; S&R levels always
≥ 2 years (19.3).

### 1.2 Varsity TA — the Grand Checklist (ch. 18.6), the spine of everything

1. Recognisable candlestick pattern.
2. S&R confirms: "The stoploss price should be around S&R" — long: pattern
   low ≈ support; short: pattern high ≈ resistance. S&R is drawn through
   **≥ 3 price-action zones, well spaced in time** (11.4). Scout rule: "If the
   S&R level is more than 4% away from the stoploss, I stop evaluating the
   chart" (19.5).
3. Volumes confirm: "above average volumes on both buy and sell day"; "Avoid
   trading on low volume days" (12.3). Reference: **today's volume vs the
   last-10-day average** (12.1).
4. Dow Theory: primary/secondary trend; double/triple tops; range/flag
   formations. "if we are in the secondary trend (which is counter to the
   primary) then you may want to think twice."
5. Indicators confirm — **with a twist**: "Scale the trade size higher if
   indicators confirm… If the indicators do not confirm go ahead with the
   original plan." Indicators size the bet; they never veto it (15.4). But
   items 1–3 *do* veto: "if the low of the bullish hammer does not coincide in
   and around the support… I may skip the opportunity."
6. RRR satisfactory: "for every Rs.1/- you risk… at least Rs.1.3/- or higher,
   otherwise it is simply not a worth the risk"; "For an active trader, I would
   suggest a RRR of at least 1.5"; beginners "as high as possible" (18.5–18.6).
   A trade that ticks every other box but has RRR ≈ 1.0 is **dropped** (18.5
   worked example).

Volume table (12.1): price↑ vol↑ = bullish · price↑ vol↓ = "caution – weak
hands buying" (possible bull trap) · price↓ vol↑ = bearish · price↓ vol↓ =
"caution – weak hands selling".

RSI (14.1–14.2): 30/70 are Wilder's 1978 defaults, "not set in stone"; in a
strong trend RSI pins in overbought/oversold and the naive contrarian read is
wrong — "If the RSI is fixed in an overbought region for a prolonged period,
look for buying opportunities instead of shorting." "RSI is not used often as
a standalone indicator." Bollinger: "In a trending market the BB's envelope
expands, and generates many false signals."

S&R reliability (11.4): "only indicative of a possible reversal… by no means
should be taken for as certain… What is the guarantee that the sellers would
come in at 214? Honestly, your guess is as good as mine."

Entry/stop convention (10.4): risk-taker enters at the pattern's close
(~15:20); risk-averse waits for next-day confirmation. Stop = lowest low of
the pattern (long) / highest high (short). Entry-quality rule (8.7): a
weaker pattern with **more checklist points beats a stronger pattern with
fewer**.

The Scout (19.5): universe **Nifty 50** (liquidity: bid-ask spread, or
"volume per day is at least 500000"; EQ segment; not operator-driven). Skim
all 50 charts, attention on the last 3–4 candles → 4–5 shortlisted → 15–20
min each → "at the most 1 or 2 may qualify… **There are days when there are
no trading opportunities. Deciding not to trade in itself is a big trading
decision.**" Once in: "do nothing till either your target is achieved or
stoploss is triggered" (trailing the stop is allowed).

Scalper guidelines (19.5): only 1–2 checklist items realistically apply —
"candlestick pattern and volume"; "A risk reward ratio of even 0.5 to 0.75 is
acceptable"; liquid stocks only; "be really quick to book a loss"; watch the
bid-ask spread and global markets; low-cost broker; "do not over leverage";
"If you sense the day is going wrong, stop trading and move away from your
terminal."

### 1.3 Varsity Risk Management — sizing is the whole game

**Gambler's fallacy** (11.2): after 6 straight stops, "the odds of making a
loss on the 7th trade is as high (or low) as it was when you placed your first
bet." Antidote: position sizing. **Recovery trauma** (11.3): lose 5% → need
+5.3%; lose 10% → +11.1%; lose 60% → +150%. "never risk too much on any one
trade, especially if you have a small capital."

**Equity estimation** (12.2, Van Tharp): core equity (subtract deployed
capital), total equity (adds open P&L — "counting the chicken before they
hatch"), **reduced total equity** (subtract deployed capital, add back only
*locked-in* profit behind a trailing stop) — the author's preference, because
it "forces you to practice basic stop loss principles."

**Sizing methods** (13.2–13.4, 14.1):
- Unit per fixed amount — simple, ignores risk, "limits the scalability".
- Percentage margin — "far more structured… especially for intraday traders";
  same margin per position but volatility differs.
- **Percentage volatility** — cap the *daily ATR-driven fluctuation* of each
  position at X% of equity: shares = (X% × equity) / ATR. Worked: 2% × ₹5L =
  ₹10,000 / ATR ₹76 → 131 shares. Portfolio-level: "if every position goes
  against you… If your stomach churns, then 15% portfolio volatility maybe a
  bit high for you."
- **Percentage risk** — the professional default: "professional traders do not
  risk more than **1 to 3%** of their capital on any single trade"; worked
  example uses 1.5%; lots = (risk% × equity) / (stop distance × lot size);
  after each fill, re-base the next trade's risk on the *reduced* equity.

**Kelly** (14.2): Kelly% = W − (1−W)/R. Raw Kelly is dangerous ("there is
still a 30% chance to lose 70% of your capital"); the author's modification:
fix a hard ceiling (e.g. 5%) and expose **Kelly% × ceiling** — Kelly scales
conviction *within* the ceiling, never above it.

**Biases** (15–16): illusion of control ("More data does not necessarily mean
quality of information"), recency, anchoring/focalism, functional fixedness,
confirmation bias, attribution bias ("traders attribute losses to problems in
the outside world and not really because of subpar analysis… overcome by
maintaining a trading journal").

### 1.4 SEBI — the base rate for intraday, FY2022-23

Sample: individual clients of the top-10 brokers (~86% of cash-segment
clients); FY19, FY22, FY23.

| Finding | Number |
|---|---|
| Loss-makers, all individual intraday traders | 65% (FY19) → 69% (FY22) → **71% (FY23)** |
| Loss-makers, > 500 trades/year | **80%** |
| Loss-makers, age < 30 | **76%** (share of participants 18% → 48%) |
| Loss-makers, trade size < ₹5k | 79% |
| Loss-makers, turnover > ₹1 cr | 76% |
| Avg loss-maker / avg profit-maker, all | ₹−5,371 / ₹+5,989 |
| Turnover > ₹1 cr: avg P/L; profit-makers; loss-makers | ₹−34,977; ₹+89,172; ₹−74,575 |
| Trading costs as % of loss (loss-makers) | **57% over and above the loss**; 72% for >500-trade traders |
| Trading costs as % of profit (profit-makers) | 19% |
| Participants | 15 lakh (FY19) → 69 lakh (FY23), 4.6× |

Costs are the dominant, controllable variable: frequency is the strongest
predictor of losing, and losers pay proportionally three times more in costs
than winners. SEBI investor do's/don'ts: deal only with registered
intermediaries; "Don't fall for the promise of indicative or exorbitant or
assured returns"; broker leverage is capped at 5× and "can increase both
potential gains and losses."

### 1.5 Costs — the number that actually differs intraday

The codebase's `COST_SCHEDULE_2024_10` is the **delivery** schedule
(STT 0.1% buy + 0.1% sell, brokerage 0, DP ₹15.93 per sell). Intraday equity
is a *different* schedule: STT **0.025% on the sell side only**, no DP charge,
but discount brokerage of **₹20 or 0.03% per executed order, whichever is
lower** (Zerodha's published schedule). Net: lower per-trip percentage than
delivery on large tickets, but a flat ₹40 round trip that dominates small
tickets — exactly SEBI's "<₹5k trade size → 79% lose" finding.

---

## 2. Doctrine vs this codebase — where each rule lives today

Legend: **✅ aligned** · **≈ partial** · **❌ gap**

| Rule (source) | Where the code encodes it | Status |
|---|---|---|
| Beginners avoid day trading; EOD bars even for day trades (TA 19.2) | Entire short-term stack runs on **completed daily bars only**; `LiveMarketDataProvider`: quotes are "display/monitoring only"; no intraday interval fetched anywhere | ✅ — the system *is* Varsity's beginner path |
| Nifty-50-class liquid universe; ≥5 lakh shares/day (TA 19.4) | `nseUniverse.ts` (151 liquid names); `SIZING_LIMITS.maxParticipationPctOfAdv = 2` of 20d ADV; `minAdvInr` filter | ✅ |
| Checklist 1 — recognisable candlestick pattern | `setups.ts` classifies *structural* setups (pullback/VCP/breakout/momentum/mean-reversion) from SMA/ATR/RSI features, not candlestick patterns | ≈ different vocabulary, same role |
| Checklist 2 — stop ≈ S&R; skip if S&R >4% from stop (TA 11.4, 19.5) | `entryExit.ts`: stop = swing support − 0.25/0.75 ATR (structure-first); `plausibility.ts` now also fails `stopStructural` when the stop is > 4% (`MAX_STOP_TO_SUPPORT_PCT`) from the nearest support, which `tiers.ts` caps at tier B | ✅ **encoded 2026-09-18** |
| S&R needs ≥3 well-spaced touches, 2-year lookback (TA 11) | `features.ts` supportDistPct from swing structure; lookback is the 5y/2y bar window | ≈ touch-count not enforced |
| Checklist 3 — volume ≥ 10-day avg both days; avoid low-volume days (TA 12) | `features.ts relVolume` = today / **20-day** avg; breakout requires ≥1.3×; <0.7× = "weak participation" *penalty* | ≈ window 20d vs 10d; low volume is a score penalty, not a hard skip |
| Checklist 4 — trade with the primary trend (TA 18.6) | `setups.ts uptrend` (price > SMA50 > SMA200); `regimeEngine.ts` market/stock regime, cap-only | ✅ |
| Checklist 5 — indicators size the bet, never veto (TA 15.4) | RSI/ADX are **hard conditions** inside several setups (e.g. RSI 35–60 for pullback, ADX > 25 for momentum) | ≈ stricter than doctrine (conservative direction) — acceptable, but note it inverts Varsity's "twist" |
| Checklist 6 — **RRR ≥ 1.5 or drop the trade** (TA 18.5) | Correction to the first draft of these notes: a hard gate *did* exist — `ranking.ts GATE_THRESHOLDS.minRewardRisk1`, at **1.2**, below both Varsity's 1.3 floor and its 1.5 active-trader minimum. Now **1.5**. Stops were *not* tightened and T1 was *not* stretched (the file's own rule); consequence: pullback/momentum geometry (1.5-ATR stop vs 1.5-ATR T1 ⇒ RRR≈1.0) is excluded unless structure gives a closer stop — which is the doctrine | ✅ **gate raised 2026-09-18** |
| "Deciding not to trade is a decision" (TA 19.5) | Scan returns UP TO 5, zero forced picks; live verdict on 2026-09-17: 0/12 cells usable | ✅ |
| "Do nothing till target or stop" (TA 19.5) | State machine + shadow ledger resolves on completed bars; no discretionary exits | ✅ |
| Risk per trade 1–3% (RM 14.1) | Correction: a default *does* exist — `types.ts DEFAULT_SCAN_PARAMS.riskPerTradePct = 0.5%`, *below* the professional range (conservative, kept). The controller ceiling was 5%; now **3%** | ✅ **ceiling lowered 2026-09-18** |
| Per-share loss includes costs + gap (RM 13.4 spirit) | `sizing.ts`: riskPerShare + cost/slippage + `GAP_BUFFER_ATR 0.2` | ✅ stricter than Varsity |
| Percentage-volatility sizing (RM 13.4) | Only the gap buffer uses ATR; no ATR-fluctuation cap as an alternative sizing method | ≈ |
| Reduced-total-equity: re-base risk after each fill (RM 12.2) | `RISK_LIMITS.maxOpenRiskPctOfBudget = 2.0` (sum of open loss-at-stop), `maxOpenPositions = 5`, sector ≤ 50% | ✅ equivalent discipline |
| Stop when the day/week goes wrong (TA 19.5, RM 11.3) | `RISK_LIMITS`: daily loss 1.5%, weekly 3.0% → entries disabled | ✅ |
| Recovery trauma / drawdown halt (RM 11.3) | `drawdownKillSwitchPct = 6.0`; `ScanService` now feeds it from the real paper equity curve via pure `computeEquityDrawdownPct(budget, dailyRealizedPnl)` (current equity vs running peak). No closed trades ⇒ 0%, never fabricated | ✅ **live 2026-09-18** (closes review §5.4) |
| Kelly capped, never raw (RM 14.2) | Admin desk: half-Kelly, f* clamp 0.25, b precedence measured > DCF > structural | ✅ same philosophy |
| Gambler's fallacy — odds don't change after a streak | Deterministic sizing from budget × risk%, never from recent P&L | ✅ |
| Journal to defeat attribution bias (RM 16.4) | `PredictionLog`, shadow ledger, `PaperTrade.entry_context`, immutable via DB triggers | ✅ better than a journal |
| Confirmation-bias guard | Fail-closed gates; AI cap-only; BH-FDR; out-of-sample study | ✅ |
| Intraday cost schedule (STT 0.025% sell-only; ₹20/order) | `costs.ts COST_SCHEDULE_INTRADAY_2024_10`, selectable via `activeCostSchedule("INTRADAY_EQUITY")`; brokerage = min(₹20, 0.03%) per side, so the flat ₹40 round trip dominates small tickets (≈0.106% on ₹4k vs ≈0.036% on ₹1 cr) — SEBI's <₹5k finding, in numbers. Delivery schedule untouched | ✅ **added 2026-09-18** — not yet consumed by any plan (no intraday surface exists) |
| SEBI base-rate disclosure on any intraday surface | Not present (no intraday surface exists) | ❌ |
| No leverage by default (SEBI 5× cap) | Sizing is cash-only; no margin modeled | ✅ (keep it that way) |

**Reading of the table.** The system already *is* the disciplined swing
trader Varsity tells a beginner to become, and in several places it is
stricter than the textbook. The genuine gaps are small and concrete: no hard
RRR ≥ 1.5 gate (and a T1 geometry that can't reach it), no "S&R too far from
stop → skip" rule, a risk-per-trade ceiling above doctrine with no default,
an inert drawdown kill switch, and no intraday cost schedule.

---

## 3. The skills an intraday operator needs — as acceptance criteria

Derived from the sources; each is testable, and each is what an intraday tab
would have to *enforce*, not merely display.

1. **Read the base rate before the chart.** Show SEBI's 71% / 80% / 57%
   figures on the surface itself, every time, with FY and sample. A tab that
   hides the base rate is a tips channel.
2. **Cost-first thinking.** Compute expected cost before expected edge, on the
   *intraday* schedule, per ticket size; refuse to show an R-multiple until
   costs are subtracted (Varsity: "containing transaction charges is one of
   the keys").
3. **Timeframe humility.** Signals confirm on completed bars of the highest
   timeframe the trade can afford (Varsity: EOD, at best 15-min). Sub-15-min
   data is *context*, never a signal, until an `INTRADAY_CANDLES` provider
   exists and its signals have earned tier authority in shadow.
4. **The 6-point checklist as gates, weighted.** Items 1–3 and 6 veto; item 4
   caps; item 5 scales size only. RRR ≥ 1.5 for positional; for anything
   labelled intraday, RRR ≥ 1.0 *and* the SEBI disclosure *and* SHADOW-only.
5. **Volume confirmation as a hard skip.** Below-average volume on the signal
   bar → no trade, not a penalty.
6. **Risk per trade ≤ 1.5% default, hard-warn above 3%, cap 3%** unless the
   user explicitly overrides with the recovery-trauma table shown.
7. **Re-base after every fill** (reduced total equity); open risk ≤ 2%; ≤ 5
   positions; daily 1.5% / weekly 3% halts; drawdown halt **active**.
8. **No trade is a decision.** Surfaces must be able to say "0 qualified" and
   mean it — as they did on 2026-09-17.
9. **Enter and leave it alone.** Exits only at stop, target, time-stop, or
   trailing stop rules fixed at entry.
10. **Journal everything before the outcome is known.** Already automatic.
11. **No leverage, ever, by default.**

---

## 4. What to build next, in order — small, each independently testable

**Items 1–5 done 2026-09-18** (`feature/continuous-learning`; tests in
`tests/intraday-doctrine.test.ts`, 50 suites / 578 tests green). Two findings
from implementing them corrected this document's first draft: the RRR gate
already existed at 1.2 (raised to 1.5, not created), and a 0.5% risk default
already existed (kept; only the 5% ceiling came down to 3%).

1. ✅ **Intraday cost schedule** in `costs.ts` (`COST_SCHEDULE_INTRADAY_2024_10`:
   STT 0.025% sell-side, brokerage min(₹20, 0.03%)/order, no DP), selectable
   via `activeCostSchedule("INTRADAY_EQUITY")`. Not yet consumed — nothing
   intraday exists to consume it.
2. ✅ **RRR gate raised 1.2 → 1.5** (`ranking.ts GATE_THRESHOLDS.minRewardRisk1`).
   Stops and targets untouched, per the file's own rule; setups whose
   structure cannot reach 1.5 are excluded — the doctrine, not a workaround.
3. ✅ **"S&R more than 4% from the stop → skip"** in `plausibility.ts`
   (`MAX_STOP_TO_SUPPORT_PCT`, new `stopToSupportPct` field; `ScanService`
   passes the swing-support price; `tiers.ts` already caps at B on
   `!stopStructural`).
4. ✅ **Risk-per-trade ceiling 5% → 3%** in `ShortTermController`; default
   0.5% kept.
5. ✅ **`equityDrawdownPct` wired** from the paper-trade equity curve
   (`computeEquityDrawdownPct`, pure, tested) so the −6% kill switch is live.
6. ✅ **Delayed candles provider — done 2026-09-18, with one deliberate
   deviation from this item's original wording.** `realtime/intradayCandlesProvider.ts`
   (`DelayedCandlesProvider`, `fetchCandles`, pure `completeCandlesOnly` /
   `aggregateSession` (IST, VWAP) / `seriesToRawQuote`) on a new
   `yahoo.fetchIntradayChart` (5m/15m, `range` 1d/5d, pure exported parser).
   **It does NOT declare `INTRADAY_CANDLES`.** That mode lifts the action
   ceiling to BUY on the premise of real intra-interval observability, and
   Yahoo's free NSE feed is delayed and polled — it has not earned that. A new
   mode **`DELAYED_CANDLES`, ceiling `WAIT`**, was added instead;
   `INTRADAY_CANDLES` stays reserved for a genuine real-time (broker) feed.
   Forming candle dropped by min(our clock, vendor `regularMarketTime`);
   freshness judged from the newest COMPLETE candle's end by the existing
   firewall (a ~15-min delayed feed will honestly read STALE ⇒ DEGRADED); every
   snapshot passes `buildScrapedSnapshot` unchanged. 1-minute bars deliberately
   not offered (Varsity: seasoned scalpers only; useless through a delay).
   Not yet wired to any surface — that is item 7. Real-time remains the
   owner's broker/paid decision; it plugs in behind the same
   `IntradayCandleFetcher` interface. 16 tests in
   `tests/delayed-candles-provider.test.ts`.
   **Live smoke against Yahoo (RELIANCE.NS 5m, 2026-09-18 12:52 IST):** 45
   rows for the session, `dataGranularity: "5m"`, `chartPreviousClose`
   present, `currentTradingPeriod.regular` = 09:15–15:30 IST. Two facts the
   fixtures had not modelled: (a) Yahoo appends a synthetic "last quote" row
   at `regularMarketTime` — off the 5-minute grid, volume 0, OHLC all equal to
   the last trade — so `completeCandlesOnly` now also requires grid alignment
   (a marker, not a candle); (b) the vendor's `regularMarketTime` trailed
   wall-clock by only 6 seconds. That is a statement about the *timestamp*,
   not about whether the *prices* are delayed, which cannot be verified
   without a reference feed — so the DELAYED label and WAIT ceiling stay
   until a real-time reference proves otherwise.
   *(original item text follows for the record)* **`INTRADAY_CANDLES` provider** — Yahoo `interval=5m` first (keyless,
   ~15-min DELAYED, rate-limited; labelled as such; `capActionByMode` already
   caps it at WAIT), so 15-min context, VWAP and slippage *measurement* become
   possible. Real-time needs a broker feed — the owner's decision.
6b. ✅ **REAL-TIME feed — Angel One SmartAPI (owner's choice, 2026-09-18).**
   The owner asked for real-time rather than delayed/degraded data and chose
   Angel One (free with a demat account; the alternatives priced at the time
   were Dhan/Upstox/Fyers free tiers and Zerodha Kite Connect at ₹500/mo).
   - `realtime/angelOneAuth.ts`: `loginByPassword` with clientcode + PIN + a
     TOTP derived from the BASE32 seed, returning jwtToken/refreshToken/
     feedToken. TOTP is implemented directly on Node `crypto` (RFC 6238,
     HMAC-SHA1, 30s, 6 digits) and verified against the RFC's published test
     vectors — `otplib` v13 is ESM-only and breaks both `tsc` and ts-jest here.
     Credentials come only from the environment; `describeConfig()` reports
     what is missing without printing a value; a partial configuration returns
     null rather than a half-session, and a broker rejection throws.
   - `realtime/angelOneStreamProvider.ts`: SmartStream v2 behind the existing
     `RealtimeMarketProvider` interface. Binary little-endian frames decoded by
     a PURE exported parser against the documented offsets (mode/exchange at
     0–1, token 2–27, sequence 27–35, exchange timestamp 35–43, LTP 43–51;
     QUOTE adds LTQ/volume/OHLC to 123; SNAP_QUOTE best-5 from 147 to 379).
     **Prices arrive as integers in PAISE and are divided by 100** — the single
     most dangerous field, isolated in one constant and asserted in tests.
     Heartbeat is the literal text `ping` every 10s; subscriptions replay on
     reconnect; ticks are emitted RAW so the existing `TickValidator` stays the
     firewall. Truncated frames and empty tokens are discarded, never
     zero-padded (a fabricated ₹0 would be catastrophic).
   - **This is the feed that earns `STREAMING`**, whose ceiling is already
     `BUY_CANDIDATE` — unlike `DELAYED_CANDLES`/`SCRAPED_SNAPSHOT`, which
     remain capped at WAIT. 26 tests in `tests/angelone-stream.test.ts`.
   - **Not yet wired to the engine, and not yet run against the live broker** —
     that needs the owner's credentials in `.env` (template added to
     `.env.example`). Angel One tokens are per-login and expire, so a session
     refresh policy is still to be decided.
   - SEBI: from 1 Apr 2026 API-based *trading* needs a static IP registered
     with the broker. This path only READS market data and places no orders;
     that obligation starts only if order placement is ever enabled.

7. **Only then** an intraday *monitoring* tab: freshness, gap policy
   (`INVALIDATED/RECOMPUTE/DO_NOT_CHASE/PROCEED`), confirmation triggers, the
   SEBI block, the intraday cost line — and zero "predictions" until anything
   intraday has earned a tier out of SHADOW on logged, graded, block-bootstrapped
   evidence, exactly as the swing setups must.

Items 1–5 are pure code with no data dependency and can start immediately.

---

## Sources

- Zerodha Varsity, Module 2 *Technical Analysis* (PDF) —
  https://zerodha-common.s3.ap-south-1.amazonaws.com/Varsity/Modules/Module%202_Technical%20Analysis.pdf
  (web: https://zerodha.com/varsity/module/technical-analysis/)
- Zerodha Varsity, Module 9 *Risk Management & Trading Psychology* (PDF) —
  https://zerodha-common.s3.ap-south-1.amazonaws.com/Varsity/Modules/Module%209_Risk%20Management%20&%20Trading%20Psychology.pdf
  (web: https://zerodha.com/varsity/module/risk-management/)
- SEBI, *Study – Analysis of Intraday Trading by Individuals in Equity Cash Segment*, 24 Jul 2024 —
  https://www.sebi.gov.in/reports-and-statistics/research/jul-2024/study-analysis-of-intraday-trading-by-individuals-in-equity-cash-segment_84946.html
  · press release https://www.sebi.gov.in/media-and-notifications/press-releases/jul-2024/sebi-study-finds-that-7-out-of-10-individual-intraday-traders-in-equity-cash-segment-make-losses_84948.html
  · numbers as reproduced at https://taxguru.in/sebi/sebi-study-finds-7-10-individual-intraday-traders-equity-cash-segment-losses.html
- SEBI Investor, *Securities Market Investment: Do's and Don'ts* — https://investor.sebi.gov.in/securities-dos_and_donts.html
- Zerodha charges (intraday STT/brokerage schedule) — https://zerodha.com/charges/
- NSE Academy / nseindia.com/learn — **not reachable from this environment**; to be read manually.
