# Market Depth UI audit

Date: 2026-09-09

## Audit basis

Reviewed the supplied Analyze screenshots, the current React/CSS component tree, and browser captures at 1600×1200, 1440×900, 1280×800, 1024×900, and 390×844. The audit treats investment logic and deterministic gate behavior as immutable.

## Problems found

- The earlier warm purple/brown surfaces blurred the distinction between neutral information, AI, risk, and action.
- A 216px rail plus a narrow centered column left large unused areas on wide displays, while dense cards still used 9–11px copy.
- Price, action, risk, confidence, evidence quality, and diagnostics often had similar visual weight.
- Long research lists read as database rows; the scan’s zero-result state looked unfinished rather than intentionally disciplined.
- The original decorative 3D object was not bounded tightly enough, causing clipping/overflow at some widths and communicating no clear state.
- Charts used local styling and muted series colors, making actual price, forecast, ranges, and trade levels harder to distinguish.
- At the 1024px rail breakpoint, the effective content column was much narrower than the viewport and could clip the radar legend.
- Generic loading/error states did not distinguish chart work, candidate evaluation, or AI evidence gathering.

## Resulting priorities

1. Make action, risk, confidence, freshness, and evidence readable in three seconds.
2. Use graphite/navy layers and reserve semantic colors for their financial meaning.
3. Give wide screens a 1560px workspace while preserving a clear single-column mobile order.
4. Make Short-Term the flagship command surface and make “zero qualified” a successful risk outcome.
5. Use 3D only as a bounded, labeled information layer.
6. Centralize tokens, chart semantics, motion, focus behavior, and responsive rules.

## Post-implementation QA notes

- Desktop composition now uses the available width and preserves calm negative space.
- 1024px switches the Trade Radar to its compact form; its legend no longer clips.
- The Short-Term empty state now exposes the Data → Evidence → Risk → Entry gate sequence.
- Backend-offline browser runs intentionally verified the error states and honest “not scanned/on demand” labels.
- The 390px headless Chrome capture is retained as evidence; Chrome on macOS may use a minimum layout viewport while cropping the output bitmap, so physical-device testing remains recommended before release.
