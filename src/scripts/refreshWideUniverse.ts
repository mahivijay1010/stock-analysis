/**
 * Refresh the wide-universe master (nse_securities) and the exchange
 * surveillance facts (stock_knowledge kind=SURVEILLANCE).
 *
 *   npx ts-node --transpile-only src/scripts/refreshWideUniverse.ts
 *
 * Sources (all NSE, all public):
 *  - EQUITY_L.csv                 every listed EQ symbol, name, ISIN, listing date
 *  - ind_*list.csv                index constituents WITH NSE's industry label
 *  - /api/reportASM, /api/reportGSM  today's ASM / GSM / ESM / IBC lists
 *    (needs a cookie from a prior www.nseindia.com request — the site
 *    answers 403 to the first hit and 200 to the second with its cookie).
 *
 * Surveillance rows are appended with observed_at = today; the screen reads
 * the latest observation date only, so a stock that LEAVES the list drops
 * out the next day without anything being deleted.
 */
import { AppDataSource } from "../config/database";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const ARCH = "https://nsearchives.nseindia.com/content";
const INDEX_FILES: Array<{ file: string; index: string }> = [
  { file: "ind_nifty500list.csv", index: "NIFTY500" },
  { file: "ind_niftymidcap150list.csv", index: "MIDCAP150" },
  { file: "ind_niftysmallcap250list.csv", index: "SMALLCAP250" },
  { file: "ind_niftymicrocap250_list.csv", index: "MICROCAP250" },
  { file: "ind_niftytotalmarket_list.csv", index: "TOTALMARKET" },
];
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

async function text(url: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "*/*", ...headers } });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.text();
}

/** Minimal CSV split (NSE files have no quoted commas in the columns we use). */
const csv = (s: string) => s.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split(",").map((c) => c.trim()));

function listingDate(s: string): string | null {
  const [dd, mon, yyyy] = s.split("-");
  const m = MONTHS.indexOf((mon ?? "").toUpperCase());
  return m < 0 ? null : `${yyyy}-${String(m + 1).padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

export async function refreshMaster(): Promise<{ securities: number; withIndustry: number }> {
  const rows = csv(await text(`${ARCH}/equities/EQUITY_L.csv`));
  const head = rows[0].map((h) => h.toUpperCase());
  const ix = (k: string) => head.findIndex((h) => h === k);
  const iSym = ix("SYMBOL"), iName = ix("NAME OF COMPANY"), iSer = ix("SERIES"), iList = ix("DATE OF LISTING"), iIsin = ix("ISIN NUMBER"), iFv = ix("FACE VALUE");

  const industry = new Map<string, string>();
  const indices = new Map<string, string[]>();
  for (const f of INDEX_FILES) {
    try {
      const r = csv(await text(`${ARCH}/indices/${f.file}`));
      const h = r[0].map((x) => x.toUpperCase());
      const s = h.indexOf("SYMBOL"), ind = h.indexOf("INDUSTRY");
      for (const row of r.slice(1)) {
        if (!row[s]) continue;
        if (ind >= 0 && row[ind]) industry.set(row[s], row[ind]);
        indices.set(row[s], [...(indices.get(row[s]) ?? []), f.index]);
      }
    } catch (e) {
      console.warn(`[universe] ${f.file}: ${e instanceof Error ? e.message : e}`);
    }
  }

  let n = 0;
  for (const r of rows.slice(1)) {
    if (r[iSer] !== "EQ" || !r[iSym]) continue;
    await AppDataSource.query(
      `INSERT INTO nse_securities (symbol, company_name, isin, listing_date, face_value, industry, indices, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now())
       ON CONFLICT (symbol) DO UPDATE SET company_name = EXCLUDED.company_name, isin = EXCLUDED.isin, listing_date = EXCLUDED.listing_date,
         face_value = EXCLUDED.face_value, industry = COALESCE(EXCLUDED.industry, nse_securities.industry), indices = EXCLUDED.indices, updated_at = now()`,
      [r[iSym], r[iName], r[iIsin] || null, listingDate(r[iList] ?? ""), Number(r[iFv]) || null, industry.get(r[iSym]) ?? null, indices.get(r[iSym]) ?? []]
    );
    n++;
  }
  return { securities: n, withIndustry: industry.size };
}

/** Tag ETFs from NSE's own list so the screen can exclude non-company instruments. */
export async function refreshEtfTags(): Promise<number> {
  const rows = csv(await text(`${ARCH}/equities/eq_etfseclist.csv`));
  const sym = rows[0].findIndex((h) => h.toUpperCase() === "SYMBOL");
  const name = rows[0].findIndex((h) => h.toUpperCase() === "SECURITYNAME");
  const list = rows.slice(1).filter((r) => r[sym]);
  // ETFs are NOT in EQUITY_L, so they must be inserted, not just tagged — otherwise
  // the screen's join cannot see them and they pass as "unknown".
  for (const r of list) {
    await AppDataSource.query(
      `INSERT INTO nse_securities (symbol, company_name, instrument_type) VALUES ($1, $2, 'ETF')
       ON CONFLICT (symbol) DO UPDATE SET instrument_type = 'ETF', updated_at = now()`,
      [r[sym], (name >= 0 && r[name]) || r[sym]]
    );
  }
  return list.length;
}

interface SurvRow { symbol: string; survCode: string; survDesc: string; companyName: string }

async function nseApi(path: string, cookie: string): Promise<unknown> {
  const s = await text(`https://www.nseindia.com${path}`, { Cookie: cookie, Referer: "https://www.nseindia.com/reports/asm", Accept: "application/json" });
  return JSON.parse(s);
}

export async function refreshSurveillance(today: string): Promise<{ asm: number; gsm: number }> {
  // First hit yields the cookie (and usually a 403); the second, with it, the JSON.
  const first = await fetch("https://www.nseindia.com/", { headers: { "User-Agent": UA, Accept: "text/html" } });
  const cookie = (first.headers.get("set-cookie") ?? "").split(/,(?=\s*\w+=)/).map((c) => c.split(";")[0]).join("; ");
  const asm = (await nseApi("/api/reportASM", cookie)) as { longterm?: { data?: SurvRow[] }; shortterm?: { data?: SurvRow[] } };
  const gsm = (await nseApi("/api/reportGSM", cookie)) as SurvRow[];
  const rows: Array<{ r: SurvRow; list: string; url: string }> = [
    ...(asm.longterm?.data ?? []).map((r) => ({ r, list: "ASM-LT", url: "https://www.nseindia.com/reports/asm" })),
    ...(asm.shortterm?.data ?? []).map((r) => ({ r, list: "ASM-ST", url: "https://www.nseindia.com/reports/asm" })),
    ...(Array.isArray(gsm) ? gsm : []).map((r) => ({ r, list: "GSM", url: "https://www.nseindia.com/reports/gsm" })),
  ];
  let n = 0;
  for (const { r, list, url } of rows) {
    if (!r.symbol) continue;
    // One row per (symbol, fact, observed_at): the trigger forbids updates, so skip if present.
    const [exists]: Array<{ c: string }> = await AppDataSource.query(
      `SELECT count(*) c FROM stock_knowledge WHERE symbol = $1 AND kind = 'SURVEILLANCE' AND fact = $2 AND observed_at = $3`,
      [r.symbol, r.survDesc, today]
    );
    if (Number(exists.c) > 0) continue;
    await AppDataSource.query(
      `INSERT INTO stock_knowledge (symbol, kind, fact, detail, source_kind, source_url, observed_at, confidence)
       VALUES ($1,'SURVEILLANCE',$2,$3::jsonb,'EXCHANGE',$4,$5,'HIGH')`,
      [r.symbol, r.survDesc, JSON.stringify({ code: r.survCode, list, companyName: r.companyName }), url, today]
    );
    n++;
  }
  return { asm: (asm.longterm?.data?.length ?? 0) + (asm.shortterm?.data?.length ?? 0), gsm: Array.isArray(gsm) ? gsm.length : 0 };
}

if (require.main === module) {
  (async () => {
    await AppDataSource.initialize();
    const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    console.log("[universe] master:", await refreshMaster());
    console.log("[universe] etfs tagged:", await refreshEtfTags());
    console.log("[universe] surveillance:", await refreshSurveillance(today));
    await AppDataSource.destroy();
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
