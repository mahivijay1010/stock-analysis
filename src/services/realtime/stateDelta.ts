/**
 * StateDelta (reviewer #10) — what materially changed between two consecutive
 * checkpoints for one security. PURE and deterministic: the same (prev, curr)
 * always yields the same delta. The AI usually receives THIS (plus supporting
 * evidence), not the full context in isolation — it reasons about the change.
 */

import { LiveStockContext, StateDelta } from "./types";

export function computeStateDelta(prev: LiveStockContext | null, curr: LiveStockContext): StateDelta {
  if (!prev) {
    return {
      securityId: curr.securityId,
      priceMovePct: null,
      postureDelta: 0,
      trendChanged: false,
      vwapCrossed: false,
      setupChanged: false,
      relativeVolumeDelta: null,
      relativeStrengthDelta: null,
      newBreakout: false,
      failedBreakout: false,
      entryQualityChanged: false,
      riskChanged: false,
      gateChanged: false,
      dataQualityChanged: false,
    };
  }
  const priceMovePct = prev.price.last > 0 ? ((curr.price.last - prev.price.last) / prev.price.last) * 100 : null;
  const prevVwapSide = sideOfVwap(prev);
  const currVwapSide = sideOfVwap(curr);
  const relVolDelta = num(curr.volume.relativeVolume) != null && num(prev.volume.relativeVolume) != null ? (curr.volume.relativeVolume! - prev.volume.relativeVolume!) : null;
  const rsDelta = curr.relativeStrength.vsMarketPct != null && prev.relativeStrength.vsMarketPct != null ? curr.relativeStrength.vsMarketPct - prev.relativeStrength.vsMarketPct : null;

  return {
    securityId: curr.securityId,
    priceMovePct,
    postureDelta: curr.posture - prev.posture,
    trendChanged: signPosture(curr.posture) !== signPosture(prev.posture),
    vwapCrossed: prevVwapSide != null && currVwapSide != null && prevVwapSide !== currVwapSide,
    setupChanged: curr.setupState !== prev.setupState,
    relativeVolumeDelta: relVolDelta,
    relativeStrengthDelta: rsDelta,
    // A breakout in this model = crossing from a non-breakout setup INTO one.
    newBreakout: !isBreakout(prev.setupState) && isBreakout(curr.setupState),
    failedBreakout: isBreakout(prev.setupState) && curr.setupState === "FAILED_BREAKOUT",
    entryQualityChanged: curr.entryQuality !== prev.entryQuality,
    riskChanged: curr.riskState !== prev.riskState,
    gateChanged: curr.gate !== prev.gate,
    dataQualityChanged: curr.dataQuality !== prev.dataQuality,
  };
}

function num(x: number | null): number | null {
  return x != null && Number.isFinite(x) ? x : null;
}
function sideOfVwap(c: LiveStockContext): "ABOVE" | "BELOW" | null {
  const d = c.features.vwapDistancePct;
  if (d == null) return null;
  return d >= 0 ? "ABOVE" : "BELOW";
}
function signPosture(p: number): -1 | 0 | 1 {
  return p > 0.15 ? 1 : p < -0.15 ? -1 : 0;
}
function isBreakout(setup: string): boolean {
  return setup === "BREAKOUT_CONFIRMED" || setup === "BREAKOUT_FORMING";
}
