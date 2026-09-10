/**
 * Realtime V1 shared types (feed-agnostic core). Nothing here knows or cares
 * which vendor produced a tick — the engine is built entirely against these
 * normalized shapes so LIVE and REPLAY run identical code (reviewer #1, #18).
 *
 * Cadence discipline (reviewer): ticks arrive continuously and build canonical
 * 1-minute bars; the DECISION engine evaluates on a coarse checkpoint (10 min
 * in V1). Ingestion cadence is decoupled from evaluation cadence, so 10→5→1 min
 * is a scheduler change, not a rewrite.
 */

import { DecisionStatus } from "../decision/policy";

/** A single normalized trade/quote print. Timestamps are ms epoch. */
export interface MarketTick {
  securityId: string;
  exchangeTimestamp: number;
  receivedAt: number;
  price: number;
  quantity: number;
  bid?: number;
  ask?: number;
  sequence?: number;
}

export type ProviderState = "CONNECTED" | "DISCONNECTED" | "DEGRADED" | "STALE";

export interface ProviderHealth {
  state: ProviderState;
  lastTickAt: number | null;
  subscribed: number;
  reason?: string;
}

/**
 * The unified pull interface both LIVE and REPLAY implement. A CLOCK event
 * advances time WITHOUT a trade (so bars can close and checkpoints can fire on
 * a quiet security); a TICK event carries a print. Replay emits exactly the
 * events a live feed would have, in order, with no lookahead.
 */
export type MarketEvent =
  | { kind: "TICK"; tick: MarketTick }
  | { kind: "CLOCK"; at: number };

export interface MarketDataSource {
  /** Next event in time order, or null at end of stream. */
  next(): Promise<MarketEvent | null>;
}

/** Push-style vendor adapter contract (wraps a MarketDataSource internally). */
export interface RealtimeMarketProvider {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  subscribe(securityIds: string[]): Promise<void>;
  onTick(cb: (tick: MarketTick) => void): void;
  onError(cb: (err: unknown) => void): void;
  health(): ProviderHealth;
}

/** Validation verdict for one tick (reviewer #2). A corrupt tick never enters a bar. */
export type TickValidation =
  | { status: "VALID"; tick: MarketTick }
  | { status: "DUPLICATE" }
  | { status: "STALE" }
  | { status: "SEQUENCE_GAP"; expected: number; got: number }
  | { status: "INVALID"; reason: string };

/** OHLCV bar. `complete` is a discriminant so a forming bar can never be mistaken
 *  for a closed one (reviewer #4). startAt/endAt are minute-aligned ms epochs. */
interface BarBase {
  securityId: string;
  startAt: number;
  endAt: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tradeCount: number;
}
export interface FormingBar extends BarBase {
  complete: false;
}
export interface CompletedBar extends BarBase {
  complete: true;
}
export type LiveBar = FormingBar | CompletedBar;

/** Incrementally-maintained numerical chart state (reviewer #6). */
export interface LiveFeatures {
  ema9: number | null;
  ema21: number | null;
  ema50: number | null;
  rsi14: number | null;
  atr14: number | null;
  vwap: number | null;
  vwapDistancePct: number | null;
  relativeVolume: number | null;
  rangePct: number | null;
  lastClose: number | null;
  completedBars: number;
}

export type LiveAssessment =
  | "STRONGLY_IMPROVING"
  | "IMPROVING"
  | "STABLE"
  | "WEAKENING"
  | "STRONGLY_WEAKENING"
  | "INVALIDATED";

export type LiveEntryQuality = "HIGH" | "MEDIUM" | "LOW" | "NONE";
export type LiveRiskState = "NORMAL" | "ELEVATED" | "HIGH";
export type LiveDataQuality = "HEALTHY" | "DEGRADED" | "UNAVAILABLE";

/**
 * The prepared, single-truth object for a security at a checkpoint (reviewer #9).
 * When a user opens a stock the backend does not start analysing — this is
 * already built. `gate` is the DETERMINISTIC action; the ranker may reorder
 * within a gate but never override it.
 */
export interface LiveStockContext {
  securityId: string;
  ticker: string;
  asOf: number;
  price: { last: number; open: number; high: number; low: number; changePct: number | null };
  volume: { session: number; relativeVolume: number | null };
  features: LiveFeatures;
  /** A single scalar posture in [-1,1] derived from features — feeds transitions. */
  posture: number;
  liveAssessment: LiveAssessment;
  setupState: string;
  expectedR: number | null;
  expectedRLowerBound: number | null;
  entryQuality: LiveEntryQuality;
  riskState: LiveRiskState;
  relativeStrength: { vsMarketPct: number | null; marketPercentile: number | null };
  dataQuality: LiveDataQuality;
  /** Deterministic gate action; the ranker respects this as a hard ceiling. */
  gate: DecisionStatus;
}

/** What changed between two consecutive checkpoints (reviewer #10). */
export interface StateDelta {
  securityId: string;
  priceMovePct: number | null;
  postureDelta: number;
  trendChanged: boolean;
  vwapCrossed: boolean;
  setupChanged: boolean;
  relativeVolumeDelta: number | null;
  relativeStrengthDelta: number | null;
  newBreakout: boolean;
  failedBreakout: boolean;
  entryQualityChanged: boolean;
  riskChanged: boolean;
  gateChanged: boolean;
  dataQualityChanged: boolean;
}
