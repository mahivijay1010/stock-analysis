/**
 * Model Lab gates + Learning Analyst with NO data, and the capital-desk
 * migration's immutability contract. No database: AppDataSource is mocked.
 */
import { AppDataSource } from "../src/config/database";
import { CreateCapitalDesk1790900000000 } from "../src/migrations/1790900000000-CreateCapitalDesk";

jest.mock("../src/config/database", () => ({ AppDataSource: { query: jest.fn(), getRepository: jest.fn() } }));
const q = AppDataSource.query as jest.Mock;

describe("migration 1790900000000 — append-only contract", () => {
  test("up() creates four tables and an immutability trigger on each, plus experiment_runs", async () => {
    const sql: string[] = [];
    const runner = { query: async (s: string) => { sql.push(s); return []; } };
    await new CreateCapitalDesk1790900000000().up(runner as never);
    const joined = sql.join("\n");
    for (const t of ["capital_plans", "capital_allocations", "capital_decision_outcomes", "daily_capital_decision_snapshots"]) {
      expect(joined).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${t}`));
      expect(joined).toMatch(new RegExp(`CREATE TRIGGER trg_${t}_immutable BEFORE UPDATE OR DELETE ON ${t}`));
    }
    expect(joined).toMatch(/CREATE TRIGGER trg_experiment_runs_immutable BEFORE UPDATE OR DELETE ON experiment_runs/);
    expect(joined).toMatch(/uq_capital_outcome_grader ON capital_decision_outcomes \(capital_allocation_id, grader_version\)/);
    expect(joined).toMatch(/uq_daily_capital_snapshot ON daily_capital_decision_snapshots \(account_id, snapshot_date\)/);
    expect(joined).toMatch(/feature_cutoff_at/);
    expect(joined).toMatch(/decision_time timestamptz NOT NULL/);
    expect(joined).toMatch(/outcome_maturity_time/);
  });
});

describe("ModelLabService with an empty registry", () => {
  beforeEach(() => q.mockReset());
  test("says there is not enough evidence; no gate passes; nothing is promoted", async () => {
    q.mockResolvedValue([]);
    const { modelLabService } = await import("../src/services/capital/ModelLabService");
    const v = await modelLabService.view();
    expect(v.evidenceVerdict).toMatch(/Only 0 resolved desk outcomes\. No model update recommended/);
    expect(v.promotionGates.every((g) => g.passed !== true)).toBe(true);
    expect(v.promotions).toHaveLength(0);
    expect(v.policy.join(" ")).toMatch(/LLM .*cannot promote/);
    expect(v.pipeline.find((p) => p.stage === "PROMOTION REVIEW")?.status).toBe("closed");
  });
});

describe("LearningAnalystService with no outcomes", () => {
  beforeEach(() => q.mockReset());
  test("emits INSUFFICIENT facts, never a finding, and a deterministic narrative that cites fact ids", async () => {
    q.mockResolvedValue([]);
    const { learningAnalystService } = await import("../src/services/capital/LearningAnalystService");
    const r = await learningAnalystService.report({ useAi: false });
    expect(r.facts.some((f) => f.kind === "FINDING")).toBe(false);
    expect(r.facts.find((f) => f.id === "desk-overall")?.kind).toBe("INSUFFICIENT");
    expect(r.narrativeSource).toBe("deterministic");
    for (const s of r.narrative) expect(s.cites.length).toBeGreaterThan(0);
    expect(r.narrative.map((s) => s.text).join(" ")).not.toMatch(/guarantee|will rise|safe profit|best stock/i);
    expect(r.evidenceStatus).toMatch(/No finding clears the sample floor/);
  });
});
