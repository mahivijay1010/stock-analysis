# Short-Term BHEL generalized regression (S13)

The BHEL pattern (price ≈ SMA20, above SMA50, far above SMA200, 52w-high
region, relVolume ≈ 0.5×, vol ~36%, fading 5d momentum) is encoded as GENERIC
rules — no ticker is special-cased:

- classifySetup ⇒ **LATE_TREND** (score 25 < 45 gate) when extended + fading;
  **NO_SETUP** when merely above SMA200 with nothing else — "price > SMA200"
  alone can never produce a candidate (tested).
- Weak participation (relVol < 0.7) explicitly reduces pullback scores and is
  quoted in the reasons ("needs confirmation before entry").
- HIGH_EVENT_RISK blocks everything near imminent events.
- Consequence for the live BHEL-type state: not entry-ready; the radar's
  answer is WATCH/NO_TRADE with the exact failed gates listed — the
  2026-09-04 failure mode (BUY on a late, unconfirmed, low-participation
  chart) cannot recur in the short-term section either.
