/**
 * Evidence-tab view of the pre-registered stock-selection study: the latest
 * stored run (experiment_runs name 'selection-study'), never recomputed per
 * request — the study reads ~190k bars.
 */
import { AppDataSource } from "../../config/database";
import type { SignalResult } from "../research/selectionStudy";
import { PERIODS, SELECTION_RULE, studyHeadline } from "../research/selectionStudy";

export interface SelectionReport {
  runId: string;
  ranAt: string;
  headline: string;
  periods: typeof PERIODS;
  rule: typeof SELECTION_RULE;
  results: SignalResult[];
  doc: string;
}

export async function selectionReport(): Promise<SelectionReport | null> {
  const [row]: Array<{ id: string; finished_at: Date; metrics: { results: SignalResult[] } }> = await AppDataSource.query(
    `SELECT id, finished_at, metrics FROM experiment_runs WHERE name = 'selection-study' AND status = 'completed' ORDER BY started_at DESC LIMIT 1`
  );
  if (!row) return null;
  const results = row.metrics.results;
  return {
    runId: row.id,
    ranAt: new Date(row.finished_at).toISOString(),
    headline: studyHeadline(results),
    periods: PERIODS,
    rule: SELECTION_RULE,
    results,
    doc: "docs/stock-selection-preregistration.md",
  };
}
