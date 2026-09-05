import { ResilientHttpClient } from "../http";
import { MacroValue } from "../types";
import { MacroDataProvider } from "./interfaces";

const API = "https://api.mospi.gov.in/api";

function flatten(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === "object");
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  for (const key of ["data", "Data", "result", "records"]) {
    if (Array.isArray(object[key])) return flatten(object[key]);
  }
  return [];
}

/** Official MoSPI adapter. Full CPI retrieval can use MOSPI_API_TOKEN. */
export class MoSPIDataSource implements MacroDataProvider {
  readonly name = "MOSPI";
  private readonly http = new ResilientHttpClient(["mospi.gov.in"], 500, 30_000);

  async fetchCurrent(): Promise<MacroValue[]> {
    const token = process.env.MOSPI_API_TOKEN;
    const url = `${API}/getCPIIndex`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await this.http.getJson<unknown>(url, { headers });
    const rows = flatten(response.data);
    return rows.flatMap((row): MacroValue[] => {
      const rawValue = row.Index ?? row.index ?? row.CPI ?? row.cpi ?? row.Value ?? row.value;
      const value = Number(String(rawValue ?? "").replace(/,/g, ""));
      if (!Number.isFinite(value)) return [];
      const month = String(row.Month ?? row.month ?? row.MonthName ?? "");
      const year = String(row.Year ?? row.year ?? row.FinancialYear ?? "");
      return [{
        indicator: String(row.Series ?? row.series ?? row.Item ?? row.item ?? "CPI index"),
        value, unit: "index", period: [month, year].filter(Boolean).join(" ") || "UNKNOWN",
        provider: "MOSPI", sourceUrl: url, status: "RAW", confidence: "HIGH", metadata: row,
      }];
    });
  }
}
