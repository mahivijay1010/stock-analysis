/**
 * Fundamentals completeness (completion directive, Phase 10) — per-field
 * availability with an explicit availableAt timestamp per field.
 *
 * Two genuinely-held sources are audited:
 *  - XBRL financial_facts (exchange filings): availableAt = when THIS system
 *    ingested the fact (created_at) — the conservative provable-knowability
 *    bound; a filing may have been public earlier, but the system never
 *    claims knowledge it cannot prove it had.
 *  - Yahoo quoteSummary snapshot fields: availableAt = the fetch timestamp.
 *
 * Nothing is imputed: a missing field is reported missing, and staleness is
 * measured, not hidden.
 */

import { AppDataSource } from "../../config/database";
import { Fundamentals } from "../market/types";

export const FUNDAMENTALS_COMPLETENESS_VERSION = "fund-completeness-v1";

/** XBRL concepts the decision layer considers core evidence. */
const XBRL_CORE_CONCEPTS = [
  "revenue",
  "net_income",
  "profit_before_tax",
  "finance_costs",
  "total_assets",
  "current_assets",
  "current_liabilities",
  "equity",
  "cash_from_operations",
  "capex",
] as const;

export interface FieldAvailability {
  field: string;
  source: "xbrl" | "yahoo";
  available: boolean;
  /** Reporting period end for XBRL facts (null for point-in-time Yahoo fields). */
  periodEnd: string | null;
  /** When the value became provably knowable to this system (ISO), null if unavailable. */
  availableAt: string | null;
  staleDays: number | null;
}

export interface FundamentalsCompleteness {
  version: string;
  xbrlCompletenessPct: number | null;
  yahooCompletenessPct: number | null;
  fields: FieldAvailability[];
  note: string;
}

export async function assessFundamentalsCompleteness(
  baseTicker: string,
  yahoo: Fundamentals | null,
  asOf: Date
): Promise<FundamentalsCompleteness> {
  const fields: FieldAvailability[] = [];

  // ── XBRL side ──────────────────────────────────────────────────────────────
  let xbrlPct: number | null = null;
  try {
    const rows: Array<{ concept: string; period_end: string; ingested_at: string }> = await AppDataSource.query(
      `SELECT concept,
              to_char(max(period_end), 'YYYY-MM-DD') AS period_end,
              to_char(min(created_at), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ingested_at
         FROM financial_facts
        WHERE ticker = $1 AND concept = ANY($2) AND created_at <= $3
        GROUP BY concept`,
      [baseTicker, XBRL_CORE_CONCEPTS, asOf]
    );
    const byConcept = new Map(rows.map((r) => [r.concept, r]));
    let have = 0;
    for (const concept of XBRL_CORE_CONCEPTS) {
      const r = byConcept.get(concept);
      if (r) {
        have++;
        const staleDays = Math.max(0, Math.floor((asOf.getTime() - new Date(r.period_end).getTime()) / 86400_000));
        fields.push({
          field: concept,
          source: "xbrl",
          available: true,
          periodEnd: r.period_end,
          availableAt: r.ingested_at,
          staleDays,
        });
      } else {
        fields.push({ field: concept, source: "xbrl", available: false, periodEnd: null, availableAt: null, staleDays: null });
      }
    }
    xbrlPct = Math.round((have / XBRL_CORE_CONCEPTS.length) * 1000) / 10;
  } catch {
    xbrlPct = null; // audit failure ⇒ unknown, not zero and not full
  }

  // ── Yahoo side ─────────────────────────────────────────────────────────────
  const yahooFields: Array<[string, number | null]> = yahoo
    ? [
        ["trailingPE", yahoo.trailingPE],
        ["pegRatio", yahoo.pegRatio],
        ["priceToBook", yahoo.priceToBook],
        ["enterpriseToEbitda", yahoo.enterpriseToEbitda],
        ["operatingMarginPct", yahoo.operatingMarginPct],
        ["revenueGrowthPct", yahoo.revenueGrowthPct],
        ["earningsGrowthPct", yahoo.earningsGrowthPct],
        ["returnOnEquityPct", yahoo.returnOnEquityPct],
        ["freeCashflow", yahoo.freeCashflow],
        ["currentRatio", yahoo.currentRatio],
      ]
    : [];
  let yahooPct: number | null = null;
  if (yahoo) {
    let have = 0;
    for (const [name, value] of yahooFields) {
      const available = value != null;
      if (available) have++;
      fields.push({
        field: name,
        source: "yahoo",
        available,
        periodEnd: null,
        availableAt: available ? yahoo.asOf : null,
        staleDays: null,
      });
    }
    yahooPct = Math.round((have / yahooFields.length) * 1000) / 10;
  }

  return {
    version: FUNDAMENTALS_COMPLETENESS_VERSION,
    xbrlCompletenessPct: xbrlPct,
    yahooCompletenessPct: yahooPct,
    fields,
    note:
      "availableAt = provable knowability (XBRL: ingestion time; Yahoo: fetch time). " +
      "Missing fields are reported, never imputed.",
  };
}
