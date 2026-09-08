# Short-Term validation

- **Leakage**: features are pure over bars ≤ anchor (shared discipline with
  the research layer; future-bar mutation tests in tests/panel-leakage.test.ts
  cover the primitives; the meta-label study uses purged date splits).
- **Meta-label calibration**: pre-registered rule (ECE ≤0.05, Brier < base
  rate, ≥30 independent windows) — FAILED on Brier ⇒ probability hidden
  (docs/short-term-models.md).
- **Freshness honesty**: provider tests assert LIVE is impossible outside an
  open session and null timestamps are STALE.
- **Bracket simulation is gap-aware**: an open through the level fills at the
  open, not the level (both in the study and the shadow resolver) — gaps can
  exceed stops and the P&L math admits it.
- **20 unit tests** (tests/short-term.test.ts): sizing math incl. the spec
  example, never-budget/price, liquidity/sector caps, risk-manager lockouts,
  cost schedule, slippage monotonicity, exit engine (stop/T1/trail/time/
  event/regime), gates (SUSPENDED health, negative EV, stale bars, illiquid,
  kill switch), BHEL generalized late-trend regression, freshness honesty.
- **Live end-to-end**: scan 151 → 4 passed → 4 shown (UP TO 5 honored); state
  transitions recorded (SCANNED → ENTRY_READY); alerts deduped per transition;
  probability text verified on every card.
