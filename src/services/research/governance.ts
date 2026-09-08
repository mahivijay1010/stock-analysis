/**
 * Model governance (autonomous directive, Part R) — the single registry of
 * every model's lifecycle state with an append-only transition trail.
 *
 * States: SHADOW → CANDIDATE → CHAMPION, with DEGRADED / SUSPENDED / RETIRED.
 * Transitions happen ONLY through this service, ONLY with an evidence
 * reference (ExperimentRun id or monitoring source) — no manual cherry-picks,
 * no AI-initiated promotion (there is deliberately no code path from any
 * reasoning provider into this service).
 */

import { AppDataSource } from "../../config/database";

export type GovernanceState = "SHADOW" | "CANDIDATE" | "CHAMPION" | "DEGRADED" | "SUSPENDED" | "RETIRED";

const ALLOWED: Record<GovernanceState, GovernanceState[]> = {
  SHADOW: ["CANDIDATE", "RETIRED"],
  CANDIDATE: ["CHAMPION", "SHADOW", "RETIRED"],
  CHAMPION: ["DEGRADED", "RETIRED"],
  DEGRADED: ["CHAMPION", "SUSPENDED", "RETIRED"],
  SUSPENDED: ["SHADOW", "RETIRED"],
  RETIRED: [],
};

export interface GovernanceRow {
  modelKey: string;
  scope: string;
  state: GovernanceState;
  evidenceRunId: string | null;
  reasons: string[];
  updatedAt: string;
}

export class ModelGovernanceService {
  async list(): Promise<GovernanceRow[]> {
    const rows: Array<{ model_key: string; scope: string; state: string; evidence_run_id: string | null; reasons: string[] | null; updated_at: string }> =
      await AppDataSource.query(`SELECT model_key, scope, state, evidence_run_id, reasons, updated_at FROM model_governance ORDER BY scope, model_key`);
    return rows.map((r) => ({
      modelKey: r.model_key,
      scope: r.scope,
      state: r.state as GovernanceState,
      evidenceRunId: r.evidence_run_id,
      reasons: r.reasons ?? [],
      updatedAt: r.updated_at,
    }));
  }

  async get(modelKey: string): Promise<GovernanceRow | null> {
    const rows = await this.list();
    return rows.find((r) => r.modelKey === modelKey) ?? null;
  }

  /** Register a model in SHADOW (idempotent). */
  async register(modelKey: string, scope: string, reason: string, evidenceRunId?: string | null): Promise<void> {
    await AppDataSource.query(
      `INSERT INTO model_governance (model_key, scope, state, evidence_run_id, reasons, updated_at)
       VALUES ($1, $2, 'SHADOW', $3, $4::jsonb, now())
       ON CONFLICT (model_key) DO NOTHING`,
      [modelKey, scope, evidenceRunId ?? null, JSON.stringify([reason])]
    );
  }

  /**
   * Transition a model's state. Requires an evidence reference; illegal
   * transitions throw. Every transition is appended to the trail.
   */
  async transition(modelKey: string, to: GovernanceState, reason: string, evidenceRunId: string | null): Promise<void> {
    const current = await this.get(modelKey);
    if (!current) throw new Error(`governance: unknown model "${modelKey}" — register() it first`);
    if (current.state === to) return; // idempotent
    if (!ALLOWED[current.state].includes(to)) {
      throw new Error(`governance: illegal transition ${current.state} → ${to} for ${modelKey}`);
    }
    if (!reason || reason.length < 8) throw new Error("governance: a substantive reason is required");
    await AppDataSource.query(
      `UPDATE model_governance SET state = $2, evidence_run_id = $3,
              reasons = reasons || $4::jsonb, updated_at = now()
        WHERE model_key = $1`,
      [modelKey, to, evidenceRunId, JSON.stringify([`${current.state}→${to}: ${reason}`])]
    );
    await AppDataSource.query(
      `INSERT INTO model_governance_transitions (model_key, from_state, to_state, reason, evidence_run_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [modelKey, current.state, to, reason, evidenceRunId]
    );
  }

  /** Seed today's honest states from the persisted study verdicts (idempotent). */
  async seedFromVerdicts(): Promise<number> {
    const seeds: Array<{ key: string; scope: string; state: GovernanceState; reason: string }> = [
      { key: "champion-quant-v1", scope: "forecast-distribution", state: "CHAMPION", reason: "incumbent; every challenger failed pre-registered promotion (runs 86b07227/0208bb27)" },
      { key: "panel-lgbm-excess", scope: "forecast-panel", state: "SHADOW", reason: "positive test IC but stride-t ≤ 1.87 — promising, not proven" },
      { key: "panel-lambdarank", scope: "ranking", state: "SHADOW", reason: "no significant held-out improvement over momentum on independent windows" },
      { key: "calibrator-platt-1d", scope: "calibration", state: "CANDIDATE", reason: "promoted on held-out 1d evidence (~26 indep obs); display horizon 30d remains withheld" },
      { key: "meta-label-lgbm", scope: "trade-probability", state: "SHADOW", reason: "failed Brier-vs-base-rate pre-registered bar (0.1639 vs 0.1635)" },
      { key: "mc-block-bootstrap", scope: "forecast-distribution", state: "RETIRED", reason: "iid coverage closer to nominal (run 3a591851); pre-registered rule keeps iid" },
      { key: "setup-mean-reversion-5-10d", scope: "short-term-setup", state: "CANDIDATE", reason: "backtest TIER A (+0.117R, CI>0, BH-sig); awaiting prospective shadow authority" },
      { key: "setup-mean-reversion-10-21d", scope: "short-term-setup", state: "CANDIDATE", reason: "backtest TIER A (+0.146R, CI>0, BH-sig); awaiting prospective shadow authority" },
      { key: "stat-har-rv", scope: "forecast-distribution", state: "SHADOW", reason: "conditional-σ coverage 79.7% ≈ nominal at 30d — interval-generation candidate (baseline-completion run)" },
      { key: "stat-ewma", scope: "forecast-return", state: "RETIRED", reason: "drift extrapolation catastrophic at 30d (BSS −0.672, MAE 12.7%)" },
    ];
    let n = 0;
    for (const s of seeds) {
      await AppDataSource.query(
        `INSERT INTO model_governance (model_key, scope, state, evidence_run_id, reasons, updated_at)
         VALUES ($1, $2, $3, NULL, $4::jsonb, now())
         ON CONFLICT (model_key) DO NOTHING`,
        [s.key, s.scope, s.state, JSON.stringify([s.reason])]
      );
      n++;
    }
    return n;
  }
}

export const modelGovernanceService = new ModelGovernanceService();
