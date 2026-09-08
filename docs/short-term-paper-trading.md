# Short-Term paper/shadow trading (S9)

SHADOW MODE is on by default and mandatory before any real-money use:

- Every scan persists a shadow prediction per passing candidate (unique per
  ticker/anchor/setup/horizon) with the full plan + forecast.
- `scripts/shortTermResolve.ts` resolves matured predictions on completed
  bars, gap-aware, recording outcome (TARGET_FIRST/STOP_FIRST/TIMEOUT),
  realized return, MFE, MAE, holding duration; unresolved stays pending —
  never guessed.
- Paper trades table mirrors the same lifecycle for user-simulated entries
  (suggestedEntry vs actualEntryTrigger, stops, targets, costs, slippage).
- The performance evaluator reports win rate, avg win/loss, profit factor,
  expectancy, target/stop/timeout rates, MFE/MAE — and refuses to print a
  table until ≥30 resolved trades exist. Current status: **INSUFFICIENT
  HISTORY (0 resolved; 4 pending as of 2026-09-08)** — stated, not padded.
- Top-5 quality (precision@5, forward excess vs NIFTY/momentum/random/current
  ranking) uses the same resolver output once history accumulates.
