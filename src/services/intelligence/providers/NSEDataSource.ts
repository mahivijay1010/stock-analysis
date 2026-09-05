import axios from "axios";
import { DocumentCache } from "../cache";
import { ResilientHttpClient } from "../http";
import { Consolidation, FilingDocument } from "../types";
import { CorporateFilingProvider, FinancialDataProvider } from "./interfaces";

const BASE = "https://www.nseindia.com";
const FILINGS_PAGE = `${BASE}/companies-listing/corporate-filings-financial-results`;
const USER_AGENT = "Mozilla/5.0 (compatible; StockIntelligenceEngine/1.0; per-company-research)";

function pad(value: number): string { return String(value).padStart(2, "0"); }
function nseDate(date: Date): string { return `${pad(date.getUTCDate())}-${pad(date.getUTCMonth() + 1)}-${date.getUTCFullYear()}`; }

function parseNseDate(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  const dateOnly = trimmed.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (dateOnly) {
    const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const month = months.indexOf(dateOnly[2].toLowerCase());
    if (month >= 0) return new Date(Date.UTC(Number(dateOnly[3]), month, Number(dateOnly[1]))).toISOString();
  }
  const clean = trimmed.replace(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/, "$1 $2 $3");
  const parsed = Date.parse(clean);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function consolidation(value: unknown): Consolidation {
  const v = String(value ?? "").toLowerCase();
  if (v.includes("non-consolidated") || v.includes("standalone")) return "STANDALONE";
  if (v.includes("consolidated")) return "CONSOLIDATED";
  return "UNKNOWN";
}

function usableUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("https://")) return null;
  return /\/(?:null|-)$/.test(value) ? null : value;
}

interface IntegratedResponse { data?: Array<Record<string, unknown>>; totalRecords?: number; }

export class NSEDataSource implements FinancialDataProvider, CorporateFilingProvider {
  readonly name = "NSE";
  private readonly http = new ResilientHttpClient(["nseindia.com"], 400, 25_000);
  private readonly cache: DocumentCache;
  private cookie: string | null = null;

  constructor(cache = new DocumentCache()) { this.cache = cache; }

  async listFinancialFilings(ticker: string, years = 10): Promise<FilingDocument[]> {
    const symbol = ticker.replace(/\.(NS|BO)$/i, "").toUpperCase();
    const to = new Date();
    const from = new Date(Date.UTC(to.getUTCFullYear() - years, to.getUTCMonth(), to.getUTCDate()));
    const [integrated, legacy] = await Promise.all([
      this.nseJson<IntegratedResponse>("/api/integrated-filing-results", { symbol, page: 1, size: 200 }).catch(() => ({ data: [] })),
      this.nseJson<Array<Record<string, unknown>>>("/api/corporates-financial-results", {
        index: "equities", symbol, period: "Annual", from_date: nseDate(from), to_date: nseDate(to),
      }).catch(() => []),
    ]);
    const current = (integrated.data ?? [])
      .filter((row) => String(row.type ?? "").toLowerCase().includes("financial"))
      .map((row): FilingDocument => ({
        provider: "NSE",
        ticker: symbol,
        title: `${row.cmName ?? symbol} ${row.type ?? "Integrated Filing"} ${row.qe_Date ?? ""}`.trim(),
        documentType: "INTEGRATED_FINANCIAL_XBRL",
        url: usableUrl(row.ixbrl) ?? usableUrl(row.xbrl) ?? FILINGS_PAGE,
        xbrlUrl: usableUrl(row.xbrl),
        ixbrlUrl: usableUrl(row.ixbrl),
        publishedAt: parseNseDate(row.creation_Date ?? row.broadcast_Date),
        periodEnd: parseNseDate(row.qe_Date)?.slice(0, 10) ?? null,
        audited: row.audited == null ? null : /^audited$/i.test(String(row.audited)),
        consolidation: consolidation(row.consolidated),
        revision: String(row.type_Sub ?? "") || null,
        metadata: row,
      }));
    const historical = legacy.map((row): FilingDocument => ({
      provider: "NSE",
      ticker: symbol,
      title: `${row.companyName ?? symbol} Financial Results ${row.toDate ?? ""}`.trim(),
      documentType: "FINANCIAL_RESULTS_XBRL",
      url: usableUrl(row.resultDetailedDataLink) ?? usableUrl(row.xbrl) ?? FILINGS_PAGE,
      xbrlUrl: usableUrl(row.xbrl),
      publishedAt: parseNseDate(row.filingDate ?? row.broadCastDate),
      periodEnd: parseNseDate(row.toDate)?.slice(0, 10) ?? null,
      audited: row.audited == null ? null : /^audited$/i.test(String(row.audited)),
      consolidation: consolidation(row.consolidated),
      revision: row.oldNewFlag === "N" ? "Original" : String(row.oldNewFlag ?? "") || null,
      metadata: row,
    }));
    return this.deduplicate([...current, ...historical]);
  }

  async downloadStructuredFiling(filing: FilingDocument): Promise<{ xml: string; contentHash: string; cachePath: string }> {
    if (!filing.xbrlUrl) throw new Error(`No XBRL URL for ${filing.title}`);
    const cached = await this.cache.getOrFetch(filing.xbrlUrl, "xml", async () =>
      (await this.http.getBuffer(filing.xbrlUrl!)).data
    );
    const xml = cached.content.toString("utf8");
    if (!/<(?:[\w.-]+:)?xbrl\b/i.test(xml)) throw new Error(`NSE document is not an XBRL instance: ${filing.xbrlUrl}`);
    return { xml, contentHash: cached.contentHash, cachePath: cached.path };
  }

  async listAnnualReports(ticker: string): Promise<FilingDocument[]> {
    const symbol = ticker.replace(/\.(NS|BO)$/i, "").toUpperCase();
    const response = await this.nseJson<{ data?: Array<Record<string, unknown>> }>("/api/annual-reports", { index: "equities", symbol });
    return (response.data ?? []).map((row) => {
      const url = usableUrl(row.fileName ?? row.attachment ?? row.url) ?? `${BASE}/companies-listing/corporate-filings-annual-reports`;
      return {
        provider: "NSE" as const, ticker: symbol, title: String(row.companyName ?? `${symbol} annual report`),
        documentType: "ANNUAL_REPORT", url, publishedAt: parseNseDate(row.broadcastDate ?? row.submissionDate),
        periodEnd: parseNseDate(row.financialYear)?.slice(0, 10) ?? null, consolidation: "UNKNOWN" as const, metadata: row,
      };
    });
  }

  async listAnnouncements(ticker: string, from: Date, to: Date): Promise<FilingDocument[]> {
    const symbol = ticker.replace(/\.(NS|BO)$/i, "").toUpperCase();
    const rows = await this.nseJson<Array<Record<string, unknown>>>("/api/corporate-announcements", {
      index: "equities", symbol, from_date: nseDate(from), to_date: nseDate(to),
    });
    return rows.map((row) => {
      const attachment = usableUrl(row.attchmntFile ?? row.attachment ?? row.filePath);
      return {
        provider: "NSE" as const, ticker: symbol,
        title: String(row.subject ?? row.desc ?? `${symbol} announcement`), documentType: "ANNOUNCEMENT",
        url: attachment ?? `${BASE}/companies-listing/corporate-filings-announcements?symbol=${encodeURIComponent(symbol)}`,
        publishedAt: parseNseDate(row.an_dt ?? row.broadcastDate), consolidation: "UNKNOWN" as const, metadata: row,
      };
    });
  }

  private deduplicate(filings: FilingDocument[]): FilingDocument[] {
    const sorted = filings.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
    const seen = new Set<string>();
    return sorted.filter((filing) => {
      const key = `${filing.periodEnd}|${filing.consolidation}|${filing.documentType}`;
      if (seen.has(key) || !filing.xbrlUrl) return false;
      seen.add(key);
      return true;
    });
  }

  private async nseJson<T>(path: string, params: Record<string, unknown>): Promise<T> {
    await this.ensureCookie();
    const url = new URL(path, BASE);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    try {
      return (await this.http.getJson<T>(url.toString(), { headers: this.headers() })).data;
    } catch (error) {
      if (!axios.isAxiosError(error) || ![401, 403].includes(error.response?.status ?? 0)) throw error;
      this.cookie = null;
      await this.ensureCookie();
      return (await this.http.getJson<T>(url.toString(), { headers: this.headers() })).data;
    }
  }

  private headers(): Record<string, string> {
    return { "User-Agent": USER_AGENT, Accept: "application/json", Referer: FILINGS_PAGE, Cookie: this.cookie ?? "" };
  }

  private async ensureCookie(): Promise<void> {
    if (this.cookie) return;
    const response = await axios.get(FILINGS_PAGE, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" }, timeout: 25_000, validateStatus: (s) => s >= 200 && s < 400,
    });
    const values = response.headers["set-cookie"] as string[] | undefined;
    this.cookie = values?.map((value) => value.split(";", 1)[0]).join("; ") ?? "";
  }
}
