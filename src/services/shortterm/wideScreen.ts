/**
 * Wide-universe sub-₹100 screen — DESCRIPTIVE, not predictive.
 *
 * Runs over every NSE EQ symbol in nse_delivery (~2,700), not the 152-stock
 * NSE_UNIVERSE, so "stocks under ₹100" means the whole exchange. It answers
 * "which cheap stocks are tradeable and not obviously dangerous?", which is a
 * question the data CAN answer, and refuses to answer "which will go up?",
 * which no signal in this system has earned the right to (docs/
 * stock-selection-preregistration.md, delivery-signals-preregistration.md).
 *
 * Hard exclusions (a stock fails the screen, with the reason kept):
 *  - exchange surveillance: any ASM / GSM / IBC stage (trading restrictions,
 *    100% margin, periodic call auction — and the exchange's own judgement
 *    that price action is abnormal);
 *  - illiquid: median daily turnover over 20 sessions < ₹2 crore or median
 *    trades < 1,500 — the cost model's slippage assumptions do not hold;
 *  - too little history: < 240 sessions (no 1-year drawdown / vol);
 *  - penny: close < ₹5 (tick size is a material fraction of price);
 *  - not a company: ETFs (tagged from NSE's eq_etfseclist.csv) never enter.
 *
 * Everything else is reported as-is: liquidity, delivery, returns, volatility,
 * drawdown, distance from the 1y high, industry, index membership. The
 * ordering is by a transparent LIQUIDITY-AND-STABILITY rank, which is a
 * tradeability rank and says nothing about expected return.
 *
 * Prices here are exchange prints (unadjusted). A split/bonus inside the
 * window shows as a large one-day move; a |1-day move| > 25% marks the stock
 * CORPORATE_ACTION_SUSPECT rather than being silently scored (a 1:2
 * bonus prints as −33%, so the bar is 25%).
 */
import { AppDataSource } from "../../config/database";

export const WIDE_SCREEN_VERSION = "wide-screen-v1";

export const SCREEN_RULES = {
  maxPrice: 100,
  minPrice: 5,
  minSessions: 240,
  minMedianTurnoverLacs: 200, // ₹2 crore
  minMedianTrades: 1500,
  liquidityWindow: 20,
  corporateActionMovePct: 25, // a 1:2 bonus prints −33%; real 25% days are rare and also deserve the flag
} as const;

export interface DailyRow {
  d: string;
  close: number;
  turnoverLacs: number | null;
  trades: number | null;
  delivPct: number | null;
}

export interface ScreenMetrics {
  symbol: string;
  asOf: string;
  price: number;
  sessions: number;
  medianTurnoverLacs20: number | null;
  medianTrades20: number | null;
  avgDelivPct60: number | null;
  /** mean delivery % last 5 sessions minus mean over the 60 before — descriptive only. */
  delivTrendPp: number | null;
  ret20Pct: number | null;
  ret60Pct: number | null;
  ret250Pct: number | null;
  vol60AnnPct: number | null;
  maxDrawdown1yPct: number | null;
  pctFrom1yHigh: number | null;
  corporateActionSuspect: boolean;
}

const median = (xs: number[]): number | null => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs: number[]): number | null => {
  const v = xs.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

/** Metrics from a symbol's daily rows (ascending by date). PURE. */
export function computeMetrics(symbol: string, rows: DailyRow[]): ScreenMetrics {
  const n = rows.length;
  const last = rows[n - 1];
  const closes = rows.map((r) => r.close);
  const ret = (k: number) => (n > k && closes[n - 1 - k] > 0 ? (closes[n - 1] / closes[n - 1 - k] - 1) * 100 : null);
  const tail = <T>(xs: T[], k: number) => xs.slice(Math.max(0, xs.length - k));

  const dailyRets: number[] = [];
  let suspect = false;
  for (let i = Math.max(1, n - 250); i < n; i++) {
    if (closes[i - 1] > 0) {
      const r = closes[i] / closes[i - 1] - 1;
      dailyRets.push(r);
      if (Math.abs(r) * 100 > SCREEN_RULES.corporateActionMovePct) suspect = true;
    }
  }
  const last60 = tail(dailyRets, 60);
  const m60 = mean(last60);
  const vol60 =
    last60.length >= 20 && m60 != null
      ? Math.sqrt(last60.reduce((a, r) => a + (r - m60) ** 2, 0) / (last60.length - 1)) * Math.sqrt(252) * 100
      : null;

  const yr = tail(closes, 250);
  let peak = -Infinity;
  let mdd = 0;
  for (const c of yr) {
    peak = Math.max(peak, c);
    mdd = Math.min(mdd, c / peak - 1);
  }
  const high1y = Math.max(...yr);

  const deliv = rows.map((r) => r.delivPct ?? NaN);
  const recent5 = mean(tail(deliv, 5));
  const base60 = mean(deliv.slice(Math.max(0, n - 65), Math.max(0, n - 5)));

  return {
    symbol,
    asOf: last.d,
    price: last.close,
    sessions: n,
    medianTurnoverLacs20: median(tail(rows, SCREEN_RULES.liquidityWindow).map((r) => r.turnoverLacs ?? NaN)),
    medianTrades20: median(tail(rows, SCREEN_RULES.liquidityWindow).map((r) => r.trades ?? NaN)),
    avgDelivPct60: mean(tail(deliv, 60)),
    delivTrendPp: recent5 != null && base60 != null ? recent5 - base60 : null,
    ret20Pct: ret(20),
    ret60Pct: ret(60),
    ret250Pct: ret(250),
    vol60AnnPct: vol60,
    maxDrawdown1yPct: yr.length >= 20 ? mdd * 100 : null,
    pctFrom1yHigh: yr.length >= 20 && high1y > 0 ? (last.close / high1y - 1) * 100 : null,
    corporateActionSuspect: suspect,
  };
}

export interface Surveillance {
  code: string;
  description: string;
  observedAt: string;
}

export interface ScreenRow extends ScreenMetrics {
  companyName: string | null;
  industry: string | null;
  indices: string[];
  listingDate: string | null;
  surveillance: Surveillance[];
  passed: boolean;
  exclusions: string[];
  /** Tradeability rank components, each 0–1; NOT a return forecast. */
  rank: { liquidity: number; stability: number; score: number } | null;
}

/** Apply the hard exclusions. PURE. */
export function exclusionsFor(m: ScreenMetrics, surveillance: Surveillance[], listingDate: string | null): string[] {
  const R = SCREEN_RULES;
  const out: string[] = [];
  if (surveillance.length) out.push(`exchange surveillance: ${surveillance.map((s) => s.code).join(", ")}`);
  if (m.price < R.minPrice) out.push(`penny: close ₹${m.price.toFixed(2)} < ₹${R.minPrice}`);
  if (m.sessions < R.minSessions) out.push(`history: ${m.sessions} sessions < ${R.minSessions}`);
  if (m.medianTurnoverLacs20 == null || m.medianTurnoverLacs20 < R.minMedianTurnoverLacs)
    out.push(`illiquid: median 20d turnover ₹${((m.medianTurnoverLacs20 ?? 0) / 100).toFixed(2)} cr < ₹${R.minMedianTurnoverLacs / 100} cr`);
  if (m.medianTrades20 == null || m.medianTrades20 < R.minMedianTrades) out.push(`thin: median 20d trades ${Math.round(m.medianTrades20 ?? 0)} < ${R.minMedianTrades}`);
  if (listingDate && m.asOf < addYear(listingDate)) out.push(`listed < 1 year (${listingDate})`);
  return out;
}

function addYear(d: string): string {
  const [y, m, dd] = d.split("-").map(Number);
  return `${y + 1}-${String(m).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

/**
 * Tradeability rank among PASSING rows: liquidity = percentile of median
 * turnover; stability = percentile of (−vol60) averaged with percentile of
 * (−|maxDrawdown|). score = 0.5·liquidity + 0.5·stability. PURE.
 */
export function rankPassing(rows: ScreenRow[]): void {
  const passing = rows.filter((r) => r.passed);
  const pct = (vals: Array<number | null>): number[] => {
    const idx = vals.map((v, i) => [v ?? -Infinity, i] as const).sort((a, b) => a[0] - b[0]);
    const out = new Array<number>(vals.length).fill(0);
    idx.forEach(([, i], k) => (out[i] = vals.length > 1 ? k / (vals.length - 1) : 1));
    return out;
  };
  const liq = pct(passing.map((r) => r.medianTurnoverLacs20));
  const volP = pct(passing.map((r) => (r.vol60AnnPct == null ? null : -r.vol60AnnPct)));
  const ddP = pct(passing.map((r) => (r.maxDrawdown1yPct == null ? null : r.maxDrawdown1yPct)));
  passing.forEach((r, i) => {
    const stability = (volP[i] + ddP[i]) / 2;
    r.rank = { liquidity: liq[i], stability, score: 0.5 * liq[i] + 0.5 * stability };
  });
}

export interface WideScreenResult {
  version: string;
  asOf: string;
  rules: typeof SCREEN_RULES;
  universeSize: number;
  under100: number;
  passed: number;
  rows: ScreenRow[];
  caveat: string;
}

export async function runWideScreen(): Promise<WideScreenResult> {
  const [{ d: asOf }]: Array<{ d: string }> = await AppDataSource.query(`SELECT to_char(max(trade_date),'YYYY-MM-DD') d FROM nse_delivery`);
  // Companies only: NSE lists ETFs in the EQ series; nse_securities tags them from NSE's ETF list.
  const under: Array<{ symbol: string }> = await AppDataSource.query(
    `SELECT d.symbol FROM nse_delivery d JOIN nse_securities s ON s.symbol = d.symbol AND s.instrument_type = 'STOCK'
      WHERE d.trade_date = $1 AND d.series = 'EQ' AND d.close_price < $2
      ORDER BY d.symbol`,
    [asOf, SCREEN_RULES.maxPrice]
  );
  const [{ n: universeSize }]: Array<{ n: string }> = await AppDataSource.query(`SELECT count(*) n FROM nse_delivery WHERE trade_date = $1 AND series = 'EQ'`, [asOf]);
  const symbols = under.map((u) => u.symbol);

  const hist: Array<{ symbol: string; d: string; c: string; t: string | null; n: string | null; p: string | null }> = await AppDataSource.query(
    `SELECT symbol, to_char(trade_date,'YYYY-MM-DD') d, close_price c, turnover_lacs t, no_of_trades n, deliv_pct p
       FROM nse_delivery WHERE series = 'EQ' AND symbol = ANY($1) AND trade_date > $2::date - interval '400 days' ORDER BY symbol, trade_date`,
    [symbols, asOf]
  );
  const bySymbol = new Map<string, DailyRow[]>();
  for (const h of hist) {
    const r: DailyRow = { d: h.d, close: Number(h.c), turnoverLacs: h.t == null ? null : Number(h.t), trades: h.n == null ? null : Number(h.n), delivPct: h.p == null ? null : Number(h.p) };
    const g = bySymbol.get(h.symbol);
    if (g) g.push(r);
    else bySymbol.set(h.symbol, [r]);
  }

  const master: Array<{ symbol: string; company_name: string; industry: string | null; indices: string[]; listing_date: string | null }> = await AppDataSource.query(
    `SELECT symbol, company_name, industry, indices, to_char(listing_date,'YYYY-MM-DD') listing_date FROM nse_securities WHERE symbol = ANY($1)`,
    [symbols]
  );
  const masterBy = new Map(master.map((m) => [m.symbol, m]));

  // Latest surveillance observation per symbol (the exchange republishes the full list daily).
  const surv: Array<{ symbol: string; fact: string; detail: { code?: string } | null; observed_at: string }> = await AppDataSource.query(
    `SELECT DISTINCT ON (symbol, fact) symbol, fact, detail, to_char(observed_at,'YYYY-MM-DD') observed_at
       FROM stock_knowledge WHERE kind = 'SURVEILLANCE' AND symbol = ANY($1)
        AND observed_at = (SELECT max(observed_at) FROM stock_knowledge WHERE kind = 'SURVEILLANCE')
      ORDER BY symbol, fact, observed_at DESC`,
    [symbols]
  );
  const survBy = new Map<string, Surveillance[]>();
  for (const s of surv) {
    const g = survBy.get(s.symbol) ?? [];
    g.push({ code: s.detail?.code ?? s.fact, description: s.fact, observedAt: s.observed_at });
    survBy.set(s.symbol, g);
  }

  const rows: ScreenRow[] = [];
  for (const symbol of symbols) {
    const daily = bySymbol.get(symbol);
    if (!daily?.length) continue;
    const m = computeMetrics(symbol, daily);
    const info = masterBy.get(symbol);
    const sv = survBy.get(symbol) ?? [];
    const exclusions = exclusionsFor(m, sv, info?.listing_date ?? null);
    rows.push({
      ...m,
      companyName: info?.company_name ?? null,
      industry: info?.industry ?? null,
      indices: info?.indices ?? [],
      listingDate: info?.listing_date ?? null,
      surveillance: sv,
      passed: exclusions.length === 0,
      exclusions,
      rank: null,
    });
  }
  rankPassing(rows);
  rows.sort((a, b) => Number(b.passed) - Number(a.passed) || (b.rank?.score ?? 0) - (a.rank?.score ?? 0) || a.symbol.localeCompare(b.symbol));

  return {
    version: WIDE_SCREEN_VERSION,
    asOf,
    rules: SCREEN_RULES,
    universeSize: Number(universeSize),
    under100: symbols.length,
    passed: rows.filter((r) => r.passed).length,
    rows,
    caveat:
      "This screen measures tradeability (liquidity, exchange status, history, stability). It does not measure expected return: " +
      "no signal in this system has demonstrated stock-picking skill (see Evidence → stock-selection studies). A passing stock is one you CAN trade at the modelled cost, not one that will go up.",
  };
}
