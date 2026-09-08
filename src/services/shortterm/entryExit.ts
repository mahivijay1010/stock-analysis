/**
 * Entry + exit engines (S5) — PURE, deterministic, per-setup-type. Every
 * level derives from ATR / structure / the setup's own definition; nothing is
 * invented, and stops are never tightened to manufacture a reward/risk ratio
 * (the stop comes FIRST from invalidation logic; R:R is then reported as-is).
 */

import { ShortTermFeatures } from "./features";
import { SetupClassification } from "./setups";
import { estimateSlippagePct, roundTripCostPct } from "./costs";
import { EntryType, HORIZON_TD, ShortTermHorizon, TradePlan } from "./types";

const r2 = (x: number): number => Math.round(x * 100) / 100;

export function buildTradePlan(
  f: ShortTermFeatures,
  setup: SetupClassification,
  horizon: ShortTermHorizon,
  orderValueForSlippage = 100_000
): TradePlan {
  const h = HORIZON_TD[horizon];
  const atr = f.atr14;
  const empty: TradePlan = {
    entryType: "NONE",
    entryZoneLow: null,
    entryZoneHigh: null,
    entryTrigger: null,
    entryTriggerPrice: null,
    entryTriggerRelVolume: null,
    invalidationPrice: null,
    invalidationReason: null,
    initialStop: null,
    stopBasis: null,
    target1: null,
    target2: null,
    target3: null,
    targetBasis: null,
    expectedHoldingDays: h.mid,
    rewardRiskToTarget1: null,
    rewardRiskToTarget2: null,
    atr14: atr != null ? r2(atr) : null,
    annualVolPct: f.realizedVol20AnnPct != null ? r2(f.realizedVol20AnnPct) : null,
    advInr: f.advInr20 != null ? Math.round(f.advInr20) : null,
    estimatedSlippagePct: estimateSlippagePct({ atrPct: f.atrPct, relVolume: f.relVolume, orderValueInr: orderValueForSlippage, advInr: f.advInr20 }),
    transactionCostPct: roundTripCostPct(orderValueForSlippage),
    expectedValueAfterCostsPct: null,
    expectedShortfallPct: null,
  };
  if (atr == null || !(atr > 0)) return empty;

  let entryType: EntryType = "NONE";
  let zoneLow: number | null = null;
  let zoneHigh: number | null = null;
  let trigger: string | null = null;
  let triggerPrice: number | null = null;
  let triggerRelVol: number | null = null;
  let refEntry: number; // reference entry for stop/target math
  let stop: number;
  let stopBasis: string;
  let invalidation: number;
  let invalidationReason: string;

  switch (setup.setupType) {
    case "PULLBACK_IN_UPTREND": {
      // Zone: SMA20 ± 0.5 ATR; structural floor = swing support / SMA50.
      const sma20 = f.sma20 as number;
      zoneLow = r2(sma20 - 0.5 * atr);
      zoneHigh = r2(sma20 + 0.5 * atr);
      entryType = "PULLBACK_ZONE";
      refEntry = Math.min(Math.max(f.price, zoneLow), zoneHigh);
      const structural = f.supportDistPct != null ? f.price * (1 - f.supportDistPct / 100) : null;
      stop = Math.min(refEntry - 1.5 * atr, structural != null ? structural - 0.25 * atr : Infinity);
      stopBasis = structural != null && structural - 0.25 * atr < refEntry - 1.5 * atr
        ? "0.25 ATR below the nearest swing low (structure)"
        : "1.5 × ATR14 below entry";
      invalidation = stop;
      invalidationReason = "A close below the stop breaks the pullback structure (higher-low sequence fails).";
      trigger = `price inside ₹${zoneLow}–₹${zoneHigh} AND holds above SMA20 on the close`;
      break;
    }
    case "VOLATILITY_CONTRACTION":
    case "BREAKOUT_CONFIRMATION": {
      const high20 = f.price * (1 + Math.max(0, -(f.breakoutDistPct ?? 0)) / 100);
      triggerPrice = r2(high20 * 1.002); // 0.2% above the 20d high
      triggerRelVol = 1.3;
      entryType = "BREAKOUT_TRIGGER";
      trigger = `close above ₹${triggerPrice} with relative volume ≥ ${triggerRelVol}×`;
      refEntry = triggerPrice;
      stop = refEntry - 1.25 * atr;
      stopBasis = "1.25 × ATR14 below the breakout trigger (failed-breakout invalidation)";
      invalidation = f.sma20 != null ? Math.min(stop, f.sma20 - 0.5 * atr) : stop;
      invalidationReason = "A close back below the breakout level / SMA20 marks a failed breakout.";
      break;
    }
    case "MOMENTUM_CONTINUATION": {
      entryType = "MOMENTUM_CONTINUATION";
      zoneLow = r2(f.price - 0.5 * atr);
      zoneHigh = r2(f.price + 0.25 * atr);
      refEntry = f.price;
      trigger = `continuation entry near ₹${r2(f.price)} while the stock keeps outperforming NIFTY`;
      stop = f.ema20 != null ? Math.min(refEntry - 1.5 * atr, f.ema20 - 0.5 * atr) : refEntry - 1.5 * atr;
      stopBasis = "1.5 × ATR14 (or 0.5 ATR below EMA20, whichever is lower)";
      invalidation = stop;
      invalidationReason = "Momentum thesis fails if price loses EMA20 and relative strength turns negative.";
      break;
    }
    case "MEAN_REVERSION": {
      entryType = "MEAN_REVERSION_ZONE";
      const support = f.supportDistPct != null ? f.price * (1 - f.supportDistPct / 100) : f.price - atr;
      zoneLow = r2(Math.max(support, f.price - 1.0 * atr));
      zoneHigh = r2(f.price);
      refEntry = (zoneLow + zoneHigh) / 2;
      stop = support - 0.75 * atr;
      stopBasis = "0.75 × ATR14 below swing support";
      invalidation = stop;
      invalidationReason = "A close below swing support ends the mean-reversion case (falling knife).";
      trigger = `RSI recovering from oversold while price holds ₹${zoneLow}+`;
      break;
    }
    default:
      return empty; // NO_SETUP / LATE_TREND / FAILED_BREAKOUT / HIGH_EVENT_RISK get no plan
  }

  const risk = refEntry - stop;
  if (!(risk > 0)) return empty;
  // Targets from structure first, ATR multiples second — never inflated to dress up R:R.
  const resistance = f.resistanceDistPct != null ? f.price * (1 + f.resistanceDistPct / 100) : null;
  let target1 = refEntry + 1.5 * atr;
  let targetBasis = "1.5 × ATR14 above entry";
  if (resistance != null && resistance > refEntry + 0.5 * atr && resistance < target1) {
    target1 = resistance;
    targetBasis = "nearest swing resistance (closer than the ATR target — honest, not stretched)";
  }
  const target2 = refEntry + 2.5 * atr;
  const target3 = HORIZON_TD[horizon].max >= 10 && (f.adx14 ?? 0) > 25 ? refEntry + 4 * atr : null;

  return {
    ...empty,
    entryType,
    entryZoneLow: zoneLow,
    entryZoneHigh: zoneHigh,
    entryTrigger: trigger,
    entryTriggerPrice: triggerPrice,
    entryTriggerRelVolume: triggerRelVol,
    invalidationPrice: r2(invalidation),
    invalidationReason,
    initialStop: r2(stop),
    stopBasis,
    target1: r2(target1),
    target2: r2(target2),
    target3: target3 != null ? r2(target3) : null,
    targetBasis,
    rewardRiskToTarget1: r2((target1 - refEntry) / risk),
    rewardRiskToTarget2: r2((target2 - refEntry) / risk),
  };
}

// ── Exit engine (S5) ─────────────────────────────────────────────────────────

export type ExitState =
  | "HOLD"
  | "TAKE_PARTIAL_PROFIT"
  | "MOVE_STOP"
  | "TRAIL_STOP"
  | "EXIT_FULL"
  | "TIME_EXIT"
  | "THESIS_INVALIDATED"
  | "EVENT_RISK_EXIT";

export interface ExitAssessment {
  state: ExitState;
  reasons: string[];
  currentStop: number;
  stopMoved: boolean;
}

export function assessExit(pos: {
  entryPrice: number;
  initialStop: number;
  currentStop: number;
  target1: number;
  target2: number;
  daysHeld: number;
  maxHoldingDays: number;
  lastClose: number;
  atr14: number;
  target1Reached: boolean;
  features: ShortTermFeatures;
  marketRegime: string | null;
  newAdverseEvent: boolean;
  modelHealthState: string | null;
  forecastDriftState: string | null;
}): ExitAssessment {
  const reasons: string[] = [];
  let currentStop = pos.currentStop;
  let stopMoved = false;

  // Hard exits first — order matters.
  if (pos.lastClose <= pos.currentStop) {
    return { state: "EXIT_FULL", reasons: [`Close ₹${pos.lastClose} at/under the stop ₹${pos.currentStop} — the defined loss is taken, not renegotiated.`], currentStop, stopMoved };
  }
  if (pos.newAdverseEvent) {
    return { state: "EVENT_RISK_EXIT", reasons: ["A new adverse tier-≤2 event arrived — binary risk exceeds the setup's edge."], currentStop, stopMoved };
  }
  const invalidated =
    (pos.features.sma20 != null && pos.lastClose < pos.features.sma20 - 1.5 * pos.atr14) ||
    (pos.features.relNifty20 ?? 0) < -0.05 ||
    pos.marketRegime === "bear_high_vol";
  if (invalidated) {
    return {
      state: "THESIS_INVALIDATED",
      reasons: ["Trend/relative-strength thesis broke (deep SMA20 break, RS collapse, or hostile market regime) — exit does not wait for the stop."],
      currentStop,
      stopMoved,
    };
  }
  if (pos.daysHeld >= pos.maxHoldingDays) {
    return { state: "TIME_EXIT", reasons: [`Maximum holding horizon (${pos.maxHoldingDays} sessions) reached without target — time stops prevent thesis creep.`], currentStop, stopMoved };
  }

  // Profit management.
  if (!pos.target1Reached && pos.lastClose >= pos.target1) {
    // Move stop to breakeven; suggest partial.
    if (currentStop < pos.entryPrice) {
      currentStop = pos.entryPrice;
      stopMoved = true;
    }
    return {
      state: "TAKE_PARTIAL_PROFIT",
      reasons: [`Target 1 (₹${pos.target1}) reached — optional partial profit; stop moves to breakeven ₹${pos.entryPrice} (deterministic rule, not price hope).`],
      currentStop,
      stopMoved,
    };
  }
  if (pos.target1Reached) {
    const trail = pos.lastClose - 1.5 * pos.atr14;
    if (trail > currentStop) {
      currentStop = Math.round(trail * 100) / 100;
      stopMoved = true;
      reasons.push(`Trailing stop raised to ₹${currentStop} (close − 1.5 ATR).`);
    }
    if (pos.lastClose >= pos.target2) reasons.push(`Target 2 (₹${pos.target2}) reached — remaining position rides the trail only.`);
    return { state: "TRAIL_STOP", reasons: reasons.length ? reasons : ["Post-T1 management: trailing stop active."], currentStop, stopMoved };
  }

  // Soft deterioration warnings (still HOLD).
  if (pos.modelHealthState === "SUSPENDED") reasons.push("Model health SUSPENDED — no new adds; manage the existing position only.");
  if (pos.forecastDriftState === "INVALIDATED") reasons.push("Forecast drift INVALIDATED — review the position against your own thesis.");
  if ((pos.features.relVolume ?? 1) > 2 && (pos.features.r1 ?? 0) < 0) reasons.push("High-volume down bar — watch for distribution.");
  return { state: "HOLD", reasons: reasons.length ? reasons : ["No exit condition met; stop and targets unchanged."], currentStop, stopMoved };
}
