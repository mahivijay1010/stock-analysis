# Short-Term Trade Radar — architecture

LIVE DATA → FREE FEATURES → SETUP CLASSIFIER → DISTRIBUTION FORECAST → EV
AFTER COSTS → ENTRY/EXIT ENGINE → RISK MANAGER → GATES → RANKING → UP TO 5 →
LOCAL AI → governed OpenAI → user. Positional short-term only (1–21 sessions),
signals confirm on COMPLETED daily bars; intraday would require its own
validation methodology and is out of scope.

- `shortterm/types.ts` — contracts (horizons, action vocabulary, plan, sizing).
- `LiveMarketDataProvider` — replaceable interface (getQuote/getBars/
  getCompletedBars/subscribeTicks(polling)/getMarketStatus/getDataFreshness).
  The Yahoo implementation NEVER reports LIVE outside a provably fresh open
  session; UI shows LIVE/DELAYED/STALE + lastUpdate everywhere.
- `features.ts` — pure zero-lookahead engine (returns, rel-NIFTY/sector, RSI,
  MACD, ATR, ADX, SMAs/EMA, 52w pct, gap, relVolume + acceleration + price
  confirmation, drawdown, breakout/support/resistance distances, contraction,
  ADV, zero-volume bars).
- `setups.ts` → PULLBACK_IN_UPTREND / BREAKOUT_CONFIRMATION / VCP / MOMENTUM /
  MEAN_REVERSION vs LATE_TREND / FAILED_BREAKOUT / HIGH_EVENT_RISK / NO_SETUP.
- `ScanService` — filters FIRST (price/sector), 151→features→gates→rank,
  persists run/candidates/transitions/deduped alerts/shadow predictions.
- API: POST /api/short-term/scan · GET latest · GET :ticker · POST :t/review ·
  GET alerts · GET ai-usage · GET/PUT preferences. UI: sidebar "Short-Term",
  in-section detail (Overview/Entry/Exit/Events/AI Review/Track Record).
