/**
 * AuthController (Phase B2) — login/logout/me for the single-owner session.
 * Envelope discipline matches the rest of the API: { success, data | error }.
 */
import { NextFunction, Request, Response } from "express";
import { authService, TOKEN_TTL } from "../services/auth/AuthService";
import { SESSION_COOKIE } from "../middleware/auth";

function ok(res: Response, data: unknown): void {
  res.status(200).json({ success: true, data });
}

export class AuthController {
  /** POST /api/auth/login { username, password } → httpOnly session cookie. */
  login = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
      const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
      const { identity, token, expiresAt } = await authService.login(String(username ?? ""), String(password ?? ""), ip);
      res.cookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: "strict",
        secure: process.env.NODE_ENV === "production", // localhost dev runs over http
        path: "/",
        maxAge: TOKEN_TTL * 1000,
      });
      ok(res, { account: { id: identity.accountId, username: identity.username }, expiresAt });
    } catch (err) {
      next(err);
    }
  };

  /** POST /api/auth/logout — clears the session cookie. */
  logout = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "strict", path: "/" });
      ok(res, { loggedOut: true });
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/auth/me — the server-side identity for the current session. */
  me = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      ok(res, { account: { id: req.account!.accountId, username: req.account!.username } });
    } catch (err) {
      next(err);
    }
  };
}

export default AuthController;
