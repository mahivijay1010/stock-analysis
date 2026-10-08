/**
 * India Market Diagnosis (pure) — roadmap §4.5, Milestone 1.
 *
 * Classifies the Indian market environment from closed-session data only:
 *   Trend (NIFTY)            the existing RegimeService assessment, mapped
 *   Financials (BANKNIFTY)   20-session return and relative strength vs NIFTY
 *   Volatility (India VIX)   level bands + 5-session spike
 *   Breadth                  exchange-wide advances/declines from the delivery feed
 *   Turnover                 total traded value vs its 20-session median, read with breadth
 *   INR (USD/INR)            5-session change (a rising pair = rupee weakness)
 *   SectorRelStrength        share of sector proxies beating NIFTY over 20 sessions
 *   FII/DII flows            NOT COVERED — no reliable keyless source; stated, never faked
 *
 * Output state STRONG / NEUTRAL / WEAK / STRESSED is diagnostic context.
 * The authoritative gate input remains shortterm/RegimeService (TREND_UP…CRISIS);
 * nothing here feeds position sizing directly.
 */

export const INDIA_MARKET_VERSION = "india-market-v1";

export interface BreadthDay {
  date: string;
  advances: number;
  declines: number;
  counted: number; // symbols with a prior close
  turnoverInr: number;
}

export interface IndiaInputs {
  /** Ascending, last element = the diagnosed session. Point-in-time: nothing after it. */
  breadth: BreadthDay[];
  /** NIFTY closes by date (ascending). */
  nifty: Array<{ date: string; close: number }>;
  bankNifty: Array<{ date: string; close: number }> | null;
  indiaVix: Array<{ date: string; close: number }> | null;
  usdInr: Array<{ date: string; close: number }> | null;
  /** 20-session return of each sector proxy minus NIFTY's, % — precomputed by the caller for the same cutoff. */
  sectorRelStrength20: Array<{ sector: string; name: string; relPct: number }> | null;
  /** The authoritative regime at this cutoff (RegimeService), passed through for display. */
  authoritativeRegime: { regime: string; reasons: string[] } | null;
}

export interface IndiaComponent {
  name: "Trend" | "Financials" | "Volatility" | "Breadth" | "Turnover" | "INR" | "SectorRelStrength" | "FIIDIIFlows";
  score: number | null; // −2 hostile … +2 supportive; null = not covered
  value: number | null;
  unit: string;
  reasons: string[];
  covered: boolean;
}

export type IndiaState = "STRONG" | "NEUTRAL" | "WEAK" | "STRESSED";

export interface IndiaDiagnosis {
  version: string;
  sessionDate: string;
  state: IndiaState;
  score: number;
  components: IndiaComponent[];
  reasons: string[];
  coverage: { covered: number; total: number; missing: string[] };
  authoritativeRegime: { regime: string; reasons: string[] } | null;
  rules: typeof INDIA_RULES;
}

export const INDIA_RULES = {
  trend: { fromRegime: { TREND_UP: 2, CHOPPY: 0, HIGH_VOL: -1, TREND_DOWN: -2, CRISIS: -2 } as Record<string, number> },
  financials: { strong20dPct: 3, weak20dPct: -3 },
  vix: { calm: 14, normal: 18, elevated: 22, high: 28, spike5dPct: 25 },
  breadth: { strongShare: 0.6, weakShare: 0.4, window: 20 },
  turnover: { highRatio: 1.3, lowRatio: 0.7, window: 20 },
  inr: { weak5dPct: 0.5, shock5dPct: 1.5, strong5dPct: -0.5 },
  sectors: { broadShare: 0.6, narrowShare: 0.3 },
  state: { strongScore: 4, weakScore: -3, stressedScore: -6, stressedHostile: 3 },
} as const;

const r2 = (v: number): number => Math.round(v * 100) / 100;
const pct = (a: number, b: number): number => (a > 0 ? ((b - a) / a) * 100 : 0);
const retN = (series: Array<{ date: string; close: number }>, k: number): number | null => {
  const n = series.length;
  return n > k && series[n - 1 - k].close > 0 ? r2(pct(series[n - 1 - k].close, series[n - 1].close)) : null;
};
const median = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function computeIndiaDiagnosis(inputs: IndiaInputs): IndiaDiagnosis | null {
  const b = inputs.breadth;
  if (!b.length) return null;
  const sessionDate = b[b.length - 1].date;
  if (inputs.nifty.some((p) => p.date > sessionDate) || b.some((p) => p.date > sessionDate)) {
    throw new Error(`leakage: inputs contain points after the diagnosed session ${sessionDate}`);
  }
  const R = INDIA_RULES;
  const comps: IndiaComponent[] = [];
  const missing: string[] = [];

  // Trend — mapped from the authoritative regime so the two never disagree on direction.
  const reg = inputs.authoritativeRegime;
  comps.push({
    name: "Trend",
    score: reg ? (R.trend.fromRegime[reg.regime] ?? 0) : null,
    value: retN(inputs.nifty, 20),
    unit: "% NIFTY 20-session return",
    reasons: reg ? [`authoritative regime ${reg.regime}: ${reg.reasons[0] ?? ""}`] : ["regime unavailable"],
    covered: !!reg,
  });

  // Financials — BANKNIFTY absolute and relative.
  const bn20 = inputs.bankNifty ? retN(inputs.bankNifty, 20) : null;
  const n20 = retN(inputs.nifty, 20);
  const rel = bn20 != null && n20 != null ? r2(bn20 - n20) : null;
  comps.push({
    name: "Financials",
    score: bn20 == null ? null : bn20 >= R.financials.strong20dPct ? 2 : bn20 > 0 ? 1 : bn20 <= R.financials.weak20dPct ? -2 : -1,
    value: bn20,
    unit: "% BANKNIFTY 20-session return",
    reasons: [bn20 == null ? "BANKNIFTY series unavailable" : `BANKNIFTY ${bn20 >= 0 ? "+" : ""}${bn20}% / 20 sessions${rel != null ? ` (${rel >= 0 ? "+" : ""}${rel} pp vs NIFTY)` : ""}`],
    covered: bn20 != null,
  });
  if (bn20 == null) missing.push("BANKNIFTY");

  // Volatility — India VIX level + spike.
  const vix = inputs.indiaVix?.length ? inputs.indiaVix[inputs.indiaVix.length - 1].close : null;
  const vixSpike = inputs.indiaVix ? retN(inputs.indiaVix, 5) : null;
  let vScore: number | null = null;
  const vReasons: string[] = [];
  if (vix != null) {
    vScore = vix < R.vix.calm ? 2 : vix < R.vix.normal ? 1 : vix < R.vix.elevated ? 0 : vix < R.vix.high ? -1 : -2;
    vReasons.push(`India VIX ${r2(vix)}`);
    if (vixSpike != null && vixSpike >= R.vix.spike5dPct) {
      vScore = Math.max(-2, vScore - 1);
      vReasons.push(`+${vixSpike}% over 5 sessions (spike)`);
    }
  } else {
    vReasons.push("India VIX unavailable");
    missing.push("INDIAVIX");
  }
  comps.push({ name: "Volatility", score: vScore, value: vix != null ? r2(vix) : null, unit: "India VIX level", reasons: vReasons, covered: vix != null });

  // Breadth — today's advance share and the 20-session mean share.
  const last = b[b.length - 1];
  const todayShare = last.counted > 0 ? last.advances / last.counted : null;
  const win = b.slice(-R.breadth.window).filter((d) => d.counted > 0);
  const meanShare = win.length ? win.reduce((s, d) => s + d.advances / d.counted, 0) / win.length : null;
  comps.push({
    name: "Breadth",
    score:
      meanShare == null || todayShare == null
        ? null
        : meanShare >= R.breadth.strongShare && todayShare >= 0.5
          ? 2
          : meanShare > 0.5
            ? 1
            : meanShare <= R.breadth.weakShare
              ? -2
              : meanShare < 0.5
                ? -1
                : 0,
    value: todayShare != null ? r2(todayShare * 100) : null,
    unit: "% of EQ symbols advancing",
    reasons: [
      todayShare != null ? `${last.advances} advances / ${last.declines} declines of ${last.counted} EQ symbols on ${last.date}` : "no breadth data",
      ...(meanShare != null ? [`${R.breadth.window}-session mean advance share ${r2(meanShare * 100)}%`] : []),
    ],
    covered: todayShare != null && win.length >= 10,
  });

  // Turnover — participation, read WITH breadth (high turnover on weak breadth = distribution).
  const med = win.length >= 10 ? median(win.map((d) => d.turnoverInr)) : null;
  const ratio = med && med > 0 ? r2(last.turnoverInr / med) : null;
  let tScore: number | null = null;
  const tReasons: string[] = [];
  if (ratio != null && todayShare != null) {
    if (ratio >= R.turnover.highRatio) {
      tScore = todayShare >= 0.5 ? 1 : -1;
      tReasons.push(`turnover ${ratio}× its 20-session median with ${todayShare >= 0.5 ? "positive" : "negative"} breadth (${tScore > 0 ? "accumulation-like participation" : "distribution-like participation"})`);
    } else if (ratio <= R.turnover.lowRatio) {
      tScore = 0;
      tReasons.push(`turnover ${ratio}× median — thin participation, moves carry less information`);
    } else {
      tScore = 0;
      tReasons.push(`turnover ${ratio}× its 20-session median (normal)`);
    }
  } else tReasons.push("turnover history insufficient");
  comps.push({ name: "Turnover", score: tScore, value: ratio, unit: "× of 20-session median traded value", reasons: tReasons, covered: ratio != null });

  // INR — USD/INR 5-session change (up = rupee weaker).
  const inr5 = inputs.usdInr ? retN(inputs.usdInr, 5) : null;
  comps.push({
    name: "INR",
    score: inr5 == null ? null : inr5 >= R.inr.shock5dPct ? -2 : inr5 >= R.inr.weak5dPct ? -1 : inr5 <= R.inr.strong5dPct ? 1 : 0,
    value: inr5,
    unit: "% USD/INR change over 5 sessions",
    reasons: [inr5 == null ? "USD/INR unavailable" : `USD/INR ${inr5 >= 0 ? "+" : ""}${inr5}% / 5 sessions (${inr5 >= R.inr.weak5dPct ? "rupee weakening" : inr5 <= R.inr.strong5dPct ? "rupee strengthening" : "stable"})`],
    covered: inr5 != null,
  });
  if (inr5 == null) missing.push("USDINR");

  // Sector relative strength — how broad the leadership is.
  const sec = inputs.sectorRelStrength20;
  if (sec && sec.length >= 5) {
    const beating = sec.filter((s) => s.relPct > 0);
    const share = beating.length / sec.length;
    const top = [...sec].sort((a, b) => b.relPct - a.relPct)[0];
    const bottom = [...sec].sort((a, b) => a.relPct - b.relPct)[0];
    comps.push({
      name: "SectorRelStrength",
      score: share >= R.sectors.broadShare ? 1 : share <= R.sectors.narrowShare ? -1 : 0,
      value: r2(share * 100),
      unit: "% of sector proxies beating NIFTY over 20 sessions",
      reasons: [`${beating.length} of ${sec.length} sectors ahead of NIFTY; strongest ${top.name} ${top.relPct >= 0 ? "+" : ""}${r2(top.relPct)} pp, weakest ${bottom.name} ${r2(bottom.relPct)} pp`],
      covered: true,
    });
  } else {
    comps.push({ name: "SectorRelStrength", score: null, value: null, unit: "% of sector proxies beating NIFTY", reasons: ["sector proxies unavailable"], covered: false });
    missing.push("SECTOR_PROXIES");
  }

  // FII/DII — honestly not covered.
  comps.push({ name: "FIIDIIFlows", score: null, value: null, unit: "net ₹cr", reasons: ["no reliable keyless source configured — tracked as a data gap, never estimated"], covered: false });
  missing.push("FII_DII");

  const scored = comps.filter((c) => c.score != null);
  const score = scored.reduce((s, c) => s + (c.score as number), 0);
  const hostile = comps.filter((c) => c.score === -2).length;
  const state: IndiaState =
    hostile >= R.state.stressedHostile || score <= R.state.stressedScore ? "STRESSED" : score <= R.state.weakScore ? "WEAK" : score >= R.state.strongScore ? "STRONG" : "NEUTRAL";
  return {
    version: INDIA_MARKET_VERSION,
    sessionDate,
    state,
    score,
    components: comps,
    reasons: [
      `component score ${score} over ${scored.length} covered components (strong ≥ ${R.state.strongScore}, weak ≤ ${R.state.weakScore}, stressed ≤ ${R.state.stressedScore} or ≥ ${R.state.stressedHostile} hostile components)`,
      ...comps.filter((c) => c.covered).map((c) => `${c.name} ${c.score != null && c.score > 0 ? "+" : ""}${c.score}: ${c.reasons[0]}`),
      ...(missing.length ? [`not covered: ${[...new Set(missing)].join(", ")}`] : []),
    ],
    coverage: { covered: scored.length, total: comps.length, missing: [...new Set(missing)] },
    authoritativeRegime: inputs.authoritativeRegime,
    rules: R,
  };
}
