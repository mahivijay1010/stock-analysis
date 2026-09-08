# Short-Term V2 audit — root cause of the 8-Sep four

On 2026-09-08 the radar showed four MEAN_REVERSION "ENTRY_ZONE" cards
(BERGEPAINT, M&M, ATGL, BDL) despite LOW confidence, INSUFFICIENT_HISTORY and
an unpromoted setup edge. Root causes, all confirmed from the persisted scan:

1. **Ranking cliff.** `classifySetup` returned `setupScore: 45` for EVERY
   mean-reversion, and the gate floor was `minSetupScore: 45` — so all four sat
   exactly on the threshold and ranked identically (23.8–27.4). Fixed: the
   mean-reversion score now VARIES with pattern strength (20–58).
2. **Health gate too narrow.** The gate blocked only `SUSPENDED`, so
   `INSUFFICIENT_HISTORY` passed. Fixed: evidence-based action ceilings.
3. **No setup-specific evidence gate.** Nothing checked whether MEAN_REVERSION
   had a realized edge. Fixed: SetupEvidenceService + expectancy study.
4. **EV gate used the raw mean.** `EV ≥ 0.25%` ignored uncertainty. Fixed: the
   80% lower confidence bound must exceed 0 (the four FAIL: lower bounds −0.9%
   to −1.5%).
5. **Action = "price in zone".** ENTRY_ZONE was assigned on geometry alone.
   Fixed: ZONE_REACHED ≠ ENTRY_CONFIRMED; entry requires tier A + confirmation
   + fresh data + positive EV lower bound + affordability + live authority.

**Data was correct** — the four candidate prices exactly matched the
2026-09-08 EOD closes in `stock_history`. The failure was decision logic.

V2 result on the same inputs: all four → RESEARCH_WATCHLIST, tier C,
RESEARCH_WATCH, with per-trade EV lower bound ≤ 0 cited. QUALIFIED = 0.
