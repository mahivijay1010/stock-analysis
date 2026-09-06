/**
 * Session auth + CSRF middleware (Phase B2, spec §12).
 *
 * Session: signed JWT in an httpOnly cookie. Identity is derived server-side
 * from the cookie on every private route — never from request bodies/params.
 *
 * CSRF choice (documented per task): the session cookie is SameSite=Strict
 * (browsers do not attach it to any cross-site request), and, as defense in
 * depth, every mutating request (non-GET/HEAD/OPTIONS) must carry the custom
 * header `X-Requested-With: XMLHttpRequest`. A cross-origin page cannot add
 * a custom header without a CORS preflight our server would have to approve,
 * so classic form/img-tag CSRF is blocked twice. No token round-trip needed
 * for this same-site, single-owner deployment.
 *
 * Admin/desk routes: previously guarded only by an optional x-admin-key.
 * They now REQUIRE a session; when ADMIN_KEY is configured, a matching
 * x-admin-key header is still accepted as an alternative for scripts/cron
 * tooling (requireAuthOrAdminKey).
 */
import { NextFunction, Request, Response } from "express";
import { authService, SessionIdentity } from "../services/auth/AuthService";
import { HttpError } from "../types";

export const SESSION_COOKIE = "stocksense_session";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      account?: SessionIdentity;
    }
  }
}

/** Minimal cookie-header parser (no extra dependency needed). */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** CSRF custom-header check for mutating requests (usable pre-session, e.g. login). */
export const requireCsrfHeader = (req: Request, res: Response, next: NextFunction): void => {
  if (MUTATING.has(req.method) && req.header("x-requested-with") !== "XMLHttpRequest") {
    res.status(403).json({
      success: false,
      error: { message: "Missing CSRF header: send X-Requested-With: XMLHttpRequest on mutating requests." },
    });
    return;
  }
  next();
};

function identityFrom(req: Request): SessionIdentity | null {
  const cookies = parseCookies(req.header("cookie"));
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  return authService.verifyToken(token);
}

/** Session required. Sets req.account (server-side identity). */
export const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
  try {
    const identity = identityFrom(req);
    if (!identity) {
      res.status(401).json({ success: false, error: { message: "Authentication required. Log in via POST /api/auth/login." } });
      return;
    }
    if (MUTATING.has(req.method) && req.header("x-requested-with") !== "XMLHttpRequest") {
      res.status(403).json({
        success: false,
        error: { message: "Missing CSRF header: send X-Requested-With: XMLHttpRequest on mutating requests." },
      });
      return;
    }
    req.account = identity;
    next();
  } catch (err) {
    // e.g. SESSION_SECRET unset — surface as the config error it is
    const status = err instanceof HttpError ? err.statusCode : 500;
    res.status(status).json({ success: false, error: { message: err instanceof Error ? err.message : "Auth failure" } });
  }
};

/**
 * Session OR (when configured) x-admin-key. Protects the desk/admin routes
 * and job submissions: without any credentials they are now 401 — the old
 * "no ADMIN_KEY set → open" behavior is gone.
 */
export const requireAuthOrAdminKey = (req: Request, res: Response, next: NextFunction): void => {
  const requiredKey = process.env.ADMIN_KEY;
  if (requiredKey && req.header("x-admin-key") === requiredKey) {
    next();
    return;
  }
  requireAuth(req, res, next);
};
