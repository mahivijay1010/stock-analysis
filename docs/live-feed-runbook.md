# Live feed runbook — verifying the Upstox stream under real load

**Why this document exists.** The Upstox path has been proven twice, but never
under load: the socket was verified against the real broker on 2026-09-18
(one instrument, market closed), and the wiring is covered by 18 unit tests
with fake feeds. What has **never** happened is 151 subscriptions streaming
through the validator, bar builder and snapshot layer during an open session.
That is the one genuinely unverified path in the system, and it can only be
tested between **09:15 and 15:30 IST on a trading day**.

This runbook exists so the procedure and its pass criteria persist beyond any
one working session.

---

## 1. Pre-open checklist (before 09:15 IST)

```bash
# 1. Backend up, DB connected
curl -s localhost:5101/health

# 2. Upstox authorized — tokens die at 03:30 IST daily, so this is ALWAYS
#    needed in the morning. Open in a browser and approve:
#    http://localhost:5101/api/auth/upstox/login
curl -s localhost:5101/api/auth/upstox/status | python3 -m json.tool
#    Require: tokenState = "VALID"

# 3. Feed not already running, universe resolves
curl -s localhost:5101/api/live/status | python3 -m json.tool
#    Require: universeSize 151, unresolved [] , running false
```

If `tokenState` is `ABSENT`, the server was restarted — the token is held in
memory only, by design, so no stale token can silently survive a restart.
Re-authorize.

---

## 2. At the open

```bash
# Start the feed (authenticated POST — needs a signed-in session cookie)
curl -s -X POST localhost:5101/api/live/start \
  -H 'X-Requested-With: XMLHttpRequest' --cookie-jar /tmp/c --cookie /tmp/c

# Then start the observer (read-only; polls status/rows, writes JSONL)
npx ts-node --transpile-only scripts/liveSessionMonitor.ts
```

The monitor samples every 60s until 15:30 IST and appends to
`docs/live-sessions/<IST date>.jsonl`. It never mutates the feed.

The UI equivalent is the **Live** tab (`http://localhost:3001/#live`) — the
Start button, plus per-row freshness. Use the monitor for the time series; use
the tab to eyeball whether rows look sane.

---

## 3. Pass criteria — decide these BEFORE looking at results

Written in advance so a disappointing session cannot be reinterpreted into a
success afterwards. Same discipline as the pre-registered promotion thresholds
in `setupEvidence.ts`.

| # | Criterion | Pass | Investigate |
|---|---|---|---|
| 1 | Subscriptions accepted | All 151 instrument keys subscribe without a limit error | Any rejection, or `subscribed < 151` |
| 2 | Coverage climbs and holds | `securitiesWithData` reaches a high fraction of 151 within ~15 min and does not decay | Coverage peaks then falls — suggests silent securities or a dropped socket |
| 3 | Ticks keep arriving | `ticksDelta > 0` on essentially every sample through the session | Any run of zero-delta samples while the market is open |
| 4 | Validator stays quiet | `ticksRejected` stays near zero and does not grow with volume | Growth ⇒ a real protocol or timestamp bug, not noise |
| 5 | Freshness dominates | Most rows `FRESH`; `STALE` confined to genuinely illiquid names | Broad staleness ⇒ the feed is behind, not the market |
| 6 | Provider health | `CONNECTED` for the session | `STALE`/`DISCONNECTED` — capture `health.reason` |
| 7 | No silent partial universe | `unresolved` stays `[]` | Any entry names a ticker that is NOT subscribed |

**Expected-but-not-failures**, so they are not mistaken for bugs:
- Illiquid names in the 151 may legitimately go minutes between trades. That
  is a `STALE` row, and correct.
- `changePct` is `null` until an exchange previous close is available — it is
  withheld rather than derived from our own first tick.
- If the feed is started mid-session, rows carry the joined-mid-session note
  and their open/high/low are **our observed** values, not the exchange's.

---

## 4. What to do with what you find

1. **Bugs** → fix, with a regression test that fails without the fix. Load-only
   bugs (backpressure, memory growth, socket drops) will not be caught by the
   existing fake-feed tests, so each needs its own.
2. **Findings that are not bugs** → append to §5 below. The point of writing
   them down is that the next session starts from them.
3. **Do not tune anything to make the numbers look better.** Coverage is what
   it is. If 151 subscriptions are too many for one socket, that is a finding
   about the vendor's limits, not a reason to quietly reduce the universe.

**What this verification does NOT establish.** That live ticks improve any
decision. The feed raises the *data mode* (`STREAMING`, ceiling
`BUY_CANDIDATE`); it does not raise the *evidence bar*. Intraday signals still
have to earn tier authority through the shadow pipeline, and the current
out-of-sample verdict remains **0/12 setups with a positive edge**
(`docs/system-trust-review.md` §13). A perfectly healthy feed changes none of
that.

---

## 5. Session log

*(append one entry per verified session — date, what passed, what did not,
what was changed as a result)*

### 2026-09-18 — pre-open setup only
Feed built and wired; socket proven against the real broker earlier that day
with one instrument while the market was closed (correct behaviour: Upstox
returned the last trade with a truthful `exchangeTimestamp` ~80 minutes old, no
fabricated live price). Monitor and this runbook written ahead of the first
real session. **No open-market verification yet.**
