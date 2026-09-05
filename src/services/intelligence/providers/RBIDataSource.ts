import { ResilientHttpClient } from "../http";
import { MacroValue } from "../types";
import { MacroDataProvider } from "./interfaces";

const RBI_HOME = "https://m.rbi.org.in/home.aspx";

function cleanHtml(value: string): string {
  return value.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
}

/** Current policy/liquidity rates from RBI's own mobile home-page table. */
export class RBIDataSource implements MacroDataProvider {
  readonly name = "RBI";
  private readonly http = new ResilientHttpClient(["rbi.org.in"], 500, 25_000);

  async fetchCurrent(): Promise<MacroValue[]> {
    const html = (await this.http.getText(RBI_HOME, { headers: { Accept: "text/html" } })).data;
    const text = cleanHtml(html);
    const labels = [
      "Policy Repo Rate", "Standing Deposit Facility Rate", "Marginal Standing Facility Rate",
      "Bank Rate", "Fixed Reverse Repo Rate", "Cash Reserve Ratio", "Statutory Liquidity Ratio",
    ];
    const period = new Date().toISOString().slice(0, 10);
    const results: MacroValue[] = [];
    for (const label of labels) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = text.match(new RegExp(`${escaped}\\s*:?\\s*(\\d+(?:\\.\\d+)?)\\s*%`, "i"));
      if (!match) continue;
      results.push({
        indicator: label, value: Number(match[1]), unit: "percent", period,
        provider: "RBI", sourceUrl: RBI_HOME, status: "RAW", confidence: "HIGH",
        metadata: { retrieval: "RBI published rates table" },
      });
    }
    return results;
  }
}
