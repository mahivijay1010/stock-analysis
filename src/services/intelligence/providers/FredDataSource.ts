import { ResilientHttpClient } from "../http";
import { MacroValue } from "../types";
import { MacroDataProvider } from "./interfaces";

/**
 * FRED (Federal Reserve Economic Data) macro source — India CPI, GDP and other
 * configured series. CONFIG-GATED like MoSPI: without FRED_API_KEY the adapter
 * makes NO request and reports the skip honestly (BLOCKED_EXTERNAL), never a
 * silent empty. Series ids are env-overridable so a bad default is skipped
 * gracefully rather than faking a value.
 *
 * Macro is a GLOBAL series (not bound to any ticker) — the monthly cron caches
 * it universe-wide. Each observation is stamped with its FRED observation date
 * (publicationDate) so downstream point-in-time discipline is preserved.
 */
const FRED_HOST = "api.stlouisfed.org";
const DEFAULT_SERIES: Array<{ id: string; indicator: string; unit: string }> = [
  { id: "INDCPIALLMINMEI", indicator: "India CPI (All Items, index)", unit: "index" },
  { id: "INDLORSGPNOSTSAM", indicator: "India Leading Indicator (normalized)", unit: "index" },
  { id: "MKTGDPINA646NWDB", indicator: "India GDP (current USD, World Bank)", unit: "usd" },
];

interface FredObservation {
  date: string;
  value: string;
}

export class FredDataSource implements MacroDataProvider {
  readonly name = "FRED";
  private readonly http = new ResilientHttpClient([FRED_HOST], 400, 20_000);
  private readonly apiKey = process.env.FRED_API_KEY ?? "";

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  private series(): Array<{ id: string; indicator: string; unit: string }> {
    const env = process.env.FRED_SERIES;
    if (!env) return DEFAULT_SERIES;
    // "SERIES_ID:Indicator label:unit, ..."
    return env
      .split(",")
      .map((chunk) => chunk.trim())
      .filter(Boolean)
      .map((chunk) => {
        const [id, indicator, unit] = chunk.split(":");
        return { id: id.trim(), indicator: (indicator ?? id).trim(), unit: (unit ?? "value").trim() };
      });
  }

  async fetchCurrent(): Promise<MacroValue[]> {
    if (!this.isConfigured()) return []; // BLOCKED_EXTERNAL — caller reports the skip
    const out: MacroValue[] = [];
    for (const s of this.series()) {
      try {
        const url =
          `https://${FRED_HOST}/fred/series/observations?series_id=${encodeURIComponent(s.id)}` +
          `&api_key=${encodeURIComponent(this.apiKey)}&file_type=json&sort_order=desc&limit=1`;
        const res = await this.http.getJson<{ observations?: FredObservation[] }>(url);
        const obs = res.data.observations?.[0];
        if (!obs || obs.value === "." || obs.value == null) continue; // FRED uses "." for missing
        const value = Number(obs.value);
        if (!Number.isFinite(value)) continue;
        out.push({
          indicator: s.indicator,
          value,
          unit: s.unit,
          period: obs.date,
          provider: "FRED",
          sourceUrl: `https://fred.stlouisfed.org/series/${s.id}`,
          publicationDate: obs.date,
          status: "RAW",
          confidence: "HIGH",
          metadata: { seriesId: s.id, retrieval: "FRED observations API (latest)" },
        });
      } catch {
        // Unknown/renamed series id or transient error ⇒ skip this series, keep the rest.
      }
    }
    return out;
  }
}
