/**
 * Part B — the feature registry must stay in sync with the actual learning
 * surfaces: every feature a model can see is registered with category,
 * lookback and availableAt rule. An unregistered feature fails CI.
 */

import { PANEL_FEATURE_REGISTRY, RESEARCH_FEATURE_REGISTRY, ABLATION_GROUPS, registryLookup } from "../src/services/research/featureRegistry";
import { buildFeatures } from "../src/services/research/features";
import { Bar } from "../src/services/market/types";

function mkBars(n: number): Bar[] {
  const bars: Bar[] = [];
  let c = 100;
  for (let i = 0; i < n; i++) {
    c *= 1 + 0.001 * Math.sin(i);
    const d = new Date(Date.UTC(2024, 0, 2 + i));
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    bars.push({ date: d.toISOString().slice(0, 10), open: c * 0.999, high: c * 1.01, low: c * 0.99, close: c, volume: 1000 + i, adjustedClose: c });
  }
  return bars;
}

describe("feature registry sync (Part B)", () => {
  test("every research feature emitted by buildFeatures is registered", () => {
    const bars = mkBars(400);
    const fv = buildFeatures("TEST.NS", bars, bars.length - 1, {});
    const missing = Object.keys(fv.features).filter((k) => !RESEARCH_FEATURE_REGISTRY.some((s) => s.featureId === k));
    expect(missing).toEqual([]);
  });

  test("registry entries carry full metadata", () => {
    for (const s of [...PANEL_FEATURE_REGISTRY, ...RESEARCH_FEATURE_REGISTRY]) {
      expect(s.featureId.length).toBeGreaterThan(0);
      expect(s.lookbackSessions).toBeGreaterThan(0);
      expect(["session-close", "announcedAt"]).toContain(s.availableAtRule);
      expect(s.calculationVersion.length).toBeGreaterThan(0);
    }
  });

  test("ablation groups partition the panel registry categories", () => {
    const grouped = Object.values(ABLATION_GROUPS).flat();
    for (const id of grouped) expect(registryLookup(id)).not.toBeNull();
    expect(ABLATION_GROUPS.MARKET).toContain("breadthAboveSma50");
    expect(ABLATION_GROUPS.EVENTS).toContain("eventCount10d");
  });
});
