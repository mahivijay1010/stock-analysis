/**
 * Global regime classifier (pure). Every component is explained: value, score
 * (−2..+2), reasons, and whether its inputs were covered. The regime is a rule
 * over the component scores — no opaque weighting, every threshold listed in
 * REGIME_RULES so it can be read, tested and tightened.
 */

export interface ObsLite {
  key: string;
  assetClass: string;
  region: string;
  sessionDate: string;
  price: number;
  ret1d: number | null; // % (bps/100 for yields: see isYield handling by caller)
  ret5d: number | null;
  ret20d: number | null;
  vol20: number | null;
  isYield?: boolean;
  /** For yields: absolute change in bps over 5 and 20 sessions. */
  chg5bps?: number | null;
  chg20bps?: number | null;
  freshness: "FRESH" | "DELAYED" | "STALE" | "UNKNOWN";
}

export type GlobalRegime = "RISK_ON" | "NEUTRAL" | "CAUTIOUS" | "RISK_OFF" | "STRESSED";
export interface RegimeComponent {
  name: "EquityTrend" | "EquityBreadth" | "Volatility" | "Rates" | "Dollar" | "Commodities" | "Credit" | "CrossAssetStress";
  score: number | null; // −2 (hostile) … +2 (supportive); null = not covered
  value: number | null;
  unit: string;
  reasons: string[];
  covered: boolean;
  inputs: string[];
}
export interface RegimeResult {
  regime: GlobalRegime;
  score: number;
  components: RegimeComponent[];
  reasons: string[];
  dataCoverage: { covered: number; total: number; stale: number; missing: string[] };
  rules: typeof REGIME_RULES;
}

export const REGIME_RULES = {
  equityTrend: { strongUp20dPct: 3, weakDown20dPct: -3, stress20dPct: -8 },
  breadth: { risingShareOn: 0.7, risingShareOff: 0.3 },
  vix: { calm: 15, elevated: 22, high: 28, stressed: 35, spike5dPct: 30 },
  rates: { shock5dBps: 25, ease5dBps: -20 },
  dollar: { strong5dPct: 1.5, weak5dPct: -1.5 },
  commodities: { oilShock5dPct: 8, oilDrop5dPct: -8, copper20dPct: 5 },
  credit: { wideningBps: 40 },
  regime: { riskOnScore: 4, neutralScore: 0, cautiousScore: -3, riskOffScore: -6, stressedComponentsHostile: 4 },
} as const;

const r2 = (v: number): number => Math.round(v * 100) / 100;
const fresh = (o: ObsLite | undefined): o is ObsLite => !!o && o.freshness !== "STALE";

export function classifyGlobalRegime(obs: ObsLite[]): RegimeResult {
  const by = new Map(obs.map((o) => [o.key, o]));
  const R = REGIME_RULES;
  const comps: RegimeComponent[] = [];
  const missing: string[] = [];
  const get = (k: string) => {
    const o = by.get(k);
    if (!fresh(o)) missing.push(k);
    return fresh(o) ? o : undefined;
  };

  // EquityTrend: mean 20d return of the global equity set (US/EU/Asia), excluding India.
  const eqKeys = ["SPX", "NDX", "DJI", "RUT", "STOXX600", "DAX", "FTSE", "CAC", "SX5E", "NKY", "HSI", "SHCOMP", "KOSPI", "TWSE", "ASX"];
  const eq = eqKeys.map(get).filter((o): o is ObsLite => !!o && o.ret20d != null);
  const mean20 = eq.length ? eq.reduce((s, o) => s + (o.ret20d as number), 0) / eq.length : null;
  comps.push({
    name: "EquityTrend",
    score: mean20 == null ? null : mean20 >= R.equityTrend.strongUp20dPct ? 2 : mean20 > 0 ? 1 : mean20 <= R.equityTrend.stress20dPct ? -2 : mean20 <= R.equityTrend.weakDown20dPct ? -2 : mean20 < 0 ? -1 : 0,
    value: mean20 != null ? r2(mean20) : null,
    unit: "% mean 20-session return",
    reasons: [mean20 == null ? "no fresh global equity index" : `mean 20d return across ${eq.length} indices ${r2(mean20)}%`],
    covered: eq.length >= 5,
    inputs: eq.map((o) => o.key),
  });
  // EquityBreadth: share of indices with positive 20d return.
  const rising = eq.filter((o) => (o.ret20d as number) > 0).length;
  const share = eq.length ? rising / eq.length : null;
  comps.push({
    name: "EquityBreadth",
    score: share == null ? null : share >= R.breadth.risingShareOn ? 2 : share > 0.5 ? 1 : share <= R.breadth.risingShareOff ? -2 : share < 0.5 ? -1 : 0,
    value: share != null ? r2(share * 100) : null,
    unit: "% of indices up over 20 sessions",
    reasons: [share == null ? "no data" : `${rising} of ${eq.length} global indices up over 20 sessions`],
    covered: eq.length >= 5,
    inputs: eq.map((o) => o.key),
  });
  // Volatility: VIX level and 5d spike.
  const vix = get("VIX");
  const vixSpike = vix?.ret5d ?? null;
  let vScore: number | null = null;
  const vReasons: string[] = [];
  if (vix) {
    vScore = vix.price < R.vix.calm ? 2 : vix.price < R.vix.elevated ? 1 : vix.price < R.vix.high ? 0 : vix.price < R.vix.stressed ? -1 : -2;
    vReasons.push(`VIX ${r2(vix.price)}`);
    if (vixSpike != null && vixSpike >= R.vix.spike5dPct) {
      vScore = Math.max(-2, vScore - 1);
      vReasons.push(`VIX +${r2(vixSpike)}% over 5 sessions (spike)`);
    }
  } else vReasons.push("VIX not fresh");
  comps.push({ name: "Volatility", score: vScore, value: vix ? r2(vix.price) : null, unit: "VIX level", reasons: vReasons, covered: !!vix, inputs: ["VIX"] });
  // Rates: US10Y 5-session change in bps; curve (10Y−3M or 10Y−2Y) as context.
  const t10 = get("US10Y");
  const t2 = get("US2Y") ?? get("US3M");
  let rScore: number | null = null;
  const rReasons: string[] = [];
  if (t10 && t10.chg5bps != null) {
    rScore = t10.chg5bps >= R.rates.shock5dBps ? -2 : t10.chg5bps > 10 ? -1 : t10.chg5bps <= R.rates.ease5dBps ? 1 : 0;
    rReasons.push(`US10Y ${r2(t10.price)}% (${t10.chg5bps >= 0 ? "+" : ""}${Math.round(t10.chg5bps)} bps / 5 sessions)`);
    if (t2) rReasons.push(`curve 10Y − ${t2.key} = ${Math.round((t10.price - t2.price) * 100)} bps`);
  } else rReasons.push("US10Y not fresh");
  comps.push({ name: "Rates", score: rScore, value: t10?.chg5bps != null ? Math.round(t10.chg5bps) : null, unit: "bps change in US10Y over 5 sessions", reasons: rReasons, covered: !!t10, inputs: ["US10Y", t2?.key ?? "US2Y"] });
  // Dollar: DXY 5d.
  const dxy = get("DXY");
  comps.push({
    name: "Dollar",
    score: dxy?.ret5d == null ? null : dxy.ret5d >= R.dollar.strong5dPct ? -2 : dxy.ret5d > 0.5 ? -1 : dxy.ret5d <= R.dollar.weak5dPct ? 1 : 0,
    value: dxy?.ret5d != null ? r2(dxy.ret5d) : null,
    unit: "% DXY change over 5 sessions",
    reasons: [dxy ? `DXY ${r2(dxy.price)} (${dxy.ret5d != null ? `${dxy.ret5d >= 0 ? "+" : ""}${r2(dxy.ret5d)}% / 5d` : "no 5d"})` : "DXY not fresh"],
    covered: !!dxy,
    inputs: ["DXY"],
  });
  // Commodities: Brent shock (hostile for India), copper trend (growth read).
  const brent = get("BRENT");
  const copper = get("COPPER");
  let cScore: number | null = null;
  const cReasons: string[] = [];
  if (brent?.ret5d != null) {
    cScore = brent.ret5d >= R.commodities.oilShock5dPct ? -2 : brent.ret5d > 3 ? -1 : brent.ret5d <= R.commodities.oilDrop5dPct ? 1 : 0;
    cReasons.push(`Brent ${r2(brent.price)} (${brent.ret5d >= 0 ? "+" : ""}${r2(brent.ret5d)}% / 5d)`);
  } else cReasons.push("Brent not fresh");
  if (copper?.ret20d != null) {
    cReasons.push(`copper ${copper.ret20d >= 0 ? "+" : ""}${r2(copper.ret20d)}% / 20d`);
    if (cScore != null) cScore = Math.max(-2, Math.min(2, cScore + (copper.ret20d >= R.commodities.copper20dPct ? 1 : copper.ret20d <= -R.commodities.copper20dPct ? -1 : 0)));
  }
  comps.push({ name: "Commodities", score: cScore, value: brent?.ret5d != null ? r2(brent.ret5d) : null, unit: "% Brent change over 5 sessions", reasons: cReasons, covered: !!brent, inputs: ["BRENT", "COPPER"] });
  // Credit: HY OAS when covered.
  const hy = get("HY_OAS");
  comps.push({
    name: "Credit",
    score: hy?.chg20bps == null ? null : hy.chg20bps >= R.credit.wideningBps ? -2 : hy.chg20bps > 15 ? -1 : hy.chg20bps < -15 ? 1 : 0,
    value: hy?.chg20bps != null ? Math.round(hy.chg20bps) : null,
    unit: "bps change in HY OAS over 20 sessions",
    reasons: [hy ? `HY OAS ${r2(hy.price)} bps` : "credit spreads not covered (no configured source)"],
    covered: !!hy,
    inputs: ["HY_OAS"],
  });
  // CrossAssetStress: number of covered components at −2.
  const hostile = comps.filter((c) => c.score === -2).length;
  const coveredComps = comps.filter((c) => c.covered);
  comps.push({
    name: "CrossAssetStress",
    score: hostile >= R.regime.stressedComponentsHostile ? -2 : hostile >= 2 ? -1 : hostile === 0 ? 1 : 0,
    value: hostile,
    unit: "components at −2",
    reasons: [`${hostile} of ${coveredComps.length} covered components at the hostile extreme`],
    covered: coveredComps.length >= 4,
    inputs: coveredComps.map((c) => c.name),
  });

  const scored = comps.filter((c) => c.score != null && c.name !== "CrossAssetStress");
  const score = scored.reduce((s, c) => s + (c.score as number), 0);
  let regime: GlobalRegime;
  if (hostile >= R.regime.stressedComponentsHostile || (vix && vix.price >= R.vix.stressed)) regime = "STRESSED";
  else if (score <= R.regime.riskOffScore) regime = "RISK_OFF";
  else if (score <= R.regime.cautiousScore) regime = "CAUTIOUS";
  else if (score >= R.regime.riskOnScore) regime = "RISK_ON";
  else regime = "NEUTRAL";
  const stale = obs.filter((o) => o.freshness === "STALE").length;
  const reasons = [
    `component score ${score} over ${scored.length} covered components (rules: risk-on ≥ ${R.regime.riskOnScore}, cautious ≤ ${R.regime.cautiousScore}, risk-off ≤ ${R.regime.riskOffScore}, stressed when ≥ ${R.regime.stressedComponentsHostile} components hostile or VIX ≥ ${R.vix.stressed})`,
    ...comps.filter((c) => c.covered).map((c) => `${c.name} ${c.score != null && c.score > 0 ? "+" : ""}${c.score}: ${c.reasons[0]}`),
    ...(missing.length ? [`not covered: ${[...new Set(missing)].join(", ")}`] : []),
  ];
  return { regime, score, components: comps, reasons, dataCoverage: { covered: scored.length, total: comps.length - 1, stale, missing: [...new Set(missing)] }, rules: R };
}
