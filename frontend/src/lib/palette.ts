// Chart palette — validated with the dataviz palette validator against the
// effective dark glass surface (#0e1220: glass over the #060913 aurora base).
// Series sets used together pass the dark lightness band (L 0.48–0.67),
// chroma floor, adjacent-pair CVD separation and 3:1 contrast:
//   • cyan #0891b2 + amber #d97706 + violet #8b5cf6 (SMA overlays)  — PASS
//   • cyan #0891b2 + violet #8b5cf6 (accuracy bars)                 — PASS
//   • gain #059669 + loss #f43f5e (volume up/down)                  — PASS
// `ink` is the single neutral primary price series (legend-labeled), not a hue slot.
export const CHART = {
  surface: 'var(--chart-surface)',
  grid: 'var(--chart-grid)',
  axisLine: 'var(--chart-axis)',
  tick: 'var(--chart-tick)',
  ink: 'var(--chart-ink)',
  sky: 'var(--chart-sky)',
  amber: 'var(--chart-amber)',
  violet: 'var(--chart-violet)',
  gain: 'var(--chart-gain)',
  loss: 'var(--chart-loss)',
  reference: 'var(--chart-reference)',
} as const;
