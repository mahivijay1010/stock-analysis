import { Router, Request, Response, NextFunction } from "express";
import { AdminController } from "../controllers/AdminController";
import { adminService } from "../services/admin/AdminService";
import { requireAuthOrAdminKey } from "../middleware/auth";

/**
 * Admin trading-desk routes (Module V2-D), mounted at /api/admin.
 *
 * Auth: none for local use. If (and only if) the ADMIN_KEY env var is set,
 * every request must carry a matching `x-admin-key` header.
 *
 * Creating these routes also triggers the idempotent boot seed of the
 * 'admin' paper account (start = cash = ₹1,000) — createApp() runs after
 * the DB is initialized, so this is safe on boot.
 */
/**
 * @deprecated Fail-OPEN when ADMIN_KEY is unset — replaced by
 * requireAuthOrAdminKey (P0 security #9). Retained only for reference; not
 * mounted on any route.
 */
export const adminKeyGuard = (req: Request, res: Response, next: NextFunction): void => {
  const requiredKey = process.env.ADMIN_KEY;
  if (!requiredKey) {
    next(); // no key configured — local use, no auth
    return;
  }
  if (req.header("x-admin-key") === requiredKey) {
    next();
    return;
  }
  res.status(401).json({
    success: false,
    error: { message: "Invalid or missing x-admin-key header." },
  });
};

export const createAdminRoutes = (): Router => {
  const router = Router();
  const controller = new AdminController();

  // Idempotent boot-time seed (fire-and-forget; endpoints re-ensure it too).
  void adminService.ensureSeeded().catch((err) => {
    console.error("⚠️ Admin paper-account seed failed (will retry on first request):", err);
  });

  // P0 security #9: fail-CLOSED. A session OR a matching x-admin-key is
  // required; the old "no ADMIN_KEY ⇒ open" behavior is gone.
  router.use(requireAuthOrAdminKey);
  router.get("/account", controller.account); //  GET  /api/admin/account
  router.post("/account/settings", controller.updateSettings); //  POST /api/admin/account/settings (disabled — honest 400)
  router.post("/trades", controller.recordTrade); //  POST /api/admin/trades
  // GET /api/admin/daily-plan REMOVED (upgrade-spec §2 rows 5/13).
  router.get("/prediction-audit", controller.predictionAudit); //  GET  /api/admin/prediction-audit
  router.get("/forecast-locks", controller.forecastLocks); //  GET  /api/admin/forecast-locks

  return router;
};
