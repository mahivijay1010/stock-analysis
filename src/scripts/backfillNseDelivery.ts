/**
 * Backfill / top-up nse_delivery from NSE sec_bhavdata_full archives.
 *
 *   npx ts-node --transpile-only src/scripts/backfillNseDelivery.ts [fromYYYY-MM-DD]
 *
 * Sessions come from stock_history (dates the panel actually has), so no
 * holiday calendar is guessed. Already-loaded dates are skipped, a 404 is
 * recorded as "not published" (not retried this run), and requests are
 * spaced ~1/s — this is a public archive, not ours to hammer.
 */
import { AppDataSource } from "../config/database";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const SPACING_MS = 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface DeliveryRow {
  symbol: string;
  tradeDate: string;
  series: string;
  close: number | null;
  tradedQty: number | null;
  turnoverLacs: number | null;
  trades: number | null;
  delivQty: number | null;
  delivPct: number | null;
}

const num = (s: string | undefined): number | null => {
  const v = Number((s ?? "").trim());
  return s == null || (s ?? "").trim() === "" || (s ?? "").trim() === "-" || !Number.isFinite(v) ? null : v;
};

/** Parse one sec_bhavdata_full CSV; keeps EQ series only. PURE. */
export function parseBhav(csv: string, expectDate: string): DeliveryRow[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const head = lines[0].split(",").map((h) => h.trim());
  const ix = (k: string) => head.indexOf(k);
  const iSym = ix("SYMBOL"), iSer = ix("SERIES"), iDate = ix("DATE1"), iClose = ix("CLOSE_PRICE"),
    iQty = ix("TTL_TRD_QNTY"), iTurn = ix("TURNOVER_LACS"), iTr = ix("NO_OF_TRADES"), iDq = ix("DELIV_QTY"), iDp = ix("DELIV_PER");
  if ([iSym, iSer, iDate, iDq, iDp].some((i) => i < 0)) throw new Error("unexpected bhavcopy header: " + lines[0]);
  const out: DeliveryRow[] = [];
  for (const l of lines.slice(1)) {
    const c = l.split(",").map((x) => x.trim());
    if (c[iSer] !== "EQ") continue;
    // DATE1 is dd-Mon-yyyy; trust the file name date, but refuse a mismatch.
    const [dd, mon, yyyy] = c[iDate].split("-");
    const iso = `${yyyy}-${String(MONTHS.indexOf(mon) + 1).padStart(2, "0")}-${dd.padStart(2, "0")}`;
    if (iso !== expectDate) throw new Error(`file for ${expectDate} contains ${c[iDate]}`);
    out.push({
      symbol: c[iSym],
      tradeDate: iso,
      series: c[iSer],
      close: num(c[iClose]),
      tradedQty: num(c[iQty]),
      turnoverLacs: num(c[iTurn]),
      trades: num(c[iTr]),
      delivQty: num(c[iDq]),
      delivPct: num(c[iDp]),
    });
  }
  return out;
}

async function insert(rows: DeliveryRow[], file: string): Promise<void> {
  const CHUNK = 500;
  for (let k = 0; k < rows.length; k += CHUNK) {
    const part = rows.slice(k, k + CHUNK);
    const params: unknown[] = [];
    const values = part.map((r, j) => {
      const b = j * 10;
      params.push(r.symbol, r.tradeDate, r.series, r.close, r.tradedQty, r.turnoverLacs, r.trades, r.delivQty, r.delivPct, file);
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10})`;
    });
    await AppDataSource.query(
      `INSERT INTO nse_delivery (symbol, trade_date, series, close_price, traded_qty, turnover_lacs, no_of_trades, deliv_qty, deliv_pct, source_file)
       VALUES ${values.join(",")} ON CONFLICT DO NOTHING`,
      params
    );
  }
}

export async function backfill(from: string): Promise<{ loaded: number; missing: string[]; failed: string[] }> {
  const sessions: Array<{ d: string }> = await AppDataSource.query(
    `SELECT DISTINCT to_char(trading_date,'YYYY-MM-DD') d FROM stock_history WHERE trading_date >= $1 ORDER BY 1`,
    [from]
  );
  const have: Array<{ d: string }> = await AppDataSource.query(`SELECT DISTINCT to_char(trade_date,'YYYY-MM-DD') d FROM nse_delivery`);
  const done = new Set(have.map((r) => r.d));
  const todo = sessions.map((s) => s.d).filter((d) => !done.has(d));
  console.log(`[delivery] ${sessions.length} sessions since ${from}; ${todo.length} to fetch`);
  const missing: string[] = [];
  const failed: string[] = [];
  let loaded = 0;
  for (const d of todo) {
    const [y, m, dd] = d.split("-");
    const file = `sec_bhavdata_full_${dd}${m}${y}.csv`;
    try {
      const res = await fetch(`https://nsearchives.nseindia.com/products/content/${file}`, { headers: { "User-Agent": UA, Accept: "text/csv,*/*" } });
      if (res.status === 404) missing.push(d);
      else if (!res.ok) failed.push(`${d}:${res.status}`);
      else {
        const rows = parseBhav(await res.text(), d);
        await insert(rows, file);
        loaded++;
        if (loaded % 50 === 0) console.log(`[delivery] ${loaded}/${todo.length} loaded (last ${d}, ${rows.length} EQ rows)`);
      }
    } catch (e) {
      failed.push(`${d}:${e instanceof Error ? e.message : String(e)}`);
    }
    await sleep(SPACING_MS);
  }
  console.log(`[delivery] done: ${loaded} loaded, ${missing.length} not published, ${failed.length} failed${failed.length ? " — " + failed.slice(0, 5).join(", ") : ""}`);
  return { loaded, missing, failed };
}

if (require.main === module) {
  (async () => {
    await AppDataSource.initialize();
    await backfill(process.argv[2] ?? "2021-09-17");
    await AppDataSource.destroy();
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
