/**
 * Valuation & quality read (valuation-quality-v1) — PURE.
 *
 * The honest answer to "is this cheap?" for a sub-₹100 stock. It does NOT
 * predict return — the system has no demonstrated stock-picking skill — it
 * describes value and, crucially, hunts VALUE TRAPS, because in this price band
 * "cheap" is usually cheap for a reason (losses, debt, promoters leaving).
 *
 * The anchor signal is the DCF margin of safety (intrinsic base case vs price),
 * which is assumption-sensitive and labelled as such. A low P/E alone is never
 * called undervalued: it must be paired with real quality (ROCE) and survive
 * the trap checks, or it is flagged CHEAP_BUT_RISKY / VALUE_TRAP instead.
 */

export const VALUATION_QUALITY_VERSION = "valuation-quality-v1";

export interface ValuationMetrics {
  pe: number | null;
  bookValuePerShare: number | null;
  roe: number | null; // %
  roce: number | null; // %
  deRatio: number | null; // debt / equity
  dcfBaseIntrinsic: number | null; // ₹ per share, base scenario
  promoterHolding: number | null; // %
  promoterChangeQoq: number | null; // pp
  operatingMargin: number | null; // %
  profitGrowthYoy: number | null; // %
}

export type ValuationVerdict =
  | "UNDERVALUED_QUALITY"
  | "CHEAP_BUT_RISKY"
  | "FAIR"
  | "EXPENSIVE"
  | "VALUE_TRAP"
  | "INSUFFICIENT_DATA";

export interface ValuationResult {
  version: string;
  pe: number | null;
  pb: number | null;
  roe: number | null;
  roce: number | null;
  deRatio: number | null;
  /** (intrinsic base − price) / price × 100. Positive = DCF says undervalued. */
  dcfMarginOfSafetyPct: number | null;
  promoterHolding: number | null;
  promoterChangeQoq: number | null;
  /** 0–100 descriptive "cheap AND quality AND not-a-trap". Null below min data. */
  valueScore: number | null;
  trapFlags: string[];
  isValueTrap: boolean;
  verdict: ValuationVerdict;
  notes: string[];
}

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
const r2 = (x: number): number => Math.round(x * 100) / 100;

export function computeValuation(m: ValuationMetrics, price: number | null): ValuationResult {
  const notes: string[] = [];
  const pb = m.bookValuePerShare != null && m.bookValuePerShare > 0 && price != null ? r2(price / m.bookValuePerShare) : null;
  const dcfMos = m.dcfBaseIntrinsic != null && m.dcfBaseIntrinsic > 0 && price != null && price > 0 ? r2(((m.dcfBaseIntrinsic - price) / price) * 100) : null;

  // ── Value-trap hunt (the point of this in penny-stock land) ──────────────
  const trapFlags: string[] = [];
  if (m.roe != null && m.roe < 0) trapFlags.push("loss-making (ROE negative)");
  if (m.profitGrowthYoy != null && m.profitGrowthYoy < -25) trapFlags.push(`profit collapsing (${r2(m.profitGrowthYoy)}% YoY)`);
  if (m.deRatio != null && m.deRatio > 2) trapFlags.push(`high leverage (D/E ${r2(m.deRatio)})`);
  if (m.promoterChangeQoq != null && m.promoterChangeQoq < -1) trapFlags.push(`promoters selling (${r2(m.promoterChangeQoq)}pp QoQ)`);
  if (m.promoterHolding != null && m.promoterHolding < 30) trapFlags.push(`low promoter holding (${r2(m.promoterHolding)}%)`);
  if (m.roce != null && m.roce < 8) trapFlags.push(`weak capital efficiency (ROCE ${r2(m.roce)}%)`);
  if (dcfMos != null && dcfMos < 0 && m.pe != null && m.pe < 12) trapFlags.push("cheap on P/E but DCF says overvalued — classic trap");

  // Severe flags make it a VALUE TRAP regardless of how cheap it looks.
  const severe = trapFlags.some((f) => f.startsWith("loss-making") || f.startsWith("profit collapsing") || f.startsWith("promoters selling") || f.startsWith("high leverage"));

  // Insufficient data: we have neither a DCF nor a quality read to judge on.
  if (dcfMos == null && m.roce == null && m.pe == null) {
    return {
      version: VALUATION_QUALITY_VERSION,
      pe: m.pe,
      pb,
      roe: m.roe,
      roce: m.roce,
      deRatio: m.deRatio,
      dcfMarginOfSafetyPct: dcfMos,
      promoterHolding: m.promoterHolding,
      promoterChangeQoq: m.promoterChangeQoq,
      valueScore: null,
      trapFlags,
      isValueTrap: false,
      verdict: "INSUFFICIENT_DATA",
      notes: ["Fundamentals not loaded for this name yet — refresh to populate."],
    };
  }

  // ── Descriptive value score: cheapness × quality, penalised by traps ─────
  // Cheapness from DCF margin of safety (preferred) or a P/E fallback.
  let cheapness: number;
  if (dcfMos != null) cheapness = clamp((dcfMos + 20) / 60, 0, 1); // −20%→0, +40%→1
  else if (m.pe != null && m.pe > 0) cheapness = clamp((25 - m.pe) / 20, 0, 1); // PE 25→0, PE 5→1
  else cheapness = 0.3;
  // Quality from ROCE (preferred) / ROE.
  const q = m.roce ?? m.roe;
  const quality = q != null ? clamp((q - 5) / 20, 0, 1) : 0.3; // 5%→0, 25%→1
  let valueScore = r2((0.55 * cheapness + 0.45 * quality) * 100);
  valueScore = r2(clamp(valueScore - trapFlags.length * 8, 0, 100));

  // ── Verdict ──────────────────────────────────────────────────────────────
  let verdict: ValuationVerdict;
  if (severe) {
    verdict = "VALUE_TRAP";
    notes.push("Looks cheap, but fails a hard quality/ownership check — avoid the trap.");
  } else if (dcfMos != null && dcfMos > 20 && q != null && q >= 12) {
    verdict = "UNDERVALUED_QUALITY";
    notes.push(`DCF base case ${dcfMos}% above price with ROCE ${r2(q)}% — genuinely cheap on these (assumption-sensitive) numbers.`);
  } else if ((dcfMos != null && dcfMos > 20) || (m.pe != null && m.pe > 0 && m.pe < 10)) {
    verdict = "CHEAP_BUT_RISKY";
    notes.push("Cheap, but quality is not strong enough to call it a quality bargain.");
  } else if (dcfMos != null && dcfMos < -25) {
    verdict = "EXPENSIVE";
  } else {
    verdict = "FAIR";
  }

  notes.push("Valuation is DESCRIPTIVE, not a buy signal: the system has no measured stock-picking skill, and the DCF is assumption-sensitive.");

  return {
    version: VALUATION_QUALITY_VERSION,
    pe: m.pe,
    pb,
    roe: m.roe,
    roce: m.roce,
    deRatio: m.deRatio,
    dcfMarginOfSafetyPct: dcfMos,
    promoterHolding: m.promoterHolding,
    promoterChangeQoq: m.promoterChangeQoq,
    valueScore,
    trapFlags,
    isValueTrap: severe,
    verdict,
    notes,
  };
}
