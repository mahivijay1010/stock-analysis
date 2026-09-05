import pdf from "pdf-parse";
import { DocumentCache } from "../cache";
import { ResilientHttpClient } from "../http";
import { DocumentProvider } from "./interfaces";
import { FilingDocument } from "../types";

function absolute(href: string, base: string): string | null {
  try {
    const url = new URL(href, base);
    return url.protocol === "https:" ? url.toString() : null;
  } catch { return null; }
}

/** User-supplied official IR page only; no open-web guessing of company URLs. */
export class CompanyDocumentSource implements DocumentProvider {
  readonly name = "COMPANY_IR";
  private readonly cache: DocumentCache;

  constructor(cache = new DocumentCache()) { this.cache = cache; }

  async discover(ticker: string, pageUrl: string): Promise<FilingDocument[]> {
    const host = new URL(pageUrl).hostname;
    const http = new ResilientHttpClient([host], 400, 30_000);
    const html = (await http.getText(pageUrl, { headers: { Accept: "text/html" } })).data;
    const documents: FilingDocument[] = [];
    const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(html)) !== null) {
      const label = match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      const url = absolute(match[1], pageUrl);
      if (!url || !/\.pdf(?:$|\?)/i.test(url)) continue;
      const kind = /annual\s+report/i.test(label) ? "ANNUAL_REPORT"
        : /investor|presentation|earnings/i.test(label) ? "INVESTOR_PRESENTATION" : null;
      if (!kind) continue;
      documents.push({ provider: "COMPANY_IR", ticker, title: label || kind, documentType: kind,
        url, consolidation: "UNKNOWN", metadata: { discoveredFrom: pageUrl } });
    }
    return documents.filter((d, i, all) => all.findIndex((x) => x.url === d.url) === i);
  }

  async extractText(document: FilingDocument): Promise<{ text: string; contentHash: string; cachePath: string }> {
    const host = new URL(document.url).hostname;
    const http = new ResilientHttpClient([host], 500, 45_000);
    const cached = await this.cache.getOrFetch(document.url, "pdf", async () => (await http.getBuffer(document.url)).data);
    const parsed = await pdf(cached.content);
    return { text: parsed.text, contentHash: cached.contentHash, cachePath: cached.path };
  }
}
