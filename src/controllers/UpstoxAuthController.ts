/**
 * UpstoxAuthController — the one daily human step the Upstox feed requires.
 *
 * Upstox issues no refresh tokens and every access token dies at 03:30 IST, so
 * a browser login is unavoidable once per trading day. These three routes make
 * it a single click:
 *
 *   GET /api/auth/upstox/login     → 302 to Upstox's consent screen
 *   GET /api/auth/upstox/callback  → Upstox redirects here with ?code=; the
 *                                    code is exchanged and the token stored
 *   GET /api/auth/upstox/status    → is the feed authorized, and until when?
 *
 * `status` is deliberately unauthenticated-readable but reveals NO token — it
 * exists so the operator (and the UI) can tell at a glance whether the feed
 * can run. The token itself is never returned by any route and never logged.
 *
 * Both /login and /callback are mutating in effect, but they are GETs because
 * OAuth redirects are GETs — the CSRF defence is the `state` parameter, which
 * the token store issues and verifies once.
 */

import { NextFunction, Request, Response } from "express";
import {
  buildAuthorizationUrl,
  describeConfig,
  exchangeCodeForToken,
  readUpstoxCredentials,
  upstoxTokenStore,
} from "../services/realtime/upstoxAuth";
import { HttpError } from "../types";

function ok(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ success: true, data });
}

/** Minimal, self-closing confirmation page — the operator sees it in the browser. */
function resultPage(title: string, detail: string, okState: boolean): string {
  const colour = okState ? "#00D4AA" : "#FF4D6D";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:system-ui;background:#0A0A0F;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center;max-width:32rem;padding:2rem">
<div style="font-size:1.25rem;font-weight:600;color:${colour};margin-bottom:.75rem">${title}</div>
<div style="color:#94a3b8;line-height:1.6">${detail}</div>
</div></body></html>`;
}

export class UpstoxAuthController {
  /** GET /api/auth/upstox/login — redirect the operator to Upstox. */
  login = (_req: Request, res: Response, next: NextFunction): void => {
    try {
      const creds = readUpstoxCredentials();
      if (!creds) {
        const cfg = describeConfig();
        throw new HttpError(503, `Upstox is not configured — missing ${cfg.missing.join(", ")} in .env`);
      }
      res.redirect(buildAuthorizationUrl(creds, upstoxTokenStore.newState()));
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/auth/upstox/callback?code=&state= — exchange and store the token. */
  callback = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const creds = readUpstoxCredentials();
      if (!creds) throw new HttpError(503, "Upstox is not configured (UPSTOX_API_KEY / UPSTOX_API_SECRET).");

      const code = typeof req.query.code === "string" ? req.query.code : null;
      const state = typeof req.query.state === "string" ? req.query.state : null;
      if (!code) {
        res.status(400).send(resultPage("Authorization failed", "Upstox did not return an authorization code.", false));
        return;
      }
      if (!upstoxTokenStore.consumeState(state)) {
        // Wrong/replayed state: refuse rather than accept a code we did not ask for.
        res.status(400).send(resultPage("Authorization rejected", "State mismatch — start again from /api/auth/upstox/login.", false));
        return;
      }

      const token = await exchangeCodeForToken(creds, code);
      upstoxTokenStore.set(token);
      const expiresIst = new Date(token.expiresAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
      res.send(
        resultPage(
          "Upstox feed authorized",
          `Live market data is enabled until <strong>${expiresIst} IST</strong>. Upstox tokens expire at 03:30 IST daily and cannot be refreshed automatically — open this link again tomorrow. You can close this tab.`,
          true
        )
      );
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/auth/upstox/status — authorization state; never exposes the token. */
  status = (_req: Request, res: Response, next: NextFunction): void => {
    try {
      const cfg = describeConfig();
      const s = upstoxTokenStore.status();
      ok(res, {
        configured: cfg.configured,
        missing: cfg.missing,
        tokenState: s.state,
        expiresAt: s.expiresAt ? new Date(s.expiresAt).toISOString() : null,
        minutesRemaining: s.msRemaining != null ? Math.floor(s.msRemaining / 60_000) : null,
        reason: s.reason,
        loginUrl: "/api/auth/upstox/login",
        note: "Upstox access tokens expire at 03:30 IST daily; no refresh tokens exist, so re-authorization is a manual browser login.",
      });
    } catch (err) {
      next(err);
    }
  };
}
