/**
 * Global asset universe + timezone/session rules (pure).
 *
 * Each instrument carries its exchange timezone and local session close so an
 * observation can be stamped with a UTC close and compared honestly against an
 * Indian decision cutoff. The leakage rule for India decisions:
 *   an observation is usable at India's close on session T only if its own
 *   UTC close is ≤ India's close on T (15:30 IST). US / Europe / US-settled
 *   commodities / FX close AFTER India's close, so their session T is NOT
 *   usable for T — only session T−1 is. Asian sessions close before 15:30 IST
 *   and are usable the same day.
 */

export type AssetClass = "EQUITY" | "VOLATILITY" | "RATES" | "FX" | "COMMODITY" | "CREDIT";
export type Region = "US" | "EUROPE" | "ASIA" | "INDIA" | "GLOBAL";

export interface GlobalInstrument {
  key: string; // stable id used everywhere
  name: string;
  yahoo: string | null; // null = no configured source (tracked as a coverage gap)
  assetClass: AssetClass;
  region: Region;
  tz: string;
  /** Local wall-clock close of a regular session, HH:MM. */
  localClose: string;
  /** Rates quoted in yield % (changes are in bps). */
  isYield?: boolean;
  /** For the India leakage rule: closes before India's 15:30 IST close on the same calendar date. */
  closesBeforeIndiaClose: boolean;
}

export const GLOBAL_UNIVERSE: GlobalInstrument[] = [
  // United States equities
  { key: "SPX", name: "S&P 500", yahoo: "^GSPC", assetClass: "EQUITY", region: "US", tz: "America/New_York", localClose: "16:00", closesBeforeIndiaClose: false },
  { key: "NDX", name: "NASDAQ 100", yahoo: "^NDX", assetClass: "EQUITY", region: "US", tz: "America/New_York", localClose: "16:00", closesBeforeIndiaClose: false },
  { key: "DJI", name: "Dow Jones", yahoo: "^DJI", assetClass: "EQUITY", region: "US", tz: "America/New_York", localClose: "16:00", closesBeforeIndiaClose: false },
  { key: "RUT", name: "Russell 2000", yahoo: "^RUT", assetClass: "EQUITY", region: "US", tz: "America/New_York", localClose: "16:00", closesBeforeIndiaClose: false },
  { key: "VIX", name: "VIX", yahoo: "^VIX", assetClass: "VOLATILITY", region: "US", tz: "America/Chicago", localClose: "15:15", closesBeforeIndiaClose: false },
  // US rates
  { key: "US2Y", name: "US 2Y yield", yahoo: "2YY=F", assetClass: "RATES", region: "US", tz: "America/New_York", localClose: "17:00", isYield: true, closesBeforeIndiaClose: false },
  { key: "US10Y", name: "US 10Y yield", yahoo: "^TNX", assetClass: "RATES", region: "US", tz: "America/Chicago", localClose: "15:00", isYield: true, closesBeforeIndiaClose: false },
  { key: "US30Y", name: "US 30Y yield", yahoo: "^TYX", assetClass: "RATES", region: "US", tz: "America/Chicago", localClose: "15:00", isYield: true, closesBeforeIndiaClose: false },
  { key: "US3M", name: "US 3M bill", yahoo: "^IRX", assetClass: "RATES", region: "US", tz: "America/Chicago", localClose: "15:00", isYield: true, closesBeforeIndiaClose: false },
  // Dollar / FX (Yahoo FX quotes are stamped in Europe/London; treated as a global 24h market with NY close)
  { key: "DXY", name: "US Dollar Index", yahoo: "DX-Y.NYB", assetClass: "FX", region: "US", tz: "America/New_York", localClose: "17:00", closesBeforeIndiaClose: false },
  { key: "EURUSD", name: "EUR/USD", yahoo: "EURUSD=X", assetClass: "FX", region: "GLOBAL", tz: "America/New_York", localClose: "17:00", closesBeforeIndiaClose: false },
  { key: "USDJPY", name: "USD/JPY", yahoo: "JPY=X", assetClass: "FX", region: "GLOBAL", tz: "America/New_York", localClose: "17:00", closesBeforeIndiaClose: false },
  { key: "USDCNH", name: "USD/CNH", yahoo: null, assetClass: "FX", region: "ASIA", tz: "Asia/Hong_Kong", localClose: "17:00", closesBeforeIndiaClose: false },
  { key: "USDINR", name: "USD/INR", yahoo: "INR=X", assetClass: "FX", region: "INDIA", tz: "Asia/Kolkata", localClose: "17:00", closesBeforeIndiaClose: false },
  // Europe
  { key: "STOXX600", name: "STOXX 600", yahoo: "^STOXX", assetClass: "EQUITY", region: "EUROPE", tz: "Europe/Zurich", localClose: "17:30", closesBeforeIndiaClose: false },
  { key: "DAX", name: "DAX", yahoo: "^GDAXI", assetClass: "EQUITY", region: "EUROPE", tz: "Europe/Berlin", localClose: "17:30", closesBeforeIndiaClose: false },
  { key: "FTSE", name: "FTSE 100", yahoo: "^FTSE", assetClass: "EQUITY", region: "EUROPE", tz: "Europe/London", localClose: "16:30", closesBeforeIndiaClose: false },
  { key: "CAC", name: "CAC 40", yahoo: "^FCHI", assetClass: "EQUITY", region: "EUROPE", tz: "Europe/Paris", localClose: "17:30", closesBeforeIndiaClose: false },
  { key: "SX5E", name: "Euro Stoxx 50", yahoo: "^STOXX50E", assetClass: "EQUITY", region: "EUROPE", tz: "Europe/Zurich", localClose: "17:30", closesBeforeIndiaClose: false },
  { key: "DE10Y", name: "German 10Y", yahoo: null, assetClass: "RATES", region: "EUROPE", tz: "Europe/Berlin", localClose: "17:30", isYield: true, closesBeforeIndiaClose: false },
  { key: "FR10Y", name: "French 10Y", yahoo: null, assetClass: "RATES", region: "EUROPE", tz: "Europe/Paris", localClose: "17:30", isYield: true, closesBeforeIndiaClose: false },
  // Asia
  { key: "NKY", name: "Nikkei 225", yahoo: "^N225", assetClass: "EQUITY", region: "ASIA", tz: "Asia/Tokyo", localClose: "15:30", closesBeforeIndiaClose: true },
  { key: "TOPIX", name: "TOPIX", yahoo: null, assetClass: "EQUITY", region: "ASIA", tz: "Asia/Tokyo", localClose: "15:30", closesBeforeIndiaClose: true },
  { key: "HSI", name: "Hang Seng", yahoo: "^HSI", assetClass: "EQUITY", region: "ASIA", tz: "Asia/Hong_Kong", localClose: "16:00", closesBeforeIndiaClose: true },
  { key: "CSI300", name: "CSI 300", yahoo: null, assetClass: "EQUITY", region: "ASIA", tz: "Asia/Shanghai", localClose: "15:00", closesBeforeIndiaClose: true },
  { key: "SHCOMP", name: "Shanghai Composite", yahoo: "000001.SS", assetClass: "EQUITY", region: "ASIA", tz: "Asia/Shanghai", localClose: "15:00", closesBeforeIndiaClose: true },
  { key: "KOSPI", name: "KOSPI", yahoo: "^KS11", assetClass: "EQUITY", region: "ASIA", tz: "Asia/Seoul", localClose: "15:30", closesBeforeIndiaClose: true },
  { key: "TWSE", name: "Taiwan Weighted", yahoo: "^TWII", assetClass: "EQUITY", region: "ASIA", tz: "Asia/Taipei", localClose: "13:30", closesBeforeIndiaClose: true },
  { key: "ASX", name: "ASX 200", yahoo: "^AXJO", assetClass: "EQUITY", region: "ASIA", tz: "Australia/Sydney", localClose: "16:00", closesBeforeIndiaClose: true },
  // Commodities (US-settled)
  { key: "BRENT", name: "Brent", yahoo: "BZ=F", assetClass: "COMMODITY", region: "GLOBAL", tz: "America/New_York", localClose: "14:30", closesBeforeIndiaClose: false },
  { key: "WTI", name: "WTI", yahoo: "CL=F", assetClass: "COMMODITY", region: "GLOBAL", tz: "America/New_York", localClose: "14:30", closesBeforeIndiaClose: false },
  { key: "GOLD", name: "Gold", yahoo: "GC=F", assetClass: "COMMODITY", region: "GLOBAL", tz: "America/New_York", localClose: "13:30", closesBeforeIndiaClose: false },
  { key: "SILVER", name: "Silver", yahoo: "SI=F", assetClass: "COMMODITY", region: "GLOBAL", tz: "America/New_York", localClose: "13:30", closesBeforeIndiaClose: false },
  { key: "COPPER", name: "Copper", yahoo: "HG=F", assetClass: "COMMODITY", region: "GLOBAL", tz: "America/New_York", localClose: "13:30", closesBeforeIndiaClose: false },
  // Credit
  { key: "HY_OAS", name: "US HY credit spread", yahoo: null, assetClass: "CREDIT", region: "US", tz: "America/New_York", localClose: "16:00", closesBeforeIndiaClose: false },
  // India (targets)
  { key: "NIFTY", name: "NIFTY 50", yahoo: "^NSEI", assetClass: "EQUITY", region: "INDIA", tz: "Asia/Kolkata", localClose: "15:30", closesBeforeIndiaClose: true },
  { key: "BANKNIFTY", name: "NIFTY Bank", yahoo: "^NSEBANK", assetClass: "EQUITY", region: "INDIA", tz: "Asia/Kolkata", localClose: "15:30", closesBeforeIndiaClose: true },
  { key: "NIFTYIT", name: "NIFTY IT", yahoo: "^CNXIT", assetClass: "EQUITY", region: "INDIA", tz: "Asia/Kolkata", localClose: "15:30", closesBeforeIndiaClose: true },
  { key: "NIFTYPHARMA", name: "NIFTY Pharma", yahoo: "^CNXPHARMA", assetClass: "EQUITY", region: "INDIA", tz: "Asia/Kolkata", localClose: "15:30", closesBeforeIndiaClose: true },
  { key: "INDIAVIX", name: "India VIX", yahoo: "^INDIAVIX", assetClass: "VOLATILITY", region: "INDIA", tz: "Asia/Kolkata", localClose: "15:30", closesBeforeIndiaClose: true },
];

/** Indian sector proxies built equal-weight from exchange closes by NSE industry (tier A/B constituents). */
export const INDIA_SECTOR_PROXIES: Array<{ key: string; name: string; industries: string[] }> = [
  { key: "SEC_FIN", name: "Financial services (proxy)", industries: ["Financial Services"] },
  { key: "SEC_IT", name: "Information technology (proxy)", industries: ["Information Technology"] },
  { key: "SEC_AUTO", name: "Auto (proxy)", industries: ["Automobile and Auto Components"] },
  { key: "SEC_METAL", name: "Metals & mining (proxy)", industries: ["Metals & Mining"] },
  { key: "SEC_PHARMA", name: "Healthcare / pharma (proxy)", industries: ["Healthcare"] },
  { key: "SEC_FMCG", name: "FMCG (proxy)", industries: ["Fast Moving Consumer Goods"] },
  { key: "SEC_ENERGY", name: "Oil, gas & power (proxy)", industries: ["Oil Gas & Consumable Fuels", "Power"] },
  { key: "SEC_CAPGOODS", name: "Capital goods & construction (proxy)", industries: ["Capital Goods", "Construction", "Construction Materials"] },
  { key: "SEC_CHEM", name: "Chemicals (proxy)", industries: ["Chemicals"] },
  { key: "SEC_CONSUMER", name: "Consumer services & durables (proxy)", industries: ["Consumer Services", "Consumer Durables", "Textiles", "Media Entertainment & Publication"] },
  { key: "SEC_REALTY", name: "Realty (proxy)", industries: ["Realty"] },
  { key: "SEC_TELECOM", name: "Telecom (proxy)", industries: ["Telecommunication"] },
];

export const INDIA_TZ = "Asia/Kolkata";
export const INDIA_CLOSE = "15:30";

/** Wall-clock parts of an instant in a timezone. */
export function partsIn(tz: string, at: Date): { date: string; hhmm: string; weekday: number } {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short" });
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return { date: `${p.year}-${p.month}-${p.day}`, hhmm: `${p.hour === "24" ? "00" : p.hour}:${p.minute}`, weekday: wd };
}

/** UTC instant of a local wall-clock time on a date in a timezone (DST-correct via offset search). */
const utcCache = new Map<string, number>();
export function localToUtc(tz: string, date: string, hhmm: string): Date {
  const ck = `${tz}|${date}|${hhmm}`;
  const hit = utcCache.get(ck);
  if (hit != null) return new Date(hit);
  const r = localToUtcUncached(tz, date, hhmm);
  if (utcCache.size > 200_000) utcCache.clear();
  utcCache.set(ck, r.getTime());
  return r;
}
function localToUtcUncached(tz: string, date: string, hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const guess = new Date(`${date}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);
  for (const offsetMin of [-840, -780, -720, -660, -600, -540, -480, -420, -360, -300, -240, -180, -120, -60, 0, 60, 120, 180, 240, 300, 330, 345, 360, 420, 480, 540, 570, 600, 660, 720, 780, 840]) {
    const cand = new Date(guess.getTime() - offsetMin * 60_000);
    const p = partsIn(tz, cand);
    if (p.date === date && p.hhmm === hhmm) return cand;
  }
  return guess;
}

export type MarketStatus = "OPEN" | "CLOSED" | "PRE_OPEN" | "WEEKEND";
/** Approximate regular-session status from the local clock (no holiday calendar; freshness carries the truth). */
export function marketStatusAt(inst: GlobalInstrument, at: Date, localOpen = defaultOpen(inst)): MarketStatus {
  const p = partsIn(inst.tz, at);
  if (inst.assetClass === "FX" || inst.assetClass === "COMMODITY") return p.weekday === 0 || p.weekday === 6 ? "WEEKEND" : "OPEN";
  if (p.weekday === 0 || p.weekday === 6) return "WEEKEND";
  if (p.hhmm < localOpen) return "PRE_OPEN";
  if (p.hhmm <= inst.localClose) return "OPEN";
  return "CLOSED";
}
function defaultOpen(inst: GlobalInstrument): string {
  if (inst.region === "US") return "09:30";
  if (inst.region === "EUROPE") return "08:00";
  if (inst.region === "INDIA") return "09:15";
  return "09:00";
}

/** Freshness of the last completed session relative to `now`, in session terms. */
export function observationFreshness(inst: GlobalInstrument, sessionDate: string, now: Date): "FRESH" | "DELAYED" | "STALE" {
  const closeUtc = localToUtc(inst.tz, sessionDate, inst.localClose);
  const ageH = (now.getTime() - closeUtc.getTime()) / 3_600_000;
  // A completed session is FRESH until the next local session has closed (≈ 24h + weekend slack), DELAYED up to 4 days, STALE after.
  const weekendSlack = partsIn(inst.tz, now).weekday <= 1 ? 72 : 0;
  if (ageH <= 30 + weekendSlack) return "FRESH";
  if (ageH <= 96 + weekendSlack) return "DELAYED";
  return "STALE";
}

/**
 * The India leakage rule. Returns the latest session date of `inst` that is
 * usable for a decision at India's close on `indiaSession`.
 */
export function usableSessionFor(inst: GlobalInstrument, indiaSession: string, sessions: string[]): string | null {
  const ordered = [...sessions].sort();
  let best: string | null = null;
  for (const d of ordered) {
    if (inst.closesBeforeIndiaClose ? d <= indiaSession : d < indiaSession) best = d;
    else break;
  }
  return best;
}

/** Explicit instant comparison used by tests and the snapshot builder. */
export function closedBeforeCutoff(inst: GlobalInstrument, sessionDate: string, cutoffUtc: Date): boolean {
  return localToUtc(inst.tz, sessionDate, inst.localClose).getTime() <= cutoffUtc.getTime();
}

export function instrumentByKey(key: string): GlobalInstrument | undefined {
  return GLOBAL_UNIVERSE.find((i) => i.key === key);
}
