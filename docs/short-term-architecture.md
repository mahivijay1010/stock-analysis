# Short-Term Tab — Architecture (backend + frontend)

_Last updated: 2026-10-07. This documents the Short-Term tab end to end: the
1–21 session radar, the sub-₹100 wide lane, the AI layer, the prospective
ledgers, the nightly bot, and the frontend that renders all of it._

---

## 0. The doctrine (why it's built this way)

Every design choice below serves four non-negotiable rules, because the system
has **measured** that it has no demonstrated stock-picking skill (9 pre-registered
signals and the quant-v1 model all failed on sealed data — see the Evidence tab):

1. **Fail-closed.** No BUY without validated setup evidence, a confirmed entry,
   and an EV lower bound that survives costs. "Often zero stocks, and that is
   the correct answer."
2. **AI is cap-only.** The LLM can veto or downgrade a decision; it can never
   raise one, invent a price/target, or manufacture a catalyst.
3. **Descriptive, not predictive.** The sub-₹100 screen ranks *tradeability*,
   not expected return. The Conviction Board ranks *evidence strength*, not
   odds of profit.
4. **Measured, not promised.** Every pick is logged prospectively and graded
   later on its own ledger. "High return" is an output we measure, never a
   promise we make.

---

## 1. Backend

### 1.1 The core scan pipeline — `src/services/shortterm/`

`ScanService.scan()` runs the full radar pipeline over a universe and persists
runs, candidates, transitions, alerts and (optionally) shadow predictions.

Per-stock pipeline, in order:

| Stage | File | What it does |
|---|---|---|
| Setup detection | `setups.ts` | pullback / breakout / momentum / mean-reversion |
| Setup evidence & tier | `setupEvidence.ts`, `tiers.ts` | tier A/B/C/D from out-of-sample shadow evidence |
| Entry / stop / targets | `entryExit.ts` | zone or trigger, ATR-based stop, T1/T2/T3 |
| Confirmation | `confirmation.ts` | volume / RSI / SMA reclaim gates |
| Contradictions & plausibility | `contradictions.ts`, `plausibility.ts` | sanity caps on the plan |
| EV after costs | `evUncertainty.ts`, `conditionalForecast.ts` | bootstrap scenario EV, 80% lower bound |
| Costs & tax | `costs.ts`, `../decision/tradeEconomics.ts` | NSE charges + STCG/LTCG |
| Position sizing | `sizing.ts` | **risk-based**, never budget ÷ price |
| Gates & action state | `actionStates.ts` | ENTRY_CONFIRMED → ZONE_REACHED → … → NO_SETUP |
| Gap / revalidation | `gapPolicy.ts`, `PreEntryRevalidationService.ts` | a plan never blindly triggers next session |
| Probability | `model.ts`, `types.ts::resolveProbability` | shown **only** if a calibrated model is promoted (today: never → "unavailable") |

Live data comes through `LiveMarketDataProvider` which labels Yahoo as
`DELAYED`, never `LIVE`. Scan scheduling and market-session logic:
`ScanService` + `../forecast/SessionCalendarService`.

### 1.2 The 1–21 session radar's prospective ledger

- `short_term_shadow_predictions` (`entities/ShortTerm.ts`) — one immutable
  prospective row per setup×horizon identity (`.orIgnore()` dedupe).
- Grading: `research/ResearchJobsService.resolveShadowOutcomes()` replays each
  matured plan with the **fill-aware bracket simulator** `shadowFill.ts`
  (`simulateBracket`): proves an entry actually filled, is gap-aware, and flags
  `AMBIGUOUS_INTRABAR` when a single bar straddles stop and target (adverse leg
  assumed for safety, **never counted as observed realized R**).
- Live authority (`shortTermHealth.ts`): a setup earns HEALTHY only after
  ≥ 20 independent resolved shadow trades with positive conservative expectancy.

### 1.3 Unified full trade plan — `fullPlan.ts`

`composeFullTradePlan()` → `GET /api/short-term/:ticker/full-plan`. One payload:
direction (or NO_TRADE with the gate's own reasons), entry/stop/trail/time/event
exits with order types, exact ₹ scenarios at stop/T1/T2/T3 (charges + tax via
`tradeEconomics.ts`), governed probability passthrough, and shadow expectancy
(withheld below the 20-trade floor).

### 1.4 The sub-₹100 wide lane

The owner's "find cheap stocks that give high returns" goal, built honestly:

| Piece | File | Role |
|---|---|---|
| Tradeability screen | `wideScreen.ts` | every NSE EQ company under a **configurable** ₹ ceiling (default 100, up to 2000), filtered for surveillance / liquidity / history. **Descriptive only.** |
| Screen report | `wideScreenReport.ts` | joins facts + sources; markdown + JSON |
| Entry/exit over the universe | `wideScan.ts` | runs the SAME radar pipeline; logs every gradeable pick |
| Prospective ledger | `WideShadowPrediction` entity + `WideLedgerService.ts` | the lane's OWN scoreboard, **isolated from the radar's evidence base** so penny-stock outcomes never gate the 152-universe models |
| Grading | `WideLedgerService.resolveWideShadowOutcomes()` | same `simulateBracket` engine; wired into the evening cron |
| Track record | `WideLedgerService.trackRecord()` | deduped, observed-only, Wilson-bounded, withheld below 10 outcomes |

**Data prerequisites** (filled by jobs, not shipped): `nse_delivery` (daily
bhavcopy+delivery history, ≥240 sessions; `scripts/backfillNseDelivery.ts`) and
`nse_securities` (symbol master, STOCK vs ETF; `scripts/refreshWideUniverse.ts`).

### 1.5 The AI layer (DeepSeek / OpenAI / Claude — all cap-only)

- Provider registry: `reasoning/providerRegistry.ts` (DeepSeek active when
  `AI_PROVIDER=deepseek` or no OpenAI key but a DeepSeek key). Verified working.
- Radar analyst/critic: `aiAnalyst.ts` — reasons only over deterministic
  evidence, clamped to the deterministic action as a ceiling, cost-governed
  (`aiCostGovernor`), evidence-hash cached.
- Sub-₹100 risk scout: `wideScout.ts` — grounded to quantitative screen
  evidence only, flags penny-stock risks, invents no catalysts, emits
  `AFFIRM | CAP_TO_WATCH | CAP_TO_NO_TRADE`. `wideLedger.applyAiCap()` takes the
  **less aggressive** of (deterministic, cap), so a model-manufactured BUY is
  structurally impossible.

### 1.6 Conviction Board — `convictionBoard.ts` + `ConvictionBoardService.ts`

Ranks the latest wide-scan's candidates into HIGH / MEDIUM / LOW by a
transparent evidence score: actionability (gate progress) + reward:risk to T1 +
EV after costs + AI risk (cap + red flags) + tradeability. A separate
**fail-closed BUY-grade bar** flags only setups clearing every gate (today: 0).
Tiers are absolute bands — an empty HIGH is a truthful "nothing qualifies",
never force-filled. `GET /api/short-term/conviction-board` (reports the price
ceiling the data reflects).

### 1.7 The background bot (cron, Asia/Kolkata) — `CronService.ts`

| Time | Job | Does |
|---|---|---|
| 08:45 | morning scan | bars → scan + log → rank snapshot → rotating intelligence |
| 18:30 | evening verify | grade radar predictions + **Lane C** + **sub-₹100 lane** |
| 19:50 | **sub-₹100 bot** | backfill delivery → refresh universe/surveillance → wide-scan (logs picks) → **DeepSeek scout** over the shortlist → Conviction Board is fresh by morning |
| 20:10 | web knowledge | gather facts + news-signal study |

### 1.8 Endpoints (`src/routes/index.ts`)

```
POST /api/short-term/scan                     run a radar scan
GET  /api/short-term/latest                   last stored scan
GET  /api/short-term/:ticker                  one ticker's detail
GET  /api/short-term/:ticker/full-plan        complete ₹ trade plan
POST /api/short-term/:ticker/revalidate       pre-entry gap/freshness re-check
GET  /api/short-term/wide-screen              sub-₹100 tradeability screen
POST /api/short-term/wide-scan                evaluate entry/exit over the screen
GET  /api/short-term/conviction-board         tiered sub-₹100 shortlist
GET  /api/short-term/wide-track-record        sub-₹100 lane graded scoreboard
POST /api/short-term/wide-scout               DeepSeek risk scout over recent picks
```

---

## 2. Frontend — `frontend/src/components/shortterm/`

| Component | Role |
|---|---|
| `ShortTermView.tsx` | the tab shell: controls (budget / min-max price / horizon / risk / strategy), runs the radar scan, renders Qualified trades + Research watchlist |
| `ConvictionBoardPanel.tsx` | three tier columns (High / Medium / Low), each card pairing upside (reward:risk, entry/stop/target) with risk (AI cap, red-flag count, EV), buy-grade chip, expandable reasons, always-visible caveat, and a **Max-price control** to re-evaluate at any ceiling |
| `WideScreenPanel.tsx` | the "Stocks under ₹N" tradeability table + "Evaluate entry & exit", with filters (price / industry / turnover / sort / search) |

API client: `frontend/src/lib/api.ts` — `runWideScan`, `getWideScreen`,
`getConvictionBoard`, `getFullPlan`, etc. Types mirror the backend payloads.

### Honest UX invariants

- The Conviction Board header always carries "Tiers measure evidence + reward:risk,
  not the odds of profit," and the footer repeats the full caveat.
- An empty HIGH tier renders "No stock reached high conviction today — that
  emptiness is the honest answer," never a force-filled column.
- Probability is shown **only** when `probabilityStatus === 'AVAILABLE'`; every
  other status nulls the number so no surface can render a stale/uncalibrated one.
- Freshness is labelled DELAYED/EOD, never LIVE.

---

## 3. What's measured vs. still pending

- **Built & live:** the whole pipeline above, both prospective ledgers, the AI
  scout, the Conviction Board, the nightly bot, configurable price ceiling.
- **Accruing:** the sub-₹100 and Lane C track records need elapsed time —
  picks logged now mature in ~2 weeks, then grade automatically.
- **Roadmap (not built):** calibrated meta-label probability for sub-₹100
  setups (display only once graded), penny-stock circuit-lock/liquidity risk
  model, options/flow data, "predicted vs. happened" panel wiring the track
  record back into the tiers.
