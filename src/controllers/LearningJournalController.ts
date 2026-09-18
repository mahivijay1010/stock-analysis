/**
 * LearningJournalController — registering expectations and grading them.
 *
 *   GET  /api/journal                  — expectations + lessons + summary
 *   GET  /api/journal/due              — claims past their resolution date
 *   POST /api/journal/expectations     — register a claim (auth)
 *   POST /api/journal/expectations/:id/resolve — record the outcome (auth)
 *   POST /api/journal/lessons          — record a lesson (auth)
 *
 * Reads are open, like the rest of the evidence surface. Writes are
 * authenticated because they append to an immutable record: a registered claim
 * can never be edited or withdrawn, so writing one is a commitment.
 *
 * Service-level refusals (unfalsifiable claim, backdated window, re-grading)
 * are client errors, not server faults, and are surfaced as 400 rather than
 * being swallowed into a 500.
 */

import { NextFunction, Request, Response } from "express";
import {
  ExpectationStatus,
  LessonAction,
  learningJournalService,
} from "../services/evidence/LearningJournalService";

function ok(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ success: true, data });
}

/** The service's guardrails are user errors; everything else is a real fault. */
function isRefusal(err: unknown): boolean {
  return err instanceof Error && (err.message.startsWith("REFUSED:") || /needs|not a valid|No expectation/.test(err.message));
}

function handle(err: unknown, res: Response, next: NextFunction): void {
  if (isRefusal(err)) {
    res.status(400).json({ success: false, error: (err as Error).message });
    return;
  }
  next(err);
}

export class LearningJournalController {
  bundle = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const limit = Number(req.query.limit);
      ok(res, await learningJournalService.bundle(Number.isFinite(limit) && limit > 0 ? limit : 200));
    } catch (err) {
      next(err);
    }
  };

  due = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      ok(res, { due: await learningJournalService.dueForResolution() });
    } catch (err) {
      next(err);
    }
  };

  register = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      ok(
        res,
        await learningJournalService.register({
          scope: String(b.scope ?? "SYSTEM"),
          subject: String(b.subject ?? ""),
          claim: String(b.claim ?? ""),
          falsifiableIf: String(b.falsifiableIf ?? ""),
          resolveAfter: String(b.resolveAfter ?? ""),
          source: (b.source as never) ?? "OPERATOR",
          metric: b.metric ? String(b.metric) : null,
          predictedValue: b.predictedValue != null ? Number(b.predictedValue) : null,
          predictedLow: b.predictedLow != null ? Number(b.predictedLow) : null,
          predictedHigh: b.predictedHigh != null ? Number(b.predictedHigh) : null,
          confidence: b.confidence != null ? Number(b.confidence) : null,
          modelVersion: b.modelVersion ? String(b.modelVersion) : null,
          policyVersion: b.policyVersion ? String(b.policyVersion) : null,
          context: (b.context as Record<string, unknown> | undefined) ?? null,
        }),
        201
      );
    } catch (err) {
      handle(err, res, next);
    }
  };

  resolve = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      ok(
        res,
        await learningJournalService.resolve(req.params.id, {
          status: String(b.status ?? "") as Exclude<ExpectationStatus, "OPEN">,
          actualValue: b.actualValue != null ? Number(b.actualValue) : null,
          note: String(b.note ?? ""),
        })
      );
    } catch (err) {
      handle(err, res, next);
    }
  };

  lesson = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      ok(
        res,
        await learningJournalService.recordLesson({
          expectationId: b.expectationId ? String(b.expectationId) : null,
          predictionLogId: b.predictionLogId ? String(b.predictionLogId) : null,
          experimentRunId: b.experimentRunId ? String(b.experimentRunId) : null,
          modelKey: b.modelKey ? String(b.modelKey) : null,
          category: String(b.category ?? "PROCESS"),
          observation: String(b.observation ?? ""),
          lesson: String(b.lesson ?? ""),
          actionTaken: (b.actionTaken as LessonAction) ?? "NONE",
          actionDetail: b.actionDetail ? String(b.actionDetail) : null,
        }),
        201
      );
    } catch (err) {
      handle(err, res, next);
    }
  };
}
