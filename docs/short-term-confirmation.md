# Short-Term entry confirmation

Reaching the zone is Stage A; ENTRY_CONFIRMED needs the setup-specific Stage-B
trigger on completed-bar evidence (`assessConfirmation`). Retained rules:

- **Universal**: no imminent material event; data freshness sufficient
  (EOD_FINAL, not delayed intraday); market regime not hostile.
- **MEAN_REVERSION**: RSI RECOVERING (>35, not merely low) · price reclaiming
  SMA20 · relative volume ≥ 0.8× · short-term relative strength not still
  collapsing. (RSI-merely-low was REJECTED — it does not distinguish a bounce
  from a falling knife.)
- **PULLBACK**: holding above SMA20 on the close · RSI 35–62 · ADX ≥ 18.
- **BREAKOUT/VCP**: closed above the 20d high · relVol ≥ 1.3× · volume-price
  confirmation ≥ 0.6.
- **MOMENTUM**: still outperforming NIFTY (20d) · RSI < 70 · above EMA20.

Confirmation is necessary, never sufficient — tier/health/EV/freshness ceilings
still apply on top.
