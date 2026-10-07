/**
 * ConvictionBoardService — assembles the sub-₹100 Conviction Board from the
 * latest wide-scan's persisted candidates, joined with the AI scout's dossier.
 * Read-only and cheap: it reuses what the nightly bot already computed, so the
 * dashboard loads instantly without re-running a 2,700-stock scan.
 */

import { AppDataSource } from "../../config/database";
import { buildConvictionBoard, ConvictionBoard, ConvictionInput } from "./convictionBoard";

interface CandidateRow {
  ticker: string;
  action: string;
  payload: Record<string, unknown>;
  run_at: string;
}
interface DossierRow {
  ticker: string;
  cap: string | null;
  conf: string | null;
  flags: number | null;
  final_decision: string | null;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export class ConvictionBoardService {
  /** Build the board from the most recent WIDE_SUB100 scan run. */
  async board(): Promise<ConvictionBoard> {
    const runRows: Array<{ id: string; created_at: string }> = await AppDataSource.query(
      `SELECT id, created_at FROM short_term_scan_runs
        WHERE diagnostics->>'universe' = 'WIDE_SUB100'
        ORDER BY created_at DESC LIMIT 1`
    );
    if (runRows.length === 0) return buildConvictionBoard([], null);
    const runId = runRows[0].id;
    const generatedAt = new Date(runRows[0].created_at).toISOString();

    const candidates: CandidateRow[] = await AppDataSource.query(
      `SELECT c.ticker, c.action, c.payload, r.created_at AS run_at
         FROM short_term_candidates c
         JOIN short_term_scan_runs r ON r.id = c.scan_run_id
        WHERE c.scan_run_id = $1`,
      [runId]
    );

    // Latest AI dossier per ticker (scouted picks live in the wide ledger).
    const dossiers: DossierRow[] = await AppDataSource.query(
      `SELECT DISTINCT ON (ticker) ticker,
              ai_dossier->>'capAction' AS cap,
              ai_dossier->>'confidence' AS conf,
              jsonb_array_length(COALESCE(ai_dossier->'redFlags','[]'::jsonb)) AS flags,
              final_decision
         FROM wide_shadow_predictions
        WHERE ai_dossier IS NOT NULL
        ORDER BY ticker, created_at DESC`
    );
    const dossierByTicker = new Map(dossiers.map((d) => [d.ticker, d]));

    const inputs: ConvictionInput[] = candidates.map((c) => {
      const p = c.payload ?? {};
      const plan = (p.plan ?? {}) as Record<string, unknown>;
      const freshness = (p.freshness ?? {}) as Record<string, unknown>;
      const d = dossierByTicker.get(c.ticker);
      const cap = d?.cap === "AFFIRM" || d?.cap === "CAP_TO_WATCH" || d?.cap === "CAP_TO_NO_TRADE" ? d.cap : null;
      const conf = d?.conf === "LOW" || d?.conf === "MEDIUM" || d?.conf === "HIGH" ? d.conf : null;
      return {
        symbol: String(p.ticker ?? c.ticker).replace(/\.(NS|BO)$/, ""),
        ticker: c.ticker,
        companyName: str(p.name),
        industry: str(p.sector),
        price: num(p.currentPrice),
        setupType: String(p.setupType ?? "NONE"),
        action: c.action,
        tier: String(p.tier ?? "D"),
        gatesPassed: ((p.gates ?? {}) as Record<string, unknown>).passed === true,
        decision: str((p as Record<string, unknown>).decisionNewBuyer) ?? this.decisionFromAction(c.action),
        rewardRiskToT1: num(plan.rewardRiskToTarget1),
        evAfterCostsPct: num(plan.expectedValueAfterCostsPct),
        dataQuality: num(p.dataQuality),
        entry: num(plan.entryZoneHigh) ?? num(plan.entryTriggerPrice),
        stop: num(plan.initialStop),
        target1: num(plan.target1),
        aiCapAction: cap,
        aiConfidence: conf,
        aiRedFlags: Number(d?.flags ?? 0),
      };
    });

    return buildConvictionBoard(inputs, generatedAt);
  }

  /** Mirror of wideScan.decisionFor for the new-buyer label (kept local to
   *  avoid an import cycle; only the coarse buckets matter for the board). */
  private decisionFromAction(action: string): string {
    switch (action) {
      case "ENTRY_CONFIRMED":
      case "TIMING_OK":
        return "BUY";
      case "ZONE_REACHED":
      case "WAIT_FOR_CONFIRMATION":
        return "WAIT";
      case "RESEARCH_WATCH":
      case "SETUP_DETECTED":
        return "WATCH";
      default:
        return "NO TRADE";
    }
  }
}

export const convictionBoardService = new ConvictionBoardService();
