# Short-Term entry/exit methodology

**Entries are per-setup and structural** (entryExit.ts): pullback zone =
SMA20 ± 0.5·ATR with hold-above-SMA20 confirmation; breakout trigger = 0.2%
above the 20d high requiring relVol ≥ 1.3× on the close; momentum continuation
near price with EMA20 floor; mean-reversion zone bounded by swing support.
Nothing triggers on partial bars.

**Stops come FIRST from invalidation logic** — 1.25–1.5·ATR or structure
(0.25 ATR below swing low), whichever is more protective; never tightened to
manufacture R:R. Targets: nearest swing resistance if CLOSER than the ATR
target (honest, not stretched), else 1.5·ATR (T1) / 2.5·ATR (T2) / 4·ATR (T3
only with ADX>25 on 10-21d horizons).

**Exits** (assessExit, fully tested): stop breach ⇒ EXIT_FULL (no
renegotiation); adverse tier-≤2 event ⇒ EVENT_RISK_EXIT; deep SMA20 break /
RS collapse / bear_high_vol ⇒ THESIS_INVALIDATED; horizon cap ⇒ TIME_EXIT;
T1 ⇒ optional partial + stop to breakeven; after T1 the trail (close −
1.5·ATR) only ever rises. Every change has a deterministic reason; targets are
never raised because price rose.
