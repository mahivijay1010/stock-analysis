# Short-Term gap policy + pre-entry revalidation

A plan computed after the close never blindly triggers next session.
`assessGap` classifies the opening/current price against the plan with
ATR-scaled thresholds:

- gap at/through the stop ⇒ **INVALIDATED**
- opened ≥70% of the way to T1 ⇒ **INVALIDATED** as a new entry (reward gone)
- ≥0.5 ATR below the zone ⇒ **RECOMPUTE**
- ≥0.35 ATR above the zone ⇒ **DO_NOT_CHASE**
- inside the zone ⇒ **PROCEED**; just outside ⇒ **WAIT**

`PreEntryRevalidationService` fetches a fresh quote and returns PROCEED only
when the gap policy proceeds AND no veto fires (stale data, new adverse event,
regime deterioration, EV lower bound no longer positive). The radar never
chases a stock because it once printed an entry zone.
