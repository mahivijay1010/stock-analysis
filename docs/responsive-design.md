# Market Depth responsive design

## Layout

- ≥1280px: expanded 248px indexed sidebar, 1560px maximum content workspace, multi-column data surfaces.
- 1024–1279px: sidebar remains; dense layouts collapse to two/three columns and the Trade Radar uses the compact orb.
- 768–1023px: mobile top/bottom navigation, two-column metric groups where useful.
- ≤640px: one-column action-first flow, 28–34px hero, full-width controls, 44px mobile targets. Short-Term inputs collapse to one column at 520px.

## Short-Term order

Company/price/state → entry/stop/target → risk → why/why not → chart/map → model diagnostics. Qualified trades and research-watch cards retain different border weight and opacity.

## Mobile navigation

The fixed bottom navigation exposes Watch, Discover, Short, Record, and More. The sheet contains search plus secondary destinations. Desktop search remains available with Cmd/Ctrl-K.

## QA matrix

Validated through CSS inspection and browser captures at 1600×1200, 1600×1050, 1440×900, 1280×800, 1024×900, and narrow mobile capture widths. Rules cover 1920, 360, long names, large INR values, negatives, zero results, loading, and API error states. Before release, repeat on physical Safari/Chrome mobile because desktop headless Chrome on macOS imposes a minimum layout viewport.
