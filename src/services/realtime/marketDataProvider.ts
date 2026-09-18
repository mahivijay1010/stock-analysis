/**
 * MarketDataProvider (reviewer: scraping is the CURRENT provider impl, not baked
 * into the engine). Everything downstream consumes a normalized MarketSnapshot,
 * so switching ScrapingMarketProvider → BrokerMarketProvider later is a swap,
 * not a rewrite.
 *
 * Honesty about the data mode (reviewer): a scraped 10-minute reading is a
 * POLLING_SNAPSHOT — we know 1430 → 1436, NOT the intra-interval path. The mode
 * is carried on every snapshot and CAPS the live authority ceiling.
 */

import { DecisionStatus } from "../decision/policy";
import { ProviderHealth, LiveDataQuality } from "./types";

export interface Security {
  securityId: string;
  ticker: string;
}

/**
 * - SCRAPED_SNAPSHOT: polled page reading — no intra-interval path. Caps at WAIT.
 * - DELAYED_CANDLES: vendor OHLCV candles that are DELAYED and polled (Yahoo's
 *   free NSE 5m/15m feed). Real intra-interval observability, but not of the
 *   present — the newest complete candle is minutes-to-a-quarter-hour old by
 *   the time it is published. Caps at WAIT: a delayed candle cannot justify a
 *   live entry any more than a delayed quote can (same rule
 *   shortterm/LiveMarketDataProvider applies: never LIVE unless provably so).
 * - INTRADAY_CANDLES: REAL-TIME candles from a broker/exchange feed. Lifts the
 *   ceiling. Reserved for such a feed; nothing free provides it.
 * - STREAMING: tick feed. Lifts the ceiling.
 */
export type MarketDataMode = "SCRAPED_SNAPSHOT" | "DELAYED_CANDLES" | "INTRADAY_CANDLES" | "STREAMING";

/** Freshness axis — independent of parse validity. */
export type FreshnessStatus = "FRESH" | "STALE" | "UNKNOWN_FRESHNESS" | "FAILED";

/** Parse/reconciliation validity axis. */
export type SnapshotQuality = "OK" | "DATA_INVALID" | "PARSER_ERROR" | "SOURCE_DISAGREEMENT" | "FAILED";

/** A single source's raw reading BEFORE validation. */
export interface RawPriceQuote {
  source: string;
  sourceUrl?: string;
  securityId: string;
  ticker: string;
  price: number | null;
  previousClose?: number | null;
  open?: number | null;
  dayHigh?: number | null;
  dayLow?: number | null;
  volume?: number | null;
  changePct?: number | null;
  bid?: number | null;
  ask?: number | null;
  sourceTimestamp?: number | null; // ms epoch if the page exposes it
  fetchedAt: number;
  /** Set when the fetch itself failed (network/timeout) — distinct from a parse miss. */
  fetchError?: string;
}

/** The normalized, validated snapshot the engine consumes. */
export interface MarketSnapshot {
  securityId: string;
  ticker: string;
  mode: MarketDataMode;
  price: number | null;
  previousClose: number | null;
  open: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  volume: number | null;
  changePct: number | null;
  bid: number | null;
  ask: number | null;
  fetchedAt: number;
  sourceTimestamp: number | null;
  ageSeconds: number | null;
  freshness: FreshnessStatus;
  quality: SnapshotQuality;
  sources: string[];
  notes: string[];
}

/** A source that produces one raw quote. The concrete HTML scraper (or a broker
 *  adapter) implements this; the provider stays vendor-agnostic and testable. */
export interface PriceSource {
  name: string;
  fetch(security: Security): Promise<RawPriceQuote>;
}

export interface MarketDataProvider {
  readonly mode: MarketDataMode;
  fetchStock(security: Security): Promise<MarketSnapshot>;
  fetchUniverse(securities: Security[]): Promise<MarketSnapshot[]>;
  health(): ProviderHealth;
}

const ACTION_RANK: Record<DecisionStatus, number> = { INSUFFICIENT_EVIDENCE: 0, AVOID_NEW_ENTRY: 1, WAIT: 2, BUY_CANDIDATE: 3 };

/**
 * The maximum LIVE action a data mode may support (reviewer): a scraped snapshot
 * lacks intra-interval observability, so it cannot on its own justify a live
 * BUY — it caps at WAIT. Intraday candles / streaming lift the ceiling.
 */
export function modeAuthorityCeiling(mode: MarketDataMode): DecisionStatus {
  switch (mode) {
    case "SCRAPED_SNAPSHOT": return "WAIT";
    case "DELAYED_CANDLES": return "WAIT";
    case "INTRADAY_CANDLES": return "BUY_CANDIDATE";
    case "STREAMING": return "BUY_CANDIDATE";
  }
}

/** Cap an action at the mode's ceiling — never raises it. */
export function capActionByMode(action: DecisionStatus, mode: MarketDataMode): DecisionStatus {
  const ceil = modeAuthorityCeiling(mode);
  return ACTION_RANK[action] > ACTION_RANK[ceil] ? ceil : action;
}

/**
 * Map a snapshot's two quality axes to the engine's data-quality gate. Only a
 * FRESH + OK snapshot is HEALTHY; a stale/unknown reading is DEGRADED; anything
 * invalid/failed/disagreeing is UNAVAILABLE → the ranker/gate refuse a new entry.
 */
export function snapshotToDataQuality(s: MarketSnapshot): LiveDataQuality {
  if (s.quality !== "OK" || s.freshness === "FAILED") return "UNAVAILABLE";
  if (s.freshness === "STALE" || s.freshness === "UNKNOWN_FRESHNESS") return "DEGRADED";
  return "HEALTHY";
}
