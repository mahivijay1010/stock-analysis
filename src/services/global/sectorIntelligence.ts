/**
 * Sector Intelligence (pure) — roadmap §6, Milestone 2.
 *
 * Classifies each Indian sector proxy as STRONG / NEUTRAL / WEAK / STRESSED
 * from closed-session data: trend of the equal-weight proxy, relative strength
 * vs NIFTY, momentum, constituent breadth, turnover (read with breadth),
 * realized volatility, and the measured global transmission label when one is
 * active. Diagnostic context only — nothing here sizes a position.
 */

export const SECTOR_INTEL_VERSION = "sector-intel-v1";

export interface SectorBreadthDay {
  date: string;
  advances: number;
  declines: number;
  counted: number;
  turnoverInr: number;
}

export interface SectorInputs {
  sector: string;
  name: string;
  /** Equal-weight proxy level series, ascending; last point = diagnosed session. */
  proxy: Array<{ date: string; value: number }>;
  nifty: Array<{ date: string; close: number }>;
  /** Constituent breadth/turnover per session for this sector's industries, ascending. */
  breadth: SectorBreadthDay[];
  /** Measured global transmission for this sector (active shocks × displayable betas), or null. */
  globalImpact: { label: "TAILWIND" | "NEUTRAL" | "HEADWIND" | "STRESS"; reason: string } | null;
}

export interface SectorComponent {
  name: "Trend" | "RelStrength" | "Momentum" | "Breadth" | "Turnover" | "Volatility" | "GlobalTransmission";
  score: number | null;
  value: number | null;
  unit: string;
  reasons: string[];
  covered: boolean;
}

export type SectorState = "STRONG" | "NEUTRAL" | "WEAK" | "STRESSED";

export interface SectorRegime {
  version: string;
  sector: string;
  name: string;
  sessionDate: string;
  state: SectorState;
  score: number;
  components: SectorComponent[];
  reasons: string[];
}

export const SECTOR_RULES = {
  trend: { strong20dPct: 3, weak20dPct: -3 },
  rel: { strongPp: 2, weakPp: -2 },
  momentum: { up5dPct: 1, down5dPct: -1 },
  breadth: { strongShare: 0.6, weakShare: 0.4, window: 20 },
  turnover: { highRatio: 1.3, lowRatio: 0.7 },
  vol: { calmAnnPct: 18, highAnnPct: 35, extremeAnnPct: 50 },
  state: { strongScore: 4, weakScore: -3, stressedScore: -6, stressedHostile: 3 },
} as const;

const r2 = (v: number): number => Math.round(v * 100) / 100;
const pct = (a: number, b: number): number => (a > 0 ? ((b - a) / a) * 100 : 0);
const median = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function computeSectorRegime(i: SectorInputs): SectorRegime | null {
  if (i.proxy.length < 25) return null;
  const sessionDate = i.proxy[i.proxy.length - 1].date;
  if (i.nifty.some((p) => p.date > sessionDate) || i.breadth.some((p) => p.date > sessionDate)) {
    throw new Error(`leakage: sector inputs contain points after ${sessionDate}`);
  }
  const R = SECTOR_RULES;
  const comps: SectorComponent[] = [];
  const vals = i.proxy.map((p) => p.value);
  const n = vals.length;
  const retN = (k: number): number | null => (n > k && vals[n - 1 - k] > 0 ? r2(pct(vals[n - 1 - k], vals[n - 1])) : null);
  const sma = (k: number): number | null => (n >= k ? vals.slice(-k).reduce((a, b) => a + b, 0) / k : null);

  // Trend: 20d return + position vs SMA20.
  const r20 = retN(20);
  const s20 = sma(20);
  comps.push({
    name: "Trend",
    score: r20 == null ? null : r20 >= R.trend.strong20dPct ? 2 : r20 > 0 ? 1 : r20 <= R.trend.weak20dPct ? -2 : -1,
    value: r20,
    unit: "% proxy 20-session return",
    reasons: [r20 == null ? "insufficient proxy history" : `${r20 >= 0 ? "+" : ""}${r20}% / 20 sessions${s20 != null ? `, ${vals[n - 1] >= s20 ? "above" : "below"} its 20-session average` : ""}`],
    covered: r20 != null,
  });
  // Relative strength vs NIFTY (20 sessions).
  const nf = i.nifty.filter((p) => p.date <= sessionDate);
  const nret = nf.length > 20 && nf[nf.length - 21].close > 0 ? r2(pct(nf[nf.length - 21].close, nf[nf.length - 1].close)) : null;
  const rel = r20 != null && nret != null ? r2(r20 - nret) : null;
  comps.push({
    name: "RelStrength",
    score: rel == null ? null : rel >= R.rel.strongPp ? 2 : rel > 0 ? 1 : rel <= R.rel.weakPp ? -2 : -1,
    value: rel,
    unit: "pp vs NIFTY over 20 sessions",
    reasons: [rel == null ? "NIFTY alignment unavailable" : `${rel >= 0 ? "+" : ""}${rel} pp vs NIFTY (sector ${r20}%, NIFTY ${nret}%)`],
    covered: rel != null,
  });
  // Momentum: 5-session return.
  const r5 = retN(5);
  comps.push({
    name: "Momentum",
    score: r5 == null ? null : r5 >= R.momentum.up5dPct ? 1 : r5 <= R.momentum.down5dPct ? -1 : 0,
    value: r5,
    unit: "% proxy 5-session return",
    reasons: [r5 == null ? "insufficient history" : `${r5 >= 0 ? "+" : ""}${r5}% / 5 sessions`],
    covered: r5 != null,
  });
  // Breadth within the sector.
  const bdays = i.breadth.filter((b) => b.counted > 0);
  const last = bdays[bdays.length - 1];
  const todayShare = last && last.date === sessionDate ? last.advances / last.counted : null;
  const win = bdays.slice(-R.breadth.window);
  const meanShare = win.length >= 10 ? win.reduce((s, d) => s + d.advances / d.counted, 0) / win.length : null;
  comps.push({
    name: "Breadth",
    score: meanShare == null ? null : meanShare >= R.breadth.strongShare ? 2 : meanShare > 0.5 ? 1 : meanShare <= R.breadth.weakShare ? -2 : meanShare < 0.5 ? -1 : 0,
    value: todayShare != null ? r2(todayShare * 100) : null,
    unit: "% of constituents advancing",
    reasons: [
      last ? `${last.advances} advances / ${last.declines} declines of ${last.counted} constituents on ${last.date}` : "no constituent data",
      ...(meanShare != null ? [`${R.breadth.window}-session mean advance share ${r2(meanShare * 100)}%`] : []),
    ],
    covered: meanShare != null,
  });
  // Turnover with breadth.
  const med = win.length >= 10 ? median(win.map((d) => d.turnoverInr)) : null;
  const ratio = last && med && med > 0 ? r2(last.turnoverInr / med) : null;
  let tScore: number | null = null;
  const tReasons: string[] = [];
  if (ratio != null && todayShare != null) {
    if (ratio >= R.turnover.highRatio) {
      tScore = todayShare >= 0.5 ? 1 : -1;
      tReasons.push(`turnover ${ratio}× its 20-session median with ${todayShare >= 0.5 ? "positive" : "negative"} breadth`);
    } else {
      tScore = 0;
      tReasons.push(`turnover ${ratio}× its 20-session median${ratio <= R.turnover.lowRatio ? " (thin)" : ""}`);
    }
  } else tReasons.push("turnover history insufficient");
  comps.push({ name: "Turnover", score: tScore, value: ratio, unit: "× of 20-session median traded value", reasons: tReasons, covered: ratio != null });
  // Realized volatility (20 sessions, annualized).
  const lr: number[] = [];
  for (let k = Math.max(1, n - 20); k < n; k++) if (vals[k - 1] > 0) lr.push(Math.log(vals[k] / vals[k - 1]));
  const mean = lr.length ? lr.reduce((a, b) => a + b, 0) / lr.length : 0;
  const vol = lr.length > 1 ? r2(Math.sqrt(lr.reduce((a, x) => a + (x - mean) ** 2, 0) / (lr.length - 1)) * Math.sqrt(252) * 100) : null;
  comps.push({
    name: "Volatility",
    score: vol == null ? null : vol >= R.vol.extremeAnnPct ? -2 : vol >= R.vol.highAnnPct ? -1 : vol <= R.vol.calmAnnPct ? 1 : 0,
    value: vol,
    unit: "% annualized (20 sessions)",
    reasons: [vol == null ? "insufficient history" : `realized vol ${vol}% annualized`],
    covered: vol != null,
  });
  // Global transmission (measured; label NEUTRAL when nothing displayable is active).
  const g = i.globalImpact;
  comps.push({
    name: "GlobalTransmission",
    score: g == null ? null : g.label === "TAILWIND" ? 1 : g.label === "HEADWIND" ? -1 : g.label === "STRESS" ? -2 : 0,
    value: null,
    unit: "measured shock × sensitivity",
    reasons: [g ? `${g.label.toLowerCase()}: ${g.reason}` : "no global snapshot for this session"],
    covered: g != null,
  });

  const scored = comps.filter((c) => c.score != null);
  const score = scored.reduce((s, c) => s + (c.score as number), 0);
  const hostile = comps.filter((c) => c.score === -2).length;
  const state: SectorState =
    hostile >= R.state.stressedHostile || score <= R.state.stressedScore ? "STRESSED" : score <= R.state.weakScore ? "WEAK" : score >= R.state.strongScore ? "STRONG" : "NEUTRAL";
  return {
    version: SECTOR_INTEL_VERSION,
    sector: i.sector,
    name: i.name,
    sessionDate,
    state,
    score,
    components: comps,
    reasons: [
      `score ${score} over ${scored.length} covered components (strong ≥ ${R.state.strongScore}, weak ≤ ${R.state.weakScore}, stressed ≤ ${R.state.stressedScore} or ≥ ${R.state.stressedHostile} hostile)`,
      ...comps.filter((c) => c.covered).map((c) => `${c.name} ${c.score != null && c.score > 0 ? "+" : ""}${c.score}: ${c.reasons[0]}`),
    ],
  };
}

/** Map a diagnostic sector state onto the Money Desk environment vocabulary. */
export function sectorStateToEnv(state: SectorState): "TAILWIND" | "NEUTRAL" | "HEADWIND" | "STRESS" {
  return state === "STRONG" ? "TAILWIND" : state === "WEAK" ? "HEADWIND" : state === "STRESSED" ? "STRESS" : "NEUTRAL";
}
const ENV_ORDER = { TAILWIND: 0, NEUTRAL: 1, HEADWIND: 2, STRESS: 3 } as const;
/** The more cautious of two environment labels (context only — never a veto). */
export function combineEnv(a: keyof typeof ENV_ORDER, b: keyof typeof ENV_ORDER): keyof typeof ENV_ORDER {
  return ENV_ORDER[a] >= ENV_ORDER[b] ? a : b;
}
