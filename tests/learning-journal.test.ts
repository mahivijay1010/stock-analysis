/**
 * LearningJournalService — the guardrails that stop the journal decaying into
 * a diary of rationalisations.
 *
 * A journal of lessons is worthless if claims can be vague, backdated, or
 * re-graded once the answer is known. Each test below pins one of those doors
 * shut. The database enforces the same invariants independently (see
 * 1789800000000-CreateLearningJournal); these cover the service so a caller
 * gets a clear refusal rather than a raw constraint violation.
 */

import { LearningJournalService, MIN_RESOLVED_FOR_RATE } from "../src/services/evidence/LearningJournalService";
import { AppDataSource } from "../src/config/database";

jest.mock("../src/config/database", () => ({ AppDataSource: { query: jest.fn() } }));
const q = AppDataSource.query as jest.Mock;

const DAY = 24 * 60 * 60 * 1000;
const future = () => new Date(Date.now() + 7 * DAY);
const past = () => new Date(Date.now() - 7 * DAY);

const base = {
  scope: "TICKER",
  subject: "COALINDIA.NS",
  claim: "mean reversion holds after a 2% single-day drop",
  falsifiableIf: "close is lower again 5 sessions later",
  source: "OPERATOR" as const,
};

beforeEach(() => q.mockReset());

describe("register — a claim must be capable of being wrong", () => {
  test("refuses a claim with no falsification criterion", async () => {
    await expect(
      new LearningJournalService().register({ ...base, falsifiableIf: "   ", resolveAfter: future() })
    ).rejects.toThrow(/must state what would prove it WRONG/);
    expect(q).not.toHaveBeenCalled(); // refused before touching the database
  });

  test("refuses a window that has already passed — that is backdating, not prediction", async () => {
    await expect(
      new LearningJournalService().register({ ...base, resolveAfter: past() })
    ).rejects.toThrow(/must be in the FUTURE/);
    expect(q).not.toHaveBeenCalled();
  });

  test("accepts a falsifiable, forward-dated claim and stores it verbatim", async () => {
    const when = future();
    q.mockResolvedValueOnce([
      {
        id: "e1", scope: base.scope, subject: base.subject, claim: base.claim,
        falsifiable_if: base.falsifiableIf, metric: null, predicted_value: null,
        predicted_low: null, predicted_high: null, confidence: null,
        registered_at: new Date(), resolve_after: when, source: "OPERATOR",
        model_version: null, policy_version: null, status: "OPEN",
        actual_value: null, resolution_note: null, resolved_at: null,
      },
    ]);
    const row = await new LearningJournalService().register({ ...base, resolveAfter: when });
    expect(row.status).toBe("OPEN");
    expect(row.claim).toBe(base.claim);
    expect(row.overdue).toBe(false);
    // The claim text must reach the database unaltered.
    expect(q.mock.calls[0][1]).toEqual(expect.arrayContaining([base.claim, base.falsifiableIf]));
  });
});

describe("resolve — grading is write-once and never early", () => {
  test("refuses to grade before the resolution date, when the outcome is not yet known", async () => {
    q.mockResolvedValueOnce([{ id: "e1", status: "OPEN", resolve_after: future() }]);
    await expect(
      new LearningJournalService().resolve("e1", { status: "CORRECT", note: "looks right already" })
    ).rejects.toThrow(/cannot be graded until/);
  });

  test("refuses to re-grade a claim that already resolved", async () => {
    q.mockResolvedValueOnce([{ id: "e1", status: "WRONG", resolve_after: past() }]);
    await expect(
      new LearningJournalService().resolve("e1", { status: "CORRECT", note: "on reflection" })
    ).rejects.toThrow(/already resolved as WRONG/);
  });

  test("requires the resolution to say what actually happened", async () => {
    await expect(
      new LearningJournalService().resolve("e1", { status: "WRONG", note: "  " })
    ).rejects.toThrow(/must say what actually happened/);
  });

  test("records a due outcome, and the UPDATE is guarded by status = 'OPEN'", async () => {
    q.mockResolvedValueOnce([{ id: "e1", status: "OPEN", resolve_after: past() }]).mockResolvedValueOnce([
      {
        id: "e1", scope: "TICKER", subject: "COALINDIA.NS", claim: base.claim,
        falsifiable_if: base.falsifiableIf, metric: null, predicted_value: null,
        predicted_low: null, predicted_high: null, confidence: null,
        registered_at: new Date(), resolve_after: past(), source: "OPERATOR",
        model_version: null, policy_version: null, status: "WRONG",
        actual_value: "-1.94", resolution_note: "fell further", resolved_at: new Date(),
      },
    ]);
    const row = await new LearningJournalService().resolve("e1", {
      status: "WRONG", actualValue: -1.94, note: "fell further",
    });
    expect(row.status).toBe("WRONG");
    expect(row.actualValue).toBeCloseTo(-1.94, 6);
    // The concurrency guard must be in the statement, not just the read above.
    expect(String(q.mock.calls[1][0])).toMatch(/status = 'OPEN'/);
  });
});

describe("bundle — the summary cannot overstate what the journal has shown", () => {
  function mockBundle(counts: Record<string, string>, lessons: Record<string, string>): void {
    q.mockImplementation(async (sql: string) => {
      if (/FROM learning_lessons/.test(sql) && /COUNT/.test(sql)) return [lessons];
      if (/FROM learning_expectations/.test(sql) && /COUNT/.test(sql)) return [counts];
      return [];
    });
  }

  test("an empty journal says plainly that it cannot train anything yet", async () => {
    mockBundle({ open: "0", overdue: "0", resolved: "0", correct: "0", wrong: "0" }, { total: "0", acted: "0" });
    const b = await new LearningJournalService().bundle();
    expect(b.summary.headline).toMatch(/No expectation has been registered yet/);
    expect(b.summary.accuracyPct).toBeNull();
  });

  test("overdue claims dominate the headline — an ungraded claim teaches nothing", async () => {
    mockBundle({ open: "5", overdue: "3", resolved: "2", correct: "1", wrong: "1" }, { total: "1", acted: "0" });
    const b = await new LearningJournalService().bundle();
    expect(b.summary.headline).toMatch(/3 expectations are past their resolution date/);
  });

  test("accuracy is withheld below the minimum resolved count", async () => {
    mockBundle({ open: "0", overdue: "0", resolved: "4", correct: "3", wrong: "1" }, { total: "2", acted: "1" });
    const b = await new LearningJournalService().bundle();
    expect(b.summary.resolved).toBeLessThan(MIN_RESOLVED_FOR_RATE);
    expect(b.summary.accuracyPct).toBeNull();
    expect(b.summary.sampleWarning).toMatch(/at least 10/);
  });

  test("lessons that changed nothing are counted separately, not as learning", async () => {
    mockBundle({ open: "0", overdue: "0", resolved: "12", correct: "7", wrong: "5" }, { total: "9", acted: "2" });
    const b = await new LearningJournalService().bundle();
    expect(b.summary.accuracyPct).toBeCloseTo(58.3, 1);
    expect(b.summary.lessons).toBe(9);
    expect(b.summary.lessonsThatChangedSomething).toBe(2);
    expect(b.summary.headline).toMatch(/9 lessons recorded, of which 2 actually changed something/);
  });
});
