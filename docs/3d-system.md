# Market Depth spatial system

## Components

- `MarketLens`: page-specific Monitor, Map, and Verify instruments for Watchlist, Discover, and Track Record. The geometry is shared, but labels, semantic posture, and state are specific to the workspace.
- `MarketPrism`: product identity whose posture, diffusion, and warm risk edge are driven by explicit direction/volatility/confidence/risk props.
- `TradeRadarOrb`: outer ring = market regime, middle = breadth/participation, inner core = candidate quality. Adjacent text makes interpretation independent of the object.
- `EvidenceGraph`: SVG relationship map between a stock and Business, Valuation, Technicals, Events, Regime, Forecast, and Risk evidence.

## Architecture decision

The system uses bounded CSS 3D transforms and SVG rather than Three.js. These objects contain no meshes, textures, business logic, WebGL context, or remote assets. This delivers the requested spatial identity at a fraction of the JavaScript/GPU cost and avoids the clipping/glitch behavior seen in the earlier experiment. Three.js remains unjustified for the current object complexity.

## Performance and fallback

- Animation uses transform/opacity and slow cadence.
- `useAmbientActivity` pauses objects offscreen and in background tabs.
- Reduced-motion removes all idle movement.
- Labels, states, and controls remain fully functional if CSS 3D is unsupported.
- Objects are constrained by fixed scenes, `contain: layout paint`, overflow-safe mastheads, and breakpoint-specific compact/hidden variants; they never influence investment logic.
