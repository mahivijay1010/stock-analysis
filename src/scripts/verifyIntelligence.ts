import { NSEDataSource } from "../services/intelligence/providers/NSEDataSource";
import { buildAnnualSeries, normalizeXbrl } from "../services/intelligence/xbrl";

const companies = [
  { ticker: "TCS", required: ["revenue", "net_income"] },
  { ticker: "HDFCBANK", required: ["net_income", "equity"] },
  { ticker: "LT", required: ["revenue", "net_income"] },
] as const;

async function main(): Promise<void> {
  const nse = new NSEDataSource();
  const results = [];
  for (const company of companies) {
    const filings = await nse.listFinancialFilings(company.ticker, 3);
    const filing = filings.find((f) => f.consolidation === "CONSOLIDATED" && /-03-31$/.test(f.periodEnd ?? "") && f.xbrlUrl);
    if (!filing) throw new Error(`${company.ticker}: no consolidated annual NSE XBRL filing found; candidates=${JSON.stringify(filings.slice(0, 8).map((f) => ({ periodEnd: f.periodEnd, consolidation: f.consolidation, type: f.documentType })))}`);
    const downloaded = await nse.downloadStructuredFiling(filing);
    const facts = normalizeXbrl(downloaded.xml, { ticker: company.ticker, consolidation: filing.consolidation,
      source: { provider: "NSE", sourceLevel: 1, url: filing.xbrlUrl!, document: filing.title, publishedAt: filing.publishedAt } });
    const annual = buildAnnualSeries(facts, "CONSOLIDATED")[0];
    if (!annual) throw new Error(`${company.ticker}: latest XBRL did not yield an annual series`);
    for (const concept of company.required) {
      const property = concept === "net_income" ? "netIncome" : concept;
      if (annual[property as keyof typeof annual] == null) throw new Error(`${company.ticker}: missing ${concept}`);
    }
    results.push({ ticker: company.ticker, period: annual.period, periodEnd: annual.periodEnd,
      revenue: annual.revenue, netIncome: annual.netIncome, equity: annual.equity,
      sourceUrl: filing.xbrlUrl, contentHash: downloaded.contentHash });
  }
  process.stdout.write(`${JSON.stringify({ verified: results.length, results }, null, 2)}\n`);
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
