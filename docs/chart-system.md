# Market Depth chart system

`CHART_THEME` in `frontend/src/lib/design-tokens.ts` and `ChartFrame`/`ChartTip` define one visual contract for Recharts, SVG, and future chart engines.

| Meaning | Style |
| --- | --- |
| Historical/actual | solid near-white |
| Forecast median | blue, dashed where applicable |
| 80% interval | soft blue band |
| 90% interval | lighter violet outer band |
| Entry | information blue |
| Stop/loss | semantic red |
| Target/gain | semantic green |
| Support | quant cyan |
| Resistance/warning | amber |
| Event | AI violet marker |
| Volume/reference | neutral gray |

Grid and axes are deliberately quiet; tooltips use an opaque elevated surface and tabular numbers. Recharts animations respect reduced motion. Charts must include an accessible title/summary and must not rely on color alone. The Short-Term `TradeLevelMap` plots only measured stop, entry, current, and target values; it does not generate a decorative sparkline when price history is absent.

Advanced candlestick/zoom/pan remains a progressive enhancement. The current dependency remains Recharts to avoid shipping a second heavy chart runtime without demonstrated need.

