/**
 * NSE archives adapter for the security master. Public CSVs, no key:
 *   EQUITY_L.csv          main-board listings (EQ / BE / BZ series)
 *   SME_EQUITY_L.csv      SME platform (SM / ST series)
 *   REITS_L.csv, INVITS_L.csv
 *   eq_etfseclist.csv     ETFs
 *   symbolchange.csv, namechange.csv
 *   ind_*list.csv         index constituents with NSE's industry label
 * Every row is returned with its list source so classification is explicit.
 */

import { HealthTracker, IndexMembership, NameChangeRecord, ProviderHealth, SecurityListing, SecurityMasterProvider, SecurityMasterSnapshot, SymbolChangeRecord } from "./interfaces";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const ARCH = "https://nsearchives.nseindia.com";
const INDEX_FILES: Array<{ file: string; index: string }> = [
  { file: "ind_nifty100list.csv", index: "NIFTY100" },
  { file: "ind_nifty500list.csv", index: "NIFTY500" },
  { file: "ind_niftymidcap150list.csv", index: "MIDCAP150" },
  { file: "ind_niftysmallcap250list.csv", index: "SMALLCAP250" },
  { file: "ind_niftymicrocap250_list.csv", index: "MICROCAP250" },
  { file: "ind_niftytotalmarket_list.csv", index: "TOTALMARKET" },
];
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

export const csvRows = (s: string): string[][] => s.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split(",").map((c) => c.trim()));

/** "06-OCT-2008" | "08-Oct-26" → YYYY-MM-DD (two-digit years are 20xx). */
export function parseNseDate(s: string | undefined): string | null {
  if (!s) return null;
  const [dd, mon, yy] = s.split("-");
  const m = MONTHS.indexOf((mon ?? "").toUpperCase());
  if (m < 0 || !dd || !yy) return null;
  const year = yy.length === 2 ? `20${yy}` : yy;
  return `${year}-${String(m + 1).padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

function col(head: string[], ...names: string[]): number {
  const h = head.map((x) => x.toUpperCase().replace(/[^A-Z]/g, ""));
  for (const n of names) {
    const i = h.indexOf(n.toUpperCase().replace(/[^A-Z]/g, ""));
    if (i >= 0) return i;
  }
  return -1;
}

export function parseListingCsv(text: string, listSource: string): SecurityListing[] {
  const rows = csvRows(text);
  if (rows.length < 2) return [];
  const head = rows[0];
  const iSym = col(head, "SYMBOL"), iName = col(head, "NAME OF COMPANY", "NAME_OF_COMPANY", "SECURITYNAME"), iSer = col(head, "SERIES");
  const iList = col(head, "DATE OF LISTING", "DATE_OF_LISTING", "DATEOFLISTING"), iIsin = col(head, "ISIN NUMBER", "ISIN_NUMBER", "ISINNUMBER"), iFv = col(head, "FACE VALUE", "FACEVALUE");
  const out: SecurityListing[] = [];
  for (const r of rows.slice(1)) {
    const symbol = r[iSym];
    if (!symbol) continue;
    out.push({
      symbol,
      companyName: (iName >= 0 && r[iName]) || symbol,
      series: iSer >= 0 && r[iSer] ? r[iSer] : null,
      isin: iIsin >= 0 && r[iIsin] ? r[iIsin] : null,
      listedDate: iList >= 0 ? parseNseDate(r[iList]) : null,
      faceValue: iFv >= 0 && r[iFv] && Number.isFinite(Number(r[iFv])) ? Number(r[iFv]) : null,
      listSource,
    });
  }
  return out;
}

export function parseSymbolChanges(text: string): SymbolChangeRecord[] {
  // No header: company, old symbol, new symbol, date
  return csvRows(text)
    .filter((r) => r.length >= 4 && r[1] && r[2] && r[1] !== r[2] && !/^SM_/.test(r[1]))
    .map((r) => ({ companyName: r[0], oldSymbol: r[1], newSymbol: r[2], effectiveDate: parseNseDate(r[3]) }));
}
export function parseNameChanges(text: string): NameChangeRecord[] {
  const rows = csvRows(text);
  return rows.slice(1).filter((r) => r.length >= 4 && r[0]).map((r) => ({ symbol: r[0], oldName: r[1], newName: r[2], effectiveDate: parseNseDate(r[3]) }));
}
export function parseIndexList(text: string, index: string): IndexMembership[] {
  const rows = csvRows(text);
  if (rows.length < 2) return [];
  const s = col(rows[0], "SYMBOL"), ind = col(rows[0], "INDUSTRY");
  return rows.slice(1).filter((r) => r[s]).map((r) => ({ symbol: r[s], index, industry: ind >= 0 && r[ind] ? r[ind] : null }));
}

export class NseSecurityMasterProvider implements SecurityMasterProvider {
  readonly name = "nse-archives";
  private tracker = new HealthTracker(this.name);

  private async text(url: string): Promise<string> {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "*/*" }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`${url} → ${res.status}`);
    return res.text();
  }

  async fetchSnapshot(): Promise<SecurityMasterSnapshot> {
    const errors: string[] = [];
    const tryFetch = async <T>(label: string, url: string, parse: (t: string) => T, empty: T): Promise<T> => {
      try {
        const out = parse(await this.text(url));
        this.tracker.ok();
        return out;
      } catch (err) {
        this.tracker.fail(err);
        errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
        return empty;
      }
    };
    const main = await tryFetch("EQUITY_L", `${ARCH}/content/equities/EQUITY_L.csv`, (t) => parseListingCsv(t, "EQUITY_L"), [] as SecurityListing[]);
    if (main.length === 0) throw new Error(`NSE EQUITY_L unavailable: ${errors.join("; ")}`); // never wipe the master on a failed fetch
    const sme = await tryFetch("SME_EQUITY_L", `${ARCH}/emerge/corporates/content/SME_EQUITY_L.csv`, (t) => parseListingCsv(t, "SME_EQUITY_L"), [] as SecurityListing[]);
    const reits = await tryFetch("REITS_L", `${ARCH}/content/equities/REITS_L.csv`, (t) => parseListingCsv(t, "REITS_L"), [] as SecurityListing[]);
    const invits = await tryFetch("INVITS_L", `${ARCH}/content/equities/INVITS_L.csv`, (t) => parseListingCsv(t, "INVITS_L"), [] as SecurityListing[]);
    const etfs = await tryFetch("ETF", `${ARCH}/content/equities/eq_etfseclist.csv`, (t) => parseListingCsv(t, "ETF"), [] as SecurityListing[]);
    const symbolChanges = await tryFetch("symbolchange", `${ARCH}/content/equities/symbolchange.csv`, parseSymbolChanges, [] as SymbolChangeRecord[]);
    const nameChanges = await tryFetch("namechange", `${ARCH}/content/equities/namechange.csv`, parseNameChanges, [] as NameChangeRecord[]);
    const indexMemberships: IndexMembership[] = [];
    for (const f of INDEX_FILES) indexMemberships.push(...(await tryFetch(f.file, `${ARCH}/content/indices/${f.file}`, (t) => parseIndexList(t, f.index), [] as IndexMembership[])));
    return { source: this.name, fetchedAt: new Date().toISOString(), listings: [...main, ...sme, ...reits, ...invits, ...etfs], symbolChanges, nameChanges, indexMemberships, errors };
  }

  health(): ProviderHealth {
    return this.tracker.get();
  }
}

export const nseSecurityMasterProvider = new NseSecurityMasterProvider();
