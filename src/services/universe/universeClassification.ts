/**
 * Pure classification for the security master: instrument type from the list
 * + series, liquidity tier from median traded value, market-cap bucket from
 * NSE index membership (explicitly labelled as index-derived), activity from
 * the last trade date, and the diff that turns two snapshots into an
 * append-only change log. No I/O.
 */

import { IndexMembership, SecurityListing } from "./providers/interfaces";

export type InstrumentType = "EQUITY" | "ETF" | "REIT" | "INVIT" | "SME" | "OTHER";
export type LiquidityTier = "A" | "B" | "C" | "X";
export type MarketCapBucket = "LARGE" | "MID" | "SMALL" | "MICRO" | "UNKNOWN";

/** Configurable, in rupees of median daily traded value over the window. */
export const LIQUIDITY_TIERS = {
  windowSessions: 20,
  tierAMinInr: 1e8, // ≥ ₹10cr/day — short-term research/trading universe
  tierBMinInr: 2e7, // ₹2–10cr/day — medium liquidity
  tierCMinInr: 5e6, // ₹50L–2cr — research only
  inactiveAfterSessions: 20,
} as const;

export function classifyInstrumentType(l: SecurityListing): InstrumentType {
  if (l.listSource === "ETF") return "ETF";
  if (l.listSource === "REITS_L") return "REIT";
  if (l.listSource === "INVITS_L") return "INVIT";
  if (l.listSource === "SME_EQUITY_L" || l.series === "SM" || l.series === "ST" || l.series === "SZ") return "SME";
  if (/\b(REIT|REAL ESTATE INVESTMENT TRUST)\b/i.test(l.companyName)) return "REIT";
  if (/\b(INVIT|INFRASTRUCTURE INVESTMENT TRUST|INFRATRUST|INFRA TRUST)\b/i.test(l.companyName)) return "INVIT";
  if (l.listSource === "EQUITY_L") return "EQUITY";
  return "OTHER";
}

export function liquidityTierOf(medianValueInr: number | null): LiquidityTier {
  if (medianValueInr == null || !Number.isFinite(medianValueInr)) return "X";
  if (medianValueInr >= LIQUIDITY_TIERS.tierAMinInr) return "A";
  if (medianValueInr >= LIQUIDITY_TIERS.tierBMinInr) return "B";
  if (medianValueInr >= LIQUIDITY_TIERS.tierCMinInr) return "C";
  return "X";
}

/** NSE's own size indices are the only exchange-wide cap signal without a vendor; labelled as such. */
export function marketCapBucketFromIndices(indices: string[]): { bucket: MarketCapBucket; source: string } {
  const set = new Set(indices);
  if (set.has("NIFTY100")) return { bucket: "LARGE", source: "nse-index:NIFTY100" };
  if (set.has("MIDCAP150")) return { bucket: "MID", source: "nse-index:MIDCAP150" };
  if (set.has("SMALLCAP250")) return { bucket: "SMALL", source: "nse-index:SMALLCAP250" };
  if (set.has("MICROCAP250")) return { bucket: "MICRO", source: "nse-index:MICROCAP250" };
  if (set.has("NIFTY500")) return { bucket: "LARGE", source: "nse-index:NIFTY500-residual" };
  return { bucket: "UNKNOWN", source: "none" };
}

export function marketCapBucketFromValue(marketCapInr: number | null): MarketCapBucket {
  if (marketCapInr == null || !Number.isFinite(marketCapInr)) return "UNKNOWN";
  if (marketCapInr >= 5e11) return "LARGE"; // ≥ ₹50,000cr
  if (marketCapInr >= 1.5e11) return "MID"; // ₹15,000–50,000cr
  if (marketCapInr >= 2e10) return "SMALL"; // ₹2,000–15,000cr
  return "MICRO";
}

/** Tradable for the short-term universe: active, main-board equity in EQ series, tier A or B, no surveillance. */
export function isTradable(i: { instrumentType: InstrumentType; series: string | null; liquidityTier: LiquidityTier; isActive: boolean; surveillance: string | null }): boolean {
  return i.isActive && i.instrumentType === "EQUITY" && i.series === "EQ" && (i.liquidityTier === "A" || i.liquidityTier === "B") && !i.surveillance;
}

export interface MasterRowInput {
  symbol: string;
  companyName: string;
  isin: string | null;
  series: string | null;
  instrumentType: InstrumentType;
  listedDate: string | null;
  isActive: boolean;
}
export interface MasterChange {
  symbol: string;
  changeType: "NEW_LISTING" | "NAME_CHANGE" | "ISIN_CHANGE" | "SERIES_CHANGE" | "TYPE_CHANGE" | "DEACTIVATED" | "REACTIVATED" | "SYMBOL_CHANGE";
  oldValue: string | null;
  newValue: string | null;
}

/** Diff a fresh snapshot against the stored master. Listings absent from the snapshot are NOT deactivated here (that is activity-based). */
export function diffMaster(stored: Map<string, MasterRowInput>, fresh: MasterRowInput[]): MasterChange[] {
  const out: MasterChange[] = [];
  for (const f of fresh) {
    const s = stored.get(f.symbol);
    if (!s) {
      out.push({ symbol: f.symbol, changeType: "NEW_LISTING", oldValue: null, newValue: `${f.companyName}|${f.series ?? ""}|${f.isin ?? ""}` });
      continue;
    }
    if (s.companyName !== f.companyName) out.push({ symbol: f.symbol, changeType: "NAME_CHANGE", oldValue: s.companyName, newValue: f.companyName });
    if ((s.isin ?? null) !== (f.isin ?? null) && f.isin) out.push({ symbol: f.symbol, changeType: "ISIN_CHANGE", oldValue: s.isin, newValue: f.isin });
    if ((s.series ?? null) !== (f.series ?? null) && f.series) out.push({ symbol: f.symbol, changeType: "SERIES_CHANGE", oldValue: s.series, newValue: f.series });
    if (s.instrumentType !== f.instrumentType) out.push({ symbol: f.symbol, changeType: "TYPE_CHANGE", oldValue: s.instrumentType, newValue: f.instrumentType });
    if (!s.isActive && f.isActive) out.push({ symbol: f.symbol, changeType: "REACTIVATED", oldValue: "false", newValue: "true" });
  }
  return out;
}

/** Dedupe listings by symbol: main board wins over SME; REIT/InvIT/ETF lists win over a duplicate EQUITY_L row of the same symbol. */
export function dedupeListings(listings: SecurityListing[]): SecurityListing[] {
  const rank = (l: SecurityListing) => (l.listSource === "REITS_L" || l.listSource === "INVITS_L" || l.listSource === "ETF" ? 3 : l.listSource === "EQUITY_L" ? 2 : 1);
  const by = new Map<string, SecurityListing>();
  for (const l of listings) {
    const cur = by.get(l.symbol);
    if (!cur || rank(l) > rank(cur)) by.set(l.symbol, l);
  }
  return [...by.values()];
}

export function industryIndexMap(memberships: IndexMembership[]): { industry: Map<string, string>; indices: Map<string, string[]> } {
  const industry = new Map<string, string>();
  const indices = new Map<string, string[]>();
  for (const m of memberships) {
    if (m.industry && !industry.has(m.symbol)) industry.set(m.symbol, m.industry);
    indices.set(m.symbol, [...new Set([...(indices.get(m.symbol) ?? []), m.index])]);
  }
  return { industry, indices };
}

/** Activity: inactive when the last EQ trade is older than N sessions relative to the latest session in the feed. */
export function isActiveByTrade(lastTradeDate: string | null, latestSession: string | null, sessionDates: string[]): boolean {
  if (!lastTradeDate || !latestSession) return false;
  const idxLast = sessionDates.indexOf(lastTradeDate);
  const idxLatest = sessionDates.indexOf(latestSession);
  if (idxLast < 0 || idxLatest < 0) return lastTradeDate >= latestSession;
  return idxLatest - idxLast < LIQUIDITY_TIERS.inactiveAfterSessions;
}
