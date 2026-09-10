# Market Depth design system

## Product character

Market Depth 2.0 is a calm institutional research terminal with an editorial sense of scale, not a trading game. Visual hierarchy is ordered as: action → price → risk → confidence → evidence → diagnostics.

## Tokens

The TypeScript contract is `frontend/src/lib/design-tokens.ts`; CSS variables live in `frontend/src/app/globals.css`.

| Role | Value |
| --- | --- |
| Page | `#070A0F` |
| Deep surface | `#0B1017` |
| Elevated | `#101720` |
| Card | `#121B25` |
| Primary / secondary / muted text | `#F5F7FA` / `#A7B0BF` / `#677384` |
| Positive | `#2BD99F` |
| Negative | `#FF5C70` |
| Warning | `#F4B860` |
| Information | `#55A7FF` |
| AI | `#9A7CFF` |
| Quant | `#40D9FF` |

Red and green are not decorative. The cyan→violet gradient is limited to the primary scan action, selected states, AI, and product-identity geometry.

## Typography

- Manrope Variable is the locally bundled UI/display face, with system fallbacks.
- Financial values use the mono token and tabular numerals.
- Hero: 48–64px desktop, 40–52px tablet, 28–34px mobile.
- Section heading: 18–22px; card heading: 15–17px; body: 14–16px; metadata: 12px target.
- Tight tracking is limited to large display text; small labels use positive tracking.

## Shape, spacing, elevation

- 8px spacing grid; primary cards 16px, secondary cards 12px, controls 8–10px.
- Level 1: open editorial divider; Level 2: interactive information canvas; Level 3: masthead or critical decision surface.
- Shadows are shallow and dark. Glass is limited to elevated heroes and AI/evidence surfaces.

## Core primitives

Reusable UI exports include Card/GlassCard, Chip/status badges, Button, Input, Select, Tabs, StatTile, meters, ChartFrame, ChartTip, Sparkline, skeletons, ViewHero, EmptyState, and ErrorState. Domain compositions include StockHero, CanonicalDecisionCard, MaterialEventsCard, ForecastVintageCard, MarketLens, MarketPrism, TradeRadarOrb, EvidenceGraph, and AIEvidenceProgress.

## Workspace identities

- Watchlist uses the Monitor lens: portfolio state and risk together.
- Discover uses the Map lens: cross-sectional opportunity discovery.
- Short-Term uses the Scan instrument: regime, participation, and candidate quality.
- Track Record uses the Verify lens: calibration before confidence.
- Nested sections deliberately omit spatial decoration and use open dividers so the objects remain meaningful.

## Semantic states

- Entry confirmed: green + label.
- Wait for confirmation/model degraded: amber + label.
- Watch/information: blue + label.
- Invalidated/model suspended: red + label.
- Insufficient data/no trade: neutral gray + label.
