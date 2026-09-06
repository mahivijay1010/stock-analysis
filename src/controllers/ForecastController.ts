/**
 * ForecastController (Phase C, spec §5) — thin HTTP handlers over
 * ForecastService. Read/write contract (B1): GETs return STORED issuances and
 * observations only; creating an issuance is always an authenticated POST (or
 * the nightly cron). Forecast runs are immutable — there is no update route.
 */
import { NextFunction, Request, Response } from "express";
import { forecastService } from "../services/forecast/ForecastService";
import { decisionService } from "../services/decision/DecisionService";
import { portfolioOverviewService } from "../services/portfolio/PortfolioOverviewService";
import { LedgerService } from "../services/ledger/LedgerService";
import { HttpError } from "../types";

function ok(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ success: true, data });
}

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export class ForecastController {
  private readonly ledger = new LedgerService();

  /** GET /api/forecast/:ticker/daily — latest stored next-30-calendar-days view. */
  daily = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      ok(res, await forecastService.getDailyView(req.params.ticker));
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/forecast/:ticker/month/:period — original snapshot + latest outlook + actuals. */
  month = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!PERIOD_RE.test(req.params.period)) {
        throw new HttpError(400, `period must be YYYY-MM, got "${req.params.period}"`);
      }
      ok(res, await forecastService.getMonthView(req.params.ticker, req.params.period));
    } catch (err) {
      next(err);
    }
  };

  /**
   * POST /api/forecast/:ticker/issue — on-demand issuance (auth): a next-30
   * run for the current anchor plus the current month's original snapshot if
   * missing. Idempotent per anchor/period (unique indexes dedupe).
   */
  issue = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ticker = req.params.ticker;
      const run = await forecastService.issueNext30(ticker);
      const period = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
      })
        .format(new Date())
        .slice(0, 7);
      let monthIssued = true;
      try {
        await forecastService.issueMonth(ticker, period);
      } catch {
        monthIssued = false; // e.g. no future sessions left in the month
      }
      ok(res, { view: await forecastService.toView(run), monthSnapshotEnsured: monthIssued }, 201);
    } catch (err) {
      next(err);
    }
  };

  /** POST /api/forecast/:ticker/month/:period/refresh — NEW latest-outlook issuance (auth). */
  refreshMonth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!PERIOD_RE.test(req.params.period)) {
        throw new HttpError(400, `period must be YYYY-MM, got "${req.params.period}"`);
      }
      const run = await forecastService.issueMonth(req.params.ticker, req.params.period, { refresh: true });
      ok(res, { view: await forecastService.toView(run) }, 201);
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/holdings/projection — the account's positions through their own forecasts. */
  holdingsProjection = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const holdings = await this.ledger.getPositions(req.account!.accountId);
      const open = holdings.positions
        .filter((p) => p.status === "OPEN" && p.qty > 0)
        .map((p) => ({ ticker: p.ticker, qty: p.qty, costBasis: Number(p.costBasisExact) }));
      ok(res, await forecastService.holdingsProjection(open));
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/portfolio/overview — the unified watchlist+holdings screen in one read. */
  portfolioOverview = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      ok(res, await portfolioOverviewService.overview(req.account!.accountId));
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/decision/:ticker — latest published snapshot (honest empty when none). */
  decision = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { snapshot, expired } = await decisionService.latest(req.params.ticker);
      ok(res, snapshot ? { available: true, expired, snapshot } : {
        available: false,
        reason:
          "No decision has been published for this instrument yet. Decisions publish nightly for " +
          "followed/held instruments, or on demand via POST /api/decision/:ticker/publish.",
      });
    } catch (err) {
      next(err);
    }
  };

  /** POST /api/decision/:ticker/publish — compute policy v1 over stored evidence (auth). */
  publishDecision = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      ok(res, { snapshot: await decisionService.publish(req.params.ticker) }, 201);
    } catch (err) {
      next(err);
    }
  };

  /** POST /api/jobs/forecast-maintenance — manual verify+renew sweep (auth/admin). */
  maintenance = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const outcomes = await forecastService.verifyOutcomes();
      const daily = await forecastService.issueDailyForAll();
      const monthly = await forecastService.renewMonthly();
      ok(res, { outcomes, daily, monthly });
    } catch (err) {
      next(err);
    }
  };
}
