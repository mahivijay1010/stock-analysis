import { ResilientHttpClient } from "../http";
import { BseFinancialSummary, CorporateFilingProvider } from "./interfaces";
import { FilingDocument } from "../types";

const API = "https://api.bseindia.com/BseIndiaAPI/api";
const RESULTS_PAGE = "https://www.bseindia.com/corporates/results.aspx";
const USER_AGENT = "Mozilla/5.0 (compatible; StockIntelligenceEngine/1.0; per-company-research)";

function unwrap<T>(value: unknown): T {
  let current = value;
  for (let i = 0; i < 2 && typeof current === "string"; i++) {
    try { current = JSON.parse(current); } catch { break; }
  }
  return current as T;
}

function number(value: unknown): number | null {
  if (value == null || value === "" || value === "-") return null;
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function date(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function ymd(value: Date): string {
  return `${value.getUTCFullYear()}${String(value.getUTCMonth() + 1).padStart(2, "0")}${String(value.getUTCDate()).padStart(2, "0")}`;
}

/** Public per-company BSE results/announcement adapter; not a bulk feed. */
export class BSEDataSource implements CorporateFilingProvider {
  readonly name = "BSE";
  private readonly http = new ResilientHttpClient(["bseindia.com"], 400, 25_000);

  async resolveScripCode(query: string): Promise<string | null> {
    if (/^\d{6}$/.test(query)) return query;
    const url = new URL(`${API}/PeerSmartSearch/w`);
    url.searchParams.set("Type", "SS");
    url.searchParams.set("text", query.replace(/\.(NS|BO)$/i, ""));
    const response = await this.http.getJson<unknown>(url.toString(), { headers: this.headers() });
    const body = unwrap<unknown>(response.data);
    const text = typeof body === "string" ? body : JSON.stringify(body);
    const code = text.match(/\b(\d{6})\b/)?.[1];
    return code ?? null;
  }

  async getFinancialSummary(tickerOrCode: string): Promise<BseFinancialSummary[]> {
    const bseCode = await this.resolveScripCode(tickerOrCode);
    if (!bseCode) return [];
    const url = new URL(`${API}/TabResults/w`);
    url.searchParams.set("scripcode", bseCode);
    url.searchParams.set("tabtype", "RESULTS");
    const response = await this.http.getJson<unknown>(url.toString(), { headers: this.headers() });
    const decoded = unwrap<Record<string, unknown> | Array<Record<string, unknown>>>(response.data);
    const rows = Array.isArray(decoded)
      ? decoded
      : Object.values(decoded ?? {}).flatMap((value) => Array.isArray(value) ? value : []);
    return rows.map((row) => ({
      bseCode,
      period: String(row.YEAREND ?? row.yearEnd ?? row.PERIOD ?? row.period ?? "UNKNOWN"),
      revenue: number(row.TotalIncome ?? row.REVENUE ?? row.Revenue ?? row.NET_SALES),
      netIncome: number(row.NetProfit ?? row.NET_PROFIT ?? row.PAT ?? row.NetProfitLoss),
      eps: number(row.EPS ?? row.BasicEPS ?? row.EPS_BASIC),
      sourceUrl: url.toString(),
      raw: row,
    }));
  }

  async listAnnouncements(tickerOrCode: string, from: Date, to: Date): Promise<FilingDocument[]> {
    const bseCode = await this.resolveScripCode(tickerOrCode);
    if (!bseCode) return [];
    const url = new URL(`${API}/AnnSubCategoryGetData/w`);
    const params = {
      pageno: "1", strCat: "-1", subcategory: "-1", strPrevDate: ymd(from),
      strToDate: ymd(to), strSearch: "P", strscrip: bseCode, strType: "C",
    };
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await this.http.getJson<unknown>(url.toString(), { headers: this.headers() });
    const decoded = unwrap<Record<string, unknown> | Array<Record<string, unknown>>>(response.data);
    const rows = Array.isArray(decoded)
      ? decoded
      : Object.values(decoded ?? {}).flatMap((value) => Array.isArray(value) ? value : []);
    return rows.map((row) => {
      const rawAttachment = row.ATTACHMENTNAME ?? row.AttachmentName ?? row.NEWS_URL ?? row.NNSURL;
      const attachment = typeof rawAttachment === "string" && rawAttachment.startsWith("https://")
        ? rawAttachment
        : typeof rawAttachment === "string" && rawAttachment
          ? `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${rawAttachment.replace(/^.*\//, "")}`
          : null;
      return {
        provider: "BSE" as const,
        ticker: tickerOrCode.replace(/\.(NS|BO)$/i, "").toUpperCase(),
        title: String(row.NEWSSUB ?? row.HEADLINE ?? row.CATEGORYNAME ?? "BSE announcement"),
        documentType: "ANNOUNCEMENT",
        url: attachment ?? `https://www.bseindia.com/stock-share-price/x/${bseCode}/corp-announcements/`,
        publishedAt: date(row.NEWS_DT ?? row.DT_TM ?? row.DISSEMINATEDDT),
        consolidation: "UNKNOWN",
        metadata: row,
      };
    });
  }

  private headers(): Record<string, string> {
    return { "User-Agent": USER_AGENT, Accept: "application/json", Origin: "https://www.bseindia.com", Referer: RESULTS_PAGE };
  }
}
