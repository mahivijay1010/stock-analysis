# Market Depth 2.0 final UI report

Date: 2026-09-09

## A. Visual problems found

Muddy warm surfaces, undersized labels, weak action/risk hierarchy, narrow wide-screen composition, repetitive cards, muted charts, non-semantic 3D, and an unfinished-looking zero-results state. The 1024px rail breakpoint also clipped the radar legend.

## B. New design language

Market Depth 2.0: graphite/navy Night and cool Polar Light themes, restrained cyan/violet intelligence accents, semantic financial color, bounded spatial instruments, editorial scale, and an action → risk → evidence hierarchy.

## C. Typography changes

Heroes now use 48–64px desktop / 28–34px mobile; critical values are larger and tabular; secondary navigation/status copy was raised; small uppercase labels are reserved for metadata.

## D. Color/theme changes

Night uses the requested `#070A0F/#0B1017/#101720/#121B25` stack. Polar Light uses cool white, blue-gray, and ink instead of a generic inverted dark theme. Green/red retain gain/loss meaning, amber means caution, blue means information, violet means AI.

## E. Layout changes

248px indexed sidebar, 72px status topbar, 1560px content maximum, adaptive grids, fixed mobile bottom navigation, and compact/hidden spatial instruments at constrained widths.

## F. Card/component system

Three elevation levels, 8–24px radii, restrained inner light/shadow, open editorial subsection dividers, reusable status/input/chart/empty/error/skeleton primitives, and domain compositions for decisions, forecasts, events, trade levels, and evidence.

## G. Chart improvements

Centralized series semantics, stronger actual-vs-forecast distinction, interval bands, integrated dark chart surfaces, standardized tooltips, reduced-motion support, and a measured-only Short-Term trade-level map.

## H. Short-Term redesign

Flagship Trade Radar hero, honest market strip, six-field command bar, automatic INR risk amount, content-specific scan progress, distinct Qualified vs Research Watchlist treatments, evidence tiers, confirmation, EV uncertainty, sizing, why/why-not content, detail cockpit, Model Lab, and a visual Data → Evidence → Risk → Entry gate path.

## I. Forecast redesign

Forecast surfaces use issuance-boundary charts, daily ranges, original/current vintage comparison, drift state, stored forecast values, and centralized interval semantics.

## J. Research redesign

Material events are source-backed cards with date, authority tier, direction, materiality, AI interpretation, and primary-source link. Keyword news remains secondary.

## K. Deep Dive redesign

AI synthesis, technical/fundamental/critic separation, interpreted technical metrics, and the interactive Evidence Graph make state and uncertainty more legible than a flat metric grid.

## L. Discover redesign

One destination contains relative strength, daily scan, and coverage universe with an explicit ranking basis, sticky local navigation, its own Opportunity Field lens, and honest error/unavailable states.

## M. Watchlist redesign

Watch and own information share one row/card system with price, decision, forecast/risk context, responsive density, direct stock actions, its own Portfolio lens, and an integrated private-workspace sign-in state.

## N. 3D components

MarketLens, MarketPrism, and TradeRadarOrb are isolated, information-bearing CSS 3D components. CSS/SVG was deliberately chosen over WebGL for stability and cost. Animation pauses offscreen/hidden and respects reduced motion. Repeated subsection prisms were removed so spatial objects carry meaning instead of decoration.

## O. Motion system

150ms micro, 220–240ms state/card, 300ms page, 460–500ms data transitions; motion is limited to state change, scan progress, selection, and slow spatial breathing.

## P. AI visual language

Violet/cyan is reserved for advisory AI. AIEvidenceProgress shows named processing stages without chain-of-thought. EvidenceGraph links existing evidence domains. AI remains visually and logically subordinate to deterministic risk and model health.

## Q. Responsive/mobile

Desktop multi-column, tablet compact/two-column, mobile action-first single column. The 1024px clipped radar, mobile minimum-width pressure, and light Discover switcher mismatch were found and fixed during screenshot QA.

## R. Accessibility

Visible focus, labeled semantic color, native roles, ARIA summaries, tabular numbers, readable hierarchy, mobile target sizing, and reduced-motion support. See `ui-accessibility.md` for the remaining release audit.

## S. Performance impact

No new runtime dependency or media asset. Spatial visuals are CSS/SVG. Intersection/visibility lifecycle control prevents background ambient animation. Production performance targets require deployed measurement.

## T. Before/after screenshots

Market Depth 2.0 captures are stored in `docs/ui-screenshots/`:

- `market-depth-2-short-term-night.png` — desktop Short-Term command surface.
- `market-depth-2-short-term-mobile.png` — narrow mobile Short-Term flow.
- `market-depth-2-discover-night.png` — Night Discover workspace.
- `market-depth-2-discover-light.png` — Polar Light Discover workspace.
- `market-depth-2-track-record-night.png` — Track Record/API-error state.
- `market-depth-2-watchlist-night.png` — Watchlist/API-error state.
- `market-depth-2-stock-decision-night.png` — live BHEL decision cockpit with real service data.

The earlier `market-depth-final-*` captures are retained as the immediately preceding iteration for direct regression comparison.

The supplied before screenshots remain the audit reference; they showed the purple/brown, dense, low-hierarchy Analyze workspace described in `ui-audit.md`.

## U. Tests/build

- `cd frontend && npm run lint` — PASS.
- `cd frontend && npx next build --webpack` — PASS (compiled, TypeScript, and 5 static pages).
- `npm run build` — PASS (backend TypeScript); confirms the UI work did not break the shared contracts.
- `npx jest tests/short-term-v2.test.ts tests/short-term.test.ts tests/decision-policy.test.ts --runInBand` — PASS, 3 suites / 79 tests.
- `git diff --check` — PASS.

The only warnings were the existing stale `baseline-browser-mapping` dataset and the existing ts-jest `isolatedModules` deprecation; neither is a test failure.

## V. Exact git commits

Implementation baseline observed during this pass: `b2f3f50` (backend hardening) after `663211f` (Short-Term V2 UI/API/tests/docs). The Market Depth completion is intentionally left as reviewable working-tree changes; no commit was created because the user did not explicitly authorize a git commit. Untracked intelligence-cache XML files are unrelated and were not modified.
