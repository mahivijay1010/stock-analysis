import { Request, Response, NextFunction } from "express";

/**
 * Global error handler — every error becomes the standard envelope:
 * { success: false, error: { message } } with the HttpError status (or 500).
 */
export const errorHandler = (
  error: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void => {
  const rawStatus = (error as { statusCode?: unknown }).statusCode;
  const statusCode = typeof rawStatus === "number" ? rawStatus : 500;
  if (statusCode >= 500) {
    // P0 security #62: log the real error server-side, but NEVER leak the
    // internal exception message (stack details, SQL, secrets) to the client.
    console.error("Error:", error);
    res.status(statusCode).json({ success: false, error: { message: "Internal Server Error" } });
    return;
  }
  // 4xx are intentional, user-facing messages (HttpError) — safe to return.
  res.status(statusCode).json({
    success: false,
    error: { message: error.message || "Request failed" },
  });
};

/** 404 handler — same envelope. */
export const notFoundHandler = (req: Request, res: Response): void => {
  res.status(404).json({
    success: false,
    error: { message: `Route ${req.method} ${req.path} not found` },
  });
};

/** Request logger. */
export const requestLogger = (req: Request, _res: Response, next: NextFunction): void => {
  console.log(`${req.method} ${req.path} - ${new Date().toISOString()}`);
  next();
};
