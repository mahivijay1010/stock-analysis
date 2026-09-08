# Short-Term risk management

**Position sizing** (sizing.ts, spec example verified in tests):
qty = floor((budget × riskPct) / (entry − stop)), then capital cap (≤35% of
budget per trade), total budget cap, liquidity cap (≤2% of 20d ADV), sector
concentration (≤50% of budget). ₹50,000 @0.5%, entry 420/stop 410 ⇒ 25 shares,
₹10,500 used, ₹39,500 remaining, ₹313 loss-at-stop incl. costs+slippage.
The full budget is never auto-deployed.

**Portfolio limits** (RISK_LIMITS): max 5 open positions, open risk ≤2% of
budget, daily loss ≤1.5%, weekly ≤3%, 6% equity-drawdown kill switch. When a
limit trips, the radar stays visible and NEW entries are disabled (gate
"portfolio risk"), verified in tests and surfaced in the UI banner.

**Costs**: versioned TransactionCostSchedule (in-delivery-2024-10: STT 0.1%
both legs, exchange/SEBI/stamp/GST, DP charge) + participation-aware slippage
(ATR%, relative volume, order/ADV). Every EV is after costs.
