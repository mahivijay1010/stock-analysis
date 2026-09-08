/**
 * Feature registry (autonomous directive, Part B) — versioned metadata for
 * every learning feature. A feature that is not registered here may not enter
 * a model (enforced by tests/feature-registry.test.ts, which asserts the
 * panel's featureNames ⊆ registry). availableAtRule documents WHEN each value
 * becomes knowable; anything not provably point-in-time is banned from
 * training (e.g. Yahoo snapshot fundamentals).
 */

export type FeatureCategory =
  | "MARKET"
  | "SECTOR"
  | "STOCK_PRICE"
  | "TECHNICAL"
  | "VOLUME"
  | "RELATIVE"
  | "EVENTS"
  | "REGIME";

export interface FeatureSpec {
  featureId: string;
  name: string;
  version: string;
  category: FeatureCategory;
  source: "adjusted-bars" | "nifty-bars" | "sector-basket" | "vix-bars" | "structured-events" | "universe-bars";
  lookbackSessions: number;
  availableAtRule: "session-close" | "announcedAt";
  calculationVersion: string;
}

const f = (
  featureId: string,
  category: FeatureCategory,
  source: FeatureSpec["source"],
  lookbackSessions: number,
  availableAtRule: FeatureSpec["availableAtRule"] = "session-close"
): FeatureSpec => ({
  featureId,
  name: featureId,
  version: "v1",
  category,
  source,
  lookbackSessions,
  availableAtRule,
  calculationVersion: "panel-v2",
});

/** Panel features (research/panel.ts) — the learning surface. */
export const PANEL_FEATURE_REGISTRY: FeatureSpec[] = [
  f("r1", "STOCK_PRICE", "adjusted-bars", 1),
  f("r3", "STOCK_PRICE", "adjusted-bars", 3),
  f("r5", "STOCK_PRICE", "adjusted-bars", 5),
  f("r10", "STOCK_PRICE", "adjusted-bars", 10),
  f("r20", "STOCK_PRICE", "adjusted-bars", 20),
  f("r60", "STOCK_PRICE", "adjusted-bars", 60),
  f("vol20Ann", "TECHNICAL", "adjusted-bars", 20),
  f("drawdown252", "STOCK_PRICE", "adjusted-bars", 252),
  f("smaDist20", "STOCK_PRICE", "adjusted-bars", 20),
  f("smaDist50", "STOCK_PRICE", "adjusted-bars", 50),
  f("smaDist200", "STOCK_PRICE", "adjusted-bars", 200),
  f("week52Pct", "STOCK_PRICE", "adjusted-bars", 252),
  f("volumeRatio20", "VOLUME", "adjusted-bars", 20),
  f("gapPct", "STOCK_PRICE", "adjusted-bars", 2),
  f("trendPersist10", "STOCK_PRICE", "adjusted-bars", 10),
  f("beta60", "RELATIVE", "nifty-bars", 60),
  f("niftyR5", "MARKET", "nifty-bars", 5),
  f("niftyR20", "MARKET", "nifty-bars", 20),
  f("sectorR5", "SECTOR", "sector-basket", 5),
  f("sectorR20", "SECTOR", "sector-basket", 20),
  f("relStrength20", "RELATIVE", "nifty-bars", 20),
  f("eventCount10d", "EVENTS", "structured-events", 10, "announcedAt"),
  f("orderWinCount30d", "EVENTS", "structured-events", 30, "announcedAt"),
  // panel-v2 additions: market breadth + advance/decline (universe-wide, PIT)
  f("breadthAboveSma50", "MARKET", "universe-bars", 50),
  f("advDecline5", "MARKET", "universe-bars", 5),
];

/** Research per-ticker features (research/features.ts) — harness surface. */
export const RESEARCH_FEATURE_REGISTRY: FeatureSpec[] = [
  ...[1, 2, 3, 5, 10, 20, 60].map((n) => f(`ret_${n}d`, "STOCK_PRICE", "adjusted-bars", n)),
  f("dist_sma20_pct", "STOCK_PRICE", "adjusted-bars", 20),
  f("dist_sma50_pct", "STOCK_PRICE", "adjusted-bars", 50),
  f("dist_sma200_pct", "STOCK_PRICE", "adjusted-bars", 200),
  f("rsi14", "TECHNICAL", "adjusted-bars", 15),
  f("macd_hist_norm", "TECHNICAL", "adjusted-bars", 35),
  f("atr14_pct", "TECHNICAL", "adjusted-bars", 15),
  f("realized_vol20_ann_pct", "TECHNICAL", "adjusted-bars", 20),
  f("rv_1d_ann_pct", "TECHNICAL", "adjusted-bars", 1),
  f("rv_5d_ann_pct", "TECHNICAL", "adjusted-bars", 5),
  f("rv_22d_ann_pct", "TECHNICAL", "adjusted-bars", 22),
  f("bollinger_pct_b", "TECHNICAL", "adjusted-bars", 20),
  f("drawdown_from_1y_high_pct", "STOCK_PRICE", "adjusted-bars", 252),
  f("week52_position_pct", "STOCK_PRICE", "adjusted-bars", 252),
  f("volume_ratio_20d", "VOLUME", "adjusted-bars", 21),
  f("gap_open_pct", "STOCK_PRICE", "adjusted-bars", 2),
  f("nifty_ret_5d", "MARKET", "nifty-bars", 5),
  f("nifty_ret_20d", "MARKET", "nifty-bars", 20),
  f("nifty_dist_sma50_pct", "MARKET", "nifty-bars", 50),
  f("nifty_dist_sma200_pct", "MARKET", "nifty-bars", 200),
  f("vix_level", "MARKET", "vix-bars", 1),
  f("nifty_vol20_ann_pct", "MARKET", "nifty-bars", 20),
  f("vix_percentile_1y", "MARKET", "vix-bars", 252),
  f("rel_strength_20d_pp", "RELATIVE", "nifty-bars", 20),
  f("sector_ret_20d_pct", "SECTOR", "sector-basket", 20),
];

export function registryLookup(featureId: string): FeatureSpec | null {
  return (
    PANEL_FEATURE_REGISTRY.find((s) => s.featureId === featureId) ??
    RESEARCH_FEATURE_REGISTRY.find((s) => s.featureId === featureId) ??
    null
  );
}

/** Feature-group membership for the ablation engine (Part P). */
export const ABLATION_GROUPS: Record<string, string[]> = {
  MARKET: PANEL_FEATURE_REGISTRY.filter((s) => s.category === "MARKET").map((s) => s.featureId),
  SECTOR: PANEL_FEATURE_REGISTRY.filter((s) => s.category === "SECTOR").map((s) => s.featureId),
  STOCK_PRICE: PANEL_FEATURE_REGISTRY.filter((s) => s.category === "STOCK_PRICE").map((s) => s.featureId),
  TECHNICAL: PANEL_FEATURE_REGISTRY.filter((s) => s.category === "TECHNICAL").map((s) => s.featureId),
  VOLUME: PANEL_FEATURE_REGISTRY.filter((s) => s.category === "VOLUME").map((s) => s.featureId),
  RELATIVE: PANEL_FEATURE_REGISTRY.filter((s) => s.category === "RELATIVE").map((s) => s.featureId),
  EVENTS: PANEL_FEATURE_REGISTRY.filter((s) => s.category === "EVENTS").map((s) => s.featureId),
};
