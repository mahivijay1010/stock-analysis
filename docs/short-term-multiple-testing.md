# Short-Term multiple testing

The radar evaluates many setup×horizon(×regime) cells, so an uncorrected
p-value is not evidence. The expectancy study computes a one-sided
block-bootstrap p-value that each cell's after-cost expectancy is > 0
(`bootstrapPValueMeanPositive`, resampling by DATE for independence), then
applies Benjamini–Hochberg FDR at q=0.10 across ALL cells
(`benjaminiHochberg`). A cell may reach TIER A only if it is BH-significant —
so a single lucky cell among a dozen cannot earn entry authority. The
Deflated-Sharpe / PBO / White-Reality-Check family is documented as the next
step once live-shadow equity curves exist (they need realized P&L series, not
just per-trade R).
